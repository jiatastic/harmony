import type { TerminalBackend } from './terminalBackend'
import { createLocalTerminalRuntime } from './terminalRuntime'

export type LocalTerminalBackend = TerminalBackend

export function createLocalTerminalBackend(): LocalTerminalBackend {
  const runtime = createLocalTerminalRuntime()

  return {
    async createOrAttach(options) {
      return runtime.createOrAttach(options)
    },
    getSession(sessionId) {
      return runtime.getSession(sessionId)
    },
    async write(sessionId, data) {
      return runtime.write(sessionId, data)
    },
    async resize(sessionId, cols, rows) {
      return runtime.resize(sessionId, cols, rows)
    },
    async detach(sessionId) {
      return runtime.detach(sessionId)
    },
    async destroy(sessionId) {
      return runtime.destroy(sessionId)
    },
    async destroyPersistentSession(persistentId) {
      runtime.destroyPersistentSession(persistentId)
    },
    dispose() {
      runtime.dispose()
    }
  }
}
