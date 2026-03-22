import { spawn as spawnChild, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants as fsConstants } from 'node:fs'
import { basename, resolve } from 'node:path'
import process from 'node:process'
import { spawn, type IDisposable, type IPty } from 'node-pty'
import type {
  CreateTerminalPayload,
  PersistentShellSupport,
  TerminalLifecycleState,
  TerminalSession
} from '../shared/workbench'

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
  sessionKey?: string
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
  restored: boolean
  exitCode?: number
  signal?: number
  process: TerminalProcessHandle
  dataDisposable: TerminalRuntimeDisposable
  exitDisposable: TerminalRuntimeDisposable
}

type TerminalRuntimeOptions = {
  processFactory?(payload: CreateTerminalPayload, cwd: string): {
    process: TerminalProcessHandle
    shellLabel: string
    restored: boolean
  }
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

function isExecutableFile(path: string | undefined): path is string {
  if (!path) {
    return false
  }

  try {
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

function getShellLaunch(): { shell: string; args: string[]; fallbacks: string[] } {
  if (process.platform === 'win32') {
    return {
      shell: process.env.ComSpec || 'powershell.exe',
      args: [],
      fallbacks: ['cmd.exe']
    }
  }

  const candidates = Array.from(
    new Set([process.env.SHELL, '/bin/zsh', '/bin/bash'].filter((value): value is string => Boolean(value)))
  )
  const shell = candidates.find((candidate) => !candidate.includes('/') || isExecutableFile(candidate)) ?? '/bin/zsh'

  return {
    shell,
    args: ['-l'],
    fallbacks: candidates.filter((candidate) => candidate !== shell)
  }
}

function inferCommandLabel(command: string, fallback: string): string {
  const firstToken = command.trim().split(/\s+/).at(0)
  return firstToken ? basename(firstToken) : fallback
}

function resolveTmuxBinary(): string | null {
  if (process.platform === 'win32') {
    return null
  }

  const shell = process.env.SHELL && isExecutableFile(process.env.SHELL) ? process.env.SHELL : '/bin/sh'
  const result = spawnSync(shell, ['-lc', 'command -v tmux'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
  const binaryPath = result.stdout?.trim()
  return binaryPath || null
}

function getTmuxInstallHint(): string | undefined {
  switch (process.platform) {
    case 'darwin':
      return 'brew install tmux'
    case 'linux':
      return 'install tmux with your package manager, for example: sudo apt install tmux'
    default:
      return undefined
  }
}

export function getPersistentShellSupport(): PersistentShellSupport {
  if (process.platform === 'win32') {
    return {
      available: true,
      required: false,
      binaryPath: null
    }
  }

  const binaryPath = resolveTmuxBinary()
  if (binaryPath) {
    return {
      available: true,
      required: true,
      binaryPath
    }
  }

  return {
    available: false,
    required: true,
    binaryPath: null,
    reason: 'Persistent shell sessions require tmux.',
    installHint: getTmuxInstallHint()
  }
}

function hasTmuxSession(persistentId: string): boolean | null {
  const sessionName = getPersistentSessionName(persistentId)
  const result = spawnSync('tmux', ['has-session', '-t', sessionName], { stdio: 'ignore' })
  if (result.error) {
    return null
  }

  return result.status === 0
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
    restored: record.restored,
    exitCode: record.exitCode,
    signal: record.signal
  }
}

export function createLocalProcess(payload: CreateTerminalPayload, cwd: string): {
  process: TerminalProcessHandle
  shellLabel: string
  restored: boolean
} {
  if (payload.persistentId) {
    const persistentShellSupport = getPersistentShellSupport()
    if (persistentShellSupport.required && !persistentShellSupport.available) {
      const installHint = persistentShellSupport.installHint
        ? ` Install it with "${persistentShellSupport.installHint}" and restart Harmony.`
        : ''
      throw new Error(`${persistentShellSupport.reason ?? 'Persistent shell sessions require tmux.'}${installHint}`)
    }
  }

  const colorFgBg = payload.themeHint === 'light' ? '0;15' : '15;0'
  const { NO_COLOR: _noColor, ...baseEnv } = process.env
  const { shell, args, fallbacks } = getShellLaunch()
  const initialCommand = payload.initialCommand?.trim()
  let restored = false
  let spawnArgs = initialCommand
    ? process.platform === 'win32'
      ? ['/d', '/s', '/c', initialCommand]
      : ['-lc', `exec ${initialCommand}`]
    : args

  if (payload.persistentId && process.platform !== 'win32') {
    const tmuxState = hasTmuxSession(payload.persistentId)
    if (tmuxState === null) {
      throw new Error('Persistent shell sessions require a working tmux binary, but Harmony could not query tmux.')
    }

    const sessionName = shellQuote(getPersistentSessionName(payload.persistentId))
    const quotedCwd = shellQuote(cwd)
    if (tmuxState) {
      spawnArgs = ['-lc', `exec tmux attach-session -t ${sessionName}`]
      restored = true
    } else {
      spawnArgs = initialCommand
        ? ['-lc', `exec tmux new-session -s ${sessionName} -c ${quotedCwd} ${shellQuote(initialCommand)}`]
        : ['-lc', `exec tmux new-session -A -s ${sessionName} -c ${quotedCwd}`]
    }
  }
  const spawnEnv = {
    ...baseEnv,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    COLORFGBG: colorFgBg,
    CLICOLOR: '1',
    FORCE_COLOR: '1'
  }
  const candidates = [shell, ...fallbacks]
  let lastError: unknown = null

  for (const candidate of candidates) {
    if (process.platform !== 'win32' && candidate.includes('/') && !isExecutableFile(candidate)) {
      continue
    }

    try {
      return {
        process: wrapPtyProcess(
          spawn(candidate, spawnArgs, {
            name: 'xterm-256color',
            cols: 120,
            rows: 32,
            cwd,
            env: spawnEnv
          })
        ),
        shellLabel: initialCommand ? inferCommandLabel(initialCommand, basename(candidate)) : basename(candidate),
        restored
      }
    } catch (error) {
      lastError = error
    }
  }

  const message = lastError instanceof Error ? lastError.message : 'unknown shell spawn failure'
  throw new Error(`Failed to start terminal shell in ${cwd}: ${message}`)
}

export function destroyLocalPersistentSession(persistentId: string): void {
  if (process.platform === 'win32') {
    return
  }

  const { shell } = getShellLaunch()
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
        existing.restored = true
        return toTerminalSession(existing)
      }

      const sessionId = randomUUID()
      const { process: processHandle, shellLabel, restored } = processFactory(options.payload, cwd)

      const record: RuntimeTerminalRecord = {
        ownerId: options.ownerId,
        sessionId,
        sessionKey: sessionKey ?? undefined,
        cwd,
        shell: shellLabel,
        state: 'running',
        attached: true,
        restored,
        process: processHandle,
        dataDisposable: { dispose() {} },
        exitDisposable: { dispose() {} }
      }

      record.dataDisposable = processHandle.onData((data) => {
        options.onData({ sessionId, sessionKey: record.sessionKey, data })
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
