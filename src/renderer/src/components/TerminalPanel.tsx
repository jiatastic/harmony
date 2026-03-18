import { useCallback, useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { AgentRun, AvailableAgent, TerminalSession } from '../../../shared/workbench'

const cursorIconUrl = new URL('../assets/agents/cursor.png', import.meta.url).href
const codexIconUrl = new URL('../assets/agents/codex.png', import.meta.url).href
const opencodeIconUrl = new URL('../assets/agents/opencode.png', import.meta.url).href
const claudeIconUrl = new URL('../assets/agents/claude.svg', import.meta.url).href
const geminiIconUrl = new URL('../assets/agents/gemini.svg', import.meta.url).href

interface TerminalPanelProps {
  workspacePath: string | null
}

type TerminalTab = {
  id: string
  type: 'terminal'
  workspacePath: string
  title: string
  sessionId?: string
  agent?: AvailableAgent
  agentRun?: AgentRun
}

type BrowserTab = {
  id: string
  type: 'browser'
  title: string
  url: string
  draftUrl: string
}

type PanelTab = TerminalTab | BrowserTab

const XTERM_LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#383a42',
  cursor: '#526eff',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(0,0,0,0.08)',
  selectionForeground: '#383a42',
  black: '#383a42',
  red: '#e45649',
  green: '#50a14f',
  yellow: '#c18401',
  blue: '#4078f2',
  magenta: '#a626a4',
  cyan: '#0184bc',
  white: '#a0a1a7',
  brightBlack: '#696c77',
  brightRed: '#e06c75',
  brightGreen: '#98c379',
  brightYellow: '#e5c07b',
  brightBlue: '#61afef',
  brightMagenta: '#c678dd',
  brightCyan: '#56b6c2',
  brightWhite: '#fafafa'
}

const XTERM_DARK: ITheme = {
  background: '#0a0a0a',
  foreground: '#e0e0e0',
  cursor: '#ffffff',
  selectionBackground: 'rgba(255,255,255,0.15)',
  black: '#0a0a0a',
  red: '#ef4444',
  green: '#3ecf8e',
  yellow: '#f59e0b',
  blue: '#3b82f6',
  magenta: '#a855f7',
  cyan: '#06b6d4',
  white: '#e0e0e0',
  brightBlack: '#555555',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#fbbf24',
  brightBlue: '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan: '#22d3ee',
  brightWhite: '#ffffff'
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

function titleFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname
    return host || 'Browser'
  } catch {
    return 'Browser'
  }
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

    const handleFail = (event: Event): void => {
      const e = event as DidFailLoadEvent
      if (e.errorCode === -3) return
      setIsLoading(false)
      setLoadError(e.errorDescription || `Failed to load ${e.validatedURL}`)
    }

    el.addEventListener('did-start-loading', handleStart)
    el.addEventListener('did-stop-loading', handleStop)
    el.addEventListener('did-fail-load', handleFail)

    return () => {
      el.removeEventListener('did-start-loading', handleStart)
      el.removeEventListener('did-stop-loading', handleStop)
      el.removeEventListener('did-fail-load', handleFail)
    }
  }, [])

  useEffect(() => {
    setIsLoading(true)
    setLoadError(null)
    const el = webviewRef.current
    if (!el) return
    if (typeof el.loadURL === 'function') {
      el.loadURL(tab.url)
      return
    }
    el.src = tab.url
  }, [tab.url])

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
      <webview
        ref={webviewRef}
        className="browser-webview"
        src={tab.url}
        allowpopups={true}
      />
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
  workspacePath: string
  visible: boolean
  agent?: AvailableAgent
  onSessionChange?: (sessionId: string | null) => void
}

function TerminalHost({
  workspacePath,
  visible,
  agent,
  onSessionChange
}: TerminalHostProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const xtermRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionRef = useRef<TerminalSession | null>(null)
  const didStartAgentRef = useRef(false)
  const onSessionChangeRef = useRef(onSessionChange)

  useEffect(() => {
    onSessionChangeRef.current = onSessionChange
  }, [onSessionChange])

  useEffect(() => {
    if (!hostRef.current) return

    let cancelled = false
    const host = hostRef.current
    const term = new Terminal({
      allowTransparency: true,
      convertEol: true,
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, monospace",
      fontSize: 13,
      fontWeight: '500',
      lineHeight: 1.4,
      scrollback: 5000,
      theme: isDarkMode() ? XTERM_DARK : XTERM_LIGHT
    })

    const fit = new FitAddon()
    fitRef.current = fit
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(host)
    fit.fit()
    term.focus()
    xtermRef.current = term

    const ro = new ResizeObserver(() => {
      fit.fit()
      const s = sessionRef.current
      if (s) window.api.resizeTerminal(s.sessionId, term.cols, term.rows)
    })
    ro.observe(host)

    const offData = window.api.onTerminalData((ev) => {
      if (ev.sessionId === sessionRef.current?.sessionId) term.write(ev.data)
    })

    const offExit = window.api.onTerminalExit((ev) => {
      if (ev.sessionId === sessionRef.current?.sessionId) {
        term.writeln(`\r\n[exited ${ev.exitCode}]`)
        sessionRef.current = null
        onSessionChangeRef.current?.(null)
      }
    })

    const inputOff = term.onData((data) => {
      const s = sessionRef.current
      if (s) window.api.writeTerminal(s.sessionId, data)
    })

    const resizeOff = term.onResize(({ cols, rows }) => {
      const s = sessionRef.current
      if (s) window.api.resizeTerminal(s.sessionId, cols, rows)
    })

    void window.api
      .createTerminal({ cwd: workspacePath })
      .then((session) => {
        if (cancelled) {
          window.api.destroyTerminal(session.sessionId)
          return
        }
        sessionRef.current = session
        onSessionChangeRef.current?.(session.sessionId)
        fit.fit()
        window.api.resizeTerminal(session.sessionId, term.cols, term.rows)
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
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : 'Shell failed'
          term.writeln(`[error] ${msg}`)
        }
      })

    const themeObserver = new MutationObserver(() => {
      term.options.theme = isDarkMode() ? XTERM_DARK : XTERM_LIGHT
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
      inputOff.dispose()
      resizeOff.dispose()
      const s = sessionRef.current
      if (s) window.api.destroyTerminal(s.sessionId)
      onSessionChangeRef.current?.(null)
      sessionRef.current = null
      fitRef.current = null
      xtermRef.current = null
      term.dispose()
    }
  }, [agent?.command, agent?.name, workspacePath])

  useEffect(() => {
    if (visible) {
      fitRef.current?.fit()
      xtermRef.current?.focus()
    }
  }, [visible])

  return (
    <div ref={hostRef} className="terminal-host" style={{ display: visible ? 'flex' : 'none' }} />
  )
}

