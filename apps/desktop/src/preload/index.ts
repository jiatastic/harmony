import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AppUpdateState,
  AgentRun,
  AgentStartPayload,
  CreateTerminalPayload,
  HarmonyApi,
  ReadFilePayload,
  SaveFilePayload,
  TerminalDataEvent,
  TerminalExitEvent,
  WorkspaceWatchEvent,
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
  getGitAvailability: () => ipcRenderer.invoke(harmonyChannels.gitStatus),
  installGit: () => ipcRenderer.invoke(harmonyChannels.installGit),
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
  watchWorkspaceChanges: async (workspacePath: string, listener: (event: WorkspaceWatchEvent) => void) => {
    const watchId = (await ipcRenderer.invoke(
      harmonyChannels.watchWorkspaceChangesStart,
      workspacePath
    )) as string

    const subscription = (_event: Electron.IpcRendererEvent, payload: WorkspaceWatchEvent): void => {
      if (payload.watchId === watchId) {
        listener(payload)
      }
    }

    ipcRenderer.on(harmonyChannels.workspaceDidChange, subscription)

    return async (): Promise<void> => {
      ipcRenderer.removeListener(harmonyChannels.workspaceDidChange, subscription)
      await ipcRenderer.invoke(harmonyChannels.watchWorkspaceChangesStop, watchId)
    }
  },
  getContextInfo: () => ipcRenderer.invoke(harmonyChannels.getContextInfo),
  searchSkillsMarketplace: (payload) =>
    ipcRenderer.invoke(harmonyChannels.searchSkillsMarketplace, payload),
  auditSkillFromMarketplace: (payload) =>
    ipcRenderer.invoke(harmonyChannels.auditSkillFromMarketplace, payload),
  installSkillFromMarketplace: (payload) =>
    ipcRenderer.invoke(harmonyChannels.installSkillFromMarketplace, payload),
  createTerminal: (payload: CreateTerminalPayload) =>
    ipcRenderer.invoke(harmonyChannels.createTerminal, payload),
  destroyTerminal: (sessionId: string) =>
    ipcRenderer.send(harmonyChannels.destroyTerminal, { sessionId }),
  destroyPersistentTerminal: (persistentId: string) =>
    ipcRenderer.send(harmonyChannels.destroyPersistentTerminal, { persistentId }),
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
  getClaudeQuota: () => ipcRenderer.invoke(harmonyChannels.getClaudeQuota),
  openExternalUrl: (url: string) => ipcRenderer.invoke(harmonyChannels.openExternalUrl, url),
  getUpdateState: () => ipcRenderer.invoke(harmonyChannels.getUpdateState),
  checkForUpdates: () => ipcRenderer.invoke(harmonyChannels.checkForUpdates),
  downloadUpdate: () => ipcRenderer.invoke(harmonyChannels.downloadUpdate),
  installUpdateAndRestart: () => ipcRenderer.invoke(harmonyChannels.installUpdate),
  onUpdateState: (listener) => subscribeToChannel<AppUpdateState>(harmonyChannels.updateState, listener)
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
