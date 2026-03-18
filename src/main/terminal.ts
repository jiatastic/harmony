import { randomUUID } from 'node:crypto'
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

const terminalSessions = new Map<string, TerminalRecord>()
const terminalDataListeners = new Set<(payload: TerminalDataDispatch) => void>()
const terminalExitListeners = new Set<(payload: TerminalExitDispatch) => void>()

function getShellLaunch(): { shell: string; args: string[] } {
  if (process.platform === 'win32') {
    return { shell: process.env.ComSpec || 'powershell.exe', args: [] }
  }

  return { shell: process.env.SHELL || '/bin/zsh', args: ['-l'] }
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
  const sessionId = randomUUID()
  const terminal = spawn(shell, args, {
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
    shell: basename(shell)
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
}

export function disposeTerminalSessions(): void {
  for (const [sessionId, record] of terminalSessions) {
    if (record.instance.pid > 0) {
      record.instance.kill()
    }

    cleanupTerminal(sessionId)
  }
}
