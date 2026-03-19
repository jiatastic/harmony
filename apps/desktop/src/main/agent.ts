import { randomUUID } from 'node:crypto'
import { ipcMain, type IpcMainInvokeEvent, webContents } from 'electron'
import type { AgentRun, AgentStartPayload } from '../shared/workbench'
import { harmonyChannels } from '../shared/workbench'

const WAITING_PATTERNS = [
  /press enter/i,
  /continue\?/i,
  /waiting for input/i,
  /approval/i,
  /allow this/i,
  /\b[yY]\/[nN]\b/,
  /select an option/i
]

type AgentRunRecord = AgentRun & {
  ownerId: number
  recentOutput: string
  completionTimer?: ReturnType<typeof setTimeout>
  currentInputLine: string
  awaitingResponse: boolean
  sawOutputSincePrompt: boolean
}

const agentRunsBySession = new Map<string, AgentRunRecord>()
const COMPLETE_AFTER_QUIET_MS = 5000

function publishUpdate(run: AgentRunRecord): void {
  const target = webContents.fromId(run.ownerId)

  if (!target || target.isDestroyed()) {
    return
  }

  target.send(harmonyChannels.agentUpdate, {
    runId: run.runId,
    sessionId: run.sessionId,
    workspacePath: run.workspacePath,
    command: run.command,
    displayName: run.displayName,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    exitCode: run.exitCode,
    signal: run.signal,
    message: run.message
  } satisfies AgentRun)
}

function inferDisplayName(command: string, displayName?: string): string {
  const trimmedDisplayName = displayName?.trim()

  if (trimmedDisplayName) {
    return trimmedDisplayName
  }

  const firstToken = command.trim().split(/\s+/).at(0)
  return firstToken || 'agent'
}

function completeRun(run: AgentRunRecord, exitCode: number, signal?: number): void {
  clearCompletionTimer(run)
  run.exitCode = exitCode
  run.signal = signal
  run.finishedAt = new Date().toISOString()
  run.status = exitCode === 0 ? 'done' : 'error'
  run.awaitingResponse = false
  run.sawOutputSincePrompt = false
  run.message =
    exitCode === 0 ? 'Agent completed successfully.' : `Agent exited with code ${exitCode}.`
  publishUpdate(run)
  agentRunsBySession.delete(run.sessionId)
}

function clearCompletionTimer(run: AgentRunRecord): void {
  if (!run.completionTimer) {
    return
  }

  clearTimeout(run.completionTimer)
  run.completionTimer = undefined
}

function markRunWaiting(run: AgentRunRecord): void {
  clearCompletionTimer(run)

  if (run.status === 'waiting') {
    return
  }

  run.status = 'waiting'
  run.message = 'Agent appears to be waiting for input.'
  publishUpdate(run)
}

function markRunRunning(run: AgentRunRecord): void {
  if (run.status === 'running') {
    return
  }

  run.status = 'running'
  run.message = 'Agent is working.'
  publishUpdate(run)
}

function markRunCompleted(run: AgentRunRecord): void {
  clearCompletionTimer(run)

  run.status = 'done'
  run.awaitingResponse = false
  run.sawOutputSincePrompt = false
  run.finishedAt = new Date().toISOString()
  run.message = 'Agent completed its latest response.'
  publishUpdate(run)
}

function scheduleCompletion(run: AgentRunRecord): void {
  clearCompletionTimer(run)

  run.completionTimer = setTimeout(() => {
    const currentRun = agentRunsBySession.get(run.sessionId)
    if (
      !currentRun ||
      currentRun.runId !== run.runId ||
      !currentRun.awaitingResponse ||
      !currentRun.sawOutputSincePrompt
    ) {
      return
    }

    currentRun.completionTimer = undefined
    markRunCompleted(currentRun)
  }, COMPLETE_AFTER_QUIET_MS)
}

function beginUserTurn(run: AgentRunRecord): void {
  clearCompletionTimer(run)
  run.awaitingResponse = true
  run.sawOutputSincePrompt = false
  run.finishedAt = undefined
  run.exitCode = undefined
  run.signal = undefined
  markRunRunning(run)
}

function appendInput(run: AgentRunRecord, chunk: string): void {
  for (const char of chunk) {
    if (char === '\u007f' || char === '\b') {
      run.currentInputLine = run.currentInputLine.slice(0, -1)
      continue
    }

    if (char === '\r' || char === '\n') {
      if (run.currentInputLine.trim()) {
        beginUserTurn(run)
      }
      run.currentInputLine = ''
      continue
    }

    if (char < ' ' || char === '\u001b') {
      continue
    }

    run.currentInputLine = `${run.currentInputLine}${char}`.slice(-400)
  }
}

async function startAgentRun(
  event: IpcMainInvokeEvent,
  payload: AgentStartPayload
): Promise<AgentRun> {
  const command = payload.command.trim()

  if (!command) {
    throw new Error('A command is required to start an agent.')
  }

  const activeRun = agentRunsBySession.get(payload.sessionId)

  if (activeRun && (activeRun.status === 'running' || activeRun.status === 'waiting')) {
    throw new Error('This terminal already has an active agent run.')
  }

  const nextRun: AgentRunRecord = {
    runId: randomUUID(),
    sessionId: payload.sessionId,
    workspacePath: payload.workspacePath,
    command,
    displayName: inferDisplayName(command, payload.displayName),
    status: 'idle',
    startedAt: new Date().toISOString(),
    ownerId: event.sender.id,
    recentOutput: '',
    message: 'Agent is ready.',
    currentInputLine: '',
    awaitingResponse: false,
    sawOutputSincePrompt: false
  }

  agentRunsBySession.set(payload.sessionId, nextRun)
  publishUpdate(nextRun)
  return nextRun
}

export function handleAgentTerminalInput(sessionId: string, ownerId: number, data: string): void {
  const run = agentRunsBySession.get(sessionId)

  if (!run || run.ownerId !== ownerId) {
    return
  }

  appendInput(run, data)
}

export function handleAgentTerminalData(sessionId: string, ownerId: number, data: string): void {
  const run = agentRunsBySession.get(sessionId)

  if (!run || run.ownerId !== ownerId) {
    return
  }

  run.recentOutput = `${run.recentOutput}${data}`.slice(-4000)

  if (run.awaitingResponse && WAITING_PATTERNS.some((pattern) => pattern.test(data))) {
    markRunWaiting(run)
    return
  }

  if (run.awaitingResponse && data.trim()) {
    run.sawOutputSincePrompt = true
    markRunRunning(run)
    scheduleCompletion(run)
  }
}

export function handleAgentTerminalExit(
  sessionId: string,
  ownerId: number,
  exitCode: number,
  signal?: number
): void {
  const run = agentRunsBySession.get(sessionId)

  if (!run || run.ownerId !== ownerId) {
    return
  }

  completeRun(run, exitCode, signal)
}

export function registerAgentIpc(): void {
  ipcMain.handle(harmonyChannels.startAgent, (event, payload: AgentStartPayload) =>
    startAgentRun(event, payload)
  )
}

export function disposeAgentRuns(): void {
  agentRunsBySession.clear()
}
