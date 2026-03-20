import { spawn as spawnChild } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { basename, resolve } from 'node:path'
import process from 'node:process'
import { spawn, type IDisposable, type IPty } from 'node-pty'
import type { CreateTerminalPayload, TerminalLifecycleState, TerminalSession } from '../shared/workbench'

export type TerminalRuntimeDisposable = Pick<IDisposable, 'dispose'>

export type TerminalProcessExitEvent = {
  exitCode: number
  signal?: number
}

export type TerminalProcessHandle = {
  pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(listener: (data: string) => void): TerminalRuntimeDisposable
  onExit(listener: (event: TerminalProcessExitEvent) => void): TerminalRuntimeDisposable
}

export type TerminalRuntimeDataEvent = {
  sessionId: string
  data: string
}

export type TerminalRuntimeExitEvent = TerminalProcessExitEvent & {
  sessionId: string
}

type CreateOrAttachRuntimeOptions = {
  ownerId: number
  payload: CreateTerminalPayload
  onData(event: TerminalRuntimeDataEvent): void
  onExit(event: TerminalRuntimeExitEvent): void
}

type RuntimeTerminalRecord = {
  ownerId: number
  sessionId: string
  sessionKey?: string
  cwd: string
  shell: string
  state: TerminalLifecycleState
  attached: boolean
  exitCode?: number
  signal?: number
  process: TerminalProcessHandle
  dataDisposable: TerminalRuntimeDisposable
  exitDisposable: TerminalRuntimeDisposable
}

type TerminalRuntimeOptions = {
  processFactory?(payload: CreateTerminalPayload, cwd: string): { process: TerminalProcessHandle; shellLabel: string }
  persistentSessionDestroyer?(persistentId: string): void
}

export interface TerminalRuntime {
  createOrAttach(options: CreateOrAttachRuntimeOptions): TerminalSession
  getSession(sessionId: string): TerminalSession | null
  write(sessionId: string, data: string): boolean
  resize(sessionId: string, cols: number, rows: number): boolean
  detach(sessionId: string): TerminalSession | null
  destroy(sessionId: string): boolean
  destroyPersistentSession(persistentId: string): void
  dispose(): void
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function getPersistentSessionName(persistentId: string): string {
  const normalized = persistentId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48)
  return `harmony-${normalized || 'session'}`
}

function getShellLaunch(): { shell: string; args: string[] } {
  if (process.platform === 'win32') {
    return { shell: process.env.ComSpec || 'powershell.exe', args: [] }
  }

  return { shell: process.env.SHELL || '/bin/zsh', args: ['-l'] }
}

function inferCommandLabel(command: string, fallback: string): string {
  const firstToken = command.trim().split(/\s+/).at(0)
  return firstToken ? basename(firstToken) : fallback
}

function wrapPtyProcess(instance: IPty): TerminalProcessHandle {
  return {
    get pid() {
      return instance.pid
    },
    write(data: string) {
      instance.write(data)
    },
    resize(cols: number, rows: number) {
      instance.resize(cols, rows)
    },
    kill() {
      instance.kill()
    },
    onData(listener: (data: string) => void): TerminalRuntimeDisposable {
      return instance.onData(listener)
    },
    onExit(listener: (event: TerminalProcessExitEvent) => void): TerminalRuntimeDisposable {
      return instance.onExit(listener)
    }
  }
}

function normalizeSessionKey(sessionKey: string | undefined): string | null {
  const value = sessionKey?.trim()
  return value ? value : null
}

function toTerminalSession(record: RuntimeTerminalRecord): TerminalSession {
  return {
    sessionId: record.sessionId,
    cwd: record.cwd,
    shell: record.shell,
    state: record.state,
    attached: record.attached,
    exitCode: record.exitCode,
    signal: record.signal
  }
}

function createLocalProcess(payload: CreateTerminalPayload, cwd: string): {
  process: TerminalProcessHandle
  shellLabel: string
} {
  const colorFgBg = payload.themeHint === 'light' ? '0;15' : '15;0'
  const { shell, args } = getShellLaunch()
  const initialCommand = payload.initialCommand?.trim()
  const spawnArgs = initialCommand
    ? process.platform === 'win32'
      ? ['/d', '/s', '/c', initialCommand]
      : ['-lc', `exec ${initialCommand}`]
    : payload.persistentId && process.platform !== 'win32'
      ? [
          '-lc',
          `if command -v tmux >/dev/null 2>&1; then exec tmux new-session -A -s ${shellQuote(getPersistentSessionName(payload.persistentId))} -c ${shellQuote(cwd)}; else exec ${shellQuote(shell)} -l; fi`
        ]
      : args
  const shellLabel = initialCommand ? inferCommandLabel(initialCommand, basename(shell)) : basename(shell)
  const processHandle = wrapPtyProcess(
    spawn(shell, spawnArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        COLORFGBG: colorFgBg
      }
    })
  )

  return {
    process: processHandle,
    shellLabel
  }
}

function destroyLocalPersistentSession(persistentId: string): void {
  if (process.platform === 'win32') {
    return
  }

  const shell = process.env.SHELL || '/bin/zsh'
  const sessionName = getPersistentSessionName(persistentId)
  const child = spawnChild(
    shell,
    ['-lc', `tmux kill-session -t ${shellQuote(sessionName)} >/dev/null 2>&1 || true`],
    { stdio: 'ignore' }
  )
  child.unref()
}

