import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { AgentRun, AvailableAgent, TerminalLifecycleState, TerminalSession } from '../../../shared/workbench'

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
type TerminalVisualStatus = AgentRun['status'] | 'exited' | 'destroyed'

const TERMINAL_LAYOUT_KEY = 'harmony-terminal-layout-v1'

function loadTerminalLayout(): { tabs: PanelTab[]; activeTabIds: Record<string, string | null> } {
  try {
    const raw = localStorage.getItem(TERMINAL_LAYOUT_KEY)
    if (!raw) {
      return { tabs: [], activeTabIds: {} }
    }

    const parsed = JSON.parse(raw) as {
      tabs?: StoredPanelTab[]
      activeTabIds?: Record<string, string | null>
    }

    const tabs: PanelTab[] = []
    if (Array.isArray(parsed.tabs)) {
      for (const tab of parsed.tabs) {
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
            title: tab.title,
            customTitle: tab.customTitle === true,
            agent: tab.agent,
            agentViewMode: tab.agent ? (tab.agentViewMode ?? 'terminal') : 'terminal',
            chatMessages: [],
            lastKnownStatus: tab.lastKnownStatus
          })
          continue
        }

        if (
          tab.type === 'browser' &&
          typeof tab.url === 'string' &&
          typeof tab.draftUrl === 'string'
        ) {
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
    }

    const activeTabIds =
      parsed.activeTabIds && typeof parsed.activeTabIds === 'object'
        ? Object.fromEntries(
            Object.entries(parsed.activeTabIds).filter(
              ([key, value]) => typeof key === 'string' && (typeof value === 'string' || value === null)
            )
          )
        : {}

    return { tabs, activeTabIds }
  } catch {
    return { tabs: [], activeTabIds: {} }
  }
}