export function TerminalPanel({ workspacePath }: TerminalPanelProps): React.JSX.Element {
  const [tabs, setTabs] = useState<PanelTab[]>(() =>
    workspacePath ? [{ id: uuid(), type: 'terminal', workspacePath, title: leaf(workspacePath) }] : []
  )
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [availableAgents, setAvailableAgents] = useState<AvailableAgent[]>([])

  const activeId = activeTabId ?? tabs[0]?.id ?? null
  const firstTerminalWorkspace = tabs.find((tab) => tab.type === 'terminal')?.workspacePath ?? ''

  const bindSession = useCallback((tabId: string, sessionId: string | null): void => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId && tab.type === 'terminal'
          ? { ...tab, sessionId: sessionId ?? undefined }
          : tab
      )
    )
  }, [])

  const addTab = useCallback(() => {
    const cwd = workspacePath ?? firstTerminalWorkspace
    if (!cwd) return
    const id = uuid()
    setTabs((prev) => [...prev, { id, type: 'terminal', workspacePath: cwd, title: leaf(cwd) }])
    setActiveTabId(id)
  }, [firstTerminalWorkspace, workspacePath])

  const addBrowserTab = useCallback(() => {
    const id = uuid()
    const url = 'https://example.com'
    setTabs((prev) => [
      ...prev,
      {
        id,
        type: 'browser',
        title: titleFromUrl(url),
        url,
        draftUrl: url
      }
    ])
    setActiveTabId(id)
  }, [])

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
          agent
        }
      ])
      setActiveTabId(id)
    },
    [firstTerminalWorkspace, workspacePath]
  )

  const closeTab = useCallback(
    (id: string): void => {
      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== id)
        if (activeTabId === id && next.length > 0) {
          const idx = prev.findIndex((t) => t.id === id)
          const newActive = next[Math.max(0, idx - 1)]?.id ?? next[0].id
          setActiveTabId(newActive)
        } else if (next.length === 0) {
          setActiveTabId(null)
        }
        return next
      })
    },
    [activeTabId]
  )

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
          tab.type === 'terminal' && tab.sessionId === run.sessionId ? { ...tab, agentRun: run } : tab
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
          title: titleFromUrl(nextUrl)
        }
      })
    )
  }, [])

  return (
    <div className="terminal-wrapper">
      <div className="terminal-tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`terminal-tab${activeId === tab.id ? ' is-active' : ''}`}
            role="tab"
            aria-selected={activeId === tab.id}
          >
            {tab.type === 'terminal' && tab.agentRun && (
              <span
                className={`terminal-tab-status is-${tab.agentRun.status}`}
                aria-label={tab.agentRun.status}
              />
            )}
            <button
              type="button"
              className="terminal-tab-label"
              onClick={() => setActiveTabId(tab.id)}
            >
              {tab.title}
            </button>
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
        <button
          type="button"
          className="terminal-tab-add"
          aria-label="New terminal"
          onClick={addTab}
          disabled={!workspacePath && tabs.length === 0}
        >
          +
        </button>
        <button
          type="button"
          className="terminal-tab-add terminal-tab-add-browser"
          aria-label="New browser tab"
          onClick={addBrowserTab}
          title="New browser tab"
        >
          Web
        </button>
      </div>

      {availableAgents.length > 0 && (
        <div className="agent-launchers">
          <div className="agent-launchers-header">
            <span className="section-label">Agents</span>
          </div>
          <div className="agent-launcher-list">
            {availableAgents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className="agent-launcher"
                onClick={() => launchAgent(agent)}
                disabled={!workspacePath && tabs.length === 0}
              >
                <AgentIcon id={agent.id} />
                <span className="agent-launcher-copy">
                  <span className="agent-launcher-name">{agent.name}</span>
                  <span className="agent-launcher-command">{agent.command}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="terminal-panes">
        {tabs.map((tab) => (
          tab.type === 'terminal' ? (
            <TerminalHost
              key={tab.id}
              workspacePath={tab.workspacePath}
              visible={tab.id === activeId}
              agent={tab.agent}
              onSessionChange={(sessionId) => bindSession(tab.id, sessionId)}
            />
          ) : (
            <BrowserPane
              key={tab.id}
              tab={tab}
              visible={tab.id === activeId}
              onDraftChange={updateBrowserDraft}
              onNavigate={navigateBrowserTab}
            />
          )
        ))}
      </div>

      {tabs.length === 0 && (
        <div className="terminal-empty">
          <p>No terminal. Select a workspace to start.</p>
        </div>
      )}
    </div>
  )
}
