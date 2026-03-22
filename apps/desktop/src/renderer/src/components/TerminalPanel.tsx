import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type {
  AgentRun,
  ArchivedPanelTab,
  AvailableAgent,
  PersistedPanelTab,
  PersistentShellSupport,
  PersistedTerminalLayout,
  TerminalLifecycleState,
  TerminalSession
} from '../../../shared/workbench'
import type { TerminalDaemonSessionRecord } from '../../../shared/terminalDaemon'

const cursorIconUrl = new URL('../assets/agents/cursor.png', import.meta.url).href
const codexIconUrl = new URL('../assets/agents/codex.png', import.meta.url).href
const opencodeIconUrl = new URL('../assets/agents/opencode.png', import.meta.url).href
const claudeIconUrl = new URL('../assets/agents/claude.svg', import.meta.url).href
const geminiIconUrl = new URL('../assets/agents/gemini.svg', import.meta.url).href

interface TerminalPanelProps {
  workspacePath: string | null
  onOpenTerminalsChange?: (tabs: OpenTerminalTabSummary[]) => void
  onActiveTerminalTabChange?: (tab: OpenTerminalTabSummary | null) => void
  requestedActiveTab?: { workspacePath: string; tabId: string; nonce: number } | null
}

export interface OpenTerminalTabSummary {
  id: string
  workspacePath: string
  title: string
  status?: AgentRun['status']
  message?: string
  isAgent?: boolean
  agentId?: string
  sessionId?: string
  externalSessionId?: string
}

type AgentViewMode = 'chat' | 'terminal'

type AgentChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
}

type StoredTerminalTab = {
  id: string
  type: 'terminal'
  workspacePath: string
  title: string
  customTitle?: boolean
  agent?: AvailableAgent
  agentRun?: AgentRun
  agentViewMode?: AgentViewMode
  lastKnownStatus?: AgentRun['status']
}

type StoredBrowserTab = {
  id: string
  type: 'browser'
  workspacePath: string
  title: string
  url: string
  draftUrl: string
  customTitle?: boolean
}

type StoredPanelTab = StoredTerminalTab | StoredBrowserTab

type TerminalTab = {
  id: string
  type: 'terminal'
  workspacePath: string
  title: string
  customTitle?: boolean
  sessionId?: string
  runtimeState?: TerminalLifecycleState
  lastExitCode?: number
  restartNonce?: number
  agent?: AvailableAgent
  agentRun?: AgentRun
  agentViewMode: AgentViewMode
  chatMessages: AgentChatMessage[]
  lastKnownStatus?: AgentRun['status']
  restoreState?: 'disconnected' | 'failed' | 'exited'
  autoStart?: boolean
  restoredSnapshot?: string
  launchCommand?: string
  resumeAgent?: boolean
}

type BrowserTab = {
  id: string
  type: 'browser'
  workspacePath: string
  title: string
  customTitle?: boolean
  url: string
  draftUrl: string
}

type PanelTab = TerminalTab | BrowserTab
type ArchivedTerminalTab = StoredTerminalTab & {
  archivedAt: string
  archivedSessionId?: string
}
type ArchivedBrowserTab = StoredBrowserTab & {
  archivedAt: string
}
type ArchivedTab = ArchivedTerminalTab | ArchivedBrowserTab
type TerminalVisualStatus = AgentRun['status'] | 'exited' | 'destroyed'
type ThemeExtras = ITheme & {
  selectionInactiveBackground?: string
  scrollbarSliderBackground?: string
  scrollbarSliderHoverBackground?: string
  scrollbarSliderActiveBackground?: string
  overviewRulerBorder?: string
}

const LEGACY_TERMINAL_LAYOUT_KEY = 'harmony-terminal-layout-v1'

function isStoredAgentRun(value: unknown): value is AgentRun {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<AgentRun>
  return (
    typeof candidate.runId === 'string' &&
    typeof candidate.sessionId === 'string' &&
    typeof candidate.workspacePath === 'string' &&
    typeof candidate.command === 'string' &&
    typeof candidate.displayName === 'string' &&
    typeof candidate.status === 'string' &&
    typeof candidate.startedAt === 'string'
  )
}

function deserializePersistedLayout(layout: PersistedTerminalLayout): {
  tabs: PanelTab[]
  activeTabIds: Record<string, string | null>
} {
  const tabs: PanelTab[] = []
  for (const tab of layout.tabs) {
    if (
      !tab ||
      typeof tab.id !== 'string' ||
      typeof tab.workspacePath !== 'string' ||
      typeof tab.title !== 'string'
    ) {
      continue
    }

    if (tab.type === 'terminal') {
      tabs.push({
        id: tab.id,
        type: 'terminal',
        workspacePath: tab.workspacePath,
        title: sanitizeStoredTerminalTitle(tab.title, tab.workspacePath),
        customTitle: tab.customTitle === true,
        agent: tab.agent,
        agentRun: isStoredAgentRun(tab.agentRun) ? tab.agentRun : undefined,
        agentViewMode: tab.agent ? (tab.agentViewMode ?? 'terminal') : 'terminal',
        chatMessages: [],
        lastKnownStatus: tab.lastKnownStatus
      })
      continue
    }

    if (tab.type === 'browser' && typeof tab.url === 'string' && typeof tab.draftUrl === 'string') {
      tabs.push({
        id: tab.id,
        type: 'browser',
        workspacePath: tab.workspacePath,
        title: tab.title,
        url: tab.url,
        draftUrl: tab.draftUrl,
        customTitle: tab.customTitle === true
      })
    }
  }

  const activeTabIds =
    layout.activeTabIds && typeof layout.activeTabIds === 'object'
      ? Object.fromEntries(
          Object.entries(layout.activeTabIds).filter(
            ([key, value]) => typeof key === 'string' && (typeof value === 'string' || value === null)
          )
        )
      : {}

  return { tabs, activeTabIds }
}

function deserializeArchivedTabs(tabs: ArchivedPanelTab[]): ArchivedTab[] {
  const archivedTabs: ArchivedTab[] = []
  for (const tab of tabs) {
    if (
      !tab ||
      typeof tab.id !== 'string' ||
      typeof tab.workspacePath !== 'string' ||
      typeof tab.title !== 'string' ||
      typeof tab.archivedAt !== 'string'
    ) {
      continue
    }

    if (tab.type === 'terminal') {
      archivedTabs.push({
        id: tab.id,
        type: 'terminal',
        workspacePath: tab.workspacePath,
        title: sanitizeStoredTerminalTitle(tab.title, tab.workspacePath),
        customTitle: tab.customTitle === true,
        agent: tab.agent,
        agentRun: isStoredAgentRun(tab.agentRun) ? tab.agentRun : undefined,
        agentViewMode: tab.agent ? (tab.agentViewMode ?? 'terminal') : 'terminal',
        lastKnownStatus: tab.lastKnownStatus,
        archivedAt: tab.archivedAt,
        archivedSessionId: tab.archivedSessionId
      })
      continue
    }

    if (tab.type === 'browser' && typeof tab.url === 'string' && typeof tab.draftUrl === 'string') {
      archivedTabs.push({
        id: tab.id,
        type: 'browser',
        workspacePath: tab.workspacePath,
        title: tab.title,
        url: tab.url,
        draftUrl: tab.draftUrl,
        customTitle: tab.customTitle === true,
        archivedAt: tab.archivedAt
      })
    }
  }

  return archivedTabs.sort((left, right) => right.archivedAt.localeCompare(left.archivedAt))
}

function inferAgentIdFromCommand(command: string | undefined): string | undefined {
  const normalized = command?.trim().toLowerCase()
  if (!normalized) {
    return undefined
  }

  if (normalized.startsWith('agent')) return 'cursor'
  if (normalized.startsWith('codex')) return 'codex'
  if (normalized.startsWith('opencode')) return 'opencode'
  if (normalized.startsWith('claude')) return 'claude'
  if (normalized.startsWith('gemini')) return 'gemini'
  return undefined
}

function inferAgentFromSession(record: TerminalDaemonSessionRecord): AvailableAgent | undefined {
  const agentId = record.agentId ?? inferAgentIdFromCommand(record.command)
  switch (agentId) {
    case 'cursor':
      return { id: 'cursor', name: 'Cursor CLI', command: 'agent', binaryPath: '' }
    case 'codex':
      return { id: 'codex', name: 'Codex', command: 'codex', binaryPath: '' }
    case 'opencode':
      return { id: 'opencode', name: 'OpenCode', command: 'opencode', binaryPath: '' }
    case 'claude':
      return { id: 'claude', name: 'Claude Code', command: 'claude', binaryPath: '' }
    case 'gemini':
      return { id: 'gemini', name: 'Gemini CLI', command: 'gemini', binaryPath: '' }
    default:
      return undefined
  }
}

function stableDaemonSessionId(record: TerminalDaemonSessionRecord): string {
  return record.sessionKey ?? record.persistentId ?? record.sessionId
}

function daemonSessionStatusPriority(status: TerminalDaemonSessionRecord['status']): number {
  switch (status) {
    case 'working':
      return 7
    case 'waiting':
      return 6
    case 'ready':
      return 5
    case 'restoring':
      return 4
    case 'disconnected':
      return 3
    case 'completed':
    case 'exited':
      return 2
    case 'failed':
      return 1
  }
}

function dedupeDaemonSessions(
  daemonSessions: TerminalDaemonSessionRecord[]
): TerminalDaemonSessionRecord[] {
  const deduped = new Map<string, TerminalDaemonSessionRecord>()

  for (const session of daemonSessions) {
    const stableId = stableDaemonSessionId(session)
    const existing = deduped.get(stableId)
    if (!existing) {
      deduped.set(stableId, session)
      continue
    }

    const priorityDiff =
      daemonSessionStatusPriority(session.status) - daemonSessionStatusPriority(existing.status)
    if (priorityDiff > 0) {
      deduped.set(stableId, session)
      continue
    }

    if (priorityDiff === 0 && existing.updatedAt < session.updatedAt) {
      deduped.set(stableId, session)
    }
  }

  return Array.from(deduped.values())
}

function shouldRestoreDaemonSession(record: TerminalDaemonSessionRecord): boolean {
  switch (record.status) {
    case 'ready':
    case 'working':
    case 'waiting':
    case 'restoring':
      return true
    case 'disconnected':
      return record.kind === 'shell' && Boolean(record.persistentId)
    case 'failed':
    case 'exited':
    case 'completed':
      return false
  }
}

function sanitizeActiveTabIds(
  tabs: PanelTab[],
  activeTabIds: Record<string, string | null>
): Record<string, string | null> {
  const tabIds = new Set(tabs.map((tab) => tab.id))
  const firstTabByWorkspace = new Map<string, string>()

  for (const tab of tabs) {
    if (!firstTabByWorkspace.has(tab.workspacePath)) {
      firstTabByWorkspace.set(tab.workspacePath, tab.id)
    }
  }

  const nextActiveTabIds: Record<string, string | null> = {}
  const workspacePaths = new Set([
    ...Object.keys(activeTabIds),
    ...tabs.map((tab) => tab.workspacePath)
  ])

  for (const workspacePath of workspacePaths) {
    const currentActiveId = activeTabIds[workspacePath]
    if (currentActiveId && tabIds.has(currentActiveId)) {
      nextActiveTabIds[workspacePath] = currentActiveId
      continue
    }

    nextActiveTabIds[workspacePath] = firstTabByWorkspace.get(workspacePath) ?? null
  }

  return nextActiveTabIds
}

