import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { flushSync } from 'react-dom'
import { FileTree } from './components/FileTree'
import { TerminalPanel, type OpenTerminalTabSummary } from './components/TerminalPanel'
import { WorktreePanel, type WorkspaceItem } from './components/WorktreePanel'
import type {
  AppUpdateState,
  AgentUsage,
  BranchInfo,
  ClaudeQuota,
  CodexQuota,
  ContextInfo,
  GitAvailability,
  SessionStat,
  SkillMarketplaceItem,
  WorkspaceDiffResult,
  WorkspaceChangesSnapshot,
  WorkspaceEntry,
  WorkspaceSnapshot,
  WorktreeSummary
} from '../../shared/workbench'

type Theme = 'light' | 'dark' | 'system'
type DocumentWithThemeTransition = Document & {
  startViewTransition?: (update: () => void) => {
    ready: Promise<void>
  }
}

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function resolveTheme(theme: Theme): 'light' | 'dark' {
  return theme === 'system' ? getSystemTheme() : theme
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', resolveTheme(theme) === 'dark')
}

function getInitialTheme(): Theme {
  const stored = localStorage.getItem('harmony-theme') as Theme | null
  return stored ?? 'system'
}

applyTheme(getInitialTheme())

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(getInitialTheme)

  useEffect(() => {
    applyTheme(theme)
    localStorage.setItem('harmony-theme', theme)
  }, [theme])

  useEffect(() => {
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (): void => applyTheme('system')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])

  return [theme, setThemeState]
}


function findFirstFile(entries: WorkspaceEntry[]): string | null {
  for (const e of entries) {
    if (e.kind === 'file') return e.path
    if (e.children?.length) {
      const f = findFirstFile(e.children)
      if (f) return f
    }
  }
  return null
}

function hasFile(entries: WorkspaceEntry[], p: string): boolean {
  for (const e of entries) {
    if (e.kind === 'file' && e.path === p) return true
    if (e.children?.length && hasFile(e.children, p)) return true
  }
  return false
}

function countFiles(entries: WorkspaceEntry[]): number {
  return entries.reduce((n, e) => n + (e.kind === 'file' ? 1 : countFiles(e.children ?? [])), 0)
}


function leafName(p: string | null): string {
  if (!p) return 'harmony'
  return p.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? p
}

const THEME_CYCLE: Theme[] = ['light', 'dark', 'system']
const THEME_LABELS: Record<Theme, string> = { light: 'Light', dark: 'Dark', system: 'System' }
const EMPTY_UPDATE_STATE: AppUpdateState = {
  phase: 'idle',
  currentVersion: ''
}
const RIGHT_TABS = ['changes', 'files', 'inspector', 'usage'] as const
type RightTab = (typeof RIGHT_TABS)[number]
const RIGHT_TAB_LABELS: Record<RightTab, string> = {
  changes: 'Changes',
  files: 'Files',
  inspector: 'Inspector',
  usage: 'Usage'
}

const AGENT_LABELS: Record<AgentUsage['agent'], string> = {
  codex: 'Codex',
  claude: 'Claude',
  opencode: 'OpenCode'
}

// Accent colors per agent (for the usage cards)
const AGENT_COLORS: Record<AgentUsage['agent'], string> = {
  codex: '#10a37f',   // OpenAI green
  claude: '#d97757',  // Anthropic coral
  opencode: '#7c6ff1' // OpenCode purple
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtInstalls(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function isSupportedAgentId(value: string | undefined): value is 'opencode' | 'codex' {
  return value === 'opencode' || value === 'codex'
}

function shouldConfirmRisk(risk: string): boolean {
  return risk === 'medium' || risk === 'high' || risk === 'critical' || risk === 'unknown'
}

function fmtResetIn(unixSec: number): string {
  const diffMs = unixSec * 1000 - Date.now()
  if (diffMs <= 0) return 'now'
  const h = Math.floor(diffMs / 3_600_000)
  const m = Math.floor((diffMs % 3_600_000) / 60_000)
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function AgentUsageCard({ usage }: { usage: AgentUsage }): React.JSX.Element {
  const color = AGENT_COLORS[usage.agent]
  const total = usage.totalInputTokens + usage.totalOutputTokens
  return (
    <div className="usage-card">
      <div className="usage-card-header">
        <span className="usage-card-dot" style={{ background: color }} aria-hidden="true" />
        <span className="usage-card-name">{AGENT_LABELS[usage.agent]}</span>
        <span className="usage-card-sessions">{usage.sessionCount} sessions</span>
      </div>

      <div className="usage-token-rows">
        <div className="usage-token-row">
          <span className="usage-token-label">Input</span>
          <span className="usage-token-value">{fmtTokens(usage.totalInputTokens)}</span>
        </div>
        <div className="usage-token-row">
          <span className="usage-token-label">Output</span>
          <span className="usage-token-value">{fmtTokens(usage.totalOutputTokens)}</span>
        </div>
        {usage.totalCacheTokens > 0 && (
          <div className="usage-token-row">
            <span className="usage-token-label">Cache</span>
            <span className="usage-token-value usage-token-cache">{fmtTokens(usage.totalCacheTokens)}</span>
          </div>
        )}
        <div className="usage-token-row usage-token-total">
          <span className="usage-token-label">Total</span>
          <span className="usage-token-value">{fmtTokens(total)}</span>
        </div>
        {usage.totalCostUSD != null && usage.totalCostUSD > 0 && (
          <div className="usage-token-row">
            <span className="usage-token-label">Cost</span>
            <span className="usage-token-value usage-token-cost">${usage.totalCostUSD.toFixed(2)}</span>
          </div>
        )}
      </div>

      {/* Rate limit meters (Codex) */}
      {(usage.sessionLimit || usage.weeklyLimit) && (
        <div className="usage-limits">
          {usage.sessionLimit && (
            <div className="usage-limit-row">
              <div className="usage-limit-info">
                <span className="usage-limit-label">Session (5h)</span>
                <span className="usage-limit-reset">resets {fmtResetIn(usage.sessionLimit.resetsAt)}</span>
              </div>
              <div className="usage-limit-bar-wrap">
                <div
                  className={`usage-limit-bar${usage.sessionLimit.usedPct >= 80 ? ' is-danger' : usage.sessionLimit.usedPct >= 60 ? ' is-warn' : ''}`}
                  style={{ width: `${Math.min(100, usage.sessionLimit.usedPct)}%` }}
                />
              </div>
              <span className="usage-limit-pct">{usage.sessionLimit.usedPct.toFixed(0)}%</span>
            </div>
          )}
          {usage.weeklyLimit && (
            <div className="usage-limit-row">
              <div className="usage-limit-info">
                <span className="usage-limit-label">Weekly</span>
                <span className="usage-limit-reset">resets {fmtResetIn(usage.weeklyLimit.resetsAt)}</span>
              </div>
              <div className="usage-limit-bar-wrap">
                <div
                  className={`usage-limit-bar${usage.weeklyLimit.usedPct >= 80 ? ' is-danger' : usage.weeklyLimit.usedPct >= 60 ? ' is-warn' : ''}`}
                  style={{ width: `${Math.min(100, usage.weeklyLimit.usedPct)}%` }}
                />
              </div>
              <span className="usage-limit-pct">{usage.weeklyLimit.usedPct.toFixed(0)}%</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function fmtDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso))
  } catch { return iso }
}

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000)
}

function QuotaMeter({
  label,
  usedPct,
  resetsAt,
  resetLabel,
  subtitle
}: {
  label: string
  usedPct: number
  resetsAt: number
  resetLabel?: string
  subtitle?: string
}): React.JSX.Element {
  const pct = Math.min(100, usedPct)
  const barClass = pct >= 80 ? ' is-danger' : pct >= 60 ? ' is-warn' : ''
  return (
    <div className="quota-meter">
      <div className="quota-meter-header">
        <span className="quota-meter-label">{label}</span>
        <span className="quota-meter-right">
          <span className="quota-meter-pct" style={{ color: pct >= 80 ? 'oklch(0.58 0.2 25)' : pct >= 60 ? 'oklch(0.7 0.15 85)' : undefined }}>
            {pct.toFixed(0)}%
          </span>
          {resetsAt > 0 && (
            <span className="quota-meter-reset">resets {fmtResetIn(resetsAt)}</span>
          )}
          {resetsAt <= 0 && resetLabel && (
            <span className="quota-meter-reset">{resetLabel}</span>
          )}
        </span>
      </div>
      <div className="usage-limit-bar-wrap">
        <div className={`usage-limit-bar${barClass}`} style={{ width: `${pct}%` }} />
      </div>
      {subtitle && <span className="quota-meter-sub">{subtitle}</span>}
    </div>
  )
}

function CodexQuotaCard({ quota }: { quota: CodexQuota }): React.JSX.Element {
  const days = quota.subscriptionEndsAt ? daysUntil(quota.subscriptionEndsAt) : null
  const renewsLabel = quota.subscriptionEndsAt ? fmtDate(quota.subscriptionEndsAt) : null

  return (
    <div className="quota-card">
      <div className="quota-card-header">
        <span className="quota-card-dot" style={{ background: AGENT_COLORS.codex }} aria-hidden="true" />
        <span className="quota-card-title">Codex Subscription</span>
        <span className="quota-card-plan">{quota.planType.toUpperCase()}</span>
      </div>

      {renewsLabel && (
        <div className="quota-subscription-row">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="1.5" y="3.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
            <path d="M5 1.5v4M11 1.5v4M1.5 7.5h13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
          <span className="quota-subscription-date">Renews {renewsLabel}</span>
          {days !== null && (
            <span className={`quota-subscription-days${days <= 3 ? ' is-soon' : ''}`}>
              {days > 0 ? `${days}d left` : 'Today'}
            </span>
          )}
        </div>
      )}

      <div className="quota-meters">
        <QuotaMeter
          label="Session (5h)"
          usedPct={quota.sessionUsedPct}
          resetsAt={quota.sessionResetsAt}
        />
        <QuotaMeter
          label="Weekly"
          usedPct={quota.weeklyUsedPct}
          resetsAt={quota.weeklyResetsAt}
        />
        {quota.additionalLimits.map((lim) => (
          <QuotaMeter
            key={lim.name}
            label={lim.name}
            usedPct={lim.sessionUsedPct}
            resetsAt={lim.sessionResetsAt}
            subtitle={lim.weeklyUsedPct != null ? `Weekly: ${lim.weeklyUsedPct.toFixed(0)}%` : undefined}
          />
        ))}
      </div>

      {quota.hasCredits && (
        <div className="quota-credits-row">
          <span className="quota-credits-label">Credits</span>
          <span className="quota-credits-value">${quota.creditBalance}</span>
        </div>
      )}
    </div>
  )
}

function ClaudeQuotaCard({ quota }: { quota: ClaudeQuota }): React.JSX.Element {
  const accountMeta = [quota.email, quota.organization, quota.loginMethod].filter(Boolean).join(' • ')

  return (
    <div className="quota-card">
      <div className="quota-card-header">
        <span className="quota-card-dot" style={{ background: AGENT_COLORS.claude }} aria-hidden="true" />
        <span className="quota-card-title">Claude Code</span>
        <span className="quota-card-plan">{quota.planType.toUpperCase()}</span>
      </div>

      {accountMeta && (
        <div className="quota-subscription-row">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="5" r="2.2" stroke="currentColor" strokeWidth="1.3" />
            <path d="M3.8 12.2c.9-1.7 2.4-2.6 4.2-2.6 1.8 0 3.3.9 4.2 2.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <span className="quota-subscription-date">{accountMeta}</span>
        </div>
      )}

      <div className="quota-meters">
        {quota.session && (
          <QuotaMeter
            label="Session"
            usedPct={quota.session.usedPct}
            resetsAt={quota.session.resetAt ?? 0}
            resetLabel={quota.session.resetLabel}
          />
        )}
        {quota.weekly && (
          <QuotaMeter
            label="Weekly"
            usedPct={quota.weekly.usedPct}
            resetsAt={quota.weekly.resetAt ?? 0}
            resetLabel={quota.weekly.resetLabel}
          />
        )}
        {quota.additionalLimits.map((limit) => (
          <QuotaMeter
            key={limit.name}
            label={limit.name}
            usedPct={limit.usedPct}
            resetsAt={limit.resetAt ?? 0}
            resetLabel={limit.resetLabel}
          />
        ))}
      </div>
    </div>
  )
}

function statusToClass(s: string): string {
  const map: Record<string, string> = {
    '?': 'untracked',
    A: 'added',
    M: 'modified',
    D: 'deleted',
    R: 'renamed',
    C: 'copied',
    U: 'unmerged'
  }
  return map[primaryStatusCode(s)] ?? 'unknown'
}

function primaryStatusCode(status: string): string {
  if (!status.trim()) {
    return '?'
  }

  if (status.includes('?')) {
    return '?'
  }

  for (const code of ['U', 'A', 'M', 'D', 'R', 'C']) {
    if (status.includes(code)) {
      return code
    }
  }

  return status.trim().charAt(0) || '?'
}

function statusLabel(status: string): string {
  const code = primaryStatusCode(status)
  return code === '?' ? '??' : code
}

function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'is-file'
  if (line.startsWith('@@')) return 'is-hunk'
  if (line.startsWith('+')) return 'is-added'
  if (line.startsWith('-')) return 'is-removed'
  if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('Staged changes') ||
    line.startsWith('Unstaged changes')
  ) {
    return 'is-meta'
  }
  return ''
}

function buildDiffViewLines(diff: string): Array<{ text: string; className: string; left: number | null; right: number | null }> {
  let leftLine: number | null = null
  let rightLine: number | null = null

  return diff.split('\n').map((line) => {
    const className = diffLineClass(line)
    let left: number | null = null
    let right: number | null = null

    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunkMatch) {
      leftLine = Number(hunkMatch[1])
      rightLine = Number(hunkMatch[2])
      return { text: line, className, left, right }
    }

    if (className === 'is-added' && !line.startsWith('+++')) {
      right = rightLine
      rightLine = rightLine == null ? null : rightLine + 1
      return { text: line, className, left, right }
    }

    if (className === 'is-removed' && !line.startsWith('---')) {
      left = leftLine
      leftLine = leftLine == null ? null : leftLine + 1
      return { text: line, className, left, right }
    }

    if (!className && line) {
      left = leftLine
      right = rightLine
      leftLine = leftLine == null ? null : leftLine + 1
      rightLine = rightLine == null ? null : rightLine + 1
    }

    return { text: line, className, left, right }
  })
}

