import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as https from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import {
  disposeAgentRuns,
  handleAgentTerminalData,
  handleAgentTerminalExit,
  registerAgentIpc
} from './agent'
import {
  disposeTerminalSessions,
  onTerminalData,
  onTerminalExit,
  registerTerminalIpc,
  writeTerminalInputForOwner
} from './terminal'
import { harmonyChannels } from '../shared/workbench'
import { ensureBundledSkillsInstalled } from './bundledSkills'
import { registerSourceControlIpc } from './sourceControl'
import { registerWorktreeIpc } from './worktree'

let detachTerminalDataListener: (() => void) | null = null
let detachTerminalExitListener: (() => void) | null = null

async function listSkillSummaries(): Promise<Array<{ id: string; name: string; source: string }>> {
  const roots = [
    { path: join(homedir(), '.cursor/skills'), source: 'cursor' },
    { path: join(homedir(), '.cursor/skills-cursor'), source: 'cursor' },
    { path: join(homedir(), '.cursor/rules'), source: 'cursor' },
    { path: join(homedir(), '.agents/skills'), source: 'agents' },
    { path: join(homedir(), '.codex/skills'), source: 'codex' }
  ]

  const seen = new Set<string>()
  const skills: Array<{ id: string; name: string; source: string }> = []

  for (const root of roots) {
    const entries = await fs.readdir(root.path, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillFile = join(root.path, entry.name, 'SKILL.md')
      const exists = await fs
        .stat(skillFile)
        .then(() => true)
        .catch(() => false)
      if (!exists) continue
      const id = `${root.source}:${entry.name}`
      if (seen.has(id)) continue
      seen.add(id)
      skills.push({
        id,
        name: entry.name,
        source: root.source
      })
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (!match) return {}
  const result: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (key) result[key] = value
  }
  return result
}

async function listOpenCodeSubagents(): Promise<
  Array<{ id: string; name: string; description: string; model: string; source: 'global' | 'project' }>
> {
  const roots: Array<{ path: string; source: 'global' | 'project' }> = [
    { path: join(homedir(), '.config', 'opencode', 'agents'), source: 'global' },
    { path: join(homedir(), '.opencode', 'agents'), source: 'global' }
  ]

  const seen = new Set<string>()
  const subagents: Array<{ id: string; name: string; description: string; model: string; source: 'global' | 'project' }> = []

  for (const root of roots) {
    const entries = await fs.readdir(root.path, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const content = await fs.readFile(join(root.path, entry.name), 'utf8').catch(() => '')
      if (!content) continue
      const fm = parseFrontmatter(content)
      const mode = fm['mode'] ?? 'all'
      if (mode !== 'subagent' && mode !== 'all') continue
      const name = entry.name.replace(/\.md$/, '')
      if (seen.has(name)) continue
      seen.add(name)
      subagents.push({
        id: `opencode:${name}`,
        name,
        description: fm['description'] ?? '',
        model: fm['model'] ?? '',
        source: root.source
      })
    }
  }

  return subagents.sort((a, b) => a.name.localeCompare(b.name))
}

function toOriginFavicon(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL('/favicon.ico', url).toString()
  } catch {
    return undefined
  }
}