function mergeLayoutWithDaemonSessions(
  persistedLayout: { tabs: PanelTab[]; activeTabIds: Record<string, string | null> },
  daemonSessions: TerminalDaemonSessionRecord[],
  archivedTabIds: Set<string>
): { tabs: PanelTab[]; activeTabIds: Record<string, string | null> } {
  const browserTabs = persistedLayout.tabs.filter((tab): tab is BrowserTab => tab.type === 'browser')
  const persistedTerminalTabs = new Map(
    persistedLayout.tabs
      .filter((tab): tab is TerminalTab => tab.type === 'terminal')
      .map((tab) => [tab.id, tab])
  )

  const mergedSessions = dedupeDaemonSessions(daemonSessions).filter(
    (record) => shouldRestoreDaemonSession(record) && !archivedTabIds.has(stableDaemonSessionId(record))
  )

  if (mergedSessions.length === 0) {
    return {
      tabs: browserTabs,
      activeTabIds: sanitizeActiveTabIds(browserTabs, persistedLayout.activeTabIds)
    }
  }

  const daemonTerminalTabs: TerminalTab[] = mergedSessions.map((record) => {
    const stableId = stableDaemonSessionId(record)
    const persisted = persistedTerminalTabs.get(stableId)
    const agent = inferAgentFromSession(record) ?? persisted?.agent
    const autoStart =
      record.kind === 'shell' && Boolean(record.persistentId)
        ? record.status === 'ready' ||
          record.status === 'working' ||
          record.status === 'waiting' ||
          record.status === 'restoring' ||
          record.status === 'disconnected'
        : record.status === 'ready' ||
          record.status === 'working' ||
          record.status === 'waiting' ||
          record.status === 'restoring'
    const restoreState =
      !autoStart && (record.status === 'disconnected' || record.status === 'failed' || record.status === 'exited')
        ? record.status
        : undefined

    return {
      id: stableId,
      type: 'terminal',
      workspacePath: record.workspacePath || record.cwd,
      title: (
        persisted?.title ??
        record.agentRun?.suggestedTitle ??
        record.title ??
        leaf(record.workspacePath || record.cwd)
      ),
      customTitle: persisted?.customTitle ?? Boolean(record.title),
      sessionId: autoStart && record.status !== 'disconnected' ? record.sessionId : undefined,
      runtimeState: record.status === 'exited' ? 'exited' : restoreState ? 'destroyed' : undefined,
      lastExitCode: record.lastKnownExitCode,
      agent,
      agentRun: record.agentRun ?? persisted?.agentRun,
      agentViewMode: persisted?.agentViewMode ?? 'terminal',
      chatMessages: [],
      lastKnownStatus: record.agentRun?.status ?? persisted?.lastKnownStatus,
      restoreState,
      autoStart,
      restoredSnapshot: record.recentOutput
    }
  })

  return {
    tabs: [...browserTabs, ...daemonTerminalTabs],
    activeTabIds: sanitizeActiveTabIds(
      [...browserTabs, ...daemonTerminalTabs],
      persistedLayout.activeTabIds
    )
  }
}

function loadLegacyTerminalLayout(): { tabs: PanelTab[]; activeTabIds: Record<string, string | null> } {
  try {
    const raw = localStorage.getItem(LEGACY_TERMINAL_LAYOUT_KEY)
    if (!raw) {
      return { tabs: [], activeTabIds: {} }
    }

    const parsed = JSON.parse(raw) as PersistedTerminalLayout & {
      tabs?: StoredPanelTab[]
      activeTabIds?: Record<string, string | null>
    }
    return deserializePersistedLayout(parsed)
  } catch {
    return { tabs: [], activeTabIds: {} }
  }
}

function serializePersistedLayout(
  tabs: PanelTab[],
  activeTabIds: Record<string, string | null>
): PersistedTerminalLayout {
  const serializableTabs: PersistedPanelTab[] = tabs.map((tab) =>
    tab.type === 'terminal'
      ? {
          id: tab.id,
          type: 'terminal',
          workspacePath: tab.workspacePath,
          title: tab.title,
          customTitle: tab.customTitle === true,
          agent: tab.agent,
          agentRun: tab.agentRun,
          agentViewMode: tab.agent ? tab.agentViewMode : undefined,
          lastKnownStatus: tab.lastKnownStatus
        }
      : {
          id: tab.id,
          type: 'browser',
          workspacePath: tab.workspacePath,
          title: tab.title,
          url: tab.url,
          draftUrl: tab.draftUrl,
          customTitle: tab.customTitle === true
        }
  )

  return {
    tabs: serializableTabs,
    activeTabIds
  }
}

function serializeArchivedTabs(tabs: ArchivedTab[]): ArchivedPanelTab[] {
  return tabs.map((tab) =>
    tab.type === 'terminal'
      ? {
          id: tab.id,
          type: 'terminal',
          workspacePath: tab.workspacePath,
          title: tab.title,
          customTitle: tab.customTitle === true,
          agent: tab.agent,
          agentRun: tab.agentRun,
          agentViewMode: tab.agent ? tab.agentViewMode : undefined,
          lastKnownStatus: tab.lastKnownStatus,
          archivedAt: tab.archivedAt,
          archivedSessionId: tab.archivedSessionId
        }
      : {
          id: tab.id,
          type: 'browser',
          workspacePath: tab.workspacePath,
          title: tab.title,
          url: tab.url,
          draftUrl: tab.draftUrl,
          customTitle: tab.customTitle === true,
          archivedAt: tab.archivedAt
        }
  )
}

function clearLegacyTerminalLayout(): void {
  try {
    localStorage.removeItem(LEGACY_TERMINAL_LAYOUT_KEY)
  } catch {
    /* ignore */
  }
}

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

function terminalTheme(): ITheme {
  const background = cssVar('--terminal-surface', isDarkMode() ? '#0b0f14' : '#ffffff')
  const foreground = cssVar('--terminal-foreground', isDarkMode() ? '#f0f6fc' : '#111827')
  const cursor = cssVar('--terminal-cursor', isDarkMode() ? '#e6edf3' : '#111827')
  const cursorText = cssVar('--terminal-cursor-text', isDarkMode() ? '#0b0f14' : '#ffffff')
  const selection = cssVar('--terminal-selection', isDarkMode() ? '#264f78' : '#dbeafe')
  const selectionInactive = cssVar(
    '--terminal-selection-inactive',
    isDarkMode() ? 'rgb(124 196 255 / 0.14)' : 'rgb(37 99 235 / 0.1)'
  )
  const selectionText = cssVar('--terminal-selection-text', isDarkMode() ? '#f0f6fc' : '#111827')
  const overviewRulerBorder = cssVar(
    '--terminal-overview-ruler-border',
    isDarkMode() ? 'rgb(148 163 184 / 0.14)' : 'rgb(148 163 184 / 0.18)'
  )
  const scrollbarSliderBackground = cssVar(
    '--terminal-scrollbar-slider',
    isDarkMode() ? 'rgb(148 163 184 / 0.2)' : 'rgb(71 85 105 / 0.18)'
  )
  const scrollbarSliderHoverBackground = cssVar(
    '--terminal-scrollbar-slider-hover',
    isDarkMode() ? 'rgb(148 163 184 / 0.32)' : 'rgb(71 85 105 / 0.28)'
  )
  const scrollbarSliderActiveBackground = cssVar(
    '--terminal-scrollbar-slider-active',
    isDarkMode() ? 'rgb(124 196 255 / 0.4)' : 'rgb(37 99 235 / 0.35)'
  )
  const black = cssVar('--terminal-ansi-black', isDarkMode() ? '#484f58' : '#111827')
  const red = cssVar('--terminal-ansi-red', isDarkMode() ? '#ff7b72' : '#dc2626')
  const green = cssVar('--terminal-ansi-green', isDarkMode() ? '#3fb950' : '#15803d')
  const yellow = cssVar('--terminal-ansi-yellow', isDarkMode() ? '#d29922' : '#b45309')
  const blue = cssVar('--terminal-ansi-blue', isDarkMode() ? '#58a6ff' : '#2563eb')
  const magenta = cssVar('--terminal-ansi-magenta', isDarkMode() ? '#bc8cff' : '#c026d3')
  const cyan = cssVar('--terminal-ansi-cyan', isDarkMode() ? '#39c5cf' : '#0891b2')
  const white = cssVar('--terminal-ansi-white', isDarkMode() ? '#b1bac4' : '#475569')
  const brightBlack = cssVar('--terminal-ansi-bright-black', isDarkMode() ? '#6e7681' : '#334155')
  const brightRed = cssVar('--terminal-ansi-bright-red', isDarkMode() ? '#ffa198' : '#b91c1c')
  const brightGreen = cssVar('--terminal-ansi-bright-green', isDarkMode() ? '#56d364' : '#166534')
  const brightYellow = cssVar('--terminal-ansi-bright-yellow', isDarkMode() ? '#e3b341' : '#a16207')
  const brightBlue = cssVar('--terminal-ansi-bright-blue', isDarkMode() ? '#79c0ff' : '#1d4ed8')
  const brightMagenta = cssVar('--terminal-ansi-bright-magenta', isDarkMode() ? '#d2a8ff' : '#a21caf')
  const brightCyan = cssVar('--terminal-ansi-bright-cyan', isDarkMode() ? '#56d4dd' : '#0e7490')
  const brightWhite = cssVar('--terminal-ansi-bright-white', isDarkMode() ? '#f0f6fc' : '#0f172a')

  const theme: ThemeExtras = {
    background,
    foreground,
    cursor,
    cursorAccent: cursorText,
    selectionBackground: selection,
    selectionForeground: selectionText,
    selectionInactiveBackground: selectionInactive,
    overviewRulerBorder,
    scrollbarSliderBackground,
    scrollbarSliderHoverBackground,
    scrollbarSliderActiveBackground,
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite
  }

  return theme
}

const OSC_TERMINATOR = '\u001b\\'
const SHIFT_ENTER_SEQUENCE = '\u001b[13;2u'

function parseCssColorToRgb(value: string): [number, number, number] | null {
  const normalized = value.trim()
  if (!normalized) {
    return null
  }

  const shortHexMatch = normalized.match(/^#([\da-f]{3})$/i)
  if (shortHexMatch) {
    return shortHexMatch[1].split('').map((chunk) => parseInt(chunk + chunk, 16)) as [
      number,
      number,
      number
    ]
  }

  const hexMatch = normalized.match(/^#([\da-f]{6})$/i)
  if (hexMatch) {
    return [
      parseInt(hexMatch[1].slice(0, 2), 16),
      parseInt(hexMatch[1].slice(2, 4), 16),
      parseInt(hexMatch[1].slice(4, 6), 16)
    ]
  }

  const rgbMatch = normalized.match(
    /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})(?:\s*[,/]\s*[\d.]+\s*)?\)$/i
  )
  if (rgbMatch) {
    return [rgbMatch[1], rgbMatch[2], rgbMatch[3]].map((chunk) =>
      Math.max(0, Math.min(255, parseInt(chunk, 10)))
    ) as [number, number, number]
  }

  return null
}

