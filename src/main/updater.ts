import { app, BrowserWindow, ipcMain } from 'electron'
import electronUpdater from 'electron-updater'
import type { ProgressInfo, UpdateInfo } from 'builder-util-runtime'
import { harmonyChannels, type AppUpdateState } from '../shared/workbench'

const { autoUpdater } = electronUpdater

let initialized = false

function supportsAutoUpdates(): boolean {
  return app.isPackaged
}

function baseUpdateState(): AppUpdateState {
  return {
    phase: supportsAutoUpdates() ? 'idle' : 'unsupported',
    currentVersion: app.getVersion(),
    message: supportsAutoUpdates()
      ? undefined
      : 'Auto-updates are only available in packaged builds.'
  }
}

let updateState: AppUpdateState = baseUpdateState()

function broadcastUpdateState(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(harmonyChannels.updateState, updateState)
    }
  }
}

function setUpdateState(next: AppUpdateState): AppUpdateState {
  updateState = next
  broadcastUpdateState()
  return updateState
}

function patchUpdateState(patch: Partial<AppUpdateState>): AppUpdateState {
  return setUpdateState({
    ...updateState,
    ...patch,
    currentVersion: app.getVersion()
  })
}

function normalizeReleaseNotes(notes: UpdateInfo['releaseNotes']): string | undefined {
  if (!notes) return undefined
  if (typeof notes === 'string') return notes
  if (Array.isArray(notes)) {
    return notes
      .map((item) => {
        if (typeof item === 'string') return item
        if (typeof item.note === 'string') return item.note
        return ''
      })
      .filter(Boolean)
      .join('\n\n')
  }
  return undefined
}

function updateFromInfo(phase: AppUpdateState['phase'], info: UpdateInfo, message?: string): AppUpdateState {
  return setUpdateState({
    ...updateState,
    phase,
    currentVersion: app.getVersion(),
    availableVersion: info.version,
    releaseName: info.releaseName ?? undefined,
    releaseDate: info.releaseDate,
    releaseNotes: normalizeReleaseNotes(info.releaseNotes),
    checkedAt: new Date().toISOString(),
    message
  })
}

function setUpdateError(error: unknown): AppUpdateState {
  const message = error instanceof Error ? error.message : 'Update failed.'
  return setUpdateState({
    ...updateState,
    phase: 'error',
    currentVersion: app.getVersion(),
    message,
    checkedAt: new Date().toISOString()
  })
}

async function checkForUpdates(): Promise<AppUpdateState> {
  if (!supportsAutoUpdates()) {
    return updateState
  }

  try {
    patchUpdateState({
      phase: 'checking',
      checkedAt: new Date().toISOString(),
      message: 'Checking for updates…'
    })
    await autoUpdater.checkForUpdates()
    return updateState
  } catch (error) {
    return setUpdateError(error)
  }
}

async function downloadUpdate(): Promise<void> {
  if (!supportsAutoUpdates()) {
    return
  }

  try {
    patchUpdateState({
      phase: 'downloading',
      message: 'Downloading update…'
    })
    await autoUpdater.downloadUpdate()
  } catch (error) {
    setUpdateError(error)
    throw error
  }
}

function installUpdateAndRestart(): void {
  if (!supportsAutoUpdates() || updateState.phase !== 'downloaded') {
    return
  }

  autoUpdater.quitAndInstall()
}

function bindAutoUpdaterEvents(): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    patchUpdateState({
      phase: 'checking',
      checkedAt: new Date().toISOString(),
      message: 'Checking for updates…'
    })
  })

  autoUpdater.on('update-available', (info) => {
    updateFromInfo('available', info, `Version ${info.version} is available.`)
  })

  autoUpdater.on('update-not-available', () => {
    setUpdateState({
      ...updateState,
      phase: 'not-available',
      currentVersion: app.getVersion(),
      availableVersion: undefined,
      releaseName: undefined,
      releaseDate: undefined,
      releaseNotes: undefined,
      progressPercent: undefined,
      downloadedBytes: undefined,
      totalBytes: undefined,
      checkedAt: new Date().toISOString(),
      message: 'Harmony is up to date.'
    })
  })

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    patchUpdateState({
      phase: 'downloading',
      progressPercent: progress.percent,
      downloadedBytes: progress.transferred,
      totalBytes: progress.total,
      message: `Downloading update… ${progress.percent.toFixed(0)}%`
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    updateFromInfo('downloaded', info, 'Update downloaded. Restart Harmony to install.')
  })

  autoUpdater.on('error', (error) => {
    setUpdateError(error)
  })
}

export function initializeUpdater(): void {
  if (initialized) {
    return
  }

  initialized = true
  updateState = baseUpdateState()

  if (!supportsAutoUpdates()) {
    return
  }

  bindAutoUpdaterEvents()
  window.setTimeout(() => {
    void checkForUpdates()
  }, 4000)
}

export function registerUpdaterIpc(): void {
  ipcMain.handle(harmonyChannels.getUpdateState, () => updateState)
  ipcMain.handle(harmonyChannels.checkForUpdates, async () => checkForUpdates())
  ipcMain.handle(harmonyChannels.downloadUpdate, async () => downloadUpdate())
  ipcMain.handle(harmonyChannels.installUpdate, async () => installUpdateAndRestart())
}
