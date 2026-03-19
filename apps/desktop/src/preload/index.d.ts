import { ElectronAPI } from '@electron-toolkit/preload'
import type { HarmonyApi } from '../shared/workbench'

declare global {
  interface Window {
    electron: ElectronAPI
    api: HarmonyApi
  }
}
