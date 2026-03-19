import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as https from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import {
  disposeAgentRuns,
  handleAgentTerminalInput,
  handleAgentTerminalData,
  handleAgentTerminalExit,
  registerAgentIpc
} from './agent'
import {
  disposeTerminalSessions,
  onTerminalData,
  onTerminalExit,
  onTerminalInput,
  registerTerminalIpc
} from './terminal'
import {
  type SkillMarketplaceAuditPayload,
  type SkillMarketplaceAuditResult,
  type SkillMarketplaceInstallPayload,
  type SkillMarketplaceInstallResult,
  type SkillMarketplaceRisk,
  type SkillMarketplaceSearchPayload,
  type SkillMarketplaceSearchResult,
  harmonyChannels
} from '../shared/workbench'
import { ensureBundledSkillsInstalled } from './bundledSkills'
import { getGitAvailability, installGit } from './git'
import { registerSourceControlIpc } from './sourceControl'
import { disposeWorkspaceWatches, registerWorktreeIpc } from './worktree'

let detachTerminalDataListener: (() => void) | null = null
let detachTerminalExitListener: (() => void) | null = null
let detachTerminalInputListener: (() => void) | null = null

const SKILLS_SH_BASE_URL = 'https://skills.sh'
const SEARCH_LIMIT_DEFAULT = 20
const SEARCH_LIMIT_MAX = 50

interface SkillsShSearchResponse {
  query?: string
  count?: number
  duration_ms?: number
  skills?: Array<{
    id?: string
    skillId?: string
    name?: string
    installs?: number
    source?: string
  }>
}

interface SkillsShAuditEntry {
  risk?: string
  alerts?: number
  score?: number
  analyzedAt?: string
}

interface SkillsShAuditResponse {
  [key: string]: SkillsShAuditEntry | undefined
}

function isValidMarketplaceSource(value: string): boolean {
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(value)
}

function isValidMarketplaceSkill(value: string): boolean {
  return /^[a-z0-9][a-z0-9-_]{0,63}$/i.test(value)
}

function clampSearchLimit(limit: number | undefined): number {
  if (!limit || Number.isNaN(limit)) return SEARCH_LIMIT_DEFAULT
  return Math.max(1, Math.min(SEARCH_LIMIT_MAX, Math.floor(limit)))
}

function normalizeRisk(value: string | undefined): SkillMarketplaceRisk {
  if (value === 'safe' || value === 'low' || value === 'medium' || value === 'high' || value === 'critical') {
    return value
  }
  return 'unknown'
}

function buildAuditUrl(source: string, skill: string): URL {
  const url = new URL('https://add-skill.vercel.sh/audit')
  url.searchParams.set('source', source)
  url.searchParams.set('skills', skill)
  return url
}

async function requestJson(url: URL): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: 'GET',
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Harmony/1.0'
        },
        timeout: 12_000
      },
      (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8')
        })
        res.on('end', () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`skills.sh search failed (${res.statusCode ?? 'unknown'})`))
            return
          }
          try {
            resolve(JSON.parse(body) as unknown)
          } catch {
            reject(new Error('Invalid JSON response from skills.sh'))
          }
        })
      }
    )

    req.on('error', (error) => reject(error))
    req.on('timeout', () => {
      req.destroy(new Error('skills.sh request timed out'))
    })
    req.end()
  })
}

async function searchSkillsMarketplace(
  payload: SkillMarketplaceSearchPayload
): Promise<SkillMarketplaceSearchResult> {
  const query = String(payload.query ?? '').trim()
  if (!query) {
    return {
      query: '',
      count: 0,
      durationMs: 0,
      items: []
    }
  }

  const url = new URL('/api/search', SKILLS_SH_BASE_URL)
  url.searchParams.set('q', query)
  url.searchParams.set('limit', String(clampSearchLimit(payload.limit)))

  const data = (await requestJson(url)) as SkillsShSearchResponse
  const skills = Array.isArray(data.skills) ? data.skills : []

  return {
    query: String(data.query ?? query),
    count: Number(data.count ?? skills.length) || 0,
    durationMs: Number(data.duration_ms ?? 0) || 0,
    items: skills
      .filter(
        (item) =>
          Boolean(item.id) &&
          Boolean(item.skillId) &&
          Boolean(item.name) &&
          Boolean(item.source) &&
          isValidMarketplaceSource(String(item.source)) &&
          isValidMarketplaceSkill(String(item.skillId))
      )
      .map((item) => ({
        id: String(item.id),
        skillId: String(item.skillId),
        name: String(item.name),
        installs: Number(item.installs ?? 0) || 0,
        source: String(item.source)
      }))
  }
}