function toOscRgbString(value: string, fallback: string): string {
  const [r, g, b] = parseCssColorToRgb(value) ?? parseCssColorToRgb(fallback) ?? [0, 0, 0]
  const toChannel = (channel: number): string => channel.toString(16).padStart(2, '0').repeat(2)
  return `rgb:${toChannel(r)}/${toChannel(g)}/${toChannel(b)}`
}

function terminalAnsiPalette(theme: ITheme): string[] {
  return [
    theme.black ?? '#000000',
    theme.red ?? '#cd3131',
    theme.green ?? '#0dbc79',
    theme.yellow ?? '#e5e510',
    theme.blue ?? '#2472c8',
    theme.magenta ?? '#bc3fbc',
    theme.cyan ?? '#11a8cd',
    theme.white ?? '#e5e5e5',
    theme.brightBlack ?? '#666666',
    theme.brightRed ?? '#f14c4c',
    theme.brightGreen ?? '#23d18b',
    theme.brightYellow ?? '#f5f543',
    theme.brightBlue ?? '#3b8eea',
    theme.brightMagenta ?? '#d670d6',
    theme.brightCyan ?? '#29b8db',
    theme.brightWhite ?? '#ffffff'
  ]
}

function inspectTerminalDomColors(host: HTMLDivElement, sessionId: string, dataSample: string): boolean {
  const styleElements = Array.from(host.querySelectorAll('style'))
  const styleSummaries = styleElements.map((element, index) => {
    const text = element.textContent ?? ''
    return {
      index,
      length: text.length,
      hasFgRule: text.includes('.xterm-fg-1'),
      hasBgRule: text.includes('.xterm-bg-1')
    }
  })

  const coloredSpans = Array.from(
    host.querySelectorAll<HTMLElement>('.xterm-rows span[class*="xterm-fg-"], .xterm-rows span[class*="xterm-bg-"]')
  )
  const sampledColoredSpans = coloredSpans.slice(0, 12).map((span) => ({
    text: JSON.stringify(span.textContent ?? ''),
    className: span.className,
    color: getComputedStyle(span).color,
    backgroundColor: getComputedStyle(span).backgroundColor
  }))

  const sampledPlainSpans = Array.from(host.querySelectorAll<HTMLElement>('.xterm-rows span'))
    .slice(0, 12)
    .map((span) => ({
      text: JSON.stringify(span.textContent ?? ''),
      className: span.className,
      color: getComputedStyle(span).color,
      backgroundColor: getComputedStyle(span).backgroundColor
    }))

  console.groupCollapsed(`[Harmony/xterm debug] session=${sessionId}`)
  console.info('payload', {
    containsAnsi: /\u001b\[[0-9;]*m/.test(dataSample),
    sample: JSON.stringify(dataSample.slice(0, 160))
  })
  console.info('styleElements', styleSummaries)
  console.info('coloredSpans', sampledColoredSpans)
  console.info('plainSpans', sampledPlainSpans)
  console.groupEnd()

  return sampledColoredSpans.length > 0
}

function buildOscColorReply(sequence: string): string {
  return `\u001b]${sequence}${OSC_TERMINATOR}`
}

function isDarkMode(): boolean {
  return document.documentElement.classList.contains('dark')
}

function leaf(path: string | null): string {
  if (!path) return 'Terminal'
  return path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? 'Terminal'
}

function uuid(): string {
  return crypto.randomUUID()
}

function normalizeUrl(raw: string): string {
  const value = raw.trim()
  if (!value) return 'https://example.com'
  if (/^https?:\/\//i.test(value)) return value
  return `https://${value}`
}

function truncateTitle(value: string, max = 36): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (compact.length <= max) return compact
  return `${compact.slice(0, max - 1)}…`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function relativeTimeFromNow(iso: string): string {
  const deltaMs = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(deltaMs)) {
    return 'just now'
  }

  const absSeconds = Math.max(1, Math.round(Math.abs(deltaMs) / 1000))
  if (absSeconds < 60) {
    return deltaMs >= 0 ? 'just now' : 'in a moment'
  }

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['minute', 60],
    ['hour', 60 * 60],
    ['day', 60 * 60 * 24],
    ['week', 60 * 60 * 24 * 7]
  ]
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

  for (let index = units.length - 1; index >= 0; index -= 1) {
    const [unit, secondsPerUnit] = units[index]
    if (absSeconds >= secondsPerUnit || unit === 'minute') {
      const value = Math.round(deltaMs / 1000 / secondsPerUnit)
      return formatter.format(-value, unit)
    }
  }

  return 'just now'
}

function buildAgentResumeCommand(agent: AvailableAgent, agentRun?: AgentRun): string {
  const externalSessionId = agentRun?.externalSessionId?.trim()
  switch (agent.id) {
    case 'cursor':
      return externalSessionId
        ? `${agent.command} --resume=${shellQuote(externalSessionId)}`
        : `${agent.command} --continue`
    case 'claude':
      return externalSessionId ? `${agent.command} -r ${shellQuote(externalSessionId)}` : `${agent.command} -c`
    case 'gemini':
      return externalSessionId ? `${agent.command} -r ${shellQuote(externalSessionId)}` : `${agent.command} -r latest`
    case 'opencode':
      return externalSessionId
        ? `${agent.command} --session ${shellQuote(externalSessionId)}`
        : `${agent.command} --continue`
    case 'codex':
      return externalSessionId
        ? `${agent.command} resume ${shellQuote(externalSessionId)}`
        : `${agent.command} resume --last`
    default:
      return agent.command
  }
}

function hasTerminalControlArtifacts(value: string): boolean {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (!compact) {
    return false
  }

  return [
    /^corrupted terminal input$/i,
    /^\[[0-9;?]*[A-Za-z]/,
    /\[[0-9;?]*c\b/,
    /\[[0-9;?]*R\b/,
    /\[[0-9;?]*n\b/,
    /]\d+;rgb:/i,
    /\brgb:[0-9a-f]{2,4}\/[0-9a-f]{2,4}\/[0-9a-f]{2,4}\b/i,
    /\b(?:\?1;2c|4;\d+;\?|10;\?|11;\?|12;\?)\b/
  ].some((pattern) => pattern.test(compact))
}

function sanitizeStoredTerminalTitle(title: string, workspacePath: string): string {
  const normalized = stripAnsi(title)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized || hasTerminalControlArtifacts(normalized)) {
    return leaf(workspacePath)
  }

  return truncateTitle(normalized, 48)
}

function normalizeTerminalTitle(rawTitle: string, workspacePath: string, fallbackTitle: string): string | null {
  const title = stripAnsi(rawTitle)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!title) {
    return null
  }

  const lower = title.toLowerCase()
  if (lower.includes('harmony-') && (lower.includes(':zsh') || lower.includes(':bash'))) {
    return null
  }

  if (hasTerminalControlArtifacts(title)) {
    return null
  }

  const primarySegment = title.split(/[·|]/)[0]?.trim() ?? title
  const normalizedPath = primarySegment.replace(/\\/g, '/')
  const pathLeaf = normalizedPath.split('/').filter(Boolean).at(-1)

  if (pathLeaf && pathLeaf !== '~' && pathLeaf !== '.' && pathLeaf.length <= 48) {
    return truncateTitle(pathLeaf)
  }

  if (title.length <= 48 && title.toLowerCase() !== fallbackTitle.toLowerCase()) {
    return truncateTitle(title)
  }

  const workspaceLeaf = leaf(workspacePath)
  return workspaceLeaf !== fallbackTitle ? truncateTitle(workspaceLeaf) : null
}

function titleFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname
    return host || 'Browser'
  } catch {
    return 'Browser'
  }
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1B\][^\u0007\x1B]*(?:\u0007|\x1B\\)/g, '')
    .replace(/\x1B[P^_][\s\S]*?\x1B\\/g, '')
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
}

function normalizeChatChunk(value: string): string {
  return stripAnsi(value)
    .replace(/\r/g, '')
    .replace(/\u0007/g, '')
    .replace(/^\s*\d+(?:;\??\d+)+(?:;\??)?/gm, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      if (!trimmed) {
        return true
      }

      if (/^[╭╮╰╯│─┌┐└┘├┤┬┴┼\s]+$/.test(trimmed)) {
        return false
      }

      if (/^>_ /.test(trimmed)) {
        return false
      }

      if (/^│.*│$/.test(trimmed)) {
        return false
      }

      return true
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
}

function hasVisibleChatContent(value: string): boolean {
  return value.replace(/\s+/g, '').length > 0
}

function shouldCaptureSystemChunk(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    return false
  }

  return ['error', 'failed', 'exit', 'denied', 'timed out', 'warning'].some((needle) => normalized.includes(needle))
}

function makeDisplayTitleMap(tabs: PanelTab[]): Map<string, string> {
  const duplicates = new Map<string, number>()
  const displayTitles = new Map<string, string>()

  for (const tab of tabs) {
    const key = `${tab.workspacePath}::${tab.title}`
    duplicates.set(key, (duplicates.get(key) ?? 0) + 1)
  }

  const seen = new Map<string, number>()
  for (const tab of tabs) {
    const key = `${tab.workspacePath}::${tab.title}`
    const count = duplicates.get(key) ?? 0
    if (count <= 1) {
      displayTitles.set(tab.id, tab.title)
      continue
    }

    const nextIndex = (seen.get(key) ?? 0) + 1
    seen.set(key, nextIndex)
    displayTitles.set(tab.id, `${tab.title} · ${nextIndex}`)
  }

  return displayTitles
}

function canMeasureTerminalHost(host: HTMLDivElement): boolean {
  return host.isConnected && host.clientWidth > 0 && host.clientHeight > 0
}

function appendChatChunk(
  messages: AgentChatMessage[],
  role: AgentChatMessage['role'],
  chunk: string
): AgentChatMessage[] {
  if (!hasVisibleChatContent(chunk)) {
    return messages
  }

  const last = messages.at(-1)
  if (last && last.role === role) {
    return [
      ...messages.slice(0, -1),
      {
        ...last,
        content: `${last.content}${chunk}`
      }
    ]
  }

  return [...messages, { id: uuid(), role, content: chunk }]
}

function addUserChatMessage(messages: AgentChatMessage[], content: string): AgentChatMessage[] {
  const trimmed = content.trim()
  if (!trimmed) {
    return messages
  }

  return [...messages, { id: uuid(), role: 'user', content: trimmed }]
}

function archivedKindLabel(tab: ArchivedTab): string {
  if (tab.type === 'browser') {
    return 'Browser'
  }
  if (!tab.agent) {
    return 'Shell'
  }
  return tab.agent.name
}

function archivedRestoreCopy(tab: ArchivedTab): string {
  if (tab.type === 'browser') {
    return 'Saved page tab.'
  }
  if (!tab.agent) {
    return 'Persistent shell session.'
  }
  if (tab.archivedSessionId) {
    return 'Reconnect live session, or resume the provider session.'
  }
  if (tab.agentRun?.externalSessionId) {
    return 'Resume the same provider session.'
  }
  return 'Continue the latest provider session.'
}

interface BrowserPaneProps {
  tab: BrowserTab
  visible: boolean
  onDraftChange: (id: string, draftUrl: string) => void
  onNavigate: (id: string) => void
}

interface DidFailLoadEvent extends Event {
  errorDescription: string
  errorCode: number
  validatedURL: string
}

interface BrowserWebviewElement extends HTMLElement {
  src: string
  loadURL?: (url: string) => void
  reload?: () => void
}