function groupChangesByDir(
  changes: WorkspaceChangesSnapshot['changes']
): Array<{ dir: string; files: Array<{ name: string; path: string; status: string; additions: number; deletions: number }> }> {
  const map = new Map<string, Array<{ name: string; path: string; status: string; additions: number; deletions: number }>>()
  for (const c of changes) {
    const parts = c.path.split('/')
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : 'Root Path'
    const name = parts.at(-1) ?? c.path
    if (!map.has(dir)) map.set(dir, [])
    map.get(dir)!.push({ name, path: c.path, status: c.status, additions: c.additions, deletions: c.deletions })
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => {
      if (a === 'Root Path') return -1
      if (b === 'Root Path') return 1
      return a.localeCompare(b)
    })
    .map(([dir, files]) => ({ dir, files }))
}
const EMPTY_WORKSPACE_CHANGES: WorkspaceChangesSnapshot = {
  isGitRepo: false,
  branch: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  hasRemote: false,
  publishRemote: null,
  changes: []
}
const EMPTY_WORKSPACE_DIFF: WorkspaceDiffResult = {
  diff: '',
  truncated: false
}

const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 480
const DEFAULT_LEFT = 260
const DEFAULT_RIGHT = 320
const SIDEBAR_COLLAPSE_KEY = 'harmony-sidebar-collapsed'
const DIFF_PANEL_MIN = 320
const DIFF_PANEL_MAX = 900
const DEFAULT_DIFF_WIDTH = 440
const DIFF_PANEL_WIDTH_KEY = 'harmony-diff-panel-width'
const DIFF_PANEL_COLLAPSED_KEY = 'harmony-diff-panel-collapsed'

function loadSidebarWidths(): [number, number] {
  try {
    const s = localStorage.getItem('harmony-sidebar-widths')
    if (s) {
      const [l, r] = JSON.parse(s) as [number, number]
      if (typeof l === 'number' && typeof r === 'number') {
        return [
          Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, l)),
          Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, r))
        ]
      }
    }
  } catch {
    /* ignore */
  }
  return [DEFAULT_LEFT, DEFAULT_RIGHT]
}

function saveSidebarWidths(left: number, right: number): void {
  try {
    localStorage.setItem('harmony-sidebar-widths', JSON.stringify([left, right]))
  } catch {
    /* ignore */
  }
}

function loadDiffPanelWidth(): number {
  try {
    const raw = localStorage.getItem(DIFF_PANEL_WIDTH_KEY)
    const value = raw ? Number(raw) : NaN
    if (!Number.isNaN(value)) {
      return Math.max(DIFF_PANEL_MIN, Math.min(DIFF_PANEL_MAX, value))
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_DIFF_WIDTH
}

function saveDiffPanelWidth(width: number): void {
  try {
    localStorage.setItem(DIFF_PANEL_WIDTH_KEY, String(width))
  } catch {
    /* ignore */
  }
}

function loadDiffPanelCollapsed(): boolean {
  try {
    return localStorage.getItem(DIFF_PANEL_COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

function saveDiffPanelCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(DIFF_PANEL_COLLAPSED_KEY, String(collapsed))
  } catch {
    /* ignore */
  }
}

function loadCollapsedSidebars(): { left: boolean; right: boolean } {
  try {
    const s = localStorage.getItem(SIDEBAR_COLLAPSE_KEY)
    if (s) {
      const parsed = JSON.parse(s) as unknown
      if (
        parsed &&
        typeof parsed === 'object' &&
        'left' in parsed &&
        'right' in parsed &&
        typeof parsed.left === 'boolean' &&
        typeof parsed.right === 'boolean'
      ) {
        return { left: parsed.left, right: parsed.right }
      }
    }
  } catch {
    /* ignore */
  }
  return { left: false, right: false }
}

function saveCollapsedSidebars(left: boolean, right: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSE_KEY, JSON.stringify({ left, right }))
  } catch {
    /* ignore */
  }
}

const OPENED_FOLDERS_KEY = 'harmony-opened-folders'
const HIDDEN_WORKTREES_KEY = 'harmony-hidden-worktrees'

function loadOpenedFolders(): string[] {
  try {
    const s = localStorage.getItem(OPENED_FOLDERS_KEY)
    if (s) {
      const parsed = JSON.parse(s) as unknown
      if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) {
        return parsed
      }
    }
  } catch {
    /* ignore */
  }
  return []
}

function saveOpenedFolders(folders: string[]): void {
  try {
    localStorage.setItem(OPENED_FOLDERS_KEY, JSON.stringify(folders))
  } catch {
    /* ignore */
  }
}

function loadHiddenWorktrees(): string[] {
  try {
    const s = localStorage.getItem(HIDDEN_WORKTREES_KEY)
    if (s) {
      const parsed = JSON.parse(s) as unknown
      if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) {
        return parsed
      }
    }
  } catch {
    /* ignore */
  }
  return []
}

function saveHiddenWorktrees(worktrees: string[]): void {
  try {
    localStorage.setItem(HIDDEN_WORKTREES_KEY, JSON.stringify(worktrees))
  } catch {
    /* ignore */
  }
}

function clampSidebar(w: number): number {
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w))
}

function clampDiffPanel(w: number): number {
  return Math.max(DIFF_PANEL_MIN, Math.min(DIFF_PANEL_MAX, w))
}