function inferMcpServerIcon(
  id: string,
  value: { type?: string; url?: string; command?: string; args?: string[] }
): string | undefined {
  const haystack = [id, value.url, value.command, ...(value.args ?? [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  const knownIcons: Array<[string[], string]> = [
    [['firecrawl'], 'https://firecrawl.dev/favicon.ico'],
    [['supabase', 'server-postgres'], 'https://supabase.com/favicon.ico'],
    [['linear'], 'https://linear.app/favicon.ico'],
    [['context7'], 'https://context7.com/favicon.ico'],
    [['posthog'], 'https://posthog.com/favicon.ico'],
    [['helicone'], 'https://helicone.ai/favicon.ico'],
    [['logfire', 'pydantic'], 'https://logfire.pydantic.dev/favicon.ico'],
    [['ai-sdk', 'vercel'], 'https://sdk.vercel.ai/favicon.ico']
  ]

  for (const [needles, iconUrl] of knownIcons) {
    if (needles.some((needle) => haystack.includes(needle))) {
      return iconUrl
    }
  }

  return toOriginFavicon(value.url)
}

async function listMcpServers(): Promise<Array<{ id: string; transport: string; iconUrl?: string }>> {
  const configPath = join(homedir(), '.cursor/mcp.json')
  const raw = await fs.readFile(configPath, 'utf8').catch(() => '')
  if (!raw) return []

  try {
    const parsed = JSON.parse(raw) as {
      mcpServers?: Record<string, { type?: string; url?: string; command?: string; args?: string[] }>
    }
    return Object.entries(parsed.mcpServers ?? {})
      .map(([id, value]) => ({
        id,
        transport: value.type ?? (value.url ? 'http' : value.command ? 'stdio' : 'unknown'),
        iconUrl: inferMcpServerIcon(id, value)
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  } catch {
    return []
  }
}

const OPENCODE_DB = join(homedir(), '.local', 'share', 'opencode', 'opencode.db')

const SESSION_STATS_SQL = `
SELECT
  s.id,
  s.title,
  s.directory,
  s.time_updated,
  COALESCE(json_extract(m.data, '$.modelID'), '') AS model,
  COALESCE(CAST(SUM(json_extract(m.data, '$.tokens.input'))     AS INTEGER), 0) AS input_tokens,
  COALESCE(CAST(SUM(json_extract(m.data, '$.tokens.output'))    AS INTEGER), 0) AS output_tokens,
  COALESCE(CAST(SUM(json_extract(m.data, '$.tokens.cache.read')) AS INTEGER), 0) AS cache_read
FROM session s
JOIN message m ON m.session_id = s.id
WHERE s.directory = ?
  AND json_extract(m.data, '$.tokens') IS NOT NULL
  AND s.time_archived IS NULL
GROUP BY s.id
ORDER BY s.time_updated DESC
LIMIT 5;
`.trim()

async function listCodexSessionStats(
  workspacePath: string
): Promise<import('../shared/workbench').SessionStat[]> {
  const codexDir = join(homedir(), '.codex')
  const sessionsRoot = join(codexDir, 'sessions')

  // Build id→title map from session_index.jsonl
  const idToTitle = new Map<string, string>()
  const indexRaw = await fs.readFile(join(codexDir, 'session_index.jsonl'), 'utf8').catch(() => '')
  for (const line of indexRaw.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as { id?: string; thread_name?: string }
      if (entry.id) idToTitle.set(entry.id, entry.thread_name ?? '')
    } catch { /* skip */ }
  }

  // Scan last 14 days of session directories
  const now = Date.now()
  const sessionFiles: string[] = []
  for (let i = 0; i < 14; i++) {
    const d = new Date(now - i * 86_400_000)
    const dir = join(
      sessionsRoot,
      d.getFullYear().toString(),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0')
    )
    const entries = await fs.readdir(dir).catch(() => [] as string[])
    for (const f of entries) {
      if (f.endsWith('.jsonl')) sessionFiles.push(join(dir, f))
    }
  }

  // Newest first (filename starts with date-time)
  sessionFiles.sort().reverse()

  const results: import('../shared/workbench').SessionStat[] = []

  for (const filePath of sessionFiles) {
    if (results.length >= 5) break

    const content = await fs.readFile(filePath, 'utf8').catch(() => '')
    if (!content) continue
    const lines = content.split('\n').filter((l) => l.trim())

    // First line must be session_meta with matching cwd
    let sessionId = ''
    let sessionCwd = ''
    let sessionTimestamp = ''
    try {
      const meta = JSON.parse(lines[0]) as {
        type?: string
        payload?: { id?: string; cwd?: string; timestamp?: string }
      }
      if (meta.type !== 'session_meta') continue
      sessionId = meta.payload?.id ?? ''
      sessionCwd = meta.payload?.cwd ?? ''
      sessionTimestamp = meta.payload?.timestamp ?? ''
    } catch { continue }

    if (sessionCwd !== workspacePath) continue

    // Scan backwards for last token_count event
    type TokenInfo = {
      total_token_usage?: {
        input_tokens: number
        cached_input_tokens: number
        output_tokens: number
        total_tokens: number
      }
      model_context_window?: number
    }
    let lastTokenInfo: TokenInfo | null = null

    for (let i = lines.length - 1; i >= 1; i--) {
      try {
        const ev = JSON.parse(lines[i]) as {
          type?: string
          payload?: { type?: string; info?: TokenInfo }
        }
        if (ev.type === 'event_msg' && ev.payload?.type === 'token_count' && ev.payload.info) {
          lastTokenInfo = ev.payload.info
          break
        }
      } catch { /* skip */ }
    }

    if (!lastTokenInfo?.total_token_usage) continue
    const u = lastTokenInfo.total_token_usage

    results.push({
      id: sessionId,
      title: idToTitle.get(sessionId) ?? '',
      directory: sessionCwd,
      model: 'codex',
      agent: 'codex',
      timeUpdated: sessionTimestamp ? new Date(sessionTimestamp).getTime() : 0,
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadTokens: u.cached_input_tokens,
      contextWindow: lastTokenInfo.model_context_window
    })
  }

  return results
}

async function listOpenCodeSessionStats(
  workspacePath: string
): Promise<import('../shared/workbench').SessionStat[]> {
  return new Promise((resolve) => {
    execFile(
      'sqlite3',
      ['-separator', '\t', OPENCODE_DB, SESSION_STATS_SQL.replace('?', `'${workspacePath.replace(/'/g, "''")}'`)],
      { encoding: 'utf8', timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve([])
          return
        }
        const rows = stdout
          .trim()
          .split('\n')
          .map((line) => {
            const [id, title, directory, timeUpdated, model, inputTokens, outputTokens, cacheReadTokens] =
              line.split('\t')
            return {
              id: id ?? '',
              title: title ?? '',
              directory: directory ?? '',
              model: model ?? '',
              agent: 'opencode' as const,
              timeUpdated: Number(timeUpdated) || 0,
              inputTokens: Number(inputTokens) || 0,
              outputTokens: Number(outputTokens) || 0,
              cacheReadTokens: Number(cacheReadTokens) || 0
            }
          })
          .filter((r) => r.id)
        resolve(rows)
      }
    )
  })
}

// ── Usage summary (last 30 days, all workspaces) ─────────────────────────────

const OPENCODE_USAGE_SQL = `
SELECT
  COALESCE(CAST(SUM(json_extract(m.data, '$.tokens.input'))      AS INTEGER), 0) AS input_tokens,
  COALESCE(CAST(SUM(json_extract(m.data, '$.tokens.output'))     AS INTEGER), 0) AS output_tokens,
  COALESCE(CAST(SUM(json_extract(m.data, '$.tokens.cache.read')) AS INTEGER), 0) AS cache_read,
  COUNT(DISTINCT s.id) AS session_count
FROM session s
JOIN message m ON m.session_id = s.id
WHERE json_extract(m.data, '$.tokens') IS NOT NULL
  AND s.time_archived IS NULL
  AND s.time_updated >= ?;
`.trim()

async function getCodexUsageSummary(): Promise<import('../shared/workbench').AgentUsage> {
  const sessionsRoot = join(homedir(), '.codex', 'sessions')
  const now = Date.now()
  let sessionCount = 0
  let totalInput = 0
  let totalOutput = 0
  let totalCache = 0
  let latestTime = 0
  let sessionLimit: import('../shared/workbench').RateLimitWindow | undefined
  let weeklyLimit: import('../shared/workbench').RateLimitWindow | undefined

  for (let i = 0; i < 30; i++) {
    const d = new Date(now - i * 86_400_000)
    const dir = join(
      sessionsRoot,
      d.getFullYear().toString(),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0')
    )
    const entries = await fs.readdir(dir).catch(() => [] as string[])
    for (const f of entries.filter((e) => e.endsWith('.jsonl'))) {
      const content = await fs.readFile(join(dir, f), 'utf8').catch(() => '')
      if (!content) continue
      const lines = content.split('\n').filter((l) => l.trim())

      // Find last token_count event
      for (let j = lines.length - 1; j >= 0; j--) {
        try {
          const ev = JSON.parse(lines[j]) as {
            type?: string
            payload?: {
              type?: string
              info?: {
                total_token_usage?: {
                  input_tokens: number
                  cached_input_tokens: number
                  output_tokens: number
                }
                rate_limits?: {
                  primary?: { used_percent: number; window_minutes: number; resets_at: number }
                  secondary?: { used_percent: number; window_minutes: number; resets_at: number }
                } | null
              }
            }
          }
          if (ev.type === 'event_msg' && ev.payload?.type === 'token_count' && ev.payload.info) {
            const u = ev.payload.info.total_token_usage
            if (u) {
              totalInput += u.input_tokens
              totalOutput += u.output_tokens
              totalCache += u.cached_input_tokens
              sessionCount++

              // Grab rate limits from most recent session
              const fileTime = now - i * 86_400_000
              if (fileTime > latestTime && ev.payload.info.rate_limits) {
                latestTime = fileTime
                const rl = ev.payload.info.rate_limits
                if (rl.primary) {
                  sessionLimit = {
                    usedPct: rl.primary.used_percent,
                    windowMin: rl.primary.window_minutes,
                    resetsAt: rl.primary.resets_at
                  }
                }
                if (rl.secondary) {
                  weeklyLimit = {
                    usedPct: rl.secondary.used_percent,
                    windowMin: rl.secondary.window_minutes,
                    resetsAt: rl.secondary.resets_at
                  }
                }
              }
            }
            break
          }
        } catch { /* skip */ }
      }
    }
  }

  return {
    agent: 'codex',
    sessionCount,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCacheTokens: totalCache,
    sessionLimit,
    weeklyLimit
  }
}

async function getClaudeUsageSummary(): Promise<import('../shared/workbench').AgentUsage> {
  const projectsRoot = join(homedir(), '.claude', 'projects')
  const cutoffMs = Date.now() - 30 * 86_400_000

  let sessionCount = 0
  let totalInput = 0
  let totalOutput = 0
  let totalCache = 0
  let totalCost = 0

  const projectDirs = await fs.readdir(projectsRoot, { withFileTypes: true }).catch(() => [])
  const seenSessions = new Set<string>()

  for (const d of projectDirs) {
    if (!d.isDirectory()) continue
    const files = await fs.readdir(join(projectsRoot, d.name)).catch(() => [] as string[])
    for (const f of files.filter((e) => e.endsWith('.jsonl'))) {
      const filePath = join(projectsRoot, d.name, f)
      const stat = await fs.stat(filePath).catch(() => null)
      if (!stat || stat.mtimeMs < cutoffMs) continue

      const content = await fs.readFile(filePath, 'utf8').catch(() => '')
      if (!content) continue

      let sessionId = ''
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          const ev = JSON.parse(line) as {
            type?: string
            sessionId?: string
            costUSD?: number | null
            message?: {
              usage?: {
                input_tokens?: number
                output_tokens?: number
                cache_creation_input_tokens?: number
                cache_read_input_tokens?: number
              }
            }
          }

          if (ev.sessionId && !sessionId) sessionId = ev.sessionId

          const usage = ev.message?.usage
          if (usage) {
            totalInput += usage.input_tokens ?? 0
            totalOutput += usage.output_tokens ?? 0
            totalCache += (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
          }
          if (ev.costUSD) totalCost += ev.costUSD
        } catch { /* skip */ }
      }

      if (sessionId && !seenSessions.has(sessionId)) {
        seenSessions.add(sessionId)
        sessionCount++
      }
    }
  }

  return {
    agent: 'claude',
    sessionCount,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCacheTokens: totalCache,
    totalCostUSD: totalCost > 0 ? totalCost : undefined
  }
}

async function getOpenCodeUsageSummary(): Promise<import('../shared/workbench').AgentUsage> {
  const cutoffSec = Math.floor((Date.now() - 30 * 86_400_000) / 1000)

  return new Promise((resolve) => {
    execFile(
      'sqlite3',
      ['-separator', '\t', OPENCODE_DB, OPENCODE_USAGE_SQL.replace('?', String(cutoffSec))],
      { encoding: 'utf8', timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve({ agent: 'opencode', sessionCount: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheTokens: 0 })
          return
        }
        const [inputStr, outputStr, cacheStr, countStr] = stdout.trim().split('\t')
        resolve({
          agent: 'opencode',
          sessionCount: Number(countStr) || 0,
          totalInputTokens: Number(inputStr) || 0,
          totalOutputTokens: Number(outputStr) || 0,
          totalCacheTokens: Number(cacheStr) || 0
        })
      }
    )
  })
}

async function getUsageSummary(): Promise<import('../shared/workbench').AgentUsage[]> {
  const [codex, claude, opencode] = await Promise.all([
    getCodexUsageSummary(),
    getClaudeUsageSummary(),
    getOpenCodeUsageSummary()
  ])
  return [codex, claude, opencode].filter((u) => u.sessionCount > 0)
}

async function listSessionStats(
  workspacePath: string
): Promise<import('../shared/workbench').SessionStat[]> {
  const [opencode, codex] = await Promise.all([
    listOpenCodeSessionStats(workspacePath),
    listCodexSessionStats(workspacePath)
  ])
  // Interleave by time, newest first, cap at 8 total
  return [...opencode, ...codex]
    .sort((a, b) => b.timeUpdated - a.timeUpdated)
    .slice(0, 8)
}

// ── Codex quota (OAuth API) ───────────────────────────────────────────────────

interface CodexAuthJson {
  tokens?: {
    access_token?: string
    id_token?: string
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const part = token.split('.')[1]
    const padded = part + '==='.slice((part.length + 3) % 4)
    return JSON.parse(Buffer.from(padded, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

let codexQuotaCache: { data: import('../shared/workbench').CodexQuota | null; fetchedAt: number } | null = null
const QUOTA_CACHE_TTL_MS = 5 * 60_000 // 5 minutes

async function getCodexQuota(): Promise<import('../shared/workbench').CodexQuota | null> {
  if (codexQuotaCache && Date.now() - codexQuotaCache.fetchedAt < QUOTA_CACHE_TTL_MS) {
    return codexQuotaCache.data
  }

  const authPath = join(homedir(), '.codex', 'auth.json')
  const authRaw = await fs.readFile(authPath, 'utf8').catch(() => '')
  if (!authRaw) return null

  let authData: CodexAuthJson
  try { authData = JSON.parse(authRaw) as CodexAuthJson } catch { return null }

  const accessToken = authData.tokens?.access_token
  if (!accessToken) return null

  // Decode id_token for subscription info
  let subscriptionEndsAt: string | undefined
  let planType = 'pro'
  const idToken = authData.tokens?.id_token
  if (idToken) {
    const claims = decodeJwtPayload(idToken)
    const auth = claims['https://api.openai.com/auth'] as Record<string, string> | undefined
    if (auth) {
      planType = auth['chatgpt_plan_type'] ?? planType
      subscriptionEndsAt = auth['chatgpt_subscription_active_until']
    }
  }

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'chatgpt.com',
        path: '/backend-api/wham/usage',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': 'CodexCLI/1.0',
          Accept: 'application/json'
        },
        timeout: 10_000
      },
      (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => { body += chunk.toString() })
        res.on('end', () => {
          try {
            const d = JSON.parse(body) as {
              plan_type?: string
              rate_limit?: {
                primary_window?: { used_percent: number; limit_window_seconds: number; reset_at: number }
                secondary_window?: { used_percent: number; limit_window_seconds: number; reset_at: number } | null
              }
              credits?: { has_credits?: boolean; balance?: string }
              additional_rate_limits?: Array<{
                limit_name: string
                rate_limit?: {
                  primary_window?: { used_percent: number; limit_window_seconds: number; reset_at: number }
                  secondary_window?: { used_percent: number; limit_window_seconds: number; reset_at: number } | null
                }
              }>
            }

            const rl = d.rate_limit
            if (!rl?.primary_window) { resolve(null); return }

            const result: import('../shared/workbench').CodexQuota = {
              planType: d.plan_type ?? planType,
              subscriptionEndsAt,
              sessionUsedPct: rl.primary_window.used_percent,
              sessionWindowSec: rl.primary_window.limit_window_seconds,
              sessionResetsAt: rl.primary_window.reset_at,
              weeklyUsedPct: rl.secondary_window?.used_percent ?? 0,
              weeklyWindowSec: rl.secondary_window?.limit_window_seconds ?? 604800,
              weeklyResetsAt: rl.secondary_window?.reset_at ?? 0,
              hasCredits: d.credits?.has_credits ?? false,
              creditBalance: d.credits?.balance ?? '0',
              additionalLimits: (d.additional_rate_limits ?? []).map((l) => ({
                name: l.limit_name,
                sessionUsedPct: l.rate_limit?.primary_window?.used_percent ?? 0,
                sessionWindowSec: l.rate_limit?.primary_window?.limit_window_seconds ?? 18000,
                sessionResetsAt: l.rate_limit?.primary_window?.reset_at ?? 0,
                weeklyUsedPct: l.rate_limit?.secondary_window?.used_percent,
                weeklyWindowSec: l.rate_limit?.secondary_window?.limit_window_seconds,
                weeklyResetsAt: l.rate_limit?.secondary_window?.reset_at
              }))
            }

            codexQuotaCache = { data: result, fetchedAt: Date.now() }
            resolve(result)
          } catch {
            resolve(null)
          }
        })
      }
    )

    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.end()
  })
}