function describeWebviewError(event: DidFailLoadEvent): string {
  if (event.errorDescription === 'ERR_BLOCKED_BY_RESPONSE') {
    return 'This site blocks being embedded in Harmony. Use Open to view it in your default browser.'
  }

  return event.errorDescription || `Failed to load ${event.validatedURL}`
}

function BrowserPane({ tab, visible, onDraftChange, onNavigate }: BrowserPaneProps): React.JSX.Element {
  const webviewRef = useRef<BrowserWebviewElement | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    const el = webviewRef.current
    if (!el) return

    const handleStart = (): void => {
      setIsLoading(true)
      setLoadError(null)
    }

    const handleStop = (): void => {
      setIsLoading(false)
    }

    const handleDomReady = (): void => {
      setIsLoading(false)
      setLoadError(null)
    }

    const handleFail = (event: Event): void => {
      const e = event as DidFailLoadEvent
      if (e.errorCode === -3) return
      setIsLoading(false)
      setLoadError(describeWebviewError(e))
    }

    el.addEventListener('did-start-loading', handleStart)
    el.addEventListener('did-stop-loading', handleStop)
    el.addEventListener('dom-ready', handleDomReady)
    el.addEventListener('did-fail-load', handleFail)

    return () => {
      el.removeEventListener('did-start-loading', handleStart)
      el.removeEventListener('did-stop-loading', handleStop)
      el.removeEventListener('dom-ready', handleDomReady)
      el.removeEventListener('did-fail-load', handleFail)
    }
  }, [])

  useEffect(() => {
    setIsLoading(true)
    setLoadError(null)
    const el = webviewRef.current
    if (!el) return
    el.src = tab.url
  }, [tab.url])

  useEffect(() => {
    if (!visible) return
    const el = webviewRef.current
    if (!el) return

    // Re-assert the URL when needed, but avoid forced reloads that wipe page state.
    window.requestAnimationFrame(() => {
      if (el.src !== tab.url) {
        el.src = tab.url
      }
    })
  }, [tab.url, visible])

  return (
    <div className="browser-pane" style={{ display: visible ? 'flex' : 'none' }}>
      <form
        className="browser-toolbar"
        onSubmit={(e) => {
          e.preventDefault()
          onNavigate(tab.id)
        }}
      >
        <input
          className="browser-url-input"
          type="text"
          spellCheck={false}
          value={tab.draftUrl}
          aria-label="Browser URL"
          onChange={(e) => onDraftChange(tab.id, e.target.value)}
        />
        <button className="browser-go-btn" type="submit">
          Go
        </button>
        <button
          className="browser-open-btn"
          type="button"
          onClick={() => {
            void window.api.openExternalUrl(normalizeUrl(tab.draftUrl))
          }}
        >
          Open
        </button>
      </form>
      <div className="browser-status" role="status" aria-live="polite">
        {loadError ? `Load failed: ${loadError}` : isLoading ? 'Loading...' : `Viewing ${tab.url}`}
      </div>
      <div className="browser-webview-shell">
        {loadError && (
          <div className="browser-error-overlay" role="alert">
            <p>{loadError}</p>
            <button
              className="browser-open-btn"
              type="button"
              onClick={() => {
                void window.api.openExternalUrl(tab.url)
              }}
            >
              Open in Browser
            </button>
          </div>
        )}
        <webview
          ref={webviewRef}
          className="browser-webview"
          src={tab.url}
          allowpopups={true}
        />
      </div>
    </div>
  )
}

const AGENT_BRANDS: Record<
  string,
  { fallbackLabel: string; bg: string; fg: string; iconUrl?: string }
> = {
  cursor: {
    fallbackLabel: 'C',
    bg: '#111111',
    fg: '#ffffff',
    iconUrl: cursorIconUrl
  },
  codex: {
    fallbackLabel: 'O',
    bg: '#111111',
    fg: '#ffffff',
    iconUrl: codexIconUrl
  },
  opencode: {
    fallbackLabel: 'O',
    bg: '#2563eb',
    fg: '#ffffff',
    iconUrl: opencodeIconUrl
  },
  claude: {
    fallbackLabel: 'C',
    bg: '#d97706',
    fg: '#ffffff',
    iconUrl: claudeIconUrl
  },
  gemini: {
    fallbackLabel: 'G',
    bg: '#7c3aed',
    fg: '#ffffff',
    iconUrl: geminiIconUrl
  }
}

function AgentIcon({ id }: { id: string }): React.JSX.Element {
  const icon = AGENT_BRANDS[id] ?? { bg: '#6b7280', fg: '#ffffff', fallbackLabel: '?' }
  const showFallback = !icon.iconUrl

  return (
    <span
      className={`agent-icon${showFallback ? ' is-fallback' : ''}`}
      aria-hidden="true"
      style={showFallback ? { background: icon.bg, color: icon.fg } : undefined}
    >
      {showFallback ? (
        icon.fallbackLabel
      ) : (
        <img className="agent-icon-image" src={icon.iconUrl} alt="" loading="lazy" />
      )}
    </span>
  )
}

interface TerminalHostProps {
  tabId: string
  title: string
  workspacePath: string
  visible: boolean
  restartNonce?: number
  autoStart?: boolean
  initialSnapshot?: string
  agent?: AvailableAgent
  agentRunSnapshot?: AgentRun
  launchCommand?: string
  resumeAgent?: boolean
  onSessionChange?: (sessionId: string | null) => void
  onRuntimeStateChange?: (state: TerminalLifecycleState, exitCode?: number) => void
  onTitleChange?: (title: string) => void
  onOutputData?: (data: string) => void
  onInputData?: (data: string) => void
}

