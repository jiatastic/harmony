import type { AgentRun, CreateTerminalPayload, TerminalSession } from './workbench'

export type TerminalDaemonSessionKind = 'shell' | 'agent'

export type TerminalDaemonSessionStatus =
  | 'restoring'
  | 'ready'
  | 'working'
  | 'waiting'
  | 'completed'
  | 'disconnected'
  | 'failed'
  | 'exited'

export interface TerminalDaemonSessionRecord {
  sessionId: string
  sessionKey?: string
  persistentId?: string
  kind: TerminalDaemonSessionKind
  workspacePath: string
  cwd: string
  createdAt: string
  updatedAt: string
  status: TerminalDaemonSessionStatus
  shell?: string
  agentId?: string
  command?: string
  externalSessionId?: string
  title: string
  lastKnownExitCode?: number
  agentRun?: AgentRun
  recentOutput?: string
}

export interface TerminalDaemonSessionPatch {
  kind?: TerminalDaemonSessionKind
  status?: TerminalDaemonSessionStatus
  shell?: string
  agentId?: string
  command?: string
  externalSessionId?: string
  title?: string
  lastKnownExitCode?: number
  agentRun?: AgentRun
  recentOutput?: string
}

export type TerminalDaemonCommand =
  | {
      requestId: string
      type: 'system.ping'
    }
  | {
      requestId: string
      type: 'session.list'
    }
  | {
      requestId: string
      type: 'session.get'
      sessionId: string
    }
  | {
      requestId: string
      type: 'session.createOrAttach'
      payload: CreateTerminalPayload
    }
  | {
      requestId: string
      type: 'session.subscribe'
      sessionId: string
    }
  | {
      requestId: string
      type: 'session.updateMetadata'
      sessionId: string
      patch: TerminalDaemonSessionPatch
    }
  | {
      requestId: string
      type: 'session.write'
      sessionId: string
      data: string
    }
  | {
      requestId: string
      type: 'session.resize'
      sessionId: string
      cols: number
      rows: number
    }
  | {
      requestId: string
      type: 'session.detach'
      sessionId: string
    }
  | {
      requestId: string
      type: 'session.destroy'
      sessionId: string
    }
  | {
      requestId: string
      type: 'session.destroyPersistent'
      persistentId: string
    }

export type TerminalDaemonCommandPayload<TType extends TerminalDaemonCommand['type']> = Omit<
  Extract<TerminalDaemonCommand, { type: TType }>,
  'requestId'
>

export type TerminalDaemonSuccessResponse =
  | {
      requestId: string
      ok: true
      type: 'system.pong'
      pid: number
      daemonVersion: number
    }
  | {
      requestId: string
      ok: true
      type: 'session.list.result'
      sessions: TerminalDaemonSessionRecord[]
    }
  | {
      requestId: string
      ok: true
      type: 'session.get.result'
      session: TerminalSession | null
    }
  | {
      requestId: string
      ok: true
      type: 'session.createOrAttach.result'
      session: TerminalSession
    }
  | {
      requestId: string
      ok: true
      type: 'session.subscribe.result'
      snapshot?: string
    }
  | {
      requestId: string
      ok: true
      type: 'session.updateMetadata.result'
      session: TerminalDaemonSessionRecord
    }
  | {
      requestId: string
      ok: true
      type: 'session.write.result'
      accepted: boolean
    }
  | {
      requestId: string
      ok: true
      type: 'session.resize.result'
      accepted: boolean
    }
  | {
      requestId: string
      ok: true
      type: 'session.detach.result'
      session: TerminalSession | null
    }
  | {
      requestId: string
      ok: true
      type: 'session.destroy.result'
      removed: boolean
    }
  | {
      requestId: string
      ok: true
      type: 'session.destroyPersistent.result'
    }

export type TerminalDaemonErrorResponse = {
  requestId: string
  ok: false
  error: {
    code: string
    message: string
  }
}

export type TerminalDaemonResponse =
  | TerminalDaemonSuccessResponse
  | TerminalDaemonErrorResponse

export type TerminalDaemonEvent =
  | {
      type: 'terminal.data'
      sessionId: string
      sessionKey?: string
      data: string
    }
  | {
      type: 'terminal.exit'
      sessionId: string
      sessionKey?: string
      exitCode: number
      signal?: number
    }

export const TERMINAL_DAEMON_PROTOCOL_VERSION = 1

export function isTerminalDaemonCommand(value: unknown): value is TerminalDaemonCommand {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<TerminalDaemonCommand>
  return typeof candidate.requestId === 'string' && typeof candidate.type === 'string'
}

export function isTerminalDaemonEvent(value: unknown): value is TerminalDaemonEvent {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<TerminalDaemonEvent>
  return (
    typeof candidate.type === 'string' &&
    typeof candidate.sessionId === 'string' &&
    (candidate.type === 'terminal.data' || candidate.type === 'terminal.exit')
  )
}