function leafPath(p: string): string {
  return p.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? p
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function shouldShowUpdateAction(state: AppUpdateState): boolean {
  return state.phase !== 'unsupported'
}

function updateActionLabel(state: AppUpdateState): string {
  switch (state.phase) {
    case 'idle':
    case 'not-available':
      return 'Check Updates'
    case 'checking':
      return 'Checking…'
    case 'available':
      return state.availableVersion ? `Update ${state.availableVersion}` : 'Download Update'
    case 'downloading':
      return state.progressPercent != null
        ? `Downloading ${state.progressPercent.toFixed(0)}%`
        : 'Downloading…'
    case 'downloaded':
      return 'Restart to Update'
    case 'error':
      return 'Retry Update'
    default:
      return 'Check Updates'
  }
}

function updateActionTitle(state: AppUpdateState): string {
  switch (state.phase) {
    case 'idle':
      return 'Check for updates.'
    case 'not-available':
      return state.message ?? 'Harmony is up to date.'
    case 'available':
      return state.message ?? 'Download the latest Harmony release.'
    case 'downloaded':
      return state.message ?? 'Restart Harmony to install the update.'
    case 'error':
      return state.message ?? 'Retry checking for updates.'
    default:
      return state.message ?? 'Check for updates.'
  }
}


const SOURCE_COLORS: Record<string, string> = {
  cursor:  '#111111',
  agents:  '#6366f1',
  codex:   '#10a37f',
  opencode: '#2563eb',
  claude:  '#d4832a',
  gemini:  '#4285f4',
  openai:  '#10a37f',
}

const SOURCE_LABELS: Record<string, string> = {
  agents:  'Agent Skills',
  cursor:  'Cursor Skills',
  codex:   'Codex Skills',
  opencode: 'OpenCode Skills',
  claude:  'Claude Skills',
  gemini:  'Gemini Skills',
  openai:  'OpenAI Skills',
}

function sourceColor(src: string): string {
  return SOURCE_COLORS[src.toLowerCase()] ?? '#6b7280'
}

function sourceLabel(src: string): string {
  return SOURCE_LABELS[src.toLowerCase()] ?? src.charAt(0).toUpperCase() + src.slice(1)
}

function mcpStatusClass(status: import('../../shared/workbench').McpServerSummary['status']): string {
  switch (status) {
    case 'connected':
      return 'is-connected'
    case 'disconnected':
      return 'is-disconnected'
    case 'error':
      return 'is-error'
    default:
      return ''
  }
}

function mcpStatusLabel(status: import('../../shared/workbench').McpServerSummary['status']): string {
  switch (status) {
    case 'connected':
      return 'connected'
    case 'disconnected':
      return 'disconnected'
    case 'error':
      return 'error'
    default:
      return status
  }
}

function AccordItemGlyph({
  iconUrl,
  color
}: {
  iconUrl?: string
  color?: string
}): JSX.Element {
  if (iconUrl) {
    return <img className="accord-item-icon" src={iconUrl} alt="" aria-hidden="true" loading="lazy" />
  }

  return <span className="accord-item-dot" style={color ? { background: color } : undefined} aria-hidden="true" />
}


function groupSkillsBySource(
  skills: import('../../shared/workbench').SkillSummary[]
): Array<{ source: string; items: import('../../shared/workbench').SkillSummary[] }> {
  const map = new Map<string, import('../../shared/workbench').SkillSummary[]>()
  for (const s of skills) {
    if (!map.has(s.source)) map.set(s.source, [])
    map.get(s.source)!.push(s)
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([source, items]) => ({ source, items }))
}

function AccordionSection({
  id,
  label,
  count,
  accent,
  open,
  onToggle,
  children,
}: {
  id: string
  label: string
  count: number
  accent?: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="accord-section">
      <button
        className="accord-hd"
        type="button"
        aria-expanded={open}
        aria-controls={`accord-body-${id}`}
        onClick={onToggle}
      >
        {accent && (
          <span className="accord-accent" style={{ background: accent }} aria-hidden="true" />
        )}
        <span className="accord-label">{label}</span>
        <span className="accord-count">{count}</span>
        <svg
          className={`accord-chevron${open ? ' is-open' : ''}`}
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div id={`accord-body-${id}`} className="accord-body">
          {children}
        </div>
      )}
    </div>
  )
}