function TerminalHost({
  tabId,
  title,
  workspacePath,
  visible,
  restartNonce,
  autoStart = true,
  initialSnapshot,
  agent,
  agentRunSnapshot,
  launchCommand,
  resumeAgent = false,
  onSessionChange,
  onRuntimeStateChange,
  onTitleChange,
  onOutputData,
  onInputData
}: TerminalHostProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const xtermRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionRef = useRef<TerminalSession | null>(null)
  const didStartAgentRef = useRef(false)
  const colorDebugLoggedRef = useRef(false)
  const wheelRemainderRef = useRef(0)
  const titleRef = useRef(title)
  const agentRunSnapshotRef = useRef(agentRunSnapshot)
  const onSessionChangeRef = useRef(onSessionChange)
  const onRuntimeStateChangeRef = useRef(onRuntimeStateChange)
  const onTitleChangeRef = useRef(onTitleChange)
  const onOutputDataRef = useRef(onOutputData)
  const onInputDataRef = useRef(onInputData)

  const focusTerminal = useCallback((): void => {
    const host = hostRef.current
    if (host) {
      host.focus({ preventScroll: true })
    }

    const focusNow = (): void => {
      xtermRef.current?.focus()
    }

    // Defer focus so it wins over launcher/drawer button teardown, then retry
    // after nearby UI transitions settle to keep the hidden xterm textarea
    // focused for immediate typing.
    window.requestAnimationFrame(() => {
      focusNow()
      for (const delay of [40, 220]) {
        window.setTimeout(() => {
          focusNow()
        }, delay)
      }
    })
  }, [])

  useEffect(() => {
    onSessionChangeRef.current = onSessionChange
  }, [onSessionChange])

  useEffect(() => {
    onRuntimeStateChangeRef.current = onRuntimeStateChange
  }, [onRuntimeStateChange])

  useEffect(() => {
    onTitleChangeRef.current = onTitleChange
  }, [onTitleChange])

  useEffect(() => {
    onOutputDataRef.current = onOutputData
  }, [onOutputData])

  useEffect(() => {
    onInputDataRef.current = onInputData
  }, [onInputData])

  useEffect(() => {
    titleRef.current = title
  }, [title])

  useEffect(() => {
    agentRunSnapshotRef.current = agentRunSnapshot
  }, [agentRunSnapshot])

  useEffect(() => {
    const session = sessionRef.current
    if (!session || !title.trim()) {
      return
    }

    void window.api.updateTerminalSessionMetadata(session.sessionId, { title })
  }, [title])

  useEffect(() => {
    if (!hostRef.current) return

    let cancelled = false
    const host = hostRef.current
    didStartAgentRef.current = false
    const term = new Terminal({
      allowTransparency: true,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',
      fontFamily: `'SF Mono', SFMono-Regular, ui-monospace, ${cssVar('--font-mono', "'Fira Code', monospace")}, Menlo, monospace`,
      fontSize: 14,
      fontWeight: '500',
      lineHeight: 1.28,
      letterSpacing: 0,
      minimumContrastRatio: 1,
      scrollback: 5000,
      theme: terminalTheme()
    })

    const fit = new FitAddon()
    fitRef.current = fit
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.attachCustomKeyEventHandler((event) => {
      if (
        event.type === 'keydown' &&
        agent?.command &&
        event.key === 'Enter' &&
        event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        const session = sessionRef.current
        if (!session) {
          return false
        }

        event.preventDefault()
        event.stopPropagation()
        void window.api.writeTerminal(session.sessionId, SHIFT_ENTER_SEQUENCE)
        return false
      }

      return true
    })
    const oscDisposables = [
      term.parser.registerOscHandler(4, (data) => {
        const session = sessionRef.current
        if (!session) {
          return false
        }

        const palette = terminalAnsiPalette(terminalTheme())
        const slots = data.split(';')
        const reports: string[] = []
        while (slots.length > 1) {
          const index = Number.parseInt(slots.shift() ?? '', 10)
          const spec = slots.shift()
          if (!Number.isInteger(index) || index < 0 || index >= palette.length || spec !== '?') {
            continue
          }
          reports.push(`4;${index};${toOscRgbString(palette[index], '#000000')}`)
        }

        if (!reports.length) {
          return false
        }

        for (const report of reports) {
          window.api.writeTerminal(session.sessionId, buildOscColorReply(report))
        }
        return true
      }),
      term.parser.registerOscHandler(10, (data) => {
        const session = sessionRef.current
        if (!session || data !== '?') {
          return false
        }

        const theme = terminalTheme()
        window.api.writeTerminal(
          session.sessionId,
          buildOscColorReply(`10;${toOscRgbString(theme.foreground ?? '#111827', '#111827')}`)
        )
        return true
      }),
      term.parser.registerOscHandler(11, (data) => {
        const session = sessionRef.current
        if (!session || data !== '?') {
          return false
        }

        const theme = terminalTheme()
        window.api.writeTerminal(
          session.sessionId,
          buildOscColorReply(`11;${toOscRgbString(theme.background ?? '#ffffff', '#ffffff')}`)
        )
        return true
      }),
      term.parser.registerOscHandler(12, (data) => {
        const session = sessionRef.current
        if (!session || data !== '?') {
          return false
        }

        const theme = terminalTheme()
        window.api.writeTerminal(
          session.sessionId,
          buildOscColorReply(`12;${toOscRgbString(theme.cursor ?? '#111827', '#111827')}`)
        )
        return true
      })
    ]
    term.attachCustomWheelEventHandler((event) => {
      // Always map trackpad/mouse wheel gestures to the xterm viewport so they
      // scroll terminal history instead of being forwarded to the shell app.
      if (event.ctrlKey || event.metaKey || event.deltaY === 0) {
        return true
      }

      const fontSize = term.options.fontSize ?? 13
      const lineHeight = term.options.lineHeight ?? 1
      const pixelsPerLine = fontSize * lineHeight
      if (!pixelsPerLine) {
        return true
      }

      wheelRemainderRef.current += event.deltaY / pixelsPerLine
      const lineDelta =
        wheelRemainderRef.current > 0
          ? Math.floor(wheelRemainderRef.current)
          : Math.ceil(wheelRemainderRef.current)

      if (lineDelta === 0) {
        event.preventDefault()
        return false
      }

      wheelRemainderRef.current -= lineDelta
      term.scrollLines(lineDelta)
      event.preventDefault()
      return false
    })
    term.open(host)
    fit.fit()
    xtermRef.current = term
    focusTerminal()

    const handlePointerDown = (): void => {
      focusTerminal()
    }
    host.addEventListener('pointerdown', handlePointerDown)
    host.addEventListener('mousedown', handlePointerDown)
    host.addEventListener('click', handlePointerDown)

    const syncTerminalSize = (): void => {
      if (!canMeasureTerminalHost(host)) {
        return
      }

      fit.fit()
      const s = sessionRef.current
      if (s && term.cols > 0 && term.rows > 0) {
        window.api.resizeTerminal(s.sessionId, term.cols, term.rows)
      }
    }

    const ro = new ResizeObserver(() => {
      syncTerminalSize()
    })
    ro.observe(host)

    const offData = window.api.onTerminalData((ev) => {
      const matchesCurrentSession = ev.sessionId === sessionRef.current?.sessionId
      const matchesPendingTab = !sessionRef.current && ev.sessionKey === tabId
      if (matchesCurrentSession || matchesPendingTab) {
        term.write(ev.data, () => {
          if (colorDebugLoggedRef.current) {
            return
          }

          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
              const currentSessionId = sessionRef.current?.sessionId
              if (!currentSessionId || currentSessionId !== ev.sessionId || !host.isConnected) {
                return
              }

              colorDebugLoggedRef.current = inspectTerminalDomColors(host, currentSessionId, ev.data)
            })
          })
        })
        onOutputDataRef.current?.(ev.data)
      }
    })

    const offExit = window.api.onTerminalExit((ev) => {
      if (ev.sessionId === sessionRef.current?.sessionId) {
        term.writeln(`\r\n[exited ${ev.exitCode}]`)
        window.api.detachTerminal(ev.sessionId)
      }
    })

    const offState = window.api.onTerminalState((ev) => {
      if (ev.sessionId !== sessionRef.current?.sessionId) {
        return
      }

      onRuntimeStateChangeRef.current?.(ev.state, ev.exitCode)

      if (ev.state !== 'running') {
        sessionRef.current = null
        onSessionChangeRef.current?.(null)
      }
    })

    const inputOff = term.onData((data) => {
      const s = sessionRef.current
      if (s) {
        onInputDataRef.current?.(data)
        window.api.writeTerminal(s.sessionId, data)
      }
    })

    const resizeOff = term.onResize(({ cols, rows }) => {
      const s = sessionRef.current
      if (s) window.api.resizeTerminal(s.sessionId, cols, rows)
    })

    const titleOff = term.onTitleChange((title) => {
      onTitleChangeRef.current?.(title)
    })

    const themeObserver = new MutationObserver(() => {
      term.options.fontFamily = `${cssVar('--font-mono', "'Fira Code', monospace")}, 'SF Mono', Menlo, monospace`
      term.options.theme = terminalTheme()
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    })

    if (!autoStart) {
      if (initialSnapshot) {
        term.write(initialSnapshot)
      }
      fit.fit()
      return () => {
        cancelled = true
        themeObserver.disconnect()
        ro.disconnect()
        offData()
        offExit()
        offState()
        inputOff.dispose()
        resizeOff.dispose()
        titleOff.dispose()
        host.removeEventListener('pointerdown', handlePointerDown)
        host.removeEventListener('mousedown', handlePointerDown)
        host.removeEventListener('click', handlePointerDown)
        onSessionChangeRef.current?.(null)
        sessionRef.current = null
        fitRef.current = null
        xtermRef.current = null
        colorDebugLoggedRef.current = false
        wheelRemainderRef.current = 0
        for (const disposable of oscDisposables) {
          disposable.dispose()
        }
        term.dispose()
      }
    }

    void window.api
      .createTerminal({
        cwd: workspacePath,
        themeHint: isDarkMode() ? 'dark' : 'light',
        sessionKey: tabId,
        persistentId: agent ? undefined : tabId,
        initialCommand: launchCommand ?? agent?.command
      })
      .then((session) => {
        if (cancelled) {
          window.api.detachTerminal(session.sessionId)
          return
        }
        sessionRef.current = session
        if (session.snapshot) {
          term.write(session.snapshot)
        }
        onSessionChangeRef.current?.(session.sessionId)
        onRuntimeStateChangeRef.current?.(session.state, session.exitCode)
        void window.api.updateTerminalSessionMetadata(session.sessionId, { title: titleRef.current })
        syncTerminalSize()
        focusTerminal()
        if (agent?.command && !didStartAgentRef.current) {
          didStartAgentRef.current = true
          const shouldRestoreAgentRun = Boolean(resumeAgent || session.restored)
          const currentAgentRunSnapshot = agentRunSnapshotRef.current
          const nextAgentCommand = launchCommand ?? agent.command
          const syncAgentRun = shouldRestoreAgentRun
            ? window.api.restoreAgent({
                sessionId: session.sessionId,
                workspacePath,
                command: nextAgentCommand,
                displayName: agent.name,
                externalSessionId: currentAgentRunSnapshot?.externalSessionId,
                suggestedTitle: titleRef.current,
                status: currentAgentRunSnapshot?.status ?? 'running',
                startedAt: currentAgentRunSnapshot?.startedAt,
                finishedAt: currentAgentRunSnapshot?.finishedAt,
                exitCode: currentAgentRunSnapshot?.exitCode,
                signal: currentAgentRunSnapshot?.signal,
                message: currentAgentRunSnapshot?.message
              })
            : window.api.startAgent({
                sessionId: session.sessionId,
                workspacePath,
                command: nextAgentCommand,
                displayName: agent.name,
                suggestedTitle: titleRef.current
              })

          void syncAgentRun
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : 'Agent failed to start'
              term.writeln(`\r\n[agent error] ${msg}`)
            })
            .finally(() => {
              focusTerminal()
            })
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : 'Shell failed'
          term.writeln(`[error] ${msg}`)
        }
      })

    return () => {
      cancelled = true
      themeObserver.disconnect()
      ro.disconnect()
      offData()
      offExit()
      offState()
      inputOff.dispose()
      resizeOff.dispose()
      titleOff.dispose()
      host.removeEventListener('pointerdown', handlePointerDown)
      host.removeEventListener('mousedown', handlePointerDown)
      host.removeEventListener('click', handlePointerDown)
      const s = sessionRef.current
      if (s) window.api.detachTerminal(s.sessionId)
      onSessionChangeRef.current?.(null)
      sessionRef.current = null
      fitRef.current = null
      xtermRef.current = null
      colorDebugLoggedRef.current = false
      wheelRemainderRef.current = 0
      for (const disposable of oscDisposables) {
        disposable.dispose()
      }
      term.dispose()
    }
  }, [
    agent?.command,
    agent?.name,
    autoStart,
    initialSnapshot,
    launchCommand,
    restartNonce,
    resumeAgent,
    tabId,
    workspacePath
  ])

  useEffect(() => {
    if (visible) {
      const host = hostRef.current
      if (host && canMeasureTerminalHost(host)) {
        fitRef.current?.fit()
      }
      focusTerminal()
    }
  }, [focusTerminal, visible])

  return (
    <div
      ref={hostRef}
      className="terminal-host"
      tabIndex={-1}
      style={{ display: visible ? 'flex' : 'none' }}
    />
  )
}

