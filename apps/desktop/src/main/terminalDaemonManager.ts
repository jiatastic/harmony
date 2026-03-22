import { accessSync, constants as fsConstants } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { app } from 'electron'
import { TerminalDaemonConnection } from './terminalDaemonClient'
import type {
  TerminalDaemonSessionPatch,
  TerminalDaemonSessionRecord,
  TerminalDaemonSuccessResponse
} from '../shared/terminalDaemon'

const TERMINAL_DAEMON_DIR = 'terminal-daemon'
const TERMINAL_DAEMON_SOCKET = 'daemon.sock'
const TERMINAL_DAEMON_BOOT_TIMEOUT_MS = 4000
const TERMINAL_DAEMON_BOOT_POLL_MS = 150

export interface TerminalDaemonPaths {
  dataDir: string
  socketPath: string
  entryPath: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export function getTerminalDaemonPaths(userDataPath: string): TerminalDaemonPaths {
  const dataDir = join(userDataPath, TERMINAL_DAEMON_DIR)
  return {
    dataDir,
    socketPath: join(dataDir, TERMINAL_DAEMON_SOCKET),
    entryPath: join(__dirname, 'daemon.js')
  }
}

async function pingTerminalDaemon(socketPath: string): Promise<boolean> {
  const connection = new TerminalDaemonConnection(socketPath)
  try {
    const response = await connection.request({ type: 'system.ping' }, 1000)
    return response.type === 'system.pong'
  } catch {
    return false
  } finally {
    connection.dispose()
  }
}

export async function ensureTerminalDaemonRunning(userDataPath: string): Promise<TerminalDaemonPaths> {
  const paths = getTerminalDaemonPaths(userDataPath)

  if (await pingTerminalDaemon(paths.socketPath)) {
    return paths
  }

  accessSync(paths.entryPath, fsConstants.R_OK)

  const child = spawn(process.execPath, [paths.entryPath], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HARMONY_TERMINAL_DAEMON_DATA_DIR: paths.dataDir,
      HARMONY_TERMINAL_DAEMON_SOCKET_PATH: paths.socketPath
    }
  })
  child.unref()

  const startedAt = Date.now()
  while (Date.now() - startedAt < TERMINAL_DAEMON_BOOT_TIMEOUT_MS) {
    if (await pingTerminalDaemon(paths.socketPath)) {
      return paths
    }

    await sleep(TERMINAL_DAEMON_BOOT_POLL_MS)
  }

  throw new Error(`Timed out waiting for terminal daemon at ${paths.socketPath}.`)
}

async function withTerminalDaemonConnection<T>(
  fn: (connection: TerminalDaemonConnection) => Promise<T>
): Promise<T> {
  const paths = await ensureTerminalDaemonRunning(app.getPath('userData'))
  const connection = new TerminalDaemonConnection(paths.socketPath)

  try {
    return await fn(connection)
  } finally {
    connection.dispose()
  }
}

export async function listTerminalDaemonSessions(): Promise<TerminalDaemonSessionRecord[]> {
  return await withTerminalDaemonConnection(async (connection) => {
    const response = await connection.request<
      Extract<TerminalDaemonSuccessResponse, { type: 'session.list.result' }>,
      'session.list'
    >({ type: 'session.list' })
    return response.sessions
  })
}

export async function updateTerminalDaemonSessionMetadata(
  sessionId: string,
  patch: TerminalDaemonSessionPatch
): Promise<TerminalDaemonSessionRecord> {
  return await withTerminalDaemonConnection(async (connection) => {
    const response = await connection.request<
      Extract<TerminalDaemonSuccessResponse, { type: 'session.updateMetadata.result' }>,
      'session.updateMetadata'
    >({
      type: 'session.updateMetadata',
      sessionId,
      patch
    })
    return response.session
  })
}