function App(): React.JSX.Element {
  const platform = window.electron.process.platform
  const isMac = platform === 'darwin'
  const [theme, setTheme] = useTheme()
  const [[leftWidth, rightWidth], setSidebarWidths] = useState(loadSidebarWidths)
  const [{ left: isLeftCollapsed, right: isRightCollapsed }, setCollapsedSidebars] =
    useState(loadCollapsedSidebars)
  const [isNarrow, setIsNarrow] = useState(() => window.innerWidth <= 860)
  const [worktrees, setWorktrees] = useState<WorktreeSummary[]>([])
  const [openedFolders, setOpenedFolders] = useState<string[]>(loadOpenedFolders)
  const [hiddenWorktrees, setHiddenWorktrees] = useState<string[]>(loadHiddenWorktrees)

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 860px)')
    const handler = (): void => setIsNarrow(mq.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const widthsRef = useRef<[number, number]>([leftWidth, rightWidth])
  useEffect(() => {
    widthsRef.current = [leftWidth, rightWidth]
  }, [leftWidth, rightWidth])

  const startResizeLeft = useCallback(
    (e: React.MouseEvent): void => {
      e.preventDefault()
      const startX = e.clientX
      const startW = leftWidth
      const onMove = (ev: MouseEvent): void => {
        const delta = ev.clientX - startX
        setSidebarWidths(([, r]) => {
          const next: [number, number] = [clampSidebar(startW + delta), r]
          widthsRef.current = next
          return next
        })
      }
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        saveSidebarWidths(widthsRef.current[0], widthsRef.current[1])
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [leftWidth]
  )

  const startResizeRight = useCallback(
    (e: React.MouseEvent): void => {
      e.preventDefault()
      const startX = e.clientX
      const startW = rightWidth
      const onMove = (ev: MouseEvent): void => {
        const delta = startX - ev.clientX
        setSidebarWidths(([l]) => {
          const next: [number, number] = [l, clampSidebar(startW + delta)]
          widthsRef.current = next
          return next
        })
      }
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        saveSidebarWidths(widthsRef.current[0], widthsRef.current[1])
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [rightWidth]
  )

  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null)
  const [selectedWt, setSelectedWt] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [selectedChangePath, setSelectedChangePath] = useState<string | null>(null)
  const [diffPanelWidth, setDiffPanelWidth] = useState(loadDiffPanelWidth)
  const [status, setStatus] = useState('Loading\u2026')
  const [rightTab, setRightTab] = useState<RightTab>('changes')
  const [commitMsg, setCommitMsg] = useState('')
  const [openAccordions, setOpenAccordions] = useState<Set<string>>(() =>
    new Set(['subagents', 'skill-store', 'mcp'])
  )
  const [workspaceChanges, setWorkspaceChanges] =
    useState<WorkspaceChangesSnapshot>(EMPTY_WORKSPACE_CHANGES)
  const [workspaceDiff, setWorkspaceDiff] = useState<WorkspaceDiffResult>(EMPTY_WORKSPACE_DIFF)
  const [isDiffLoading, setIsDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [isChangesListCollapsed, setIsChangesListCollapsed] = useState(false)
  const [isDiffCollapsed, setIsDiffCollapsed] = useState(loadDiffPanelCollapsed)
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null)
  const [marketplaceQuery, setMarketplaceQuery] = useState('')
  const [marketplaceResults, setMarketplaceResults] = useState<SkillMarketplaceItem[]>([])
  const [marketplaceError, setMarketplaceError] = useState<string | null>(null)
  const [isMarketplaceLoading, setIsMarketplaceLoading] = useState(false)
  const [installingSkillId, setInstallingSkillId] = useState<string | null>(null)
  const [gitAvailability, setGitAvailability] = useState<GitAvailability | null>(null)
  const [sessionStats, setSessionStats] = useState<SessionStat[]>([])
  const [usageData, setUsageData] = useState<AgentUsage[]>([])
  const [codexQuota, setCodexQuota] = useState<CodexQuota | null>(null)
  const [claudeQuota, setClaudeQuota] = useState<ClaudeQuota | null>(null)
  const [updateState, setUpdateState] = useState<AppUpdateState>(EMPTY_UPDATE_STATE)
  const [isGeneratingCommitMsg, setIsGeneratingCommitMsg] = useState(false)
  const [isStagingChanges, setIsStagingChanges] = useState(false)
  const [isCommitting, setIsCommitting] = useState(false)
  const [isPublishing, setIsPublishing] = useState(false)
  const [isGitActionPending, setIsGitActionPending] = useState(false)
  const [openTerminalTabs, setOpenTerminalTabs] = useState<OpenTerminalTabSummary[]>([])
  const [activeTerminalTab, setActiveTerminalTab] = useState<OpenTerminalTabSummary | null>(null)
  const [requestedActiveTerminalTab, setRequestedActiveTerminalTab] = useState<{
    workspacePath: string
    tabId: string
    nonce: number
  } | null>(null)
  const wtRef = useRef<string | null>(null)
  const fileRowRefs = useRef(new Map<string, HTMLButtonElement>())
  const diffWidthRef = useRef(diffPanelWidth)
  const marketplaceSearchTimerRef = useRef<number | null>(null)
  const marketplaceSearchRequestRef = useRef(0)

  const startResizeDiff = useCallback(
    (e: React.MouseEvent): void => {
      e.preventDefault()
      const startX = e.clientX
      const startW = diffPanelWidth
      const onMove = (ev: MouseEvent): void => {
        const delta = startX - ev.clientX
        setDiffPanelWidth(clampDiffPanel(startW + delta))
      }
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        saveDiffPanelWidth(diffWidthRef.current)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [diffPanelWidth]
  )

  useEffect(() => {
    wtRef.current = selectedWt
  }, [selectedWt])

  useEffect(() => {
    diffWidthRef.current = diffPanelWidth
    saveDiffPanelWidth(diffPanelWidth)
  }, [diffPanelWidth])

  useEffect(() => {
    saveDiffPanelCollapsed(isDiffCollapsed)
  }, [isDiffCollapsed])

  useEffect(() => {
    saveOpenedFolders(openedFolders)
  }, [openedFolders])

  useEffect(() => {
    saveHiddenWorktrees(hiddenWorktrees)
  }, [hiddenWorktrees])

  useEffect(() => {
    saveCollapsedSidebars(isLeftCollapsed, isRightCollapsed)
  }, [isLeftCollapsed, isRightCollapsed])

  const activeChanges = selectedWt ? workspaceChanges : EMPTY_WORKSPACE_CHANGES

  useEffect(() => {
    let cancelled = false

    void window.api.getGitAvailability().then((info) => {
      if (!cancelled) {
        setGitAvailability(info)
      }
    })

    return () => {
      cancelled = true
    }
  }, [])

  const refreshGitAvailability = useCallback(async (): Promise<void> => {
    const info = await window.api.getGitAvailability()
    setGitAvailability(info)
  }, [])

  useEffect(() => {
    let cancelled = false

    void window.api.getContextInfo().then((info) => {
      if (!cancelled) {
        setContextInfo(info)
      }
    })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    void window.api.getUpdateState().then((state) => {
      if (!cancelled) {
        setUpdateState(state)
      }
    })

    const off = window.api.onUpdateState((state) => {
      if (!cancelled) {
        setUpdateState(state)
      }
    })

    return () => {
      cancelled = true
      off()
    }
  }, [])

  // Poll opencode session stats every 30 s while a workspace is active
  useEffect(() => {
    if (!selectedWt) return
    let cancelled = false

    const fetchStats = (): void => {
      void window.api.listSessionStats({
        workspacePath: selectedWt,
        activeHint:
          activeTerminalTab?.externalSessionId && isSupportedAgentId(activeTerminalTab.agentId)
            ? {
                agent: activeTerminalTab.agentId,
                externalSessionId: activeTerminalTab.externalSessionId
              }
            : undefined
      }).then((rows) => {
        if (!cancelled) setSessionStats(rows)
      })
    }

    fetchStats()
    const timer = window.setInterval(fetchStats, 30_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [activeTerminalTab?.agentId, activeTerminalTab?.externalSessionId, selectedWt])

  // Poll usage summary every 60 s
  useEffect(() => {
    let cancelled = false
    const fetchUsage = (): void => {
      void window.api.getUsageSummary().then((rows) => {
        if (!cancelled) setUsageData(rows)
      })
    }
    fetchUsage()
    const timer = window.setInterval(fetchUsage, 60_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  // Poll subscription/usage cards every 5 min (cached/best-effort server-side)
  useEffect(() => {
    let cancelled = false
    const fetchQuota = (): void => {
      void Promise.all([window.api.getCodexQuota(), window.api.getClaudeQuota()]).then(([codex, claude]) => {
        if (!cancelled) {
          setCodexQuota(codex)
          setClaudeQuota(claude)
        }
      })
    }
    fetchQuota()
    const timer = window.setInterval(fetchQuota, 5 * 60_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  const refreshChanges = useCallback(async (workspacePath: string): Promise<void> => {
    try {
      const changes = await window.api.listWorkspaceChanges(workspacePath)
      setWorkspaceChanges(changes)
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : 'Failed to load changes')
    }
  }, [])

  useEffect(() => {
    if (!selectedWt) {
      return
    }

    void refreshChanges(selectedWt)
  }, [refreshChanges, selectedWt])

  useEffect(() => {
    if (!selectedWt || !activeChanges.isGitRepo || activeChanges.changes.length === 0) {
      setSelectedChangePath(null)
      setWorkspaceDiff(EMPTY_WORKSPACE_DIFF)
      setDiffError(null)
      return
    }

    if (!selectedChangePath || !activeChanges.changes.some((change) => change.path === selectedChangePath)) {
      setSelectedChangePath(activeChanges.changes[0]?.path ?? null)
    }
  }, [activeChanges.changes, activeChanges.isGitRepo, selectedChangePath, selectedWt])

  useEffect(() => {
    if (!selectedWt || !selectedChangePath) {
      setWorkspaceDiff(EMPTY_WORKSPACE_DIFF)
      setDiffError(null)
      setIsDiffLoading(false)
      return
    }

    let cancelled = false
    setIsDiffLoading(true)
    setDiffError(null)

    void window.api
      .getWorkspaceDiff({
        workspacePath: selectedWt,
        path: selectedChangePath
      })
      .then((result) => {
        if (cancelled) return
        setWorkspaceDiff(result)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setWorkspaceDiff(EMPTY_WORKSPACE_DIFF)
        setDiffError(err instanceof Error ? err.message : 'Failed to load diff')
      })
      .finally(() => {
        if (!cancelled) {
          setIsDiffLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [selectedChangePath, selectedWt])

  useEffect(() => {
    if (!selectedWt) {
      return
    }

    let stopWatching: (() => Promise<void>) | null = null
    let debounceTimer: number | null = null
    let cancelled = false

    void window.api
      .watchWorkspaceChanges(selectedWt, () => {
        if (debounceTimer !== null) {
          window.clearTimeout(debounceTimer)
        }

        // Debounce bursts from editors and git operations into a single refresh.
        debounceTimer = window.setTimeout(() => {
          if (wtRef.current === selectedWt) {
            void refreshChanges(selectedWt)
          }
        }, 350)
      })
      .then((dispose) => {
        if (cancelled) {
          void dispose()
          return
        }

        stopWatching = dispose
      })
      .catch(() => {
        // Watching is best-effort; manual refresh remains available.
      })

    return () => {
      cancelled = true
      if (debounceTimer !== null) {
        window.clearTimeout(debounceTimer)
      }
      if (stopWatching) {
        void stopWatching()
      }
    }
  }, [refreshChanges, selectedWt])

  const openFile = useCallback((wt: string, path: string): void => {
    void wt
    setSelectedFile(path)
    setStatus(`Opened ${leafName(path)}`)
  }, [])

  const loadWorkspace = useCallback(
    async (wt: string, preferFile?: string) => {
      try {
        const snap = await window.api.getWorkspace(wt)
        setWorkspace(snap)
        setSelectedWt(wt)
        const next =
          preferFile && hasFile(snap.entries, preferFile) ? preferFile : findFirstFile(snap.entries)
        if (next) {
          openFile(wt, next)
        } else {
          setSelectedFile(null)
          setStatus('Workspace loaded')
        }
      } catch (err: unknown) {
        setStatus(err instanceof Error ? err.message : 'Load failed')
      }
    },
    [openFile]
  )

  const workspaces = useMemo((): WorkspaceItem[] => {
    const wtPaths = new Set(worktrees.map((w) => w.path))
    const hiddenPaths = new Set(hiddenWorktrees)
    const items: WorkspaceItem[] = worktrees.filter((w) => !hiddenPaths.has(w.path))
    for (const path of openedFolders) {
      if (wtPaths.has(path)) continue
      items.push({
        id: path,
        name: leafPath(path),
        path,
        repoRoot: path,
        branch: '—',
        head: '',
        isMain: false,
        isLocked: false,
        isOpenedFolder: true
      })
    }
    return items
  }, [hiddenWorktrees, worktrees, openedFolders])

  const openedTerminalsByWorkspace = useMemo(() => {
    const grouped: Record<string, Array<{ id: string; title: string; status?: string; isAgent?: boolean }>> = {}
    for (const tab of openTerminalTabs) {
      if (!grouped[tab.workspacePath]) {
        grouped[tab.workspacePath] = []
      }
      grouped[tab.workspacePath].push({
        id: tab.id,
        title: tab.title,
        status: tab.status,
        isAgent: tab.isAgent
      })
    }
    return grouped
  }, [openTerminalTabs])

  const refresh = useCallback(
    async ({
      preferWt,
      preferFile,
      extraWorkspacePaths = []
    }: {
      preferWt?: string
      preferFile?: string
      extraWorkspacePaths?: string[]
    } = {}) => {
      setStatus('Loading\u2026')
      try {
        const workspacePaths = Array.from(new Set([...openedFolders, ...extraWorkspacePaths]))
        const wts = await window.api.listWorktrees(workspacePaths.length ? workspacePaths : undefined)
        setWorktrees(wts)
        const fallback =
          preferWt ??
          wtRef.current ??
          wts.find((w) => w.isMain)?.path ??
          wts[0]?.path ??
          openedFolders[0]
        if (!fallback) {
          setWorkspace(null)
          setSelectedWt(null)
          setSelectedFile(null)
          setStatus('No workspaces')
          return
        }
        await loadWorkspace(fallback, preferFile)
      } catch (err: unknown) {
        setStatus(err instanceof Error ? err.message : 'Refresh failed')
      }
    },
    [loadWorkspace, openedFolders]
  )

  useEffect(() => {
    const t = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(t)
  }, [refresh])

  const openFolderAndRefresh = useCallback(async (): Promise<string | null> => {
    try {
      const path = await window.api.openFolder()
      if (!path) return null
      setOpenedFolders((prev) => (prev.includes(path) ? prev : [...prev, path]))
      await refresh({ preferWt: path, extraWorkspacePaths: [path] })
      setStatus(`Opened ${leafPath(path)}`)
      return path
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : 'Open failed')
      return null
    }
  }, [refresh])

  const handleOpenFolder = useCallback(async (): Promise<void> => {
    await openFolderAndRefresh()
  }, [openFolderAndRefresh])

  const handleCreateWorktree = useCallback(
    async (branch: BranchInfo, workspacePath?: string): Promise<void> => {
      try {
        let path = workspacePath ?? selectedWt ?? worktrees[0]?.path ?? openedFolders[0] ?? null
        if (!path) {
          path = await openFolderAndRefresh()
        }
        if (!path) {
          return
        }
        const worktree = await window.api.createWorktree({
          branch: branch.name,
          baseRef: branch.remote ? branch.remoteRef : undefined,
          workspacePath: path
        })
        await refresh({ preferWt: worktree.path, extraWorkspacePaths: [path] })
        setStatus(`Created ${worktree.name}`)
      } catch (err: unknown) {
        setStatus(err instanceof Error ? err.message : 'Create failed')
      }
    },
    [openFolderAndRefresh, refresh, selectedWt, worktrees, openedFolders]
  )

  const handleOpenTerminalTab = useCallback(
    async (workspacePath: string, tabId: string): Promise<void> => {
      setRequestedActiveTerminalTab({
        workspacePath,
        tabId,
        nonce: Date.now()
      })

      if (selectedWt !== workspacePath) {
        await loadWorkspace(workspacePath)
      }
    },
    [loadWorkspace, selectedWt]
  )

  const handleRefreshChanges = useCallback((): void => {
    if (!selectedWt) {
      return
    }

    void refreshChanges(selectedWt)
  }, [refreshChanges, selectedWt])

  const handleMarketplaceSearch = useCallback(async (queryOverride?: string): Promise<void> => {
    const query = (queryOverride ?? marketplaceQuery).trim()
    const requestId = marketplaceSearchRequestRef.current + 1
    marketplaceSearchRequestRef.current = requestId
    setMarketplaceError(null)

    if (!query) {
      setMarketplaceResults([])
      return
    }

    try {
      setIsMarketplaceLoading(true)
      const result = await window.api.searchSkillsMarketplace({ query, limit: 20 })
      if (marketplaceSearchRequestRef.current !== requestId) {
        return
      }
      setMarketplaceResults(result.items)
      setStatus(`Found ${result.items.length} installable skills for "${query}".`)
    } catch (err: unknown) {
      if (marketplaceSearchRequestRef.current !== requestId) {
        return
      }
      const message = err instanceof Error ? err.message : 'Failed to search skills.sh'
      setMarketplaceError(message)
      setStatus(message)
    } finally {
      if (marketplaceSearchRequestRef.current === requestId) {
        setIsMarketplaceLoading(false)
      }
    }
  }, [marketplaceQuery])

  useEffect(() => {
    if (marketplaceSearchTimerRef.current !== null) {
      window.clearTimeout(marketplaceSearchTimerRef.current)
      marketplaceSearchTimerRef.current = null
    }

    if (!marketplaceQuery.trim()) {
      marketplaceSearchRequestRef.current += 1
      setMarketplaceResults([])
      setMarketplaceError(null)
      setIsMarketplaceLoading(false)
      return
    }

    marketplaceSearchTimerRef.current = window.setTimeout(() => {
      void handleMarketplaceSearch(marketplaceQuery)
    }, 350)

    return () => {
      if (marketplaceSearchTimerRef.current !== null) {
        window.clearTimeout(marketplaceSearchTimerRef.current)
        marketplaceSearchTimerRef.current = null
      }
    }
  }, [handleMarketplaceSearch, marketplaceQuery])

  const handleMarketplaceInstall = useCallback(
    async (item: SkillMarketplaceItem): Promise<void> => {
      if (installingSkillId !== null) {
        return
      }
      try {
        setInstallingSkillId(item.id)
        setMarketplaceError(null)

        const audit = await window.api.auditSkillFromMarketplace({ source: item.source, skill: item.skillId })
        const riskLine = `Risk: ${audit.risk.toUpperCase()}`
        const scoreLine = audit.score === null ? 'Score: n/a' : `Score: ${audit.score}`
        const alertsLine = audit.alerts === null ? 'Alerts: n/a' : `Alerts: ${audit.alerts}`
        if (shouldConfirmRisk(audit.risk)) {
          const proceed = window.confirm(
            [
              `Security audit before install (${item.name})`,
              riskLine,
              scoreLine,
              alertsLine,
              '',
              'Continue installing this skill?'
            ].join('\n')
          )
          if (!proceed) {
            setStatus(`Cancelled install for ${item.skillId}.`)
            return
          }
        } else {
          setStatus(`Audit passed: ${riskLine}. Installing ${item.skillId}...`)
        }

        const result = await window.api.installSkillFromMarketplace({ source: item.source, skill: item.skillId })
        setStatus(result.summary)
        const info = await window.api.getContextInfo()
        setContextInfo(info)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Failed to install skill'
        setMarketplaceError(message)
        setStatus(message)
      } finally {
        setInstallingSkillId(null)
      }
    },
    [installingSkillId]
  )

  const handleGenerateCommitMessage = useCallback(async (): Promise<void> => {
    if (!selectedWt) {
      return
    }

    try {
      setIsGeneratingCommitMsg(true)
      const result = await window.api.generateCommitMessage({ workspacePath: selectedWt })
      setCommitMsg(result.message)
      setStatus(
        result.usedFallback
          ? `Generated commit message with ${result.provider}.`
          : `Generated commit message with ${result.provider}.`
      )
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : 'Failed to generate commit message')
    } finally {
      setIsGeneratingCommitMsg(false)
    }
  }, [selectedWt])

  const handleStageAllChanges = useCallback(async (): Promise<void> => {
    if (!selectedWt) {
      return
    }

    try {
      setIsStagingChanges(true)
      const result = await window.api.stageWorkspaceChanges({ workspacePath: selectedWt })
      await refreshChanges(selectedWt)
      setStatus(result.summary)
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : 'Failed to stage changes')
    } finally {
      setIsStagingChanges(false)
    }
  }, [refreshChanges, selectedWt])

  const handleCommitChanges = useCallback(async (): Promise<void> => {
    if (!selectedWt) {
      return
    }

    try {
      setIsCommitting(true)
      const result = await window.api.commitWorkspaceChanges({
        workspacePath: selectedWt,
        message: commitMsg,
        stageAll: true
      })
      setCommitMsg('')
      await refreshChanges(selectedWt)
      setStatus(result.summary)
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : 'Failed to create commit')
    } finally {
      setIsCommitting(false)
    }
  }, [commitMsg, refreshChanges, selectedWt])

  const handlePublishBranch = useCallback(
    async (chooseRemote: boolean): Promise<void> => {
      if (!selectedWt) {
        return
      }

      let remote: string | undefined

      if (chooseRemote) {
        const entered = window.prompt('Publish branch to remote:', activeChanges.publishRemote ?? 'origin')
        if (entered === null) {
          return
        }

        remote = entered.trim()
        if (!remote) {
          setStatus('Remote name is required.')
          return
        }
      }

      try {
        setIsPublishing(true)
        const result = await window.api.publishBranch({ workspacePath: selectedWt, remote })
        await refreshChanges(selectedWt)
        setStatus(result.summary)
      } catch (err: unknown) {
        setStatus(err instanceof Error ? err.message : 'Failed to publish branch')
      } finally {
        setIsPublishing(false)
      }
    },
    [activeChanges.publishRemote, refreshChanges, selectedWt]
  )

  const handleRemove = useCallback(
    async (path: string, isOpenedFolder: boolean): Promise<void> => {
      const name = workspaces.find((w) => w.path === path)?.name ?? path
      if (!window.confirm(`Remove "${name}" from list?`)) return
      if (isOpenedFolder) {
        setOpenedFolders((prev) => prev.filter((p) => p !== path))
        if (selectedWt === path) {
          const fallback = workspaces.find((w) => w.path !== path)?.path ?? undefined
          await refresh({ preferWt: fallback })
        }
        setStatus(`Removed ${name}`)
      } else {
        setHiddenWorktrees((prev) => (prev.includes(path) ? prev : [...prev, path]))
        if (selectedWt === path) {
          const fallback =
            workspaces.find((w) => w.isMain && w.path !== path)?.path ??
            workspaces.find((w) => w.path !== path)?.path
          if (fallback) {
            await loadWorkspace(fallback)
          } else {
            setWorkspace(null)
            setSelectedWt(null)
            setSelectedFile(null)
          }
        }
        setStatus(`Removed ${name}`)
      }
    },
    [loadWorkspace, selectedWt, workspaces]
  )

  const wt = useMemo(
    () => worktrees.find((w) => w.path === selectedWt) ?? null,
    [selectedWt, worktrees]
  )
  const branch = activeChanges.branch ?? wt?.branch ?? '\u2014'
  const label = leafName(workspace?.rootPath ?? null)
  const files = useMemo(() => countFiles(workspace?.entries ?? []), [workspace])
  const skillsCount = contextInfo?.skills.length ?? 0
  const mcpCount = contextInfo?.mcpServers.length ?? 0
  const changesCount = activeChanges.changes.length
  const hasUpstream = Boolean(activeChanges.upstream)
  const needsPush = hasUpstream && activeChanges.ahead > 0
  const branchActionMode =
    Boolean(selectedWt) && activeChanges.isGitRepo && activeChanges.hasRemote && Boolean(activeChanges.branch)
      ? hasUpstream
        ? (needsPush ? 'push' : null)
        : 'publish'
      : null
  const publishLabel = branchActionMode === 'push' ? 'Push Branch' : 'Publish Branch'
  const publishMeta = !activeChanges.isGitRepo
    ? 'Open a git repository to enable source control.'
    : activeChanges.upstream
      ? `${activeChanges.upstream}${activeChanges.ahead > 0 ? ` • ahead ${activeChanges.ahead}` : ' • up to date'}${activeChanges.behind > 0 ? ` • behind ${activeChanges.behind}` : ''}`
      : activeChanges.hasRemote
        ? `Ready to publish to ${activeChanges.publishRemote ?? 'origin'}`
        : 'No git remote found.'
  const canGenerateCommitMessage =
    Boolean(selectedWt) && activeChanges.isGitRepo && changesCount > 0 && !isGeneratingCommitMsg
  const canCommit =
    Boolean(selectedWt) &&
    activeChanges.isGitRepo &&
    changesCount > 0 &&
    commitMsg.trim().length > 0 &&
    !isCommitting
  const canPublish = branchActionMode !== null && !isPublishing
  const groupedChanges = useMemo(
    () => groupChangesByDir(activeChanges.changes),
    [activeChanges.changes]
  )
  const changePaths = useMemo(
    () => groupedChanges.flatMap((group) => group.files.map((file) => file.path)),
    [groupedChanges]
  )
  const diffViewLines = useMemo(() => buildDiffViewLines(workspaceDiff.diff), [workspaceDiff.diff])
  const groupedSkills = useMemo(
    () => groupSkillsBySource(contextInfo?.skills ?? []),
    [contextInfo]
  )
  const subagentsList = contextInfo?.subagents ?? []
  const activeSessionStat = useMemo(() => {
    if (!activeTerminalTab?.isAgent) {
      return null
    }

    if (!isSupportedAgentId(activeTerminalTab.agentId) || !activeTerminalTab.externalSessionId) {
      return null
    }

    return (
      sessionStats.find(
        (session) =>
          session.agent === activeTerminalTab.agentId &&
          session.id === activeTerminalTab.externalSessionId
      ) ??
      sessionStats[0] ??
      null
    )
  }, [activeTerminalTab, sessionStats])
  const contextWindowCount = activeSessionStat ? 1 : 0

  const toggleAccordion = useCallback((id: string): void => {
    setOpenAccordions((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleChangeRowKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, path: string): void => {
      const currentIndex = changePaths.indexOf(path)
      if (currentIndex === -1) return

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const delta = event.key === 'ArrowDown' ? 1 : -1
        const nextPath = changePaths[currentIndex + delta]
        if (!nextPath) return
        setSelectedChangePath(nextPath)
        fileRowRefs.current.get(nextPath)?.focus()
        return
      }

      if (event.key === 'Enter' && selectedWt) {
        event.preventDefault()
        openFile(selectedWt, path)
      }
    },
    [changePaths, openFile, selectedWt]
  )

  const handleUpdateAction = useCallback((): void => {
    if (updateState.phase === 'available') {
      void window.api.downloadUpdate()
      return
    }

    if (updateState.phase === 'downloaded') {
      void window.api.installUpdateAndRestart()
      return
    }

    if (updateState.phase === 'idle' || updateState.phase === 'not-available' || updateState.phase === 'error') {
      void window.api.checkForUpdates()
    }
  }, [updateState.phase])

  const handleThemeToggle = useCallback((event: React.MouseEvent<HTMLButtonElement>): void => {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length]
    const doc = document as DocumentWithThemeTransition

    if (!doc.startViewTransition || prefersReducedMotion()) {
      setTheme(next)
      return
    }

    const x = event.clientX
    const y = event.clientY
    const maxRadius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y)
    )

    const transition = doc.startViewTransition(() => {
      flushSync(() => {
        setTheme(next)
      })
    })

    void transition.ready.then(() => {
      document.documentElement.animate(
        {
          clipPath: [
            `circle(0px at ${x}px ${y}px)`,
            `circle(${maxRadius}px at ${x}px ${y}px)`
          ]
        },
        {
          duration: 520,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          pseudoElement: '::view-transition-new(root)'
        } as KeyframeAnimationOptions
      )
    })
  }, [theme, setTheme])

  const handleInstallGit = useCallback(async (): Promise<void> => {
    try {
      setIsGitActionPending(true)
      const message = await window.api.installGit()
      setStatus(message)
      await refreshGitAvailability()
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : 'Failed to start Git installation')
    } finally {
      setIsGitActionPending(false)
    }
  }, [refreshGitAvailability])

  const handleRetryGit = useCallback(async (): Promise<void> => {
    try {
      setIsGitActionPending(true)
      await refreshGitAvailability()
      setStatus('Refreshed Git availability.')
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : 'Failed to refresh Git availability')
    } finally {
      setIsGitActionPending(false)
    }
  }, [refreshGitAvailability])

  const toggleLeftSidebar = useCallback((): void => {
    setCollapsedSidebars((prev) => ({ ...prev, left: !prev.left }))
  }, [])

  const toggleRightSidebar = useCallback((): void => {
    setCollapsedSidebars((prev) => ({ ...prev, right: !prev.right }))
  }, [])

  const toggleDiffPanel = useCallback((): void => {
    setIsDiffCollapsed((value) => !value)
  }, [])

  const openDiffPanelForChange = useCallback((path: string): void => {
    setSelectedChangePath(path)
    setIsDiffCollapsed(false)
  }, [])

  const layoutStyle = useMemo((): React.CSSProperties | undefined => {
    if (isNarrow) {
      const rows: string[] = []
      if (!isLeftCollapsed) rows.push('200px')
      rows.push('minmax(0, 1fr)')
      if (!isRightCollapsed) rows.push('280px')
      return {
        gridTemplateColumns: '1fr',
        gridTemplateRows: rows.join(' ')
      }
    }

    const columns: string[] = []
    if (!isLeftCollapsed) {
      columns.push(`${leftWidth}px`, '1px')
    }
    columns.push('minmax(0, 1fr)')
    if (!isRightCollapsed) {
      columns.push('1px', `${rightWidth}px`)
    }
    return {
      gridTemplateColumns: columns.join(' ')
    }
  }, [isLeftCollapsed, isNarrow, isRightCollapsed, leftWidth, rightWidth])

  return (
    <div className={`shell${isMac ? ' is-native-mac' : ''}`}>
      {/* aria-live region for async status announcements */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {status}
      </div>

      <header className={`titlebar${isMac ? ' is-native-mac' : ''}`}>
        <div className="titlebar-leading">
          <button
            className="titlebar-btn"
            type="button"
            aria-label={isLeftCollapsed ? 'Expand left sidebar' : 'Collapse left sidebar'}
            title={isLeftCollapsed ? 'Expand left sidebar' : 'Collapse left sidebar'}
            onClick={toggleLeftSidebar}
          >
            <span className="titlebar-btn-icon">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                {isLeftCollapsed ? (
                  <path d="M6 3l4 5-4 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                ) : (
                  <path d="M10 3L6 8l4 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                )}
                <path d="M3.5 2v12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </span>
          </button>
          <div className="titlebar-main">
            <span className="titlebar-app">Harmony</span>
            <div className="titlebar-meta">
              {branch && branch !== '—' && <span className="titlebar-branch-pill">{branch}</span>}
              {changesCount > 0 && (
                <span className="titlebar-changes-badge">{changesCount} changes</span>
              )}
            </div>
          </div>
        </div>
        <div className="titlebar-actions">
          {shouldShowUpdateAction(updateState) && (
            <button
              className={`titlebar-update-btn is-${updateState.phase}`}
              type="button"
              title={updateActionTitle(updateState)}
              disabled={updateState.phase === 'checking' || updateState.phase === 'downloading'}
              onClick={handleUpdateAction}
            >
              {updateActionLabel(updateState)}
            </button>
          )}
          <button
            className="titlebar-btn"
            type="button"
            aria-label={`Theme: ${THEME_LABELS[theme]}. Click to switch.`}
            title={THEME_LABELS[theme]}
            onClick={handleThemeToggle}
          >
            <span key={theme} className="titlebar-btn-icon">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                {theme === 'dark' ? (
                  <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.2 3.1A4.5 4.5 0 0 1 12.9 9.8 6.5 6.5 0 0 1 6.2 3.1Z" fill="currentColor"/>
                ) : theme === 'light' ? (
                  <path d="M8 3.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9ZM8 2a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 0-1 0v1A.5.5 0 0 0 8 2Zm0 12a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 1 0v-1A.5.5 0 0 0 8 14ZM2 8a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 0 0 1h1A.5.5 0 0 0 2 8Zm12 0a.5.5 0 0 0 .5.5h1a.5.5 0 0 0 0-1h-1A.5.5 0 0 0 14 8ZM3.8 3.8a.5.5 0 0 0-.7-.7l-.7.7a.5.5 0 0 0 .7.7l.7-.7Zm8.4 8.4a.5.5 0 0 0 .7.7l.7-.7a.5.5 0 0 0-.7-.7l-.7.7ZM3.8 12.2a.5.5 0 0 0-.7.7l.7.7a.5.5 0 0 0 .7-.7l-.7-.7Zm8.4-8.4a.5.5 0 0 0 .7-.7l-.7-.7a.5.5 0 0 0-.7.7l.7.7Z" fill="currentColor"/>
                ) : (
                  <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM3.5 8a4.5 4.5 0 0 1 4.5-4.5v9A4.5 4.5 0 0 1 3.5 8Z" fill="currentColor"/>
                )}
              </svg>
            </span>
          </button>
          <button
            className="titlebar-btn"
            type="button"
            aria-label={isRightCollapsed ? 'Expand right sidebar' : 'Collapse right sidebar'}
            title={isRightCollapsed ? 'Expand right sidebar' : 'Collapse right sidebar'}
            onClick={toggleRightSidebar}
          >
            <span className="titlebar-btn-icon">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                {isRightCollapsed ? (
                  <path d="M10 3L6 8l4 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                ) : (
                  <path d="M6 3l4 5-4 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                )}
                <path d="M12.5 2v12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </span>
          </button>
        </div>
      </header>

      <div
        className="layout"
        style={layoutStyle}
      >
        {/* ── Left: Workspaces ── */}
        {!isLeftCollapsed && (
          <div className="panel-left">
            <WorktreePanel
              workspaces={workspaces}
              openedTerminalsByWorkspace={openedTerminalsByWorkspace}
              selectedPath={selectedWt}
              gitAvailability={gitAvailability}
              gitActionPending={isGitActionPending}
              onSelect={(p) => void loadWorkspace(p)}
              onOpenTerminalTab={(workspacePath, tabId) => {
                void handleOpenTerminalTab(workspacePath, tabId)
              }}
              onCreate={handleCreateWorktree}
              onOpenFolder={handleOpenFolder}
              onRemove={handleRemove}
              onInstallGit={handleInstallGit}
              onRetryGit={handleRetryGit}
            />
          </div>
        )}

        {!isNarrow && !isLeftCollapsed && (
          <div
            className="resize-handle resize-handle-left"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize left sidebar"
            tabIndex={0}
            onMouseDown={startResizeLeft}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault()
                const delta = e.key === 'ArrowRight' ? 8 : -8
                setSidebarWidths(([, r]) => {
                  const next: [number, number] = [clampSidebar(leftWidth + delta), r]
                  saveSidebarWidths(next[0], next[1])
                  return next
                })
              }
            }}
          />
        )}

        {/* ── Center: Terminal ── */}
        <div className="panel-center">
          <div className="center-split">
            <div className="center-main">
              <TerminalPanel
                workspacePath={selectedWt}
                requestedActiveTab={requestedActiveTerminalTab}
                onOpenTerminalsChange={setOpenTerminalTabs}
                onActiveTerminalTabChange={setActiveTerminalTab}
              />
            </div>

            {!isNarrow && !isDiffCollapsed && (
              <div
                className="resize-handle resize-handle-diff"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize diff panel"
                tabIndex={0}
                onMouseDown={startResizeDiff}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                    e.preventDefault()
                    const delta = e.key === 'ArrowLeft' ? 12 : -12
                    const next = clampDiffPanel(diffPanelWidth + delta)
                    setDiffPanelWidth(next)
                    saveDiffPanelWidth(next)
                  }
                }}
              />
            )}

            {!isDiffCollapsed && (
              <aside className="panel-diff" style={!isNarrow ? { width: diffPanelWidth } : undefined}>
                <div className="diff-pane-header">
                  <div className="diff-pane-title">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M3 4.5h10M3 8h10M3 11.5h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                    <span className="sc-section-label">Diff</span>
                    {selectedChangePath && (
                      <span className="sc-section-path" title={selectedChangePath}>
                        {selectedChangePath}
                      </span>
                    )}
                    {isDiffLoading && workspaceDiff.diff && <span className="sc-section-loading">Updating…</span>}
                    {workspaceDiff.truncated && <span className="sc-section-count">Truncated</span>}
                  </div>
                  <button
                    className="diff-pane-close"
                    type="button"
                    aria-label="Close diff panel"
                    onClick={toggleDiffPanel}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
                {isDiffLoading && !workspaceDiff.diff ? (
                  <div className="sc-diff-empty">Loading diff…</div>
                ) : diffError ? (
                  <div className="sc-diff-empty">{diffError}</div>
                ) : workspaceDiff.diff ? (
                  <div className="sc-diff-view" role="region" aria-label="Selected file diff">
                    {diffViewLines.map((line, index) => (
                      <div key={`${index}-${line.text}`} className={`sc-diff-line ${line.className}`.trim()}>
                        <span className="sc-diff-ln">{line.left ?? ''}</span>
                        <span className="sc-diff-ln">{line.right ?? ''}</span>
                        <span className="sc-diff-text">{line.text || ' '}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="sc-diff-empty">Select a changed file to inspect its diff.</div>
                )}
              </aside>
            )}
          </div>
        </div>

        {!isNarrow && !isRightCollapsed && (
          <div
            className="resize-handle resize-handle-right"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize right sidebar"
            tabIndex={0}
            onMouseDown={startResizeRight}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault()
                const delta = e.key === 'ArrowLeft' ? 8 : -8
                setSidebarWidths(([l]) => {
                  const next: [number, number] = [l, clampSidebar(rightWidth + delta)]
                  saveSidebarWidths(next[0], next[1])
                  return next
                })
              }
            }}
          />
        )}

        {/* ── Right: Source Control ── */}
        {!isRightCollapsed && (
        <div className="panel-right">
          {/* Tab bar */}
          <div className="sc-tabbar" role="tablist" aria-label="Panel tabs">
            {RIGHT_TABS.map((tab) => (
              <button
                key={tab}
                id={`tab-${tab}`}
                className={`sc-tab${rightTab === tab ? ' is-active' : ''}`}
                type="button"
                role="tab"
                aria-selected={rightTab === tab}
                aria-controls={`panel-${tab}`}
                onClick={() => setRightTab(tab)}
              >
                {RIGHT_TAB_LABELS[tab]}
                {tab === 'changes' && changesCount > 0 && (
                  <span className="sc-tab-badge">{changesCount}</span>
                )}
              </button>
            ))}
          </div>

          {/* Panel body */}
          <div
            id={`panel-${rightTab}`}
            className="sc-body"
            role="tabpanel"
            aria-labelledby={`tab-${rightTab}`}
          >
            {/* ── Changes ── */}
            {rightTab === 'changes' && (
              <div className="sc-panel">
                {/* Toolbar */}
                <div className="sc-toolbar">
                  <button
                    className="sc-tool-btn"
                    type="button"
                    aria-label="Refresh changes"
                    onClick={handleRefreshChanges}
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5c1.8 0 3.4.87 4.4 2.2L10.5 6.5H14V3l-1.6 1.6A7 7 0 1 0 15 8h-1.5Z" fill="currentColor"/>
                    </svg>
                  </button>
                  <div className="sc-toolbar-spacer" />
                  <span className="sc-toolbar-branch">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M5 3.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM3.5 6A2.5 2.5 0 0 0 6 3.5h2.5a1.5 1.5 0 1 0 0-1H6A3.5 3.5 0 0 0 2.5 6v4A2.5 2.5 0 1 0 5 10V6A1.5 1.5 0 0 1 6 4.5h2.5A1.5 1.5 0 1 0 9 3.5a1.5 1.5 0 0 0-1 .37V3.5H6A2.5 2.5 0 0 0 3.5 6Z" fill="currentColor"/>
                    </svg>
                    {branch}
                  </span>
                </div>

                {/* Commit input */}
                <div className="sc-commit-wrap">
                  <textarea
                    className="sc-commit-input"
                    placeholder="Commit message"
                    aria-label="Commit message"
                    spellCheck={false}
                    value={commitMsg}
                    onChange={(e) => setCommitMsg(e.target.value)}
                  />
                  <div className="sc-commit-actions">
                    <button
                      className="sc-secondary-btn"
                      type="button"
                      disabled={!canGenerateCommitMessage}
                      onClick={() => void handleGenerateCommitMessage()}
                    >
                      {isGeneratingCommitMsg ? 'Generating…' : 'AI Message'}
                    </button>
                    <button
                      className="sc-commit-btn"
                      type="button"
                      disabled={!canCommit}
                      onClick={() => void handleCommitChanges()}
                    >
                      {isCommitting ? 'Committing…' : 'Commit All'}
                    </button>
                  </div>
                  {(status || isGeneratingCommitMsg) && status !== 'Loading…' && (
                    <div
                      className="sc-commit-status"
                      role="status"
                      aria-live="polite"
                    >
                      {isGeneratingCommitMsg && !status
                        ? 'Calling AI…'
                        : status}
                    </div>
                  )}
                </div>

                {/* Publish */}
                {branchActionMode && (
                  <div className="sc-publish-row">
                    <button
                      className="sc-publish-btn"
                      type="button"
                      disabled={!canPublish}
                      onClick={() => void handlePublishBranch(false)}
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M8 2l5 5H9.5v7h-3V7H3L8 2Z" fill="currentColor"/>
                      </svg>
                      {isPublishing ? 'Publishing…' : publishLabel}
                    </button>
                    {branchActionMode === 'publish' && (
                      <button
                        className="sc-publish-chevron"
                        type="button"
                        aria-label="Choose publish remote"
                        disabled={!canPublish}
                        onClick={() => void handlePublishBranch(true)}
                      >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </button>
                    )}
                  </div>
                )}
                <div className="sc-publish-meta">{publishMeta}</div>

                {/* File list */}
                {!activeChanges.isGitRepo ? (
                  <div className="empty-state">Not a git repository.</div>
                ) : changesCount === 0 ? (
                  <div className="empty-state">Working tree is clean.</div>
                ) : (
                  <div className={`sc-file-list-panel${isChangesListCollapsed ? ' is-collapsed' : ''}`}>
                      <div className="sc-section-hd">
                        <button
                          className="sc-section-toggle"
                          type="button"
                          aria-expanded={!isChangesListCollapsed}
                          onClick={() => setIsChangesListCollapsed((value) => !value)}
                        >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <path d="M1 4h14M1 8h14M1 12h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                        </svg>
                        <span className="sc-section-label">Changes</span>
                        <span className="sc-section-count">{changesCount}</span>
                        <svg
                          className={`sc-section-chevron${isChangesListCollapsed ? ' is-collapsed' : ''}`}
                          width="12"
                          height="12"
                          viewBox="0 0 16 16"
                          fill="none"
                          aria-hidden="true"
                        >
                          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        </button>
                        <div className="sc-section-spacer" />
                        <button
                          className="sc-tool-btn"
                          type="button"
                          aria-label="Stage all changes"
                          disabled={isStagingChanges || changesCount === 0}
                          onClick={() => void handleStageAllChanges()}
                        >
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                            <path d="M8 2v10M3 7l5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </button>
                      </div>

                      {!isChangesListCollapsed && (
                      <div className="sc-file-list-scroll">
                        {groupedChanges.map((group) => (
                          <div key={group.dir} className="sc-dir-group">
                            <div className="sc-dir-hd">
                              <span className="sc-dir-name">{group.dir}</span>
                              <span className="sc-dir-count">{group.files.length}</span>
                            </div>
                            {group.files.map((f) => (
                              <div
                                key={f.path}
                                className={`sc-file-row${selectedChangePath === f.path ? ' is-selected' : ''}`}
                                title={f.path}
                              >
                                <button
                                  type="button"
                                  className="sc-file-main"
                                  ref={(node) => {
                                    if (node) {
                                      fileRowRefs.current.set(f.path, node)
                                    } else {
                                      fileRowRefs.current.delete(f.path)
                                    }
                                  }}
                                  onClick={() => setSelectedChangePath(f.path)}
                                  onKeyDown={(event) => handleChangeRowKeyDown(event, f.path)}
                                >
                                  <span
                                    className={`sc-status-dot sc-s-${statusToClass(f.status)}`}
                                    aria-label={statusLabel(f.status)}
                                  />
                                  <span className="sc-file-name">{f.name}</span>
                                  <span className="sc-file-stats" aria-label={`${f.additions} additions and ${f.deletions} deletions`}>
                                    {f.additions > 0 && <span className="sc-file-additions">+{f.additions}</span>}
                                    {f.deletions > 0 && <span className="sc-file-deletions">-{f.deletions}</span>}
                                    {f.additions === 0 && f.deletions === 0 && <span className="sc-file-neutral">0</span>}
                                  </span>
                                </button>
                                <span className="sc-file-actions">
                                  {selectedWt && (
                                    <button
                                      className="sc-inline-icon"
                                      type="button"
                                      aria-label={`Show diff for ${f.name}`}
                                      title={`Show diff for ${f.name}`}
                                      onClick={() => openDiffPanelForChange(f.path)}
                                    >
                                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                                        <path d="M6 3.5h6.5V10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                        <path d="M10.5 3.5 4 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                                        <path d="M4.5 5.5V12h6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                      </svg>
                                    </button>
                                  )}
                                </span>
                                <span className="sc-file-badge">{statusLabel(f.status)}</span>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                      )}
                  </div>
                )}
              </div>
            )}

            {/* ── Files ── */}
            {rightTab === 'files' && (
              <div className="files-panel files-panel-full">
                <div className="panel-subheader">
                  <div>
                    <div className="section-label">Workspace Files</div>
                    <div className="section-title">{label}</div>
                  </div>
                  <span className="badge">{files}</span>
                </div>
                <div className="file-scroll">
                  <FileTree
                    entries={workspace?.entries ?? []}
                    selectedPath={selectedFile}
                    onSelect={(p) => {
                      if (selectedWt) openFile(selectedWt, p)
                    }}
                  />
                </div>
              </div>
            )}

            {/* ── Inspector ── */}
            {rightTab === 'inspector' && (
              <div className="right-scroll">
                <div className="inspector-actions">
                  <button
                    className="inspector-diff-btn"
                    type="button"
                    onClick={() => setIsDiffCollapsed(false)}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M3 4.5h10M3 8h10M3 11.5h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                    {isDiffCollapsed ? 'Open Diff Panel' : 'Diff Panel Open'}
                  </button>
                </div>
                <div className="accord-list">
                  {/* Context Window — active agent session */}
                  <AccordionSection
                    id="context"
                    label="Context Window"
                    count={contextWindowCount}
                    open={openAccordions.has('context')}
                    onToggle={() => toggleAccordion('context')}
                  >
                    {activeTerminalTab && (
                      <div className="accord-item accord-item-session">
                        <div className="session-row">
                          <span className="session-title">Active Session</span>
                          <span className="session-tokens">{activeTerminalTab.title}</span>
                        </div>
                        <div className="session-meta">
                          <span className="session-agent">{activeTerminalTab.agentId ?? 'terminal'}</span>
                          <span className="session-model">{activeTerminalTab.status ?? 'active'}</span>
                        </div>
                      </div>
                    )}
                    {!activeTerminalTab ? (
                      <div className="empty-state">
                        Select an active terminal tab to inspect its session context.
                      </div>
                    ) : !activeTerminalTab.isAgent ? (
                      <div className="empty-state">
                        Context window data is only available for the active AI agent session.
                      </div>
                    ) : !activeSessionStat ? (
                      <div className="empty-state">
                        No matching session context found for the active agent session yet.
                      </div>
                    ) : (
                      (() => {
                        const total = activeSessionStat.inputTokens + activeSessionStat.outputTokens
                        const totalK = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total)
                        const pct = activeSessionStat.contextWindow
                          ? Math.min(100, (total / activeSessionStat.contextWindow) * 100)
                          : null
                        const ctxK = activeSessionStat.contextWindow
                          ? `${(activeSessionStat.contextWindow / 1000).toFixed(0)}k`
                          : null
                        const barClass = pct === null ? '' : pct >= 80 ? ' is-danger' : pct >= 60 ? ' is-warn' : ' is-ok'

                        return (
                          <div key={activeSessionStat.id} className="accord-item accord-item-session">
                            <div className="session-row">
                              <span className="session-title">{activeSessionStat.title || 'Untitled'}</span>
                              <span className="session-tokens">{totalK}{ctxK && <span className="session-ctx-max">/{ctxK}</span>}</span>
                            </div>
                            {pct !== null && (
                              <div className="session-bar-wrap" title={`${pct.toFixed(1)}% of context window`}>
                                <div className={`session-bar${barClass}`} style={{ width: `${pct}%` }} />
                              </div>
                            )}
                            <div className="session-meta">
                              <span className="session-agent">{activeSessionStat.agent}</span>
                              <span className="session-model">{activeSessionStat.model || '—'}</span>
                              <span className="session-breakdown">
                                ↑{(activeSessionStat.inputTokens / 1000).toFixed(1)}k&nbsp;↓{(activeSessionStat.outputTokens / 1000).toFixed(1)}k
                                {activeSessionStat.cacheReadTokens > 0 && <>&nbsp;⚡{(activeSessionStat.cacheReadTokens / 1000).toFixed(1)}k</>}
                              </span>
                            </div>
                          </div>
                        )
                      })()
                    )}
                  </AccordionSection>

                  <AccordionSection
                    id="skill-store"
                    label="Skill Store"
                    count={marketplaceResults.length}
                    open={openAccordions.has('skill-store')}
                    onToggle={() => toggleAccordion('skill-store')}
                  >
                    <div className="skill-store-toolbar">
                      <input
                        className="skill-store-input"
                        type="text"
                        placeholder="Search skills.sh (e.g. react, postgres)"
                        value={marketplaceQuery}
                        onChange={(event) => setMarketplaceQuery(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            if (marketplaceSearchTimerRef.current !== null) {
                              window.clearTimeout(marketplaceSearchTimerRef.current)
                              marketplaceSearchTimerRef.current = null
                            }
                            void handleMarketplaceSearch()
                          }
                        }}
                      />
                      <button
                        className="skill-store-search-btn"
                        type="button"
                        onClick={() => {
                          if (marketplaceSearchTimerRef.current !== null) {
                            window.clearTimeout(marketplaceSearchTimerRef.current)
                            marketplaceSearchTimerRef.current = null
                          }
                          void handleMarketplaceSearch()
                        }}
                        disabled={isMarketplaceLoading}
                      >
                        {isMarketplaceLoading ? 'Searching…' : 'Search'}
                      </button>
                      <button
                        className="skill-store-open-btn"
                        type="button"
                        onClick={() => {
                          void window.api.openExternalUrl('https://skills.sh')
                        }}
                      >
                        Browse
                      </button>
                    </div>

                    {marketplaceError && <div className="skill-store-error">{marketplaceError}</div>}

                    {marketplaceResults.length === 0 ? (
                      <div className="empty-state">Search to browse skills from skills.sh.</div>
                    ) : (
                      marketplaceResults.map((item) => (
                        <div key={item.id} className="skill-store-item">
                          <div className="skill-store-item-copy">
                            <span className="skill-store-item-name">{item.name}</span>
                            <span className="skill-store-item-meta">
                              {item.source} · {fmtInstalls(item.installs)} installs
                            </span>
                          </div>
                          <button
                            className="skill-store-install-btn"
                            type="button"
                            disabled={installingSkillId !== null}
                            onClick={() => {
                              void handleMarketplaceInstall(item)
                            }}
                          >
                            {installingSkillId === item.id ? 'Installing…' : 'Install'}
                          </button>
                        </div>
                      ))
                    )}
                  </AccordionSection>

                  {/* Skills grouped by source */}
                  {skillsCount === 0 ? (
                    <div className="empty-state">No skills detected.</div>
                  ) : (
                    groupedSkills.map((group) => {
                      const accordId = `skill-${group.source}`
                      const color = sourceColor(group.source)
                      return (
                        <AccordionSection
                          key={group.source}
                          id={accordId}
                          label={sourceLabel(group.source)}
                          count={group.items.length}
                          accent={color}
                          open={openAccordions.has(accordId)}
                          onToggle={() => toggleAccordion(accordId)}
                        >
                          {group.items.map((skill) => (
                            <div key={skill.id} className="accord-item">
                              <span className="accord-item-dot" style={{ background: color }} aria-hidden="true" />
                              <span className="accord-item-name">{skill.name}</span>
                            </div>
                          ))}
                        </AccordionSection>
                      )
                    })
                  )}

                  {/* MCP Servers */}
                  <AccordionSection
                    id="mcp"
                    label="MCP Servers"
                    count={mcpCount}
                    open={openAccordions.has('mcp')}
                    onToggle={() => toggleAccordion('mcp')}
                  >
                    {mcpCount === 0 ? (
                      <div className="empty-state">No MCP servers detected.</div>
                    ) : (
                      contextInfo!.mcpServers.map((server) => (
                        <div
                          key={server.id}
                          className="accord-item accord-item-mcp"
                          title={server.statusDetail ?? `${server.id} is ${mcpStatusLabel(server.status)}.`}
                        >
                          <AccordItemGlyph iconUrl={server.iconUrl} />
                          <span className="accord-item-name">{server.id}</span>
                          <span className={`accord-item-chip ${mcpStatusClass(server.status)}`}>
                            {mcpStatusLabel(server.status)}
                          </span>
                          {server.statusDetail && (
                            <span className="accord-item-meta">{server.statusDetail}</span>
                          )}
                        </div>
                      ))
                    )}
                  </AccordionSection>

                  {/* Subagents — from OpenCode agent config files */}
                  <AccordionSection
                    id="subagents"
                    label="Subagents"
                    count={subagentsList.length}
                    open={openAccordions.has('subagents')}
                    onToggle={() => toggleAccordion('subagents')}
                  >
                    {subagentsList.length === 0 ? (
                      <div className="empty-state">No OpenCode subagents found.<br />Add agents to <code>~/.config/opencode/agents/</code></div>
                    ) : (
                      subagentsList.map((agent) => (
                        <div key={agent.id} className="accord-item accord-item-subagent">
                          <span className="accord-item-dot" aria-hidden="true" />
                          <span className="accord-item-name">{agent.name}</span>
                          {agent.source === 'project' && (
                            <span className="accord-item-chip">project</span>
                          )}
                          {agent.model && (
                            <span className="accord-item-chip accord-item-chip-model">{agent.model.split('/').at(-1)}</span>
                          )}
                        </div>
                      ))
                    )}
                  </AccordionSection>
                </div>
              </div>
            )}

            {/* ── Usage ── */}
            {rightTab === 'usage' && (
              <div className="sc-panel usage-panel">
                {/* Quota section header */}
                <div className="usage-header">
                  <span className="usage-header-label">Subscription Quota</span>
                  <button
                    className="sc-tool-btn"
                    type="button"
                    aria-label="Refresh quota"
                    onClick={() => {
                      void Promise.all([window.api.getCodexQuota(), window.api.getClaudeQuota()]).then(
                        ([codex, claude]) => {
                          setCodexQuota(codex)
                          setClaudeQuota(claude)
                        }
                      )
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5c1.8 0 3.4.87 4.4 2.2L10.5 6.5H14V3l-1.6 1.6A7 7 0 1 0 15 8h-1.5Z" fill="currentColor"/>
                    </svg>
                  </button>
                </div>

                <div className="usage-cards">
                  {codexQuota ? (
                    <CodexQuotaCard quota={codexQuota} />
                  ) : (
                    <div className="empty-state" style={{ padding: '12px 16px', fontSize: '11px' }}>
                      Codex quota unavailable — check <code>~/.codex/auth.json</code>
                    </div>
                  )}
                  {claudeQuota ? (
                    <ClaudeQuotaCard quota={claudeQuota} />
                  ) : (
                    <div className="empty-state" style={{ padding: '12px 16px', fontSize: '11px' }}>
                      Claude Code subscription usage unavailable — connect Claude Code and make sure <code>claude /usage</code> works.
                    </div>
                  )}
                </div>

                {/* Token usage section header */}
                <div className="usage-header" style={{ marginTop: '8px' }}>
                  <span className="usage-header-label">Token Usage (30 days)</span>
                  <button
                    className="sc-tool-btn"
                    type="button"
                    aria-label="Refresh token usage"
                    onClick={() => {
                      void window.api.getUsageSummary().then(setUsageData)
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5c1.8 0 3.4.87 4.4 2.2L10.5 6.5H14V3l-1.6 1.6A7 7 0 1 0 15 8h-1.5Z" fill="currentColor"/>
                    </svg>
                  </button>
                </div>

                {usageData.length === 0 ? (
                  <div className="empty-state" style={{ padding: '12px 16px' }}>
                    No usage data found.
                  </div>
                ) : (
                  <div className="usage-cards">
                    {usageData.map((u) => (
                      <AgentUsageCard key={u.agent} usage={u} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        )}
      </div>
    </div>
  )
}

export default App