export function TerminalPanel({
  workspacePath,
  onOpenTerminalsChange,
  onActiveTerminalTabChange,
  requestedActiveTab
}: TerminalPanelProps): React.JSX.Element {
  const initialLegacyLayoutRef = useRef<{ tabs: PanelTab[]; activeTabIds: Record<string, string | null> } | null>(
    null
  )
  if (initialLegacyLayoutRef.current === null) {
    initialLegacyLayoutRef.current = loadLegacyTerminalLayout()
  }

  const [tabs, setTabs] = useState<PanelTab[]>(() => initialLegacyLayoutRef.current?.tabs ?? [])
  const [activeTabIds, setActiveTabIds] = useState<Record<string, string | null>>(
    () => initialLegacyLayoutRef.current?.activeTabIds ?? {}
  )
  const [persistentShellSupport, setPersistentShellSupport] = useState<PersistentShellSupport | null>(null)
  const [layoutHydrated, setLayoutHydrated] = useState(false)
  const [archivedTabs, setArchivedTabs] = useState<ArchivedTab[]>([])
  const [archiveDrawerOpen, setArchiveDrawerOpen] = useState(false)
  const [showAllArchived, setShowAllArchived] = useState(false)
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [launchingAgent, setLaunchingAgent] = useState<AvailableAgent | null>(null)
  const [agentTaskDraft, setAgentTaskDraft] = useState('')
  const [availableAgents, setAvailableAgents] = useState<AvailableAgent[]>([])
  const initializedWorkspacesRef = useRef(
    new Set((initialLegacyLayoutRef.current?.tabs ?? []).map((tab) => tab.workspacePath))
  )
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const agentTaskInputRef = useRef<HTMLInputElement | null>(null)
  const terminalInputBuffersRef = useRef<Record<string, string>>({})
  const terminalEchoSuppressionsRef = useRef<Record<string, string>>({})
  const handledRequestedActiveTabNonceRef = useRef<number | null>(null)

  const currentWorkspaceTabs = useMemo(
    () => (workspacePath ? tabs.filter((tab) => tab.workspacePath === workspacePath) : []),
    [tabs, workspacePath]
  )
  const currentWorkspaceDisplayTitles = useMemo(
    () => makeDisplayTitleMap(currentWorkspaceTabs),
    [currentWorkspaceTabs]
  )
  const currentWorkspaceArchivedTabs = useMemo(
    () => (workspacePath ? archivedTabs.filter((tab) => tab.workspacePath === workspacePath) : []),
    [archivedTabs, workspacePath]
  )
  const visibleArchivedTabs = useMemo(
    () => (showAllArchived ? archivedTabs : currentWorkspaceArchivedTabs),
    [archivedTabs, currentWorkspaceArchivedTabs, showAllArchived]
  )
  const persistentShellBlocked =
    persistentShellSupport?.required === true && !persistentShellSupport.available
  const persistentShellMessage = persistentShellSupport?.reason ?? 'Persistent shell sessions require tmux.'
  const persistentShellInstallHint = persistentShellSupport?.installHint
  const activeId =
    workspacePath ? (activeTabIds[workspacePath] ?? currentWorkspaceTabs[0]?.id ?? null) : null
  const firstTerminalWorkspace =
    currentWorkspaceTabs.find((tab) => tab.type === 'terminal')?.workspacePath ?? ''

  useEffect(() => {
    let cancelled = false
    const legacyLayout = initialLegacyLayoutRef.current ?? { tabs: [], activeTabIds: {} }

    void Promise.all([
      window.api.getPersistedTerminalLayout(),
      window.api.getArchivedTabs().catch(() => []),
      window.api.listTerminalSessions().catch(() => []),
      window.api.getPersistentShellSupport().catch(() => null)
    ])
      .then(([persistedLayout, archivedTabRecords, daemonSessions, shellSupport]) => {
        if (cancelled) {
          return
        }

        setPersistentShellSupport(shellSupport)
        const nextArchivedTabs = deserializeArchivedTabs(archivedTabRecords)
        setArchivedTabs(nextArchivedTabs)

        const hasPersistedLayout =
          persistedLayout.tabs.length > 0 || Object.keys(persistedLayout.activeTabIds).length > 0
        const hasLegacyLayout =
          legacyLayout.tabs.length > 0 || Object.keys(legacyLayout.activeTabIds).length > 0
        const baseLayout = hasPersistedLayout
          ? deserializePersistedLayout(persistedLayout)
          : legacyLayout
        const mergedLayout = mergeLayoutWithDaemonSessions(
          baseLayout,
          daemonSessions,
          new Set(nextArchivedTabs.map((tab) => tab.id))
        )
        const nextLayout =
          shellSupport && shellSupport.required && !shellSupport.available
            ? {
                ...mergedLayout,
                tabs: mergedLayout.tabs.map((tab) =>
                  tab.type === 'terminal' && !tab.agent
                    ? {
                        ...tab,
                        sessionId: undefined,
                        runtimeState: 'destroyed' as const,
                        restoreState: 'failed' as const,
                        autoStart: false,
                        restoredSnapshot: undefined
                      }
                    : tab
                )
              }
            : mergedLayout

        initializedWorkspacesRef.current = new Set([
          ...nextLayout.tabs.map((tab) => tab.workspacePath),
          ...nextArchivedTabs.map((tab) => tab.workspacePath)
        ])
        setTabs(nextLayout.tabs)
        setActiveTabIds(nextLayout.activeTabIds)
        setLayoutHydrated(true)

        if (!hasPersistedLayout && hasLegacyLayout) {
          void window.api
            .savePersistedTerminalLayout(
              serializePersistedLayout(legacyLayout.tabs, legacyLayout.activeTabIds)
            )
            .then(() => {
              clearLegacyTerminalLayout()
            })
            .catch(() => {
              /* ignore migration failures */
            })
        } else if (hasPersistedLayout) {
          clearLegacyTerminalLayout()
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPersistentShellSupport(null)
          setLayoutHydrated(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  const terminalStatus = useCallback((tab: TerminalTab): TerminalVisualStatus | undefined => {
    if (tab.runtimeState === 'exited' || tab.runtimeState === 'destroyed') {
      return tab.runtimeState
    }

    if (!tab.agent) {
      return undefined
    }

    return tab.agentRun?.status ?? tab.lastKnownStatus
  }, [])

  const appendAgentOutput = useCallback((tabId: string, rawData: string): void => {
    let chunk = normalizeChatChunk(rawData)
    const echoSuppression = terminalEchoSuppressionsRef.current[tabId] ?? ''
    if (echoSuppression) {
      let consumed = 0
      while (
        consumed < chunk.length &&
        consumed < echoSuppression.length &&
        chunk[consumed] === echoSuppression[consumed]
      ) {
        consumed++
      }
      if (consumed > 0) {
        chunk = chunk.slice(consumed)
        terminalEchoSuppressionsRef.current[tabId] = echoSuppression.slice(consumed)
      }
    }

    if (!hasVisibleChatContent(chunk)) {
      return
    }

    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id !== tabId || tab.type !== 'terminal' || !tab.agent) {
          return tab
        }

        const hasUserTurn = tab.chatMessages.some((message) => message.role === 'user')
        if (!hasUserTurn && !shouldCaptureSystemChunk(chunk)) {
          return tab
        }

        const role: AgentChatMessage['role'] = hasUserTurn ? 'assistant' : 'system'
        const chatMessages = appendChatChunk(tab.chatMessages, role, chunk)
        return chatMessages === tab.chatMessages ? tab : { ...tab, chatMessages }
      })
    )
  }, [])

  const appendCommittedUserInput = useCallback((tabId: string, content: string): void => {
    const trimmed = content.trim()
    if (!trimmed) {
      return
    }

    terminalEchoSuppressionsRef.current[tabId] =
      (terminalEchoSuppressionsRef.current[tabId] ?? '') + trimmed

    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id !== tabId || tab.type !== 'terminal' || !tab.agent) {
          return tab
        }

        const chatMessages = addUserChatMessage(tab.chatMessages, trimmed)
        return chatMessages === tab.chatMessages ? tab : { ...tab, chatMessages }
      })
    )
  }, [])

  const handleTerminalInputChunk = useCallback((tabId: string, chunk: string): void => {
    let buffer = terminalInputBuffersRef.current[tabId] ?? ''
    const committedLines: string[] = []

    for (const char of chunk) {
      if (char === '\u007f' || char === '\b') {
        buffer = buffer.slice(0, -1)
        continue
      }

      if (char === '\r' || char === '\n') {
        if (buffer.trim()) {
          committedLines.push(buffer.trim())
        }
        buffer = ''
        continue
      }

      if (char < ' ' || char === '\u001b') {
        continue
      }

      buffer = `${buffer}${char}`.slice(-400)
    }

    terminalInputBuffersRef.current[tabId] = buffer
    if (committedLines.length === 0) {
      return
    }

    for (const line of committedLines) {
      appendCommittedUserInput(tabId, line)
    }
  }, [appendCommittedUserInput])

  useEffect(() => {
    if (!layoutHydrated || !workspacePath || initializedWorkspacesRef.current.has(workspacePath)) {
      return
    }

    if (persistentShellBlocked) {
      return
    }

    initializedWorkspacesRef.current.add(workspacePath)
    const id = uuid()
    setTabs((prev) => [
      ...prev,
      { id, type: 'terminal', workspacePath, title: leaf(workspacePath), agentViewMode: 'terminal', chatMessages: [] }
    ])
    setActiveTabIds((prev) => ({ ...prev, [workspacePath]: id }))
  }, [layoutHydrated, persistentShellBlocked, workspacePath])

  useEffect(() => {
    if (!workspacePath || currentWorkspaceTabs.length === 0) {
      return
    }

    if (!activeId || !currentWorkspaceTabs.some((tab) => tab.id === activeId)) {
      setActiveTabIds((prev) => ({ ...prev, [workspacePath]: currentWorkspaceTabs[0]?.id ?? null }))
    }
  }, [activeId, currentWorkspaceTabs, workspacePath])

  useEffect(() => {
    if (!layoutHydrated) {
      return
    }

    void window.api.savePersistedTerminalLayout(serializePersistedLayout(tabs, activeTabIds))
  }, [activeTabIds, layoutHydrated, tabs])

  useEffect(() => {
    if (!layoutHydrated) {
      return
    }

    void window.api.saveArchivedTabs(serializeArchivedTabs(archivedTabs))
  }, [archivedTabs, layoutHydrated])

  useEffect(() => {
    if (archivedTabs.length === 0) {
      setArchiveDrawerOpen(false)
      setShowAllArchived(false)
    }
  }, [archivedTabs.length])

  useEffect(() => {
    if (!requestedActiveTab) {
      return
    }

    if (handledRequestedActiveTabNonceRef.current === requestedActiveTab.nonce) {
      return
    }

    if (
      !tabs.some(
        (tab) => tab.type === 'terminal' && tab.workspacePath === requestedActiveTab.workspacePath && tab.id === requestedActiveTab.tabId
      )
    ) {
      return
    }

    setActiveTabIds((prev) =>
      prev[requestedActiveTab.workspacePath] === requestedActiveTab.tabId
        ? prev
        : { ...prev, [requestedActiveTab.workspacePath]: requestedActiveTab.tabId }
    )
    handledRequestedActiveTabNonceRef.current = requestedActiveTab.nonce
  }, [requestedActiveTab, tabs])

  useEffect(() => {
    if (!renamingTabId) {
      return
    }

    window.requestAnimationFrame(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    })
  }, [renamingTabId])

  useEffect(() => {
    if (!launchingAgent) {
      return
    }

    window.requestAnimationFrame(() => {
      agentTaskInputRef.current?.focus()
      agentTaskInputRef.current?.select()
    })
  }, [launchingAgent])

  useEffect(() => {
    onOpenTerminalsChange?.(
      tabs
        .filter((tab): tab is TerminalTab => tab.type === 'terminal')
        .map((tab) => ({
          id: tab.id,
          workspacePath: tab.workspacePath,
          title: tab.title,
          status: tab.agent ? (tab.agentRun?.status ?? tab.lastKnownStatus) : undefined,
          message: tab.agent ? tab.agentRun?.message : undefined,
          isAgent: Boolean(tab.agent),
          agentId: tab.agent?.id,
          sessionId: tab.sessionId,
          externalSessionId: tab.agentRun?.externalSessionId
        }))
    )
  }, [onOpenTerminalsChange, tabs])

  useEffect(() => {
    if (!workspacePath) {
      onActiveTerminalTabChange?.(null)
      return
    }

    const activeTab = tabs.find(
      (tab): tab is TerminalTab =>
        tab.type === 'terminal' &&
        tab.workspacePath === workspacePath &&
        tab.id === (activeTabIds[workspacePath] ?? null)
    )

    onActiveTerminalTabChange?.(
      activeTab
        ? {
            id: activeTab.id,
            workspacePath: activeTab.workspacePath,
            title: activeTab.title,
            status: activeTab.agent ? (activeTab.agentRun?.status ?? activeTab.lastKnownStatus) : undefined,
            message: activeTab.agent ? activeTab.agentRun?.message : undefined,
            isAgent: Boolean(activeTab.agent),
            agentId: activeTab.agent?.id,
            sessionId: activeTab.sessionId,
            externalSessionId: activeTab.agentRun?.externalSessionId
          }
        : null
    )
  }, [activeTabIds, onActiveTerminalTabChange, tabs, workspacePath])

  const bindSession = useCallback((tabId: string, sessionId: string | null): void => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId && tab.type === 'terminal'
          ? { ...tab, sessionId: sessionId ?? undefined }
          : tab
      )
    )
  }, [])

  const updateTerminalRuntimeState = useCallback(
    (tabId: string, state: TerminalLifecycleState, exitCode?: number): void => {
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId && tab.type === 'terminal'
            ? {
                ...tab,
                runtimeState: state,
                lastExitCode: state === 'exited' ? exitCode : undefined
              }
            : tab
        )
      )
    },
    []
  )

  const startRenameTab = useCallback((tab: PanelTab): void => {
    setRenamingTabId(tab.id)
    setRenameDraft(tab.title)
  }, [])

  const cancelRenameTab = useCallback((): void => {
    setRenamingTabId(null)
    setRenameDraft('')
  }, [])

  const commitRenameTab = useCallback((tabId: string): void => {
    const nextTitle = truncateTitle(renameDraft, 48)
    if (!nextTitle.trim()) {
      cancelRenameTab()
      return
    }

    let sessionIdToUpdate: string | undefined
    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id !== tabId) {
          return tab
        }

        if (tab.type === 'terminal') {
          sessionIdToUpdate = tab.sessionId
        }

        return {
          ...tab,
          title: nextTitle,
          customTitle: true
        }
      })
    )
    if (sessionIdToUpdate) {
      void window.api.updateTerminalSessionMetadata(sessionIdToUpdate, { title: nextTitle })
    }
    cancelRenameTab()
  }, [cancelRenameTab, renameDraft])

  const updateTerminalTitle = useCallback((tabId: string, nextTitle: string): void => {
    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id !== tabId || tab.type !== 'terminal' || tab.agentRun || tab.customTitle) {
          return tab
        }

        const normalized = normalizeTerminalTitle(nextTitle, tab.workspacePath, tab.title)
        if (!normalized || normalized === tab.title) {
          return tab
        }

        return { ...tab, title: normalized }
      })
    )
  }, [])

  const addTab = useCallback(() => {
    if (persistentShellBlocked) return
    const cwd = workspacePath ?? firstTerminalWorkspace
    if (!cwd) return
    const id = uuid()
    setTabs((prev) => [
      ...prev,
      {
        id,
        type: 'terminal',
        workspacePath: cwd,
        title: leaf(cwd),
        agentViewMode: 'terminal',
        chatMessages: [],
        runtimeState: 'running',
        restartNonce: 0
      }
    ])
    setActiveTabIds((prev) => ({ ...prev, [cwd]: id }))
  }, [firstTerminalWorkspace, persistentShellBlocked, workspacePath])

  const addBrowserTab = useCallback(() => {
    if (!workspacePath) return
    const id = uuid()
    const url = 'https://example.com'
    setTabs((prev) => [
      ...prev,
      {
        id,
        type: 'browser',
        workspacePath,
        title: titleFromUrl(url),
        url,
        draftUrl: url
      }
    ])
    setActiveTabIds((prev) => ({ ...prev, [workspacePath]: id }))
  }, [workspacePath])

  const launchAgent = useCallback(
    (agent: AvailableAgent, taskName: string) => {
      const cwd = workspacePath ?? firstTerminalWorkspace
      if (!cwd) return
      const id = uuid()
      const title = truncateTitle(taskName, 48)
      setTabs((prev) => [
        ...prev,
        {
          id,
          type: 'terminal',
          workspacePath: cwd,
          title,
          customTitle: true,
          agent,
          agentViewMode: 'terminal',
          chatMessages: [],
          lastKnownStatus: 'running',
          runtimeState: 'running',
          restartNonce: 0
        }
      ])
      setActiveTabIds((prev) => ({ ...prev, [cwd]: id }))
    },
    [firstTerminalWorkspace, workspacePath]
  )

  const openAgentLaunchDialog = useCallback((agent: AvailableAgent): void => {
    setLaunchingAgent(agent)
    setAgentTaskDraft('')
  }, [])

  const cancelAgentLaunchDialog = useCallback((): void => {
    setLaunchingAgent(null)
    setAgentTaskDraft('')
  }, [])

  const confirmAgentLaunch = useCallback((): void => {
    if (!launchingAgent) {
      return
    }

    const nextTitle = truncateTitle(agentTaskDraft, 48)
    if (!nextTitle.trim()) {
      return
    }

    launchAgent(launchingAgent, nextTitle)
    setLaunchingAgent(null)
    setAgentTaskDraft('')
  }, [agentTaskDraft, launchingAgent, launchAgent])

  const closeTab = useCallback(
    (id: string): void => {
      const closing = tabs.find((tab) => tab.id === id)
      if (!closing) {
        return
      }

      delete terminalInputBuffersRef.current[id]
      delete terminalEchoSuppressionsRef.current[id]

      const archivedAt = new Date().toISOString()
      const archivedTab: ArchivedTab =
        closing.type === 'terminal'
          ? {
              id: closing.id,
              type: 'terminal',
              workspacePath: closing.workspacePath,
              title: closing.title,
              customTitle: closing.customTitle,
              agent: closing.agent,
              agentRun: closing.agentRun,
              agentViewMode: closing.agent ? closing.agentViewMode : undefined,
              lastKnownStatus: closing.agent ? (closing.agentRun?.status ?? closing.lastKnownStatus) : closing.lastKnownStatus,
              archivedAt,
              archivedSessionId: closing.sessionId
            }
          : {
              id: closing.id,
              type: 'browser',
              workspacePath: closing.workspacePath,
              title: closing.title,
              url: closing.url,
              draftUrl: closing.draftUrl,
              customTitle: closing.customTitle,
              archivedAt
            }

      setArchivedTabs((prev) => [archivedTab, ...prev.filter((tab) => tab.id !== archivedTab.id)])
      setArchiveDrawerOpen(true)
      setTabs((prev) => {
        const next = prev.filter((tab) => tab.id !== id)
        const prevWorkspaceTabs = prev.filter((tab) => tab.workspacePath === closing.workspacePath)
        const nextWorkspaceTabs = next.filter((tab) => tab.workspacePath === closing.workspacePath)
        const idx = prevWorkspaceTabs.findIndex((tab) => tab.id === id)
        const fallbackActive =
          nextWorkspaceTabs[Math.max(0, idx - 1)]?.id ?? nextWorkspaceTabs[0]?.id ?? null

        setActiveTabIds((activePrev) =>
          activePrev[closing.workspacePath] === id
            ? { ...activePrev, [closing.workspacePath]: fallbackActive }
            : activePrev
        )
        return next
      })

      if (closing.type === 'terminal' && !closing.agent && closing.sessionId) {
        window.api.destroyTerminal(closing.sessionId)
      }
    },
    [tabs]
  )

  const restoreArchivedTab = useCallback(
    (id: string): void => {
      const archived = archivedTabs.find((tab) => tab.id === id)
      if (!archived) {
        return
      }

      delete terminalInputBuffersRef.current[id]
      delete terminalEchoSuppressionsRef.current[id]

      const restoredTab: PanelTab =
        archived.type === 'terminal'
          ? {
              id: archived.id,
              type: 'terminal',
              workspacePath: archived.workspacePath,
              title: archived.title,
              customTitle: archived.customTitle,
              agent: archived.agent,
              agentRun: archived.agentRun,
              agentViewMode: archived.agent ? (archived.agentViewMode ?? 'terminal') : 'terminal',
              chatMessages: [],
              lastKnownStatus: archived.agentRun?.status ?? archived.lastKnownStatus,
              launchCommand: archived.agent ? buildAgentResumeCommand(archived.agent, archived.agentRun) : undefined,
              resumeAgent: Boolean(archived.agent),
              autoStart: archived.agent ? true : !persistentShellBlocked,
              runtimeState:
                !archived.agent && persistentShellBlocked ? 'destroyed' : undefined,
              restoreState:
                !archived.agent && persistentShellBlocked ? 'failed' : undefined,
              restartNonce: 0
            }
          : {
              id: archived.id,
              type: 'browser',
              workspacePath: archived.workspacePath,
              title: archived.title,
              url: archived.url,
              draftUrl: archived.draftUrl,
              customTitle: archived.customTitle
            }

      setArchivedTabs((prev) => prev.filter((tab) => tab.id !== id))
      setTabs((prev) => {
        const withoutExisting = prev.filter((tab) => tab.id !== id)
        return [...withoutExisting, restoredTab]
      })
      setActiveTabIds((prev) => ({ ...prev, [archived.workspacePath]: archived.id }))
      setArchiveDrawerOpen(false)
    },
    [archivedTabs, persistentShellBlocked]
  )

  const deleteArchivedTab = useCallback(
    (id: string): void => {
      const archived = archivedTabs.find((tab) => tab.id === id)
      if (!archived) {
        return
      }

      if (archived.type === 'terminal') {
        if (archived.archivedSessionId) {
          window.api.destroyTerminal(archived.archivedSessionId)
        }
        if (!archived.agent) {
          window.api.destroyPersistentTerminal(archived.id)
        }
      }

      delete terminalInputBuffersRef.current[id]
      delete terminalEchoSuppressionsRef.current[id]
      setArchivedTabs((prev) => prev.filter((tab) => tab.id !== id))
    },
    [archivedTabs]
  )

  const restartTerminal = useCallback((id: string): void => {
    delete terminalInputBuffersRef.current[id]
    delete terminalEchoSuppressionsRef.current[id]
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === id && tab.type === 'terminal'
          ? {
              ...tab,
              sessionId: undefined,
              runtimeState: !tab.agent && persistentShellBlocked ? 'destroyed' : undefined,
              lastExitCode: undefined,
              agentRun:
                tab.agent && tab.resumeAgent && tab.agentRun
                  ? {
                      ...tab.agentRun,
                      status: 'running',
                      finishedAt: undefined,
                      exitCode: undefined,
                      signal: undefined,
                      message: 'Restoring agent session.'
                    }
                  : undefined,
              chatMessages: tab.agent ? [] : tab.chatMessages,
              lastKnownStatus: tab.agent ? 'running' : tab.lastKnownStatus,
              restartNonce: (tab.restartNonce ?? 0) + 1,
              restoreState: !tab.agent && persistentShellBlocked ? 'failed' : undefined,
              autoStart: tab.agent ? true : !persistentShellBlocked,
              restoredSnapshot: undefined
            }
          : tab
      )
    )
  }, [persistentShellBlocked])

  useEffect(() => {
    let cancelled = false

    void window.api.listAvailableAgents().then((agents) => {
      if (!cancelled) {
        setAvailableAgents(agents)
      }
    })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    return window.api.onAgentUpdate((run) => {
      setTabs((prev) =>
        prev.map((tab) =>
          tab.type === 'terminal' && tab.sessionId === run.sessionId
            ? {
                ...tab,
                agentRun: run,
                lastKnownStatus: run.status
              }
            : tab
        )
      )
    })
  }, [])

  const updateBrowserDraft = useCallback((id: string, draftUrl: string): void => {
    setTabs((prev) =>
      prev.map((tab) => (tab.id === id && tab.type === 'browser' ? { ...tab, draftUrl } : tab))
    )
  }, [])

  const navigateBrowserTab = useCallback((id: string): void => {
    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id !== id || tab.type !== 'browser') return tab
        const nextUrl = normalizeUrl(tab.draftUrl)
        return {
          ...tab,
          url: nextUrl,
          draftUrl: nextUrl,
          title: tab.customTitle ? tab.title : titleFromUrl(nextUrl)
        }
      })
    )
  }, [])

  if (!workspacePath) {
    return (
      <div className="terminal-wrapper">
        <div className="terminal-empty">
          <p>No terminal. Select a workspace to start.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="terminal-wrapper">
      {persistentShellBlocked && (
        <div className="terminal-support-banner" role="status" aria-live="polite">
          <span>{persistentShellMessage}</span>
          {persistentShellInstallHint && <code>{persistentShellInstallHint}</code>}
        </div>
      )}

      <div className="terminal-tabs">
        <div className="terminal-tab-list" role="tablist" aria-label="Terminal tabs">
          {currentWorkspaceTabs.map((tab) => (
            <div
              key={tab.id}
              className={`terminal-tab${activeId === tab.id ? ' is-active' : ''}`}
              role="tab"
              aria-selected={activeId === tab.id}
            >
              {tab.type === 'terminal' && terminalStatus(tab) && (
                <span
                  className={`terminal-tab-status is-${terminalStatus(tab)}`}
                  aria-label={terminalStatus(tab)}
                />
              )}
              {renamingTabId === tab.id ? (
                <input
                  ref={renameInputRef}
                  className="terminal-tab-rename"
                  type="text"
                  value={renameDraft}
                  aria-label="Rename tab"
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={() => commitRenameTab(tab.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitRenameTab(tab.id)
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      cancelRenameTab()
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="terminal-tab-label"
                  onClick={() => setActiveTabIds((prev) => ({ ...prev, [tab.workspacePath]: tab.id }))}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    startRenameTab(tab)
                  }}
                  title="Right click to rename"
                >
                  {currentWorkspaceDisplayTitles.get(tab.id) ?? tab.title}
                </button>
              )}
              <button
                type="button"
                className="terminal-tab-close"
                aria-label="Archive tab"
                title="Archive tab"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab.id)
                }}
              >
                -
              </button>
            </div>
          ))}
        </div>
        <div className="terminal-tab-actions">
          <button
            type="button"
            className="terminal-tab-add"
            aria-label="New terminal"
            onClick={addTab}
            disabled={!workspacePath || persistentShellBlocked}
            title={persistentShellBlocked ? persistentShellMessage : 'New terminal'}
          >
            +
          </button>
          <button
            type="button"
            className="terminal-tab-add terminal-tab-add-browser"
            aria-label="New browser tab"
            onClick={addBrowserTab}
            title="New browser tab"
            disabled={!workspacePath}
          >
            Web
          </button>
          <button
            type="button"
            className={`terminal-tab-add terminal-tab-archive-toggle${archiveDrawerOpen ? ' is-active' : ''}`}
            aria-label={archiveDrawerOpen ? 'Hide archived tabs' : 'Show archived tabs'}
            aria-expanded={archiveDrawerOpen}
            aria-controls="terminal-archive-panel"
            onClick={() => setArchiveDrawerOpen((open) => !open)}
            title={archiveDrawerOpen ? 'Hide archived tabs' : 'Show archived tabs'}
          >
            <span className={`terminal-tab-chevron${archiveDrawerOpen ? ' is-open' : ''}`} aria-hidden="true">
              ▾
            </span>
            <span className="terminal-tab-archive-copy">
              <span className="terminal-tab-archive-label">Archived</span>
              <span className="terminal-tab-archive-state">{archiveDrawerOpen ? 'Hide' : 'Show'}</span>
            </span>
            {archivedTabs.length > 0 && <span className="terminal-tab-count">{archivedTabs.length}</span>}
          </button>
        </div>
      </div>

      <div
        id="terminal-archive-panel"
        className={`terminal-archive-panel${archiveDrawerOpen ? ' is-open' : ''}`}
        aria-hidden={!archiveDrawerOpen}
      >
        <div className="terminal-archive-header">
          <div className="terminal-archive-heading">
            <div className="terminal-archive-title">Archived tabs</div>
            <div className="terminal-archive-copy">
              Close a tab, keep the context. Agent tabs reconnect to the live terminal when possible,
              then fall back to each provider's native resume flow.
            </div>
          </div>
          <div className="terminal-archive-header-actions">
            <button
              type="button"
              className={`terminal-archive-scope${showAllArchived ? ' is-active' : ''}`}
              onClick={() => setShowAllArchived((current) => !current)}
            >
              {showAllArchived ? 'Current workspace' : 'All workspaces'}
            </button>
          </div>
        </div>

        {visibleArchivedTabs.length > 0 ? (
          <div className="terminal-archive-list" role="list" aria-label="Archived tabs">
            {visibleArchivedTabs.map((tab) => {
              const archiveStatus =
                tab.type === 'terminal' && tab.agent ? (tab.agentRun?.status ?? tab.lastKnownStatus) : undefined
              const workspaceLabel = leaf(tab.workspacePath)
              const showWorkspaceChip =
                showAllArchived || workspaceLabel.trim().toLowerCase() !== tab.title.trim().toLowerCase()

              return (
                <div key={tab.id} className="terminal-archive-card" role="listitem">
                  <div className="terminal-archive-card-main">
                    <div className="terminal-archive-card-title-row">
                      {tab.type === 'terminal' && tab.agent ? <AgentIcon id={tab.agent.id} /> : null}
                      <div className="terminal-archive-card-title-group">
                        <div className="terminal-archive-card-title">{tab.title}</div>
                        <div className="terminal-archive-card-meta">
                          <span className="terminal-archive-chip">{archivedKindLabel(tab)}</span>
                          {archiveStatus ? (
                            <span className={`terminal-archive-chip is-status-${archiveStatus}`}>
                              {archiveStatus}
                            </span>
                          ) : null}
                          {showWorkspaceChip ? (
                            <span className="terminal-archive-chip">{workspaceLabel}</span>
                          ) : null}
                          <span className="terminal-archive-time">{relativeTimeFromNow(tab.archivedAt)}</span>
                        </div>
                      </div>
                    </div>
                    <div className="terminal-archive-card-copy">{archivedRestoreCopy(tab)}</div>
                  </div>
                  <div className="terminal-archive-card-actions">
                    <button
                      type="button"
                      className="terminal-archive-action is-primary"
                      onClick={() => restoreArchivedTab(tab.id)}
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      className="terminal-archive-action"
                      onClick={() => deleteArchivedTab(tab.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="terminal-archive-empty">
            {showAllArchived
              ? 'No archived tabs yet.'
              : `No archived tabs for ${leaf(workspacePath)}.`}
          </div>
        )}
      </div>

      {availableAgents.length > 0 && (
        <div className="agent-launchers">
          <div className="agent-launchers-title">Launch your agent</div>
          <div className="agent-launcher-list">
            {availableAgents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className="agent-launcher"
                onClick={() => openAgentLaunchDialog(agent)}
                disabled={!workspacePath}
                title={workspacePath ? `Launch ${agent.name} in ${leaf(workspacePath)}` : `Launch ${agent.name}`}
              >
                <AgentIcon id={agent.id} />
                <span className="agent-launcher-copy">
                  <span className="agent-launcher-name">{agent.name}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {launchingAgent && (
        <div
          className="agent-task-overlay"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              cancelAgentLaunchDialog()
            }
          }}
        >
          <div
            className="agent-task-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-task-title"
          >
            <div className="agent-task-title-row">
              <div>
                <div id="agent-task-title" className="agent-task-title">
                  Name the task
                </div>
                <div className="agent-task-copy">
                  This will be used as the fixed title for the new {launchingAgent.name} tab.
                </div>
              </div>
              <button
                type="button"
                className="agent-task-close"
                aria-label="Close task name dialog"
                onClick={cancelAgentLaunchDialog}
              >
                ×
              </button>
            </div>
            <input
              ref={agentTaskInputRef}
              className="agent-task-input"
              type="text"
              placeholder="Enter a task name"
              value={agentTaskDraft}
              onChange={(event) => setAgentTaskDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  confirmAgentLaunch()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelAgentLaunchDialog()
                }
              }}
            />
            <div className="agent-task-actions">
              <button
                type="button"
                className="agent-task-btn"
                onClick={cancelAgentLaunchDialog}
              >
                Cancel
              </button>
              <button
                type="button"
                className="agent-task-btn is-primary"
                onClick={confirmAgentLaunch}
                disabled={!agentTaskDraft.trim()}
              >
                Launch
              </button>
            </div>
          </div>
        </div>
      )}

      <div
        className="terminal-panes"
        style={{ display: currentWorkspaceTabs.length === 0 ? 'none' : 'flex' }}
      >
        {tabs.map((tab) => (
          tab.type === 'terminal' ? (
            <div
              key={tab.id}
              className="terminal-stack"
              style={{ display: tab.workspacePath === workspacePath && tab.id === activeId ? 'flex' : 'none' }}
            >
              <TerminalHost
                tabId={tab.id}
                title={tab.title}
                workspacePath={tab.workspacePath}
                restartNonce={tab.restartNonce}
                visible={tab.workspacePath === workspacePath && tab.id === activeId}
                autoStart={tab.autoStart}
                initialSnapshot={tab.restoredSnapshot}
                agent={tab.agent}
                agentRunSnapshot={tab.agentRun}
                launchCommand={tab.launchCommand}
                resumeAgent={tab.resumeAgent}
                onSessionChange={(sessionId) => bindSession(tab.id, sessionId)}
                onRuntimeStateChange={(state, exitCode) =>
                  updateTerminalRuntimeState(tab.id, state, exitCode)
                }
                onTitleChange={(title) => updateTerminalTitle(tab.id, title)}
                onOutputData={(data) => appendAgentOutput(tab.id, data)}
                onInputData={(data) => handleTerminalInputChunk(tab.id, data)}
              />
              {(tab.runtimeState === 'exited' || tab.runtimeState === 'destroyed') && (
                <div className="terminal-exit-overlay">
                  <div className="terminal-exit-card">
                    <div className="terminal-exit-title">
                      {tab.restoreState === 'disconnected'
                        ? 'Session disconnected'
                        : tab.restoreState === 'failed'
                          ? 'Session unavailable'
                          : tab.runtimeState === 'destroyed'
                            ? 'Terminal closed'
                            : 'Terminal exited'}
                    </div>
                    <div className="terminal-exit-copy">
                      {tab.restoreState === 'disconnected' ? (
                        'Harmony restored this tab from the daemon registry, but the live terminal session no longer exists.'
                      ) : tab.restoreState === 'failed' ? (
                        'Harmony restored metadata for this session, but reconnect is not available. Start a new session to continue.'
                      ) : tab.runtimeState === 'destroyed' ? (
                        'This session was explicitly closed and can be started again.'
                      ) : tab.lastExitCode && tab.lastExitCode !== 0 ? (
                        <>
                          Exited with code <code>{tab.lastExitCode}</code>.
                        </>
                      ) : (
                        <>
                          Exit code: <code>{tab.lastExitCode ?? 0}</code>
                        </>
                      )}
                    </div>
                    <div className="terminal-exit-actions">
                      <button
                        type="button"
                        className="terminal-exit-restart"
                        disabled={!tab.agent && persistentShellBlocked}
                        title={!tab.agent && persistentShellBlocked ? persistentShellMessage : undefined}
                        onClick={() => restartTerminal(tab.id)}
                      >
                        {tab.agent ? 'Restart agent' : 'Restart'}
                      </button>
                      <button
                        type="button"
                        className="terminal-exit-dismiss"
                        onClick={() => closeTab(tab.id)}
                      >
                        Archive tab
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <BrowserPane
              key={tab.id}
              tab={tab}
              visible={tab.workspacePath === workspacePath && tab.id === activeId}
              onDraftChange={updateBrowserDraft}
              onNavigate={navigateBrowserTab}
            />
          )
        ))}
      </div>

      {currentWorkspaceTabs.length === 0 && (
        <div className="terminal-empty">
          {currentWorkspaceArchivedTabs.length > 0 ? (
            <p>
              <code>{leaf(workspacePath)}</code> has {currentWorkspaceArchivedTabs.length} archived{' '}
              {currentWorkspaceArchivedTabs.length === 1 ? 'tab' : 'tabs'}. Open{' '}
              <strong>Archived</strong> to restore them.
            </p>
          ) : persistentShellBlocked ? (
            <p>
              Persistent shell sessions are unavailable for <code>{leaf(workspacePath)}</code>. Install{' '}
              <code>tmux</code>
              {persistentShellInstallHint ? <> with <code>{persistentShellInstallHint}</code></> : null} to
              enable shell tabs.
            </p>
          ) : (
            <p>
              No session attached for <code>{leaf(workspacePath)}</code>. Open a terminal tab to start
              working in this workspace.
            </p>
          )}
        </div>
      )}

    </div>
  )
}
