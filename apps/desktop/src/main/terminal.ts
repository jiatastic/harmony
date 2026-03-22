import { resolve } from 'node:path'
import { app, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { CreateTerminalPayload, TerminalSession } from '../shared/workbench'
import { harmonyChannels } from '../shared/workbench'
import { createDefaultTerminalBackend } from './terminalBackendFactory'
import type { TerminalBackend } from './terminalBackend'
import {
  ensureTerminalDaemonRunning,
  listTerminalDaemonSessions,
  updateTerminalDaemonSessionMetadata
} from './terminalDaemonManager'
import type { TerminalDaemonSessionPatch, TerminalDaemonSessionRecord } from '../shared/terminalDaemon'

type TerminalRecord = {
  sessionId: string
  sessionKey?: string
  ownerId: number
}

export type TerminalDataDispatch = {
  ownerId: number
  sessionId: string
  sessionKey?: string
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

let terminalRuntime: TerminalBackend | null = null
let terminalRuntimePromise: Promise<TerminalBackend> | null = null
const terminalSessions = new Map<string, TerminalRecord>()
const terminalDataListeners = new Set<(payload: TerminalDataDispatch) => void>()
const terminalExitListeners = new Set<(payload: TerminalExitDispatch) => void>()
const terminalInputListeners = new Set<(payload: TerminalInputDispatch) => void>()

function normalizeSessionKey(sessionKey: string | undefined): string | null {
  const value = sessionKey?.trim()
  return value ? value : null
}

async function getTerminalRuntime(): Promise<TerminalBackend> {
  if (terminalRuntime) {
    return terminalRuntime
  }

  if (!terminalRuntimePromise) {
    terminalRuntimePromise = ensureTerminalDaemonRunning(app.getPath('userData'))
      .then((paths) => {
        const backend = createDefaultTerminalBackend(paths.socketPath)
        terminalRuntime = backend
        return backend
      })
      .catch((error) => {
        terminalRuntimePromise = null
        throw error
      })
  }

  return await terminalRuntimePromise
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
  const runtime = await getTerminalRuntime()
  const runtimeSession = await runtime.createOrAttach({
    ownerId: event.sender.id,
    payload: {
      ...payload,
      cwd,
      sessionKey: sessionKey ?? undefined
    },
    onData: ({ sessionId, sessionKey, data }) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(harmonyChannels.terminalData, { sessionId, sessionKey, data })
      }

      notifyTerminalData({
        ownerId: event.sender.id,
        sessionId,
        sessionKey,
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

      const snapshot = runtime.getSession(sessionId)
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

async function handleListTerminalSessions(): Promise<TerminalDaemonSessionRecord[]> {
  return await listTerminalDaemonSessions()
}

async function handleUpdateTerminalSessionMetadata(
  _event: IpcMainInvokeEvent,
  payload: { sessionId: string; patch: TerminalDaemonSessionPatch }
): Promise<TerminalDaemonSessionRecord> {
  return await updateTerminalDaemonSessionMetadata(payload.sessionId, payload.patch)
}

function handleTerminalWrite(
  event: IpcMainEvent,
  payload: { sessionId: string; data: string }
): void {
  void writeTerminalInputForOwner(event.sender.id, payload.sessionId, payload.data)
}

function handleTerminalResize(
  event: IpcMainEvent,
  payload: { sessionId: string; cols: number; rows: number }
): void {
  const record = getOwnedTerminalRecord(event.sender.id, payload.sessionId)

  if (!record) {
    return
  }

  void getTerminalRuntime()
    .then((runtime) => runtime.resize(payload.sessionId, payload.cols, payload.rows))
    .catch((error) => {
      console.error('Failed to resize terminal session', error)
    })
}

function handleTerminalDetach(event: IpcMainEvent, payload: { sessionId: string }): void {
  void detachTerminalForOwner(event.sender.id, payload.sessionId)
}

function handleTerminalDestroy(event: IpcMainEvent, payload: { sessionId: string }): void {
  void destroyTerminalForOwner(event.sender.id, payload.sessionId, event)
}

function handlePersistentTerminalDestroy(
  _event: IpcMainEvent,
  payload: { persistentId: string }
): void {
  if (!payload.persistentId?.trim()) {
    return
  }

  void getTerminalRuntime()
    .then((runtime) => runtime.destroyPersistentSession(payload.persistentId))
    .catch((error) => {
      console.error('Failed to destroy persistent terminal session', error)
    })
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
): Promise<boolean> {
  const record = getOwnedTerminalRecord(ownerId, sessionId)

  if (!record) {
    return Promise.resolve(false)
  }

  return getTerminalRuntime()
    .then((runtime) => runtime.write(sessionId, data))
    .then((didWrite) => {
      if (!didWrite) {
        return false
      }

      notifyTerminalInput({
        ownerId,
        sessionId,
        data
      })
      return true
    })
    .catch((error) => {
      console.error('Failed to write terminal input', error)
      return false
    })
}

export async function detachTerminalForOwner(ownerId: number, sessionId: string): Promise<void> {
  const record = getOwnedTerminalRecord(ownerId, sessionId)

  if (!record) {
    return
  }

  const runtime = await getTerminalRuntime().catch((error) => {
    console.error('Failed to detach terminal session', error)
    return null
  })
  if (!runtime) {
    return
  }

  const snapshot = await runtime.detach(sessionId)
  if (!snapshot) {
    terminalSessions.delete(sessionId)
  }
}

export async function destroyTerminalForOwner(
  ownerId: number,
  sessionId: string,
  event?: IpcMainEvent | IpcMainInvokeEvent
): Promise<void> {
  const record = getOwnedTerminalRecord(ownerId, sessionId)

  if (!record) {
    return
  }

  const runtime = await getTerminalRuntime().catch((error) => {
    console.error('Failed to destroy terminal session', error)
    return null
  })
  if (!runtime) {
    return
  }

  const snapshot = runtime.getSession(sessionId)
  await runtime.destroy(sessionId)
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
  ipcMain.handle(harmonyChannels.listTerminalSessions, handleListTerminalSessions)
  ipcMain.handle(harmonyChannels.updateTerminalSessionMetadata, handleUpdateTerminalSessionMetadata)
  ipcMain.on(harmonyChannels.writeTerminal, handleTerminalWrite)
  ipcMain.on(harmonyChannels.resizeTerminal, handleTerminalResize)
  ipcMain.on(harmonyChannels.detachTerminal, handleTerminalDetach)
  ipcMain.on(harmonyChannels.destroyTerminal, handleTerminalDestroy)
  ipcMain.on(harmonyChannels.destroyPersistentTerminal, handlePersistentTerminalDestroy)
}

export function disposeTerminalSessions(): void {
  terminalRuntime?.dispose()
  terminalRuntime = null
  terminalRuntimePromise = null
  terminalSessions.clear()
}