function saveTerminalLayout(tabs: PanelTab[], activeTabIds: Record<string, string | null>): void {
  try {
    const serializableTabs: StoredPanelTab[] = tabs.map((tab) =>
      tab.type === 'terminal'
        ? {
            id: tab.id,
            type: 'terminal',
            workspacePath: tab.workspacePath,
            title: tab.title,
            customTitle: tab.customTitle === true,
            agent: tab.agent,
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

    localStorage.setItem(
      TERMINAL_LAYOUT_KEY,
      JSON.stringify({
        tabs: serializableTabs,
        activeTabIds
      })
    )
  } catch {
    /* ignore */
  }
}

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

function terminalTheme(): ITheme {
  const background = cssVar('--terminal-surface', isDarkMode() ? '#262b34' : '#fbfcfd')
  const foreground = cssVar('--terminal-foreground', isDarkMode() ? '#eef2f7' : '#20242b')
  const accent = cssVar('--terminal-accent', isDarkMode() ? '#68b8d1' : '#2e8aa8')
  const muted = cssVar('--terminal-muted', isDarkMode() ? '#98a2b3' : '#69707d')
  const destructive = cssVar('--destructive', isDarkMode() ? '#f87171' : '#e45649')
  const green = cssVar('--chart-3', isDarkMode() ? '#73d39c' : '#5e9b67')
  const yellow = cssVar('--chart-5', isDarkMode() ? '#dfc06f' : '#b4872f')
  const cyan = cssVar('--chart-2', isDarkMode() ? '#68b8d1' : '#2e8aa8')
  const selection = cssVar(
    '--terminal-selection',
    isDarkMode() ? 'rgba(104,184,209,0.18)' : 'rgba(46,138,168,0.14)'
  )

  return {
    background,
    foreground,
    cursor: accent,
    cursorAccent: background,
    selectionBackground: selection,
    selectionForeground: foreground,
    black: isDarkMode() ? '#1f242c' : '#e7eaee',
    red: destructive,
    green,
    yellow,
    blue: accent,
    magenta: isDarkMode() ? '#b8a5d6' : '#8f76b8',
    cyan,
    white: foreground,
    brightBlack: muted,
    brightRed: destructive,
    brightGreen: green,
    brightYellow: yellow,
    brightBlue: accent,
    brightMagenta: isDarkMode() ? '#d3c5ea' : '#a78ecf',
    brightCyan: cyan,
    brightWhite: isDarkMode() ? '#ffffff' : '#111827'
  }
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

function extractTaskContext(command: string): string | null {
  const value = command.trim()
  if (!value) return null

  const tokens = value.match(/"[^"]+"|'[^']+'|\S+/g) ?? []
  if (tokens.length <= 1) return null

  const ignored = new Set([
    'opencode',
    'codex',
    'claude',
    'gemini',
    'agent',
    'exec',
    'task',
    'run',
    'npm',
    'npx',
    'bun'
  ])

  const cleaned = tokens
    .slice(1)
    .map((token) => token.replace(/^['"]|['"]$/g, '').trim())
    .filter((token) => token && !token.startsWith('-'))

  for (const token of cleaned) {
    const lower = token.toLowerCase()
    if (ignored.has(lower)) continue
    if (token.length < 3) continue
    return truncateTitle(token)
  }

  return null
}

function buildTaskAwareTitle(tab: TerminalTab, run: AgentRun): string {
  const displayName = truncateTitle(run.displayName || tab.agent?.name || tab.title)
  const context = extractTaskContext(run.command)
  if (!context) {
    return truncateTitle(`${displayName} · ${leaf(tab.workspacePath)}`)
  }
  if (context.toLowerCase() === displayName.toLowerCase()) {
    return displayName
  }
  return truncateTitle(`${displayName}: ${context}`)
}

function normalizeTerminalTitle(rawTitle: string, workspacePath: string, fallbackTitle: string): string | null {
  const title = stripAnsi(rawTitle).replace(/\s+/g, ' ').trim()
  if (!title) {
    return null
  }

  const lower = title.toLowerCase()
  if (lower.includes('harmony-') && (lower.includes(':zsh') || lower.includes(':bash'))) {
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

    // Webviews can stay black after being hidden or first attached in a tabbed layout.
    // Re-assert the current URL when the pane becomes visible so Chromium repaints it.
    window.requestAnimationFrame(() => {
      if (el.src !== tab.url) {
        el.src = tab.url
      } else if (typeof el.reload === 'function') {
        el.reload()
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
  workspacePath: string
  visible: boolean
  restartNonce?: number
  agent?: AvailableAgent
  onSessionChange?: (sessionId: string | null) => void
  onRuntimeStateChange?: (state: TerminalLifecycleState, exitCode?: number) => void
  onTitleChange?: (title: string) => void
  onOutputData?: (data: string) => void
  onInputData?: (data: string) => void
}

function TerminalHost({
  tabId,
  workspacePath,
  visible,
  restartNonce,
  agent,
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
  const wheelRemainderRef = useRef(0)
  const onSessionChangeRef = useRef(onSessionChange)
  const onRuntimeStateChangeRef = useRef(onRuntimeStateChange)
  const onTitleChangeRef = useRef(onTitleChange)
  const onOutputDataRef = useRef(onOutputData)
  const onInputDataRef = useRef(onInputData)

  const focusTerminal = useCallback((): void => {
    // Defer focus slightly so it wins over the launcher button/tab that was just clicked.
    window.requestAnimationFrame(() => {
      xtermRef.current?.focus()
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
      fontFamily: `${cssVar('--font-mono', "'Fira Code', monospace")}, 'SF Mono', Menlo, monospace`,
      fontSize: 13,
      fontWeight: '500',
      lineHeight: 1.36,
      letterSpacing: 0.15,
      minimumContrastRatio: 1.1,
      scrollback: 5000,
      theme: terminalTheme()
    })

    const fit = new FitAddon()
    fitRef.current = fit
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
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

    const ro = new ResizeObserver(() => {
      fit.fit()
      const s = sessionRef.current
      if (s) window.api.resizeTerminal(s.sessionId, term.cols, term.rows)
    })
    ro.observe(host)

    const offData = window.api.onTerminalData((ev) => {
      if (ev.sessionId === sessionRef.current?.sessionId) {
        term.write(ev.data)
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

    void window.api
      .createTerminal({
        cwd: workspacePath,
        themeHint: isDarkMode() ? 'dark' : 'light',
        sessionKey: tabId,
        persistentId: agent ? undefined : tabId,
        initialCommand: agent?.command
      })
      .then((session) => {
        if (cancelled) {
          window.api.detachTerminal(session.sessionId)
          return
        }
        sessionRef.current = session
        onSessionChangeRef.current?.(session.sessionId)
        onRuntimeStateChangeRef.current?.(session.state, session.exitCode)
        fit.fit()
        window.api.resizeTerminal(session.sessionId, term.cols, term.rows)
        focusTerminal()
        if (agent?.command && !didStartAgentRef.current) {
          didStartAgentRef.current = true
          void window.api
            .startAgent({
              sessionId: session.sessionId,
              workspacePath,
              command: agent.command,
              displayName: agent.name
            })
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

    const themeObserver = new MutationObserver(() => {
      term.options.fontFamily = `${cssVar('--font-mono', "'Fira Code', monospace")}, 'SF Mono', Menlo, monospace`
      term.options.theme = terminalTheme()
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
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
      const s = sessionRef.current
      if (s) window.api.detachTerminal(s.sessionId)
      onSessionChangeRef.current?.(null)
      sessionRef.current = null
      fitRef.current = null
      xtermRef.current = null
      wheelRemainderRef.current = 0
      term.dispose()
    }
  }, [agent?.command, agent?.name, restartNonce, tabId, workspacePath])

  useEffect(() => {
    if (visible) {
      fitRef.current?.fit()
      focusTerminal()
    }
  }, [focusTerminal, visible])

  return (
    <div ref={hostRef} className="terminal-host" style={{ display: visible ? 'flex' : 'none' }} />
  )
}

export function TerminalPanel({
  workspacePath,
  onOpenTerminalsChange,
  onActiveTerminalTabChange,
  requestedActiveTab
}: TerminalPanelProps): React.JSX.Element {
  const [tabs, setTabs] = useState<PanelTab[]>(() => loadTerminalLayout().tabs)
  const [activeTabIds, setActiveTabIds] = useState<Record<string, string | null>>(
    () => loadTerminalLayout().activeTabIds
  )
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [availableAgents, setAvailableAgents] = useState<AvailableAgent[]>([])
  const initializedWorkspacesRef = useRef(new Set(tabs.map((tab) => tab.workspacePath)))
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const terminalInputBuffersRef = useRef<Record<string, string>>({})
  const terminalEchoSuppressionsRef = useRef<Record<string, string>>({})

  const currentWorkspaceTabs = useMemo(
    () => (workspacePath ? tabs.filter((tab) => tab.workspacePath === workspacePath) : []),
    [tabs, workspacePath]
  )
  const activeId =
    workspacePath ? (activeTabIds[workspacePath] ?? currentWorkspaceTabs[0]?.id ?? null) : null
  const firstTerminalWorkspace =
    currentWorkspaceTabs.find((tab) => tab.type === 'terminal')?.workspacePath ?? ''

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
    if (!workspacePath || initializedWorkspacesRef.current.has(workspacePath)) {
      return
    }

    initializedWorkspacesRef.current.add(workspacePath)
    const id = uuid()
    setTabs((prev) => [
      ...prev,
      { id, type: 'terminal', workspacePath, title: leaf(workspacePath), agentViewMode: 'terminal', chatMessages: [] }
    ])
    setActiveTabIds((prev) => ({ ...prev, [workspacePath]: id }))
  }, [workspacePath])

  useEffect(() => {
    if (!workspacePath || currentWorkspaceTabs.length === 0) {
      return
    }

    if (!activeId || !currentWorkspaceTabs.some((tab) => tab.id === activeId)) {
      setActiveTabIds((prev) => ({ ...prev, [workspacePath]: currentWorkspaceTabs[0]?.id ?? null }))
    }
  }, [activeId, currentWorkspaceTabs, workspacePath])

  useEffect(() => {
    saveTerminalLayout(tabs, activeTabIds)
  }, [activeTabIds, tabs])

  useEffect(() => {
    if (!requestedActiveTab) {
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
    onOpenTerminalsChange?.(
      tabs
        .filter((tab): tab is TerminalTab => tab.type === 'terminal')
        .map((tab) => ({
          id: tab.id,
          workspacePath: tab.workspacePath,
          title: tab.title,
          status: tab.agent ? (tab.agentRun?.status ?? tab.lastKnownStatus) : undefined,
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

    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              title: nextTitle,
              customTitle: true
            }
          : tab
      )
    )
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
  }, [firstTerminalWorkspace, workspacePath])

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
    (agent: AvailableAgent) => {
      const cwd = workspacePath ?? firstTerminalWorkspace
      if (!cwd) return
      const id = uuid()
      setTabs((prev) => [
        ...prev,
        {
          id,
          type: 'terminal',
          workspacePath: cwd,
          title: agent.name,
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

  const closeTab = useCallback(
    (id: string): void => {
      delete terminalInputBuffersRef.current[id]
      delete terminalEchoSuppressionsRef.current[id]
      setTabs((prev) => {
        const closing = prev.find((t) => t.id === id)
        if (!closing) {
          return prev
        }

        if (closing.type === 'terminal') {
          if (closing.sessionId) {
            window.api.destroyTerminal(closing.sessionId)
          }
          window.api.destroyPersistentTerminal(closing.id)
        }

        const next = prev.filter((t) => t.id !== id)
        const prevWorkspaceTabs = prev.filter((t) => t.workspacePath === closing.workspacePath)
        const nextWorkspaceTabs = next.filter((t) => t.workspacePath === closing.workspacePath)
        const idx = prevWorkspaceTabs.findIndex((t) => t.id === id)
        const fallbackActive =
          nextWorkspaceTabs[Math.max(0, idx - 1)]?.id ?? nextWorkspaceTabs[0]?.id ?? null

        setActiveTabIds((activePrev) =>
          activePrev[closing.workspacePath] === id
            ? { ...activePrev, [closing.workspacePath]: fallbackActive }
            : activePrev
        )
        return next
      })
    },
    []
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
              runtimeState: undefined,
              lastExitCode: undefined,
              agentRun: undefined,
              chatMessages: tab.agent ? [] : tab.chatMessages,
              lastKnownStatus: tab.agent ? 'running' : tab.lastKnownStatus,
              restartNonce: (tab.restartNonce ?? 0) + 1
            }
          : tab
      )
    )
  }, [])

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
                lastKnownStatus: run.status,
                title: tab.customTitle ? tab.title : buildTaskAwareTitle(tab, run)
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
                  {tab.title}
                </button>
              )}
              <button
                type="button"
                className="terminal-tab-close"
                aria-label="Close tab"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab.id)
                }}
              >
                ×
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
            disabled={!workspacePath}
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
        </div>
      </div>

      {availableAgents.length > 0 && (
        <div className="agent-launchers">
          <div className="agent-launchers-header">
            <div className="agent-launchers-heading">
              <div className="agent-launchers-title-row">
                <span className="agent-launchers-title">AI Workspace</span>
                <span className="agent-launchers-context">{leaf(workspacePath)}</span>
              </div>
              <div className="agent-launchers-copy">
                Launch a coding agent directly inside this workspace without leaving the terminal surface.
              </div>
            </div>
          </div>
          <div className="agent-launcher-list">
            {availableAgents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className="agent-launcher"
                onClick={() => launchAgent(agent)}
                disabled={!workspacePath}
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

      <div className="terminal-panes">
        {tabs.map((tab) => (
          tab.type === 'terminal' ? (
            <div
              key={tab.id}
              className="terminal-stack"
              style={{ display: tab.workspacePath === workspacePath && tab.id === activeId ? 'flex' : 'none' }}
            >
              <TerminalHost
                tabId={tab.id}
                workspacePath={tab.workspacePath}
                restartNonce={tab.restartNonce}
                visible={tab.workspacePath === workspacePath && tab.id === activeId}
                agent={tab.agent}
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
                      {tab.runtimeState === 'destroyed' ? 'Terminal closed' : 'Terminal exited'}
                    </div>
                    <div className="terminal-exit-copy">
                      {tab.runtimeState === 'destroyed' ? (
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
                        onClick={() => restartTerminal(tab.id)}
                      >
                        {tab.agent ? 'Restart agent' : 'Restart'}
                      </button>
                      <button
                        type="button"
                        className="terminal-exit-dismiss"
                        onClick={() => closeTab(tab.id)}
                      >
                        Close tab
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
          <p>
            No session attached for <code>{leaf(workspacePath)}</code>. Open a terminal tab to start
            working in this workspace.
          </p>
        </div>
      )}

    </div>
  )
}
