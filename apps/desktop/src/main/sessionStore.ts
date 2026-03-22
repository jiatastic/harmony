import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { ArchivedPanelTab, PersistedTerminalLayout } from '../shared/workbench'

const TERMINAL_LAYOUT_FILE = 'terminal-layout.json'
const ARCHIVED_TABS_FILE = 'terminal-archived-tabs.json'

const emptyLayout = (): PersistedTerminalLayout => ({
  tabs: [],
  activeTabIds: {}
})

let cachedLayout: PersistedTerminalLayout | null = null
let cachedArchivedTabs: ArchivedPanelTab[] | null = null

function getStorePath(fileName: string): string {
  return join(app.getPath('userData'), fileName)
}

function normalizeLayout(value: unknown): PersistedTerminalLayout {
  if (!value || typeof value !== 'object') {
    return emptyLayout()
  }

  const candidate = value as Partial<PersistedTerminalLayout>
  const tabs = Array.isArray(candidate.tabs) ? candidate.tabs : []
  const activeTabIds =
    candidate.activeTabIds && typeof candidate.activeTabIds === 'object'
      ? Object.fromEntries(
          Object.entries(candidate.activeTabIds).filter(
            ([key, val]) => typeof key === 'string' && (typeof val === 'string' || val === null)
          )
        )
      : {}

  return {
    tabs,
    activeTabIds
  }
}

function normalizeArchivedTabs(value: unknown): ArchivedPanelTab[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter((candidate): candidate is ArchivedPanelTab => {
    if (!candidate || typeof candidate !== 'object') {
      return false
    }

    const tab = candidate as Partial<ArchivedPanelTab>
    if (
      typeof tab.id !== 'string' ||
      typeof tab.type !== 'string' ||
      typeof tab.workspacePath !== 'string' ||
      typeof tab.title !== 'string' ||
      typeof tab.archivedAt !== 'string'
    ) {
      return false
    }

    if (tab.type === 'terminal') {
      return true
    }

    return (
      tab.type === 'browser' &&
      typeof (tab as { url?: unknown }).url === 'string' &&
      typeof (tab as { draftUrl?: unknown }).draftUrl === 'string'
    )
  })
}

async function readStoreFile(fileName: string): Promise<string> {
  return await fs.readFile(getStorePath(fileName), 'utf8').catch(() => '')
}

async function writeStoreFile(fileName: string, value: unknown): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(getStorePath(fileName), JSON.stringify(value), 'utf8')
}

export async function getPersistedTerminalLayout(): Promise<PersistedTerminalLayout> {
  if (cachedLayout) {
    return cachedLayout
  }

  const raw = await readStoreFile(TERMINAL_LAYOUT_FILE)
  if (!raw) {
    cachedLayout = emptyLayout()
    return cachedLayout
  }

  try {
    cachedLayout = normalizeLayout(JSON.parse(raw) as unknown)
  } catch {
    cachedLayout = emptyLayout()
  }

  return cachedLayout
}

export async function savePersistedTerminalLayout(layout: PersistedTerminalLayout): Promise<void> {
  const normalized = normalizeLayout(layout)
  cachedLayout = normalized
  await writeStoreFile(TERMINAL_LAYOUT_FILE, normalized)
}

export async function getArchivedTabs(): Promise<ArchivedPanelTab[]> {
  if (cachedArchivedTabs) {
    return cachedArchivedTabs
  }

  const raw = await readStoreFile(ARCHIVED_TABS_FILE)
  if (!raw) {
    cachedArchivedTabs = []
    return cachedArchivedTabs
  }

  try {
    cachedArchivedTabs = normalizeArchivedTabs(JSON.parse(raw) as unknown)
  } catch {
    cachedArchivedTabs = []
  }

  return cachedArchivedTabs
}

export async function saveArchivedTabs(tabs: ArchivedPanelTab[]): Promise<void> {
  const normalized = normalizeArchivedTabs(tabs)
  cachedArchivedTabs = normalized
  await writeStoreFile(ARCHIVED_TABS_FILE, normalized)
}
