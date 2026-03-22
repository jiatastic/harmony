import type { TerminalBackend } from './terminalBackend'
import { createDaemonTerminalBackend } from './daemonTerminalBackend'

export function createDefaultTerminalBackend(socketPath: string): TerminalBackend {
  return createDaemonTerminalBackend(socketPath)
}