async function installSkillFromMarketplace(
  payload: SkillMarketplaceInstallPayload
): Promise<SkillMarketplaceInstallResult> {
  const source = String(payload.source ?? '').trim()
  const skill = String(payload.skill ?? '').trim()

  if (!isValidMarketplaceSource(source)) {
    throw new Error('Invalid skill source. Use owner/repo format.')
  }
  if (!isValidMarketplaceSkill(skill)) {
    throw new Error('Invalid skill name.')
  }

  const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const args = ['skills', 'add', source, '--skill', skill, '--yes', '--global', '--agent', 'opencode']

  await new Promise<void>((resolve, reject) => {
    execFile(npxCommand, args, { cwd: process.cwd(), timeout: 120_000 }, (error, _stdout, stderr) => {
      if (error) {
        const message = stderr?.trim() || error.message || 'skills install command failed'
        reject(new Error(message))
        return
      }
      resolve()
    })
  })

  return {
    summary: `Installed ${skill} from ${source}.`
  }
}

async function auditSkillFromMarketplace(
  payload: SkillMarketplaceAuditPayload
): Promise<SkillMarketplaceAuditResult> {
  const source = String(payload.source ?? '').trim()
  const skill = String(payload.skill ?? '').trim()

  if (!isValidMarketplaceSource(source)) {
    throw new Error('Invalid skill source. Use owner/repo format.')
  }
  if (!isValidMarketplaceSkill(skill)) {
    throw new Error('Invalid skill name.')
  }

  const data = (await requestJson(buildAuditUrl(source, skill))) as SkillsShAuditResponse
  const entry = data[skill] ?? data[`${source}/${skill}`] ?? Object.values(data)[0]

  return {
    risk: normalizeRisk(entry?.risk),
    alerts: typeof entry?.alerts === 'number' ? entry.alerts : null,
    score: typeof entry?.score === 'number' ? entry.score : null,
    analyzedAt: typeof entry?.analyzedAt === 'string' ? entry.analyzedAt : null
  }
}

async function listSkillSummaries(): Promise<Array<{ id: string; name: string; source: string }>> {
  const roots = [
    { path: join(homedir(), '.cursor/skills'), source: 'cursor' },
    { path: join(homedir(), '.cursor/skills-cursor'), source: 'cursor' },
    { path: join(homedir(), '.cursor/rules'), source: 'cursor' },
    { path: join(homedir(), '.agents/skills'), source: 'agents' },
    { path: join(homedir(), '.codex/skills'), source: 'codex' },
    { path: join(homedir(), '.config/opencode/skills'), source: 'opencode' },
    { path: join(homedir(), '.opencode/skills'), source: 'opencode' }
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
  value: McpServerConfig
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

interface McpServerConfig {
  type?: string
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
}

type McpConnectionStatus = import('../shared/workbench').McpServerSummary['status']

interface McpStatusResult {
  status: McpConnectionStatus
  statusDetail?: string
}

let mcpServersCache: { data: import('../shared/workbench').McpServerSummary[]; fetchedAt: number } | null = null
const MCP_STATUS_CACHE_TTL_MS = 30_000
const MCP_CHECK_TIMEOUT_MS = 4_000
const MCP_PROTOCOL_VERSION = '2024-11-05'

function resolveTemplate(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, name: string) => env[name] ?? process.env[name] ?? '')
}

function normalizeMcpTransport(config: McpServerConfig): string {
  return config.type ?? (config.url ? 'http' : config.command ? 'stdio' : 'unknown')
}

