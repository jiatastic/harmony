import { resolve } from 'node:path'
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { CreateTerminalPayload, TerminalSession } from '../shared/workbench'
import { harmonyChannels } from '../shared/workbench'
import { createLocalTerminalRuntime } from './terminalRuntime'

type TerminalRecord = {
  sessionId: string
  sessionKey?: string
  ownerId: number
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

const terminalRuntime = createLocalTerminalRuntime()
const terminalSessions = new Map<string, TerminalRecord>()
const terminalDataListeners = new Set<(payload: TerminalDataDispatch) => void>()
const terminalExitListeners = new Set<(payload: TerminalExitDispatch) => void>()
const terminalInputListeners = new Set<(payload: TerminalInputDispatch) => void>()

function normalizeSessionKey(sessionKey: string | undefined): string | null {
  const value = sessionKey?.trim()
  return value ? value : null
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

function sendTerminalState(
  event: IpcMainInvokeEvent | IpcMainEvent,
  session: TerminalSession
): void {
  if (event.sender.isDestroyed()) {
    return
  }

  event.sender.send(harmonyChannels.terminalState, {
    sessionId: session.sessionId,
    state: session.state,
    exitCode: session.exitCode,
    signal: session.signal
  })
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
  if (!payload.cwd?.trim()) {
    throw new Error('A worktree path is required to create a terminal.')
  }

  const cwd = resolve(payload.cwd)
  const sessionKey = normalizeSessionKey(payload.sessionKey)
  const runtimeSession = terminalRuntime.createOrAttach({
    ownerId: event.sender.id,
    payload: {
      ...payload,
      cwd,
      sessionKey: sessionKey ?? undefined
    },
    onData: ({ sessionId, data }) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(harmonyChannels.terminalData, { sessionId, data })
      }

      notifyTerminalData({
        ownerId: event.sender.id,
        sessionId,
        data
      })
    },
    onExit: ({ sessionId, exitCode, signal }) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(harmonyChannels.terminalExit, {
          sessionId,
          exitCode,
          signal
        })
      }

      notifyTerminalExit({
        ownerId: event.sender.id,
        sessionId,
        exitCode,
        signal
      })

      const snapshot = terminalRuntime.getSession(sessionId)
      if (snapshot) {
        sendTerminalState(event, snapshot)
      } else {
        terminalSessions.delete(sessionId)
      }
    }
  })

  terminalSessions.set(runtimeSession.sessionId, {
    sessionId: runtimeSession.sessionId,
    sessionKey: sessionKey ?? undefined,
    ownerId: event.sender.id
  })

  sendTerminalState(event, runtimeSession)
  return runtimeSession
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

  terminalRuntime.resize(payload.sessionId, payload.cols, payload.rows)
}

function handleTerminalDetach(event: IpcMainEvent, payload: { sessionId: string }): void {
  detachTerminalForOwner(event.sender.id, payload.sessionId)
}

function handleTerminalDestroy(event: IpcMainEvent, payload: { sessionId: string }): void {
  destroyTerminalForOwner(event.sender.id, payload.sessionId, event)
}

function handlePersistentTerminalDestroy(
  _event: IpcMainEvent,
  payload: { persistentId: string }
): void {
  if (!payload.persistentId?.trim()) {
    return
  }

  terminalRuntime.destroyPersistentSession(payload.persistentId)
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

  const didWrite = terminalRuntime.write(sessionId, data)
  if (!didWrite) {
    return false
  }

  notifyTerminalInput({
    ownerId,
    sessionId,
    data
  })
  return true
}

export function detachTerminalForOwner(ownerId: number, sessionId: string): void {
  const record = getOwnedTerminalRecord(ownerId, sessionId)

  if (!record) {
    return
  }

  const snapshot = terminalRuntime.detach(sessionId)
  if (!snapshot) {
    terminalSessions.delete(sessionId)
  }
}

export function destroyTerminalForOwner(
  ownerId: number,
  sessionId: string,
  event?: IpcMainEvent | IpcMainInvokeEvent
): void {
  const record = getOwnedTerminalRecord(ownerId, sessionId)

  if (!record) {
    return
  }

  const snapshot = terminalRuntime.getSession(sessionId)
  terminalRuntime.destroy(sessionId)
  terminalSessions.delete(sessionId)

  if (event && snapshot) {
    sendTerminalState(event, {
      ...snapshot,
      state: 'destroyed',
      attached: false
    })
  }
}

export function registerTerminalIpc(): void {
  ipcMain.handle(harmonyChannels.createTerminal, createTerminalSession)
  ipcMain.on(harmonyChannels.writeTerminal, handleTerminalWrite)
  ipcMain.on(harmonyChannels.resizeTerminal, handleTerminalResize)
  ipcMain.on(harmonyChannels.detachTerminal, handleTerminalDetach)
  ipcMain.on(harmonyChannels.destroyTerminal, handleTerminalDestroy)
  ipcMain.on(harmonyChannels.destroyPersistentTerminal, handlePersistentTerminalDestroy)
}

export function disposeTerminalSessions(): void {
  terminalRuntime.dispose()
  terminalSessions.clear()
}
