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
const EXIT_MARKER_PREFIX = '__HARMONY_AGENT_EXIT__'

type AgentRunRecord = AgentRun & {
  ownerId: number
  recentOutput: string
}

const agentRunsBySession = new Map<string, AgentRunRecord>()

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

function buildWrappedCommand(runId: string, command: string): string {
  return `{ ${command.trim()}; }\r__harmony_agent_exit_code=$?\rprintf '\\n${EXIT_MARKER_PREFIX}:${runId}:%s\\n' "$__harmony_agent_exit_code"\r`
}

function completeRun(run: AgentRunRecord, exitCode: number, signal?: number): void {
  run.exitCode = exitCode
  run.signal = signal
  run.finishedAt = new Date().toISOString()
  run.status = exitCode === 0 ? 'done' : 'error'
  run.message =
    exitCode === 0 ? 'Agent completed successfully.' : `Agent exited with code ${exitCode}.`
  publishUpdate(run)
  agentRunsBySession.delete(run.sessionId)
}

function markRunWaiting(run: AgentRunRecord): void {
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
  run.message = 'Agent is running.'
  publishUpdate(run)
}

async function startAgentRun(
  event: IpcMainInvokeEvent,
  payload: AgentStartPayload,
  writeToTerminal: (ownerId: number, sessionId: string, data: string) => boolean
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
    status: 'running',
    startedAt: new Date().toISOString(),
    ownerId: event.sender.id,
    recentOutput: '',
    message: 'Agent started.'
  }

  const didWrite = writeToTerminal(
    event.sender.id,
    payload.sessionId,
    buildWrappedCommand(nextRun.runId, command)
  )

  if (!didWrite) {
    throw new Error('Unable to find the target terminal session.')
  }

  agentRunsBySession.set(payload.sessionId, nextRun)
  publishUpdate(nextRun)
  return nextRun
}

export function handleAgentTerminalData(sessionId: string, ownerId: number, data: string): void {
  const run = agentRunsBySession.get(sessionId)

  if (!run || run.ownerId !== ownerId) {
    return
  }

  run.recentOutput = `${run.recentOutput}${data}`.slice(-4000)

  const exitMatch = run.recentOutput.match(
    new RegExp(`${EXIT_MARKER_PREFIX}:${run.runId}:(\\d+)`, 'i')
  )

  if (exitMatch) {
    completeRun(run, Number(exitMatch[1]))
    return
  }

  if (WAITING_PATTERNS.some((pattern) => pattern.test(data))) {
    markRunWaiting(run)
    return
  }

  if (data.trim()) {
    markRunRunning(run)
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

  run.finishedAt = new Date().toISOString()
  run.exitCode = exitCode
  run.signal = signal
  run.status = 'error'
  run.message = 'Terminal session closed before the agent completed.'
  publishUpdate(run)
  agentRunsBySession.delete(sessionId)
}

export function registerAgentIpc(
  writeToTerminal: (ownerId: number, sessionId: string, data: string) => boolean
): void {
  ipcMain.handle(harmonyChannels.startAgent, (event, payload: AgentStartPayload) =>
    startAgentRun(event, payload, writeToTerminal)
  )
}

export function disposeAgentRuns(): void {
  agentRunsBySession.clear()
}
