import { randomUUID } from 'node:crypto'
import { ipcMain, type IpcMainInvokeEvent, webContents } from 'electron'
import type { AgentRestorePayload, AgentRun, AgentStartPayload } from '../shared/workbench'
import { harmonyChannels } from '../shared/workbench'
import { updateTerminalDaemonSessionMetadata } from './terminalDaemonManager'

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

function toPublicAgentRun(run: AgentRunRecord): AgentRun {
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    workspacePath: run.workspacePath,
    command: run.command,
    displayName: run.displayName,
    externalSessionId: run.externalSessionId,
    suggestedTitle: run.suggestedTitle,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    exitCode: run.exitCode,
    signal: run.signal,
    message: run.message
  }
}

function publishUpdate(run: AgentRunRecord): void {
  void syncAgentRunToDaemon(run)

  const target = webContents.fromId(run.ownerId)

  if (!target || target.isDestroyed()) {
    return
  }

  target.send(harmonyChannels.agentUpdate, toPublicAgentRun(run))
}

function toDaemonStatus(status: AgentRun['status']): 'working' | 'waiting' | 'completed' | 'failed' {
  switch (status) {
    case 'waiting':
      return 'waiting'
    case 'done':
      return 'completed'
    case 'error':
      return 'failed'
    default:
      return 'working'
  }
}

function inferAgentId(run: AgentRunRecord): string | undefined {
  const kind = inferAgentKind(run)
  if (kind) {
    return kind
  }

  const command = run.command.toLowerCase()
  if (command.startsWith('claude')) {
    return 'claude'
  }
  if (command.startsWith('gemini')) {
    return 'gemini'
  }
  if (command.startsWith('agent')) {
    return 'cursor'
  }
  return undefined
}

async function syncAgentRunToDaemon(run: AgentRunRecord): Promise<void> {
  await updateTerminalDaemonSessionMetadata(run.sessionId, {
    kind: 'agent',
    status: toDaemonStatus(run.status),
    agentId: inferAgentId(run),
    command: run.command,
    externalSessionId: run.externalSessionId,
    title: run.suggestedTitle ?? run.displayName,
    lastKnownExitCode: run.exitCode,
    agentRun: {
      runId: run.runId,
      sessionId: run.sessionId,
      workspacePath: run.workspacePath,
      command: run.command,
      displayName: run.displayName,
      externalSessionId: run.externalSessionId,
      suggestedTitle: run.suggestedTitle,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      exitCode: run.exitCode,
      signal: run.signal,
      message: run.message
    }
  }).catch(() => {
    /* daemon metadata sync is best effort */
  })
}

function inferAgentKind(
  run: AgentRunRecord
): 'codex' | 'opencode' | 'cursor' | 'claude' | 'gemini' | null {
  const command = run.command.toLowerCase()
  const displayName = run.displayName.toLowerCase()
  if (command.startsWith('codex') || displayName.includes('codex')) {
    return 'codex'
  }
  if (command.startsWith('opencode') || displayName.includes('opencode')) {
    return 'opencode'
  }
  if (command.startsWith('agent') || displayName.includes('cursor')) {
    return 'cursor'
  }
  if (command.startsWith('claude') || displayName.includes('claude')) {
    return 'claude'
  }
  if (command.startsWith('gemini') || displayName.includes('gemini')) {
    return 'gemini'
  }
  return null
}

function extractExternalSessionId(run: AgentRunRecord, data: string): string | null {
  const kind = inferAgentKind(run)
  if (!kind) {
    return null
  }

  if (kind === 'opencode') {
    const match = data.match(/\bses_[A-Za-z0-9]+\b/)
    return match?.[0] ?? null
  }

  if (kind === 'cursor') {
    const cursorMatch = data.match(/\bchat_[A-Za-z0-9_-]+\b/)
    if (cursorMatch?.[0]) {
      return cursorMatch[0]
    }
  }

  const genericSessionMatch = data.match(/\bsession(?:\s+id)?\s*[:=]\s*([A-Za-z0-9._:-]{8,})\b/i)
  if (genericSessionMatch?.[1]) {
    return genericSessionMatch[1]
  }

  const uuidMatch = data.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i)
  return uuidMatch?.[0] ?? null
}

