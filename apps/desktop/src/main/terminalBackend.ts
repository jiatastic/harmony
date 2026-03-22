import type { CreateTerminalPayload, TerminalSession } from '../shared/workbench'

export type TerminalBackendDataEvent = {
  sessionId: string
  sessionKey?: string
  data: string
}

export type TerminalBackendExitEvent = {
  sessionId: string
  exitCode: number
  signal?: number
}

export type CreateOrAttachTerminalOptions = {
  ownerId: number
  payload: CreateTerminalPayload
  onData(event: TerminalBackendDataEvent): void
  onExit(event: TerminalBackendExitEvent): void
}

export interface TerminalBackend {
  createOrAttach(options: CreateOrAttachTerminalOptions): Promise<TerminalSession>
  getSession(sessionId: string): TerminalSession | null
  write(sessionId: string, data: string): Promise<boolean>
  resize(sessionId: string, cols: number, rows: number): Promise<boolean>
  detach(sessionId: string): Promise<TerminalSession | null>
  destroy(sessionId: string): Promise<boolean>
  destroyPersistentSession(persistentId: string): Promise<void>
  dispose(): void
}
