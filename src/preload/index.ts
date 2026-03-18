import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AgentRun,
  AgentStartPayload,
  CreateTerminalPayload,
  HarmonyApi,
  ReadFilePayload,
  SaveFilePayload,
  TerminalDataEvent,
  TerminalExitEvent,
  WorktreeCreatePayload,
  WorktreeRemovePayload
} from '../shared/workbench'
import { harmonyChannels } from '../shared/workbench'

function subscribeToChannel<T>(channel: string, listener: (payload: T) => void): () => void {
  const subscription = (_event: Electron.IpcRendererEvent, payload: T): void => {
    listener(payload)
  }

  ipcRenderer.on(channel, subscription)

  return () => {
    ipcRenderer.removeListener(channel, subscription)
  }
}

const api: HarmonyApi = {
  openFolder: () => ipcRenderer.invoke(harmonyChannels.openFolder),
  listAvailableAgents: () => ipcRenderer.invoke(harmonyChannels.listAvailableAgents),
  listWorktrees: (workspacePaths?: string[]) =>
    ipcRenderer.invoke(harmonyChannels.listWorktrees, workspacePaths),
  listBranches: (workspacePath?: string) =>
    ipcRenderer.invoke(harmonyChannels.listBranches, workspacePath),
  createWorktree: (payload: WorktreeCreatePayload) =>
    ipcRenderer.invoke(harmonyChannels.createWorktree, payload),
  removeWorktree: (payload: WorktreeRemovePayload) =>
    ipcRenderer.invoke(harmonyChannels.removeWorktree, payload),
  listWorkspaceChanges: (workspacePath: string) =>
    ipcRenderer.invoke(harmonyChannels.listWorkspaceChanges, workspacePath),
  getContextInfo: () => ipcRenderer.invoke(harmonyChannels.getContextInfo),
  createTerminal: (payload: CreateTerminalPayload) =>
    ipcRenderer.invoke(harmonyChannels.createTerminal, payload),
  destroyTerminal: (sessionId: string) =>
    ipcRenderer.send(harmonyChannels.destroyTerminal, { sessionId }),
  getWorkspace: (workspacePath: string) =>
    ipcRenderer.invoke(harmonyChannels.getWorkspace, workspacePath),
  onTerminalData: (listener) =>
    subscribeToChannel<TerminalDataEvent>(harmonyChannels.terminalData, listener),
  onTerminalExit: (listener) =>
    subscribeToChannel<TerminalExitEvent>(harmonyChannels.terminalExit, listener),
  onAgentUpdate: (listener) => subscribeToChannel<AgentRun>(harmonyChannels.agentUpdate, listener),
  readFile: (payload: ReadFilePayload) => ipcRenderer.invoke(harmonyChannels.readFile, payload),
  stageWorkspaceChanges: (payload) =>
    ipcRenderer.invoke(harmonyChannels.stageWorkspaceChanges, payload),
  commitWorkspaceChanges: (payload) =>
    ipcRenderer.invoke(harmonyChannels.commitWorkspaceChanges, payload),
  publishBranch: (payload) => ipcRenderer.invoke(harmonyChannels.publishBranch, payload),
  generateCommitMessage: (payload) =>
    ipcRenderer.invoke(harmonyChannels.generateCommitMessage, payload),
  resizeTerminal: (sessionId: string, cols: number, rows: number) =>
    ipcRenderer.send(harmonyChannels.resizeTerminal, { sessionId, cols, rows }),
  startAgent: (payload: AgentStartPayload) =>
    ipcRenderer.invoke(harmonyChannels.startAgent, payload),
  writeFile: (payload: SaveFilePayload) => ipcRenderer.invoke(harmonyChannels.writeFile, payload),
  writeTerminal: (sessionId: string, data: string) =>
    ipcRenderer.send(harmonyChannels.writeTerminal, { sessionId, data }),
  listSessionStats: (workspacePath: string) =>
    ipcRenderer.invoke(harmonyChannels.listSessionStats, workspacePath),
  getUsageSummary: () => ipcRenderer.invoke(harmonyChannels.getUsageSummary),
  getCodexQuota: () => ipcRenderer.invoke(harmonyChannels.getCodexQuota),
  openExternalUrl: (url: string) => ipcRenderer.invoke(harmonyChannels.openExternalUrl, url)
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  Object.assign(window, {
    electron: electronAPI,
    api
  })
}