function inferDisplayName(command: string, displayName?: string): string {
  const trimmedDisplayName = displayName?.trim()

  if (trimmedDisplayName) {
    return trimmedDisplayName
  }

  const firstToken = command.trim().split(/\s+/).at(0)
  return firstToken || 'agent'
}

function createAgentRunRecord(
  ownerId: number,
  payload: AgentStartPayload | AgentRestorePayload,
  options?: {
    runId?: string
    externalSessionId?: string
    suggestedTitle?: string
    status?: AgentRun['status']
    startedAt?: string
    finishedAt?: string
    exitCode?: number
    signal?: number
    message?: string
    awaitingResponse?: boolean
    sawOutputSincePrompt?: boolean
  }
): AgentRunRecord {
  return {
    runId: options?.runId ?? randomUUID(),
    sessionId: payload.sessionId,
    workspacePath: payload.workspacePath,
    command: payload.command.trim(),
    displayName: inferDisplayName(payload.command, payload.displayName),
    externalSessionId: options?.externalSessionId,
    suggestedTitle: options?.suggestedTitle ?? payload.suggestedTitle,
    status: options?.status ?? 'running',
    startedAt: options?.startedAt ?? new Date().toISOString(),
    finishedAt: options?.finishedAt,
    exitCode: options?.exitCode,
    signal: options?.signal,
    ownerId,
    recentOutput: '',
    message: options?.message ?? 'Agent is starting.',
    currentInputLine: '',
    awaitingResponse: options?.awaitingResponse ?? true,
    sawOutputSincePrompt: options?.sawOutputSincePrompt ?? false
  }
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

  const nextRun = createAgentRunRecord(event.sender.id, payload, {
    status: 'running',
    message: 'Agent is starting.',
    awaitingResponse: true,
    sawOutputSincePrompt: false
  })

  agentRunsBySession.set(payload.sessionId, nextRun)
  publishUpdate(nextRun)
  return toPublicAgentRun(nextRun)
}

async function restoreAgentRun(
  event: IpcMainInvokeEvent,
  payload: AgentRestorePayload
): Promise<AgentRun> {
  const command = payload.command.trim()

  if (!command) {
    throw new Error('A command is required to restore an agent run.')
  }

  const existingRun = agentRunsBySession.get(payload.sessionId)
  if (existingRun) {
    return toPublicAgentRun(existingRun)
  }

  const status = payload.status ?? 'running'
  const restoredRun = createAgentRunRecord(event.sender.id, payload, {
    externalSessionId: payload.externalSessionId,
    suggestedTitle: payload.suggestedTitle,
    status,
    startedAt: payload.startedAt,
    finishedAt: payload.finishedAt,
    exitCode: payload.exitCode,
    signal: payload.signal,
    message:
      payload.message ??
      (status === 'done'
        ? 'Restored completed agent session.'
        : status === 'waiting'
          ? 'Restored agent session waiting for input.'
          : 'Restored agent session.'),
    awaitingResponse: status === 'running' || status === 'waiting',
    sawOutputSincePrompt: status === 'running'
  })

  agentRunsBySession.set(payload.sessionId, restoredRun)
  publishUpdate(restoredRun)
  return toPublicAgentRun(restoredRun)
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

  const hasVisibleOutput = data.trim().length > 0

  run.recentOutput = `${run.recentOutput}${data}`.slice(-4000)

  if (!run.externalSessionId) {
    const externalSessionId = extractExternalSessionId(run, data)
    if (externalSessionId) {
      run.externalSessionId = externalSessionId
      publishUpdate(run)
    }
  }

  // Once a run is marked done, keep it done until the user starts a new turn.
  // Interactive agent CLIs often print a prompt or minor tail output after the
  // final response, and treating that as fresh work makes the sidebar status
  // bounce back to "running" even though the response already completed.
  if (run.status === 'done') {
    return
  }

  if (run.awaitingResponse && WAITING_PATTERNS.some((pattern) => pattern.test(data))) {
    markRunWaiting(run)
    return
  }

  if (run.awaitingResponse && hasVisibleOutput) {
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
  ipcMain.handle(harmonyChannels.restoreAgent, (event, payload: AgentRestorePayload) =>
    restoreAgentRun(event, payload)
  )
}

export function disposeAgentRuns(): void {
  agentRunsBySession.clear()
}