function formatStatusDetail(detail: string): string {
  return detail.replace(/\s+/g, ' ').trim().slice(0, 160)
}

function buildInitializePayload(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'harmony',
        version: '1.1.0'
      }
    }
  })
}

async function checkHttpMcpServer(config: McpServerConfig): Promise<McpStatusResult> {
  if (!config.url) {
    return { status: 'error', statusDetail: 'Missing MCP URL.' }
  }

  const env = { ...process.env, ...(config.env ?? {}) } as Record<string, string>
  const resolvedUrl = resolveTemplate(config.url, env)
  const headers = Object.fromEntries(
    Object.entries(config.headers ?? {}).map(([key, value]) => [key, resolveTemplate(value, env)])
  )

  try {
    const response = await fetch(resolvedUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        ...headers
      },
      body: buildInitializePayload(),
      signal: AbortSignal.timeout(MCP_CHECK_TIMEOUT_MS)
    })

    if (response.ok) {
      return { status: 'connected' }
    }

    const detail = response.status === 401 || response.status === 403
      ? `Auth failed (${response.status})`
      : `HTTP ${response.status}`

    return {
      status: response.status >= 500 ? 'disconnected' : 'error',
      statusDetail: detail
    }
  } catch (error) {
    return {
      status: 'disconnected',
      statusDetail: error instanceof Error ? formatStatusDetail(error.message) : 'Connection failed.'
    }
  }
}

