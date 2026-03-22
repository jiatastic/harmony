import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Socket } from 'node:net'
import type { TerminalLifecycleState, TerminalSession, CreateTerminalPayload } from '../shared/workbench'
import type {
  TerminalDaemonEvent,
  TerminalDaemonSessionPatch,
  TerminalDaemonSessionRecord
} from '../shared/terminalDaemon'
import {
  createLocalProcess,
  destroyLocalPersistentSession,
  type TerminalProcessHandle
} from '../main/terminalRuntime'
import { SessionRegistry } from './sessionRegistry'

type HostedTerminalRecord = {
  sessionId: string
  sessionKey?: string
  persistentId?: string
  cwd: string
  shell: string
  state: TerminalLifecycleState
  restored: boolean
  exitCode?: number
  signal?: number
  process: TerminalProcessHandle
  recentOutput: string
  subscribers: Set<Socket>
}

const RECENT_OUTPUT_LIMIT = 200_000

function normalizeSessionKey(value: string | undefined): string | null {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

function normalizePersistentId(value: string | undefined): string | null {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

function toTerminalSession(record: HostedTerminalRecord, restoredOverride?: boolean): TerminalSession {
  return {
    sessionId: record.sessionId,
    cwd: record.cwd,
    shell: record.shell,
    state: record.state,
    attached: record.subscribers.size > 0,
    restored: restoredOverride ?? record.restored,
    exitCode: record.exitCode,
    signal: record.signal
  }
}

function toRegistryStatus(state: TerminalLifecycleState): TerminalDaemonSessionRecord['status'] {
  switch (state) {
    case 'running':
      return 'ready'
    case 'exited':
      return 'exited'
    case 'destroyed':
      return 'failed'
  }
}

export class TerminalSessionHost {
  private readonly sessions = new Map<string, HostedTerminalRecord>()
  private readonly sessionKeys = new Map<string, string>()

  constructor(private readonly registry: SessionRegistry) {}

  listSessions(): TerminalDaemonSessionRecord[] {
    return this.registry.list()
  }

  getSession(sessionId: string): TerminalSession | null {
    const record = this.sessions.get(sessionId)
    return record ? toTerminalSession(record) : null
  }

  async createOrAttach(
    payload: CreateTerminalPayload
  ): Promise<{ session: TerminalSession }> {
    if (!payload.cwd?.trim()) {
      throw new Error('A worktree path is required to create a terminal.')
    }

    const cwd = resolve(payload.cwd)
    const sessionKey = normalizeSessionKey(payload.sessionKey)
    const persistentId = normalizePersistentId(payload.persistentId)

    if (sessionKey) {
      const existingSessionId = this.sessionKeys.get(sessionKey)
      const existing = existingSessionId ? this.sessions.get(existingSessionId) : null
      if (existing) {
        // Reusing a detached tmux-backed shell only replays the stale raw output
        // buffer, which can leave the renderer on an empty alternate screen.
        // Recreate the attach process so tmux paints the current live screen.
        if (existing.persistentId && existing.subscribers.size === 0) {
          await this.destroy(existing.sessionId)
        } else {
        return {
          session: toTerminalSession(existing, true)
        }
        }
      }
    }

    await this.clearConflictingRegistrySessions(sessionKey, persistentId)

    const sessionId = randomUUID()
    const { process, shellLabel, restored } = createLocalProcess(payload, cwd)
    const record: HostedTerminalRecord = {
      sessionId,
      sessionKey: sessionKey ?? undefined,
      persistentId: persistentId ?? undefined,
      cwd,
      shell: shellLabel,
      state: 'running',
      restored,
      process,
      recentOutput: '',
      subscribers: new Set()
    }

    process.onData((data) => {
      record.recentOutput = `${record.recentOutput}${data}`.slice(-RECENT_OUTPUT_LIMIT)
      void this.registry.upsert(this.toRegistryRecord(record), { defer: true })
      this.broadcast(record, {
        type: 'terminal.data',
        sessionId: record.sessionId,
        sessionKey: record.sessionKey,
        data
      })
    })

    process.onExit(({ exitCode, signal }) => {
      if (record.state === 'destroyed') {
        this.cleanupRecord(record)
        return
      }

      record.state = 'exited'
      record.exitCode = exitCode
      record.signal = signal
      void this.registry.upsert(this.toRegistryRecord(record))
      this.broadcast(record, {
        type: 'terminal.exit',
        sessionId: record.sessionId,
        sessionKey: record.sessionKey,
        exitCode,
        signal
      })
    })

    this.sessions.set(sessionId, record)
    if (record.sessionKey) {
      this.sessionKeys.set(record.sessionKey, sessionId)
    }

    await this.registry.upsert(this.toRegistryRecord(record))

    return {
      session: toTerminalSession(record)
    }
  }

  async write(sessionId: string, data: string): Promise<boolean> {
    const record = this.sessions.get(sessionId)
    if (!record || record.state !== 'running') {
      return false
    }

    record.process.write(data)
    return true
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<boolean> {
    const record = this.sessions.get(sessionId)
    if (!record || record.state !== 'running' || cols <= 0 || rows <= 0) {
      return false
    }

    record.process.resize(cols, rows)
    return true
  }

  async detach(socket: Socket, sessionId: string): Promise<TerminalSession | null> {
    const record = this.sessions.get(sessionId)
    if (!record) {
      return null
    }

    this.detachSocket(record, socket)
    const snapshot = toTerminalSession(record)
    this.cleanupIfInactive(record)
    return snapshot
  }

  async destroy(sessionId: string): Promise<boolean> {
    const record = this.sessions.get(sessionId)
    if (!record) {
      return false
    }

    record.state = 'destroyed'
    if (record.process.pid > 0) {
      record.process.kill()
    }
    this.cleanupRecord(record)
    await this.registry.destroy(sessionId)
    return true
  }

  async destroyPersistentSession(persistentId: string): Promise<void> {
    const normalized = normalizePersistentId(persistentId)
    if (!normalized) {
      return
    }

    for (const record of this.sessions.values()) {
      if (record.persistentId === normalized) {
        await this.destroy(record.sessionId)
      }
    }

    destroyLocalPersistentSession(normalized)
  }

  handleSocketClosed(socket: Socket): void {
    for (const record of this.sessions.values()) {
      this.detachSocket(record, socket)
      this.cleanupIfInactive(record)
    }
  }

  private broadcast(record: HostedTerminalRecord, event: TerminalDaemonEvent): void {
    const payload = `${JSON.stringify(event)}\n`
    for (const socket of record.subscribers) {
      if (!socket.destroyed) {
        socket.write(payload)
      }
    }
  }

  private attachSocket(record: HostedTerminalRecord, socket: Socket): void {
    record.subscribers.add(socket)
  }

  subscribe(sessionId: string, socket: Socket): string | undefined {
    const record = this.sessions.get(sessionId)
    if (!record) {
      return undefined
    }

    this.attachSocket(record, socket)
    return record.recentOutput || undefined
  }

  async updateSessionMetadata(
    sessionId: string,
    patch: TerminalDaemonSessionPatch
  ): Promise<TerminalDaemonSessionRecord> {
    const liveRecord = this.sessions.get(sessionId)
    const existing = this.registry.get(sessionId)
    const base =
      existing ??
      (liveRecord
        ? this.toRegistryRecord(liveRecord)
        : null)

    if (!base) {
      throw new Error(`Unknown terminal session: ${sessionId}`)
    }

    const nextRecord: TerminalDaemonSessionRecord = {
      ...base,
      ...patch,
      sessionId: base.sessionId,
      sessionKey: base.sessionKey,
      persistentId: base.persistentId,
      workspacePath: base.workspacePath,
      cwd: base.cwd,
      createdAt: base.createdAt,
      updatedAt: new Date().toISOString()
    }

    return await this.registry.upsert(nextRecord)
  }

  private detachSocket(record: HostedTerminalRecord, socket: Socket): void {
    record.subscribers.delete(socket)
  }

  private cleanupIfInactive(record: HostedTerminalRecord): void {
    if (record.state === 'running' || record.subscribers.size > 0) {
      return
    }

    this.cleanupRecord(record)
  }

  private cleanupRecord(record: HostedTerminalRecord): void {
    this.sessions.delete(record.sessionId)
    if (record.sessionKey) {
      this.sessionKeys.delete(record.sessionKey)
    }
  }

  private async clearConflictingRegistrySessions(
    sessionKey: string | null,
    persistentId: string | null
  ): Promise<void> {
    const conflicts = this.registry.list().filter((session) => {
      if (this.sessions.has(session.sessionId)) {
        return false
      }

      return (
        (sessionKey && session.sessionKey === sessionKey) ||
        (persistentId && session.persistentId === persistentId)
      )
    })

    for (const conflict of conflicts) {
      await this.registry.destroy(conflict.sessionId)
    }
  }

  private toRegistryRecord(record: HostedTerminalRecord): TerminalDaemonSessionRecord {
    const existing = this.registry.get(record.sessionId)
    const now = new Date().toISOString()
    return {
      sessionId: record.sessionId,
      sessionKey: record.sessionKey,
      persistentId: record.persistentId,
      kind: existing?.kind ?? 'shell',
      workspacePath: record.cwd,
      cwd: record.cwd,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      status:
        existing?.kind === 'agent' && record.state === 'running'
          ? existing.status
          : toRegistryStatus(record.state),
      shell: record.shell,
      agentId: existing?.agentId,
      command: existing?.command,
      externalSessionId: existing?.externalSessionId,
      title: existing?.title ?? record.shell,
      lastKnownExitCode: record.exitCode ?? existing?.lastKnownExitCode,
      agentRun: existing?.agentRun,
      recentOutput: record.recentOutput
    }
  }
}