export function registerWorkbenchIpc(): void {
  void ensureBundledSkillsInstalled()

  ipcMain.handle(harmonyChannels.openFolder, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: OpenDialogOptions = { properties: ['openDirectory'] }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled) return null
    return result.filePaths[0] ?? null
  })

  ipcMain.handle(harmonyChannels.listAvailableAgents, async () => {
    const candidates = [
      { id: 'cursor', name: 'Cursor CLI', command: 'agent' },
      { id: 'codex', name: 'Codex', command: 'codex' },
      { id: 'opencode', name: 'OpenCode', command: 'opencode' },
      { id: 'claude', name: 'Claude Code', command: 'claude' },
      { id: 'gemini', name: 'Gemini CLI', command: 'gemini' }
    ]

    return await Promise.all(
      candidates.map(
        (candidate) =>
          new Promise<{ id: string; name: string; command: string; binaryPath: string } | null>(
            (resolveAgent) => {
              execFile(
                'zsh',
                ['-lc', `command -v ${candidate.command}`],
                { encoding: 'utf8' },
                (error, stdout) => {
                  if (error || !stdout.trim()) {
                    resolveAgent(null)
                    return
                  }

                  resolveAgent({
                    ...candidate,
                    binaryPath: stdout.trim()
                  })
                }
              )
            }
          )
      )
    ).then((agents) => agents.filter((agent) => Boolean(agent)))
  })

  ipcMain.handle(harmonyChannels.getContextInfo, async () => {
    await ensureBundledSkillsInstalled()

    const [skills, mcpServers, subagents] = await Promise.all([
      listSkillSummaries(),
      listMcpServers(),
      listOpenCodeSubagents()
    ])

    return {
      contextWindow: {
        maximum: 'Unavailable',
        remaining: 'Unavailable',
        note: 'CLI agents do not expose live remaining tokens to this local app.'
      },
      skills,
      mcpServers,
      subagents
    }
  })

  ipcMain.handle(harmonyChannels.listSessionStats, (_, workspacePath: string) =>
    listSessionStats(workspacePath)
  )

  ipcMain.handle(harmonyChannels.getUsageSummary, () => getUsageSummary())
  ipcMain.handle(harmonyChannels.getCodexQuota, () => getCodexQuota())
  ipcMain.handle(harmonyChannels.openExternalUrl, (_event, url: string) => shell.openExternal(url))

  registerWorktreeIpc()
  registerSourceControlIpc()
  registerTerminalIpc()
  registerAgentIpc(writeTerminalInputForOwner)

  detachTerminalDataListener = onTerminalData(({ ownerId, sessionId, data }) => {
    handleAgentTerminalData(sessionId, ownerId, data)
  })

  detachTerminalExitListener = onTerminalExit(({ ownerId, sessionId, exitCode, signal }) => {
    handleAgentTerminalExit(sessionId, ownerId, exitCode, signal)
  })
}

export function disposeWorkbench(): void {
  detachTerminalDataListener?.()
  detachTerminalDataListener = null
  detachTerminalExitListener?.()
  detachTerminalExitListener = null

  disposeAgentRuns()
  disposeTerminalSessions()
}
