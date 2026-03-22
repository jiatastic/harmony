import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { AgentRun } from '../shared/workbench'
import type { TerminalDaemonSessionRecord, TerminalDaemonSessionStatus } from '../shared/terminalDaemon'

type SessionRegistryEnvelope = {
  cleanShutdown: boolean
  sessions: TerminalDaemonSessionRecord[]
}

type SessionRegistryUpsertOptions = {
  defer?: boolean
}

function emptyEnvelope(): SessionRegistryEnvelope {
  return {
    cleanShutdown: true,
    sessions: []
  }
}

function normalizeStatus(value: string | undefined): TerminalDaemonSessionStatus {
  switch (value) {
    case 'restoring':
    case 'ready':
    case 'working':
    case 'waiting':
    case 'completed':
    case 'disconnected':
    case 'failed':
    case 'exited':
      return value
    default:
      return 'disconnected'
  }
}

function normalizeSessionRecord(value: unknown): TerminalDaemonSessionRecord | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const candidate = value as Partial<TerminalDaemonSessionRecord>
  if (
    typeof candidate.sessionId !== 'string' ||
    typeof candidate.kind !== 'string' ||
    typeof candidate.workspacePath !== 'string' ||
    typeof candidate.cwd !== 'string' ||
    typeof candidate.createdAt !== 'string' ||
    typeof candidate.updatedAt !== 'string' ||
    typeof candidate.title !== 'string'
  ) {
    return null
  }

  return {
    sessionId: candidate.sessionId,
    sessionKey: typeof candidate.sessionKey === 'string' ? candidate.sessionKey : undefined,
    persistentId: typeof candidate.persistentId === 'string' ? candidate.persistentId : undefined,
    kind: candidate.kind === 'agent' ? 'agent' : 'shell',
    workspacePath: candidate.workspacePath,
    cwd: candidate.cwd,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    status: normalizeStatus(candidate.status),
    shell: typeof candidate.shell === 'string' ? candidate.shell : undefined,
    agentId: typeof candidate.agentId === 'string' ? candidate.agentId : undefined,
    command: typeof candidate.command === 'string' ? candidate.command : undefined,
    externalSessionId:
      typeof candidate.externalSessionId === 'string' ? candidate.externalSessionId : undefined,
    title: candidate.title,
    lastKnownExitCode:
      typeof candidate.lastKnownExitCode === 'number' ? candidate.lastKnownExitCode : undefined,
    agentRun: normalizeAgentRun(candidate.agentRun),
    recentOutput: typeof candidate.recentOutput === 'string' ? candidate.recentOutput : undefined
  }
}

function normalizeAgentRun(value: unknown): AgentRun | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const candidate = value as Partial<AgentRun>
  if (
    typeof candidate.runId !== 'string' ||
    typeof candidate.sessionId !== 'string' ||
    typeof candidate.workspacePath !== 'string' ||
    typeof candidate.command !== 'string' ||
    typeof candidate.displayName !== 'string' ||
    typeof candidate.status !== 'string' ||
    typeof candidate.startedAt !== 'string'
  ) {
    return undefined
  }

  return {
    runId: candidate.runId,
    sessionId: candidate.sessionId,
    workspacePath: candidate.workspacePath,
    command: candidate.command,
    displayName: candidate.displayName,
    externalSessionId:
      typeof candidate.externalSessionId === 'string' ? candidate.externalSessionId : undefined,
    suggestedTitle:
      typeof candidate.suggestedTitle === 'string' ? candidate.suggestedTitle : undefined,
    status:
      candidate.status === 'idle' ||
      candidate.status === 'running' ||
      candidate.status === 'waiting' ||
      candidate.status === 'done' ||
      candidate.status === 'error'
        ? candidate.status
        : 'running',
    startedAt: candidate.startedAt,
    finishedAt: typeof candidate.finishedAt === 'string' ? candidate.finishedAt : undefined,
    exitCode: typeof candidate.exitCode === 'number' ? candidate.exitCode : undefined,
    signal: typeof candidate.signal === 'number' ? candidate.signal : undefined,
    message: typeof candidate.message === 'string' ? candidate.message : undefined
  }
}

function normalizeEnvelope(value: unknown): SessionRegistryEnvelope {
  if (!value || typeof value !== 'object') {
    return emptyEnvelope()
  }

  const candidate = value as Partial<SessionRegistryEnvelope>
  const sessions = Array.isArray(candidate.sessions)
    ? candidate.sessions
        .map((session) => normalizeSessionRecord(session))
        .filter((session): session is TerminalDaemonSessionRecord => session !== null)
    : []

  return {
    cleanShutdown: candidate.cleanShutdown !== false,
    sessions
  }
}

