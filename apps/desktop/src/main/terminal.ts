import { randomUUID } from 'node:crypto'
import { spawn as spawnChild } from 'node:child_process'
import { basename, resolve } from 'node:path'
import process from 'node:process'
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { spawn, type IDisposable, type IPty } from 'node-pty'
import type { CreateTerminalPayload, TerminalSession } from '../shared/workbench'
import { harmonyChannels } from '../shared/workbench'

type TerminalRecord = {
  instance: IPty
  dataDisposable: IDisposable
  exitDisposable: IDisposable
  ownerId: number
  cwd: string
}

export type TerminalDataDispatch = {
  ownerId: number
  sessionId: string
  data: string
}

export type TerminalExitDispatch = {
  ownerId: number
  sessionId: string
  exitCode: number
  signal?: number
}

export type TerminalInputDispatch = {
  ownerId: number
  sessionId: string
  data: string
}

const terminalSessions = new Map<string, TerminalRecord>()
const terminalDataListeners = new Set<(payload: TerminalDataDispatch) => void>()
const terminalExitListeners = new Set<(payload: TerminalExitDispatch) => void>()
const terminalInputListeners = new Set<(payload: TerminalInputDispatch) => void>()

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function getPersistentSessionName(persistentId: string): string {
  const normalized = persistentId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48)
  return `harmony-${normalized || 'session'}`
}

function destroyPersistentSession(persistentId: string): void {
  if (process.platform === 'win32') {
    return
  }

  const shell = process.env.SHELL || '/bin/zsh'
  const sessionName = getPersistentSessionName(persistentId)
  const child = spawnChild(shell, ['-lc', `tmux kill-session -t ${shellQuote(sessionName)} >/dev/null 2>&1 || true`], {
    stdio: 'ignore'
  })
  child.unref()
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

function notifyTerminalData(payload: TerminalDataDispatch): void {
  for (const listener of terminalDataListeners) {
    listener(payload)
  }
}

function notifyTerminalExit(payload: TerminalExitDispatch): void {
  for (const listener of terminalExitListeners) {
    listener(payload)
  }
}

function notifyTerminalInput(payload: TerminalInputDispatch): void {
  for (const listener of terminalInputListeners) {
    listener(payload)
  }
}

function cleanupTerminal(sessionId: string): void {
  const record = terminalSessions.get(sessionId)

  if (!record) {
    return
  }

  record.dataDisposable.dispose()
  record.exitDisposable.dispose()
  terminalSessions.delete(sessionId)
}

function getOwnedTerminalRecord(ownerId: number, sessionId: string): TerminalRecord | null {
  const record = terminalSessions.get(sessionId)

  if (!record || record.ownerId !== ownerId) {
    return null
  }

  return record
}

async function createTerminalSession(
  event: IpcMainInvokeEvent,
  payload: CreateTerminalPayload
): Promise<TerminalSession> {
  const cwd = resolve(payload.cwd)
  const colorFgBg = payload.themeHint === 'light' ? '0;15' : '15;0'

  if (!payload.cwd?.trim()) {
    throw new Error('A worktree path is required to create a terminal.')
  }

  const { shell, args } = getShellLaunch()
  const initialCommand = payload.initialCommand?.trim()
  const sessionId = randomUUID()
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
  const sessionLabel = initialCommand ? inferCommandLabel(initialCommand, basename(shell)) : basename(shell)

  const terminal = spawn(shell, spawnArgs, {
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

  const dataDisposable = terminal.onData((data) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send(harmonyChannels.terminalData, { sessionId, data })
    }

    notifyTerminalData({
      ownerId: event.sender.id,
      sessionId,
      data
    })
  })

  const exitDisposable = terminal.onExit(({ exitCode, signal }) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send(harmonyChannels.terminalExit, { sessionId, exitCode, signal })
    }

    notifyTerminalExit({
      ownerId: event.sender.id,
      sessionId,
      exitCode,
      signal
    })
    cleanupTerminal(sessionId)
  })

  terminalSessions.set(sessionId, {
    instance: terminal,
    dataDisposable,
    exitDisposable,
    ownerId: event.sender.id,
    cwd
  })

  return {
    sessionId,
    cwd,
    shell: sessionLabel
  }
}

function handleTerminalWrite(
  event: IpcMainEvent,
  payload: { sessionId: string; data: string }
): void {
  writeTerminalInputForOwner(event.sender.id, payload.sessionId, payload.data)
}

function handleTerminalResize(
  event: IpcMainEvent,
  payload: { sessionId: string; cols: number; rows: number }
): void {
  const record = getOwnedTerminalRecord(event.sender.id, payload.sessionId)

  if (!record) {
    return
  }

  if (payload.cols <= 0 || payload.rows <= 0) {
    return
  }

  record.instance.resize(payload.cols, payload.rows)
}

function handleTerminalDestroy(event: IpcMainEvent, payload: { sessionId: string }): void {
  destroyTerminalForOwner(event.sender.id, payload.sessionId)
}

function handlePersistentTerminalDestroy(
  _event: IpcMainEvent,
  payload: { persistentId: string }
): void {
  if (!payload.persistentId?.trim()) {
    return
  }

  destroyPersistentSession(payload.persistentId)
}

export function onTerminalData(listener: (payload: TerminalDataDispatch) => void): () => void {
  terminalDataListeners.add(listener)

  return () => {
    terminalDataListeners.delete(listener)
  }
}

export function onTerminalExit(listener: (payload: TerminalExitDispatch) => void): () => void {
  terminalExitListeners.add(listener)

  return () => {
    terminalExitListeners.delete(listener)
  }
}

export function onTerminalInput(listener: (payload: TerminalInputDispatch) => void): () => void {
  terminalInputListeners.add(listener)

  return () => {
    terminalInputListeners.delete(listener)
  }
}

export function writeTerminalInputForOwner(
  ownerId: number,
  sessionId: string,
  data: string
): boolean {
  const record = getOwnedTerminalRecord(ownerId, sessionId)

  if (!record) {
    return false
  }

  record.instance.write(data)
  notifyTerminalInput({
    ownerId,
    sessionId,
    data
  })
  return true
}

export function destroyTerminalForOwner(ownerId: number, sessionId: string): void {
  const record = getOwnedTerminalRecord(ownerId, sessionId)

  if (!record) {
    return
  }

  if (record.instance.pid > 0) {
    record.instance.kill()
  }

  cleanupTerminal(sessionId)
}

export function registerTerminalIpc(): void {
  ipcMain.handle(harmonyChannels.createTerminal, createTerminalSession)
  ipcMain.on(harmonyChannels.writeTerminal, handleTerminalWrite)
  ipcMain.on(harmonyChannels.resizeTerminal, handleTerminalResize)
  ipcMain.on(harmonyChannels.destroyTerminal, handleTerminalDestroy)
  ipcMain.on(harmonyChannels.destroyPersistentTerminal, handlePersistentTerminalDestroy)
}

export function disposeTerminalSessions(): void {
  for (const [sessionId, record] of terminalSessions) {
    if (record.instance.pid > 0) {
      record.instance.kill()
    }

    cleanupTerminal(sessionId)
  }
}