async function checkStdioMcpServer(config: McpServerConfig): Promise<McpStatusResult> {
  if (!config.command) {
    return { status: 'error', statusDetail: 'Missing MCP command.' }
  }

  const env = { ...process.env, ...(config.env ?? {}) } as Record<string, string>
  const command = resolveTemplate(config.command, env)
  const args = (config.args ?? []).map((arg) => resolveTemplate(arg, env))

  return await new Promise((resolveStatus) => {
    let settled = false
    let stderr = ''
    let stdoutBuffer = Buffer.alloc(0)

    const child = spawn(command, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const finish = (result: McpStatusResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout.removeAllListeners()
      child.stderr.removeAllListeners()
      child.removeAllListeners()
      child.kill()
      resolveStatus(result)
    }

    const parseMessages = (): void => {
      while (true) {
        const headerEnd = stdoutBuffer.indexOf('\r\n\r\n')
        if (headerEnd === -1) return

        const headerText = stdoutBuffer.slice(0, headerEnd).toString('utf8')
        const lengthMatch = /Content-Length:\s*(\d+)/i.exec(headerText)
        if (!lengthMatch) {
          finish({ status: 'error', statusDetail: 'Invalid MCP stdio response headers.' })
          return
        }

        const contentLength = Number(lengthMatch[1])
        const totalLength = headerEnd + 4 + contentLength
        if (stdoutBuffer.length < totalLength) return

        const body = stdoutBuffer.slice(headerEnd + 4, totalLength).toString('utf8')
        stdoutBuffer = stdoutBuffer.slice(totalLength)

        try {
          const message = JSON.parse(body) as { id?: number; result?: unknown; error?: { message?: string } }
          if (message.id === 1 && message.result) {
            finish({ status: 'connected' })
            return
          }
          if (message.id === 1 && message.error) {
            finish({
              status: 'error',
              statusDetail: formatStatusDetail(message.error.message ?? 'Server returned an MCP error.')
            })
            return
          }
        } catch {
          finish({ status: 'error', statusDetail: 'Invalid MCP stdio response body.' })
          return
        }
      }
    }

    const timer = setTimeout(() => {
      finish({
        status: 'disconnected',
        statusDetail: stderr ? formatStatusDetail(stderr) : 'Timed out during MCP initialize.'
      })
    }, MCP_CHECK_TIMEOUT_MS)

    child.on('error', (error) => {
      finish({
        status: 'error',
        statusDetail: error instanceof Error ? formatStatusDetail(error.message) : 'Failed to start MCP server.'
      })
    })

    child.on('exit', (code) => {
      if (!settled) {
        finish({
          status: code === 0 ? 'disconnected' : 'error',
          statusDetail: stderr ? formatStatusDetail(stderr) : `Exited before initialize (${code ?? 'unknown'}).`
        })
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-400)
    })

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer = Buffer.concat([stdoutBuffer, chunk])
      parseMessages()
    })

    const payload = buildInitializePayload()
    child.stdin.write(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`)
  })
}

async function detectMcpServerStatus(config: McpServerConfig): Promise<McpStatusResult> {
  const transport = normalizeMcpTransport(config)

  if (transport === 'http') {
    return await checkHttpMcpServer(config)
  }

  if (transport === 'stdio') {
    return await checkStdioMcpServer(config)
  }

  return { status: 'error', statusDetail: `Unsupported MCP transport: ${transport}` }
}

async function listMcpServers(): Promise<import('../shared/workbench').McpServerSummary[]> {
  if (mcpServersCache && Date.now() - mcpServersCache.fetchedAt < MCP_STATUS_CACHE_TTL_MS) {
    return mcpServersCache.data
  }

  const configPath = join(homedir(), '.cursor/mcp.json')
  const raw = await fs.readFile(configPath, 'utf8').catch(() => '')
  if (!raw) return []

  try {
    const parsed = JSON.parse(raw) as {
      mcpServers?: Record<string, McpServerConfig>
    }
    const entries = await Promise.all(
      Object.entries(parsed.mcpServers ?? {}).map(async ([id, value]) => {
        const status = await detectMcpServerStatus(value)
        return {
          id,
          transport: normalizeMcpTransport(value),
          iconUrl: inferMcpServerIcon(id, value),
          status: status.status,
          statusDetail: status.statusDetail
        } satisfies import('../shared/workbench').McpServerSummary
      })
    )

    const data = entries
      .sort((a, b) => a.id.localeCompare(b.id))
    mcpServersCache = { data, fetchedAt: Date.now() }
    return data
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

function createEmptyClaudeUsageWindow(): import('../shared/workbench').ClaudeUsageWindow {
  return {
    sessionCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheTokens: 0
  }
}

function addClaudeUsage(
  target: import('../shared/workbench').ClaudeUsageWindow,
  usage: { input: number; output: number; cache: number; cost: number }
): void {
  target.totalInputTokens += usage.input
  target.totalOutputTokens += usage.output
  target.totalCacheTokens += usage.cache
  if (usage.cost > 0) {
    target.totalCostUSD = (target.totalCostUSD ?? 0) + usage.cost
  }
}

async function getClaudeQuota(): Promise<import('../shared/workbench').ClaudeQuota | null> {
  const transcriptsRoot = join(homedir(), '.claude', 'transcripts')
  const now = Date.now()
  const cutoff5h = now - 5 * 3_600_000
  const cutoff7d = now - 7 * 86_400_000
  const cutoff30d = now - 30 * 86_400_000

  const files = await fs.readdir(transcriptsRoot, { withFileTypes: true }).catch(() => [])
  if (files.length === 0) {
    return null
  }

  const rolling5h = createEmptyClaudeUsageWindow()
  const rolling7d = createEmptyClaudeUsageWindow()
  const rolling30d = createEmptyClaudeUsageWindow()
  const sessionSets = {
    rolling5h: new Set<string>(),
    rolling7d: new Set<string>(),
    rolling30d: new Set<string>()
  }

  for (const entry of files) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue
    }

    const filePath = join(transcriptsRoot, entry.name)
    const stat = await fs.stat(filePath).catch(() => null)
    if (!stat || stat.mtimeMs < cutoff30d) {
      continue
    }

    const content = await fs.readFile(filePath, 'utf8').catch(() => '')
    if (!content) {
      continue
    }

    const sessionId = entry.name.replace(/\.jsonl$/, '')
    let seen5h = false
    let seen7d = false
    let seen30d = false

    for (const line of content.split('\n')) {
      if (!line.trim()) continue

      try {
        const ev = JSON.parse(line) as {
          timestamp?: string
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

        const timestamp = ev.timestamp ? Date.parse(ev.timestamp) : NaN
        if (Number.isNaN(timestamp) || timestamp < cutoff30d) {
          continue
        }

        const usage = {
          input: ev.message?.usage?.input_tokens ?? 0,
          output: ev.message?.usage?.output_tokens ?? 0,
          cache:
            (ev.message?.usage?.cache_creation_input_tokens ?? 0) +
            (ev.message?.usage?.cache_read_input_tokens ?? 0),
          cost: ev.costUSD ?? 0
        }

        if (timestamp >= cutoff30d) {
          addClaudeUsage(rolling30d, usage)
          seen30d = true
        }
        if (timestamp >= cutoff7d) {
          addClaudeUsage(rolling7d, usage)
          seen7d = true
        }
        if (timestamp >= cutoff5h) {
          addClaudeUsage(rolling5h, usage)
          seen5h = true
        }
      } catch {
        /* skip malformed lines */
      }
    }

    if (seen30d) sessionSets.rolling30d.add(sessionId)
    if (seen7d) sessionSets.rolling7d.add(sessionId)
    if (seen5h) sessionSets.rolling5h.add(sessionId)
  }

  rolling5h.sessionCount = sessionSets.rolling5h.size
  rolling7d.sessionCount = sessionSets.rolling7d.size
  rolling30d.sessionCount = sessionSets.rolling30d.size

  if (rolling30d.sessionCount === 0) {
    return null
  }

  return {
    source: 'local-estimate',
    note: 'Estimated from local Claude transcripts. Official subscription quota and reset times are not exposed here.',
    rolling5h,
    rolling7d,
    rolling30d
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

  ipcMain.handle(harmonyChannels.gitStatus, async () => await getGitAvailability())

  ipcMain.handle(harmonyChannels.installGit, async () => {
    const result = await installGit()
    if (result === 'OPEN_DOWNLOAD_PAGE') {
      await shell.openExternal('https://git-scm.com/downloads')
      return 'Opened the Git download page.'
    }
    return result
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

  ipcMain.handle(harmonyChannels.searchSkillsMarketplace, async (_event, payload: SkillMarketplaceSearchPayload) =>
    await searchSkillsMarketplace(payload)
  )

  ipcMain.handle(harmonyChannels.auditSkillFromMarketplace, async (_event, payload: SkillMarketplaceAuditPayload) =>
    await auditSkillFromMarketplace(payload)
  )

  ipcMain.handle(
    harmonyChannels.installSkillFromMarketplace,
    async (_event, payload: SkillMarketplaceInstallPayload) => await installSkillFromMarketplace(payload)
  )

  ipcMain.handle(harmonyChannels.listSessionStats, (_, workspacePath: string) =>
    listSessionStats(workspacePath)
  )

  ipcMain.handle(harmonyChannels.getUsageSummary, () => getUsageSummary())
  ipcMain.handle(harmonyChannels.getCodexQuota, () => getCodexQuota())
  ipcMain.handle(harmonyChannels.getClaudeQuota, () => getClaudeQuota())
  ipcMain.handle(harmonyChannels.openExternalUrl, (_event, url: string) => shell.openExternal(url))

  registerWorktreeIpc()
  registerSourceControlIpc()
  registerTerminalIpc()
  registerAgentIpc()

  detachTerminalDataListener = onTerminalData(({ ownerId, sessionId, data }) => {
    handleAgentTerminalData(sessionId, ownerId, data)
  })

  detachTerminalExitListener = onTerminalExit(({ ownerId, sessionId, exitCode, signal }) => {
    handleAgentTerminalExit(sessionId, ownerId, exitCode, signal)
  })

  detachTerminalInputListener = onTerminalInput(({ ownerId, sessionId, data }) => {
    handleAgentTerminalInput(sessionId, ownerId, data)
  })
}

export function disposeWorkbench(): void {
  detachTerminalDataListener?.()
  detachTerminalDataListener = null
  detachTerminalExitListener?.()
  detachTerminalExitListener = null
  detachTerminalInputListener?.()
  detachTerminalInputListener = null

  disposeWorkspaceWatches()
  disposeAgentRuns()
  disposeTerminalSessions()
}
