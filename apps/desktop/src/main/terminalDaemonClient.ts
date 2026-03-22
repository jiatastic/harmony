import { createConnection, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import type {
  TerminalDaemonCommand,
  TerminalDaemonCommandPayload,
  TerminalDaemonEvent,
  TerminalDaemonResponse,
  TerminalDaemonSuccessResponse
} from '../shared/terminalDaemon'
import { isTerminalDaemonEvent } from '../shared/terminalDaemon'

type PendingRequest = {
  resolve(value: TerminalDaemonSuccessResponse): void
  reject(error: Error): void
  timeout: ReturnType<typeof setTimeout>
}

function withRequestId<TType extends TerminalDaemonCommand['type']>(
  command: TerminalDaemonCommandPayload<TType>
): TerminalDaemonCommand {
  return {
    ...command,
    requestId: randomUUID()
  } as TerminalDaemonCommand
}

export class TerminalDaemonConnection {
  private socket: Socket | null = null
  private connectPromise: Promise<void> | null = null
  private buffer = ''
  private readonly pendingRequests = new Map<string, PendingRequest>()
  private readonly eventListeners = new Set<(event: TerminalDaemonEvent) => void>()

  constructor(private readonly socketPath: string) {}

  onEvent(listener: (event: TerminalDaemonEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  async request<
    T extends TerminalDaemonSuccessResponse,
    TType extends TerminalDaemonCommand['type'] = TerminalDaemonCommand['type']
  >(
    command: TerminalDaemonCommandPayload<TType>,
    timeoutMs = 2000
  ): Promise<T> {
    await this.ensureConnected()

    const payload = withRequestId(command)

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(payload.requestId)
        reject(new Error(`Terminal daemon request timed out: ${payload.type}`))
      }, timeoutMs)

      this.pendingRequests.set(payload.requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout
      })

      this.socket?.write(`${JSON.stringify(payload)}\n`)
    })
  }

  dispose(): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Terminal daemon connection closed.'))
    }

    this.pendingRequests.clear()
    this.buffer = ''
    this.socket?.destroy()
    this.socket = null
    this.connectPromise = null
    this.eventListeners.clear()
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      return
    }

    if (this.connectPromise) {
      return await this.connectPromise
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = createConnection(this.socketPath)
      const initialErrorListener = (error: Error): void => {
        fail(error)
      }

      const fail = (error: Error): void => {
        socket.removeAllListeners()
        socket.destroy()
        this.socket = null
        this.connectPromise = null
        reject(error)
      }

      socket.once('connect', () => {
        socket.removeListener('error', initialErrorListener)
        this.socket = socket
        this.connectPromise = null
        socket.on('data', (chunk) => {
          this.handleData(chunk.toString('utf8'))
        })
        socket.on('close', () => {
          this.handleDisconnect(new Error('Terminal daemon connection closed.'))
        })
        socket.on('error', (error) => {
          this.handleDisconnect(error)
        })
        resolve()
      })

      socket.once('error', initialErrorListener)
    })

    return await this.connectPromise
  }

  private handleData(chunk: string): void {
    this.buffer += chunk

    while (this.buffer.includes('\n')) {
      const newlineIndex = this.buffer.indexOf('\n')
      const rawMessage = this.buffer.slice(0, newlineIndex).trim()
      this.buffer = this.buffer.slice(newlineIndex + 1)

      if (!rawMessage) {
        continue
      }

      const parsed = JSON.parse(rawMessage) as TerminalDaemonResponse | TerminalDaemonEvent

      if (isTerminalDaemonEvent(parsed)) {
        for (const listener of this.eventListeners) {
          listener(parsed)
        }
        continue
      }

      if (!('requestId' in parsed) || typeof parsed.requestId !== 'string') {
        continue
      }

      const pending = this.pendingRequests.get(parsed.requestId)
      if (!pending) {
        continue
      }

      this.pendingRequests.delete(parsed.requestId)
      clearTimeout(pending.timeout)

      if (!parsed.ok) {
        pending.reject(new Error(parsed.error.message))
        continue
      }

      pending.resolve(parsed)
    }
  }

  private handleDisconnect(error: Error): void {
    if (this.socket) {
      this.socket.removeAllListeners()
      this.socket.destroy()
    }

    this.socket = null
    this.connectPromise = null
    this.buffer = ''

    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(error)
      this.pendingRequests.delete(requestId)
    }
  }
}