function markSessionRecovered(session: TerminalDaemonSessionRecord): TerminalDaemonSessionRecord {
  if (session.status === 'completed' || session.status === 'failed' || session.status === 'exited') {
    return session
  }

  return {
    ...session,
    status: 'disconnected',
    updatedAt: new Date().toISOString()
  }
}

function stableSessionIdentity(session: TerminalDaemonSessionRecord): string {
  return session.sessionKey || session.persistentId || session.sessionId
}

function sessionStatusPriority(status: TerminalDaemonSessionStatus): number {
  switch (status) {
    case 'working':
      return 7
    case 'waiting':
      return 6
    case 'ready':
      return 5
    case 'restoring':
      return 4
    case 'disconnected':
      return 3
    case 'completed':
    case 'exited':
      return 2
    case 'failed':
      return 1
  }
}

function choosePreferredSessionRecord(
  left: TerminalDaemonSessionRecord,
  right: TerminalDaemonSessionRecord
): TerminalDaemonSessionRecord {
  const priorityDiff = sessionStatusPriority(right.status) - sessionStatusPriority(left.status)
  if (priorityDiff !== 0) {
    return priorityDiff > 0 ? right : left
  }

  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt < right.updatedAt ? right : left
  }

  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? right : left
  }

  if (!left.agentRun && right.agentRun) {
    return right
  }

  return left
}

function compactSessions(
  sessions: Iterable<TerminalDaemonSessionRecord>
): TerminalDaemonSessionRecord[] {
  const deduped = new Map<string, TerminalDaemonSessionRecord>()

  for (const session of sessions) {
    const identity = stableSessionIdentity(session)
    const existing = deduped.get(identity)
    deduped.set(identity, existing ? choosePreferredSessionRecord(existing, session) : session)
  }

  return Array.from(deduped.values())
}

function shouldHydrateSessionRecord(session: TerminalDaemonSessionRecord): boolean {
  if (session.kind === 'agent') {
    return true
  }

  // Plain shell PTYs cannot be reattached after the daemon process restarts,
  // but tmux-backed shells can be re-created from their persistent identity.
  return typeof session.persistentId === 'string' && session.persistentId.trim().length > 0
}

export class SessionRegistry {
  private readonly sessions = new Map<string, TerminalDaemonSessionRecord>()
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private persistQueue = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    const raw = await fs.readFile(this.filePath, 'utf8').catch(() => '')
    let parsed = emptyEnvelope()

    if (raw) {
      try {
        parsed = normalizeEnvelope(JSON.parse(raw) as unknown)
      } catch {
        parsed = emptyEnvelope()
      }
    }

    const sessions = compactSessions(
      parsed.cleanShutdown ? parsed.sessions : parsed.sessions.map(markSessionRecovered)
    ).filter(shouldHydrateSessionRecord)

    this.sessions.clear()
    for (const session of sessions) {
      this.sessions.set(session.sessionId, session)
    }

    await this.persist(false)
  }

  list(): TerminalDaemonSessionRecord[] {
    return Array.from(this.sessions.values()).sort((left, right) =>
      left.updatedAt < right.updatedAt ? 1 : -1
    )
  }

  listSessionsByKey(sessionKey: string): TerminalDaemonSessionRecord[] {
    const normalized = sessionKey.trim()
    if (!normalized) {
      return []
    }

    return this.list().filter((session) => session.sessionId === normalized || session.sessionKey === normalized)
  }

  get(sessionId: string): TerminalDaemonSessionRecord | null {
    return this.sessions.get(sessionId) ?? null
  }

  async upsert(
    session: TerminalDaemonSessionRecord,
    options?: SessionRegistryUpsertOptions
  ): Promise<TerminalDaemonSessionRecord> {
    const identity = stableSessionIdentity(session)
    for (const existing of this.sessions.values()) {
      if (existing.sessionId !== session.sessionId && stableSessionIdentity(existing) === identity) {
        this.sessions.delete(existing.sessionId)
      }
    }

    const nextSession = {
      ...session,
      updatedAt: session.updatedAt || new Date().toISOString()
    }

    this.sessions.set(session.sessionId, nextSession)

    if (options?.defer) {
      this.schedulePersist()
      return nextSession
    }

    await this.persist(false)
    return nextSession
  }

  async destroy(sessionId: string): Promise<boolean> {
    const removed = this.sessions.delete(sessionId)
    if (removed) {
      await this.persist(false)
    }
    return removed
  }

  async markCleanShutdown(): Promise<void> {
    await this.persist(true)
  }

  private schedulePersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
    }

    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.persist(false)
    }, 150)
  }

  private async persist(cleanShutdown: boolean): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }

    this.persistQueue = this.persistQueue
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(dirname(this.filePath), { recursive: true })
        await fs.writeFile(
          this.filePath,
          JSON.stringify({
            cleanShutdown,
            sessions: compactSessions(this.list())
          } satisfies SessionRegistryEnvelope),
          'utf8'
        )
      })

    await this.persistQueue
  }
}