export function createTerminalRuntime(runtimeOptions: TerminalRuntimeOptions = {}): TerminalRuntime {
  const processFactory = runtimeOptions.processFactory ?? createLocalProcess
  const persistentSessionDestroyer =
    runtimeOptions.persistentSessionDestroyer ?? destroyLocalPersistentSession
  const terminalSessions = new Map<string, RuntimeTerminalRecord>()
  const terminalSessionKeys = new Map<string, string>()

  function cleanupTerminal(sessionId: string): void {
    const record = terminalSessions.get(sessionId)

    if (!record) {
      return
    }

    if (record.sessionKey) {
      terminalSessionKeys.delete(record.sessionKey)
    }

    record.dataDisposable.dispose()
    record.exitDisposable.dispose()
    terminalSessions.delete(sessionId)
  }

  function maybeCleanupDetachedTerminal(record: RuntimeTerminalRecord): void {
    if (!record.attached && record.state !== 'running') {
      cleanupTerminal(record.sessionId)
    }
  }

  function getAttachableTerminal(ownerId: number, sessionKey: string | null): RuntimeTerminalRecord | null {
    if (!sessionKey) {
      return null
    }

    const sessionId = terminalSessionKeys.get(sessionKey)
    if (!sessionId) {
      return null
    }

    const record = terminalSessions.get(sessionId)
    if (!record || record.ownerId !== ownerId) {
      return null
    }

    if (record.state !== 'running') {
      if (!record.attached) {
        cleanupTerminal(record.sessionId)
      }
      return null
    }

    return record
  }

  return {
    createOrAttach(options: CreateOrAttachRuntimeOptions): TerminalSession {
      if (!options.payload.cwd?.trim()) {
        throw new Error('A worktree path is required to create a terminal.')
      }

      const cwd = resolve(options.payload.cwd)
      const sessionKey = normalizeSessionKey(options.payload.sessionKey)
      const existing = getAttachableTerminal(options.ownerId, sessionKey)

      if (existing) {
        existing.attached = true
        return toTerminalSession(existing)
      }

      const sessionId = randomUUID()
      const { process: processHandle, shellLabel } = processFactory(options.payload, cwd)

      const record: RuntimeTerminalRecord = {
        ownerId: options.ownerId,
        sessionId,
        sessionKey: sessionKey ?? undefined,
        cwd,
        shell: shellLabel,
        state: 'running',
        attached: true,
        process: processHandle,
        dataDisposable: { dispose() {} },
        exitDisposable: { dispose() {} }
      }

      record.dataDisposable = processHandle.onData((data) => {
        options.onData({ sessionId, data })
      })

      record.exitDisposable = processHandle.onExit(({ exitCode, signal }) => {
        const activeRecord = terminalSessions.get(sessionId)

        if (!activeRecord) {
          options.onExit({ sessionId, exitCode, signal })
          return
        }

        if (activeRecord.state === 'destroyed') {
          cleanupTerminal(sessionId)
          options.onExit({ sessionId, exitCode, signal })
          return
        }

        activeRecord.state = 'exited'
        activeRecord.exitCode = exitCode
        activeRecord.signal = signal
        maybeCleanupDetachedTerminal(activeRecord)
        options.onExit({ sessionId, exitCode, signal })
      })

      terminalSessions.set(sessionId, record)

      if (record.sessionKey) {
        terminalSessionKeys.set(record.sessionKey, sessionId)
      }

      return toTerminalSession(record)
    },

    getSession(sessionId: string): TerminalSession | null {
      const record = terminalSessions.get(sessionId)
      return record ? toTerminalSession(record) : null
    },

    write(sessionId: string, data: string): boolean {
      const record = terminalSessions.get(sessionId)

      if (!record || record.state !== 'running') {
        return false
      }

      record.process.write(data)
      return true
    },

    resize(sessionId: string, cols: number, rows: number): boolean {
      const record = terminalSessions.get(sessionId)

      if (!record || record.state !== 'running') {
        return false
      }

      if (cols <= 0 || rows <= 0) {
        return false
      }

      record.process.resize(cols, rows)
      return true
    },

    detach(sessionId: string): TerminalSession | null {
      const record = terminalSessions.get(sessionId)

      if (!record) {
        return null
      }

      record.attached = false
      const snapshot = toTerminalSession(record)
      maybeCleanupDetachedTerminal(record)
      return snapshot
    },

    destroy(sessionId: string): boolean {
      const record = terminalSessions.get(sessionId)

      if (!record) {
        return false
      }

      record.state = 'destroyed'
      record.attached = false

      if (record.process.pid > 0) {
        record.process.kill()
      }

      cleanupTerminal(sessionId)
      return true
    },

    destroyPersistentSession(persistentId: string): void {
      persistentSessionDestroyer(persistentId)
    },

    dispose(): void {
      for (const [sessionId, record] of terminalSessions) {
        record.state = 'destroyed'
        record.attached = false

        if (record.process.pid > 0) {
          record.process.kill()
        }

        cleanupTerminal(sessionId)
      }
    }
  }
}

export function createLocalTerminalRuntime(): TerminalRuntime {
  return createTerminalRuntime()
}
