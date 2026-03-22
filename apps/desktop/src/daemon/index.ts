import { createServer, createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import process from 'node:process'
import {
  isTerminalDaemonCommand,
  TERMINAL_DAEMON_PROTOCOL_VERSION,
  type TerminalDaemonCommand,
  type TerminalDaemonErrorResponse,
  type TerminalDaemonResponse
} from '../shared/terminalDaemon'
import { SessionRegistry } from './sessionRegistry'
import { TerminalSessionHost } from './terminalSessionHost'

const DEFAULT_DAEMON_DIRNAME = 'terminal-daemon'
const REGISTRY_FILE = 'sessions.json'
const SOCKET_FILE = 'daemon.sock'

function getDaemonDataDir(): string {
  const configured = process.env.HARMONY_TERMINAL_DAEMON_DATA_DIR?.trim()
  if (configured) {
    return configured
  }

  return join(process.cwd(), DEFAULT_DAEMON_DIRNAME)
}

function getSocketPath(dataDir: string): string {
  const configured = process.env.HARMONY_TERMINAL_DAEMON_SOCKET_PATH?.trim()
  if (configured) {
    return configured
  }

  return join(dataDir, SOCKET_FILE)
}

function writeResponse(socket: Socket, payload: TerminalDaemonResponse): void {
  socket.write(`${JSON.stringify(payload)}\n`)
}

async function ensureSocketIsUsable(socketPath: string): Promise<void> {
  const stat = await fs.stat(socketPath).catch(() => null)
  if (!stat) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    const probe = createConnection(socketPath)
    probe.once('connect', () => {
      probe.destroy()
      reject(new Error(`Terminal daemon already running at ${socketPath}.`))
    })
    probe.once('error', async () => {
      probe.destroy()
      await fs.rm(socketPath, { force: true }).catch(() => undefined)
      resolve()
    })
  })
}

async function dispatchCommand(
  host: TerminalSessionHost,
  socket: Socket,
  command: TerminalDaemonCommand
): Promise<TerminalDaemonResponse> {
  switch (command.type) {
    case 'system.ping':
      return {
        requestId: command.requestId,
        ok: true,
        type: 'system.pong',
        pid: process.pid,
        daemonVersion: TERMINAL_DAEMON_PROTOCOL_VERSION
      }
    case 'session.list':
      return {
        requestId: command.requestId,
        ok: true,
        type: 'session.list.result',
        sessions: host.listSessions()
      }
    case 'session.get':
      return {
        requestId: command.requestId,
        ok: true,
        type: 'session.get.result',
        session: host.getSession(command.sessionId)
      }
    case 'session.createOrAttach': {
      const result = await host.createOrAttach(command.payload)
      return {
        requestId: command.requestId,
        ok: true,
        type: 'session.createOrAttach.result',
        session: result.session
      }
    }
    case 'session.subscribe': {
      const snapshot = host.subscribe(command.sessionId, socket)
      return {
        requestId: command.requestId,
        ok: true,
        type: 'session.subscribe.result',
        snapshot
      }
    }
    case 'session.updateMetadata':
      return {
        requestId: command.requestId,
        ok: true,
        type: 'session.updateMetadata.result',
        session: await host.updateSessionMetadata(command.sessionId, command.patch)
      }
    case 'session.write':
      return {
        requestId: command.requestId,
        ok: true,
        type: 'session.write.result',
        accepted: await host.write(command.sessionId, command.data)
      }
    case 'session.resize':
      return {
        requestId: command.requestId,
        ok: true,
        type: 'session.resize.result',
        accepted: await host.resize(command.sessionId, command.cols, command.rows)
      }
    case 'session.detach':
      return {
        requestId: command.requestId,
        ok: true,
        type: 'session.detach.result',
        session: await host.detach(socket, command.sessionId)
      }
    case 'session.destroy':
      return {
        requestId: command.requestId,
        ok: true,
        type: 'session.destroy.result',
        removed: await host.destroy(command.sessionId)
      }
    case 'session.destroyPersistent':
      await host.destroyPersistentSession(command.persistentId)
      return {
        requestId: command.requestId,
        ok: true,
        type: 'session.destroyPersistent.result'
      }
  }
}

async function startTerminalDaemon(): Promise<void> {
  const dataDir = getDaemonDataDir()
  const socketPath = getSocketPath(dataDir)
  const registry = new SessionRegistry(join(dataDir, REGISTRY_FILE))

  await fs.mkdir(dataDir, { recursive: true })
  await ensureSocketIsUsable(socketPath)
  await registry.load()
  const host = new TerminalSessionHost(registry)

  const server = createServer((socket) => {
    let buffer = ''

    socket.on('close', () => {
      host.handleSocketClosed(socket)
    })

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')

      while (buffer.includes('\n')) {
        const newlineIndex = buffer.indexOf('\n')
        const rawMessage = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)

        if (!rawMessage) {
          continue
        }

        let parsed: unknown
        try {
          parsed = JSON.parse(rawMessage) as unknown
        } catch {
          writeResponse(socket, {
            requestId: 'unknown',
            ok: false,
            error: {
              code: 'invalid_json',
              message: 'Malformed daemon JSON payload.'
            }
          } satisfies TerminalDaemonErrorResponse)
          continue
        }

        if (!isTerminalDaemonCommand(parsed)) {
          writeResponse(socket, {
            requestId: 'unknown',
            ok: false,
            error: {
              code: 'invalid_command',
              message: 'Unsupported daemon command.'
            }
          } satisfies TerminalDaemonErrorResponse)
          continue
        }

        void dispatchCommand(host, socket, parsed)
          .then((response) => {
            writeResponse(socket, response)
          })
          .catch((error: unknown) => {
            writeResponse(socket, {
              requestId: parsed.requestId,
              ok: false,
              error: {
                code: 'command_failed',
                message: error instanceof Error ? error.message : 'Unknown daemon command failure.'
              }
            } satisfies TerminalDaemonErrorResponse)
          })
      }
    })
  })

  const shutdown = async (): Promise<void> => {
    server.close()
    await registry.markCleanShutdown().catch(() => undefined)
    await fs.rm(socketPath, { force: true }).catch(() => undefined)
    process.exit(0)
  }

  process.on('SIGINT', () => {
    void shutdown()
  })
  process.on('SIGTERM', () => {
    void shutdown()
  })

  server.listen(socketPath)
}

void startTerminalDaemon().catch((error) => {
  console.error('[terminal-daemon]', error)
  process.exit(1)
})
