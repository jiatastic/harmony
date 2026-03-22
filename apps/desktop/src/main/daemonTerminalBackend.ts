import type { TerminalSession } from '../shared/workbench'
import type {
  TerminalDaemonEvent,
  TerminalDaemonSuccessResponse
} from '../shared/terminalDaemon'
import type {
  CreateOrAttachTerminalOptions,
  TerminalBackend
} from './terminalBackend'
import { TerminalDaemonConnection } from './terminalDaemonClient'

type SessionListeners = {
  onData(data: string, sessionKey?: string): void
  onExit(exitCode: number, signal?: number): void
}

export class DaemonTerminalBackend implements TerminalBackend {
  private readonly connection: TerminalDaemonConnection
  private readonly sessions = new Map<string, TerminalSession>()
  private readonly listeners = new Map<string, SessionListeners>()

  constructor(socketPath: string) {
    this.connection = new TerminalDaemonConnection(socketPath)
    this.connection.onEvent((event) => {
      this.handleEvent(event)
    })
  }

  async createOrAttach(options: CreateOrAttachTerminalOptions): Promise<TerminalSession> {
    const response = await this.connection.request<
      Extract<TerminalDaemonSuccessResponse, { type: 'session.createOrAttach.result' }>,
      'session.createOrAttach'
    >({
      type: 'session.createOrAttach',
      payload: options.payload
    })

    this.sessions.set(response.session.sessionId, response.session)
    this.listeners.set(response.session.sessionId, {
      onData: (data, sessionKey) => {
        options.onData({ sessionId: response.session.sessionId, sessionKey, data })
      },
      onExit: (exitCode, signal) => {
        options.onExit({ sessionId: response.session.sessionId, exitCode, signal })
      }
    })

    const subscribeResponse = await this.connection.request<
      Extract<TerminalDaemonSuccessResponse, { type: 'session.subscribe.result' }>,
      'session.subscribe'
    >({
      type: 'session.subscribe',
      sessionId: response.session.sessionId
    })

    return {
      ...response.session,
      snapshot: subscribeResponse.snapshot
    }
  }

  getSession(sessionId: string): TerminalSession | null {
    return this.sessions.get(sessionId) ?? null
  }

  async write(sessionId: string, data: string): Promise<boolean> {
    const response = await this.connection.request<
      Extract<TerminalDaemonSuccessResponse, { type: 'session.write.result' }>,
      'session.write'
    >({
      type: 'session.write',
      sessionId,
      data
    })
    return response.accepted
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<boolean> {
    const response = await this.connection.request<
      Extract<TerminalDaemonSuccessResponse, { type: 'session.resize.result' }>,
      'session.resize'
    >({
      type: 'session.resize',
      sessionId,
      cols,
      rows
    })
    return response.accepted
  }

  async detach(sessionId: string): Promise<TerminalSession | null> {
    const response = await this.connection.request<
      Extract<TerminalDaemonSuccessResponse, { type: 'session.detach.result' }>,
      'session.detach'
    >({
      type: 'session.detach',
      sessionId
    })
    this.listeners.delete(sessionId)
    this.sessions.delete(sessionId)
    return response.session
  }

  async destroy(sessionId: string): Promise<boolean> {
    const response = await this.connection.request<
      Extract<TerminalDaemonSuccessResponse, { type: 'session.destroy.result' }>,
      'session.destroy'
    >({
      type: 'session.destroy',
      sessionId
    })
    this.listeners.delete(sessionId)
    this.sessions.delete(sessionId)
    return response.removed
  }

  async destroyPersistentSession(persistentId: string): Promise<void> {
    await this.connection.request<
      Extract<TerminalDaemonSuccessResponse, { type: 'session.destroyPersistent.result' }>,
      'session.destroyPersistent'
    >({
      type: 'session.destroyPersistent',
      persistentId
    })
  }

  dispose(): void {
    this.listeners.clear()
    this.sessions.clear()
    this.connection.dispose()
  }

  private handleEvent(event: TerminalDaemonEvent): void {
    if (event.type === 'terminal.data') {
      const listener = this.listeners.get(event.sessionId)
      listener?.onData(event.data, event.sessionKey)
      return
    }

    const session = this.sessions.get(event.sessionId)
    if (session) {
      this.sessions.set(event.sessionId, {
        ...session,
        state: 'exited',
        exitCode: event.exitCode,
        signal: event.signal
      })
    }

    const listener = this.listeners.get(event.sessionId)
    listener?.onExit(event.exitCode, event.signal)
  }
}

export function createDaemonTerminalBackend(socketPath: string): TerminalBackend {
  return new DaemonTerminalBackend(socketPath)
}
