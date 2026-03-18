export type WorkspaceEntryKind = 'file' | 'directory'

export interface BranchInfo {
  name: string
  remote: boolean
}
export type AgentStatus = 'idle' | 'running' | 'waiting' | 'done' | 'error'

export interface SessionStat {
  id: string
  title: string
  directory: string
  model: string
  agent: 'opencode' | 'codex'
  timeUpdated: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** Model context window size in tokens (available for Codex) */
  contextWindow?: number
}

export interface RateLimitWindow {
  usedPct: number
  windowMin: number
  resetsAt: number
}

export interface AgentUsage {
  agent: 'codex' | 'claude' | 'opencode'
  sessionCount: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheTokens: number
  totalCostUSD?: number
  /** Codex rate limits from most recent session */
  sessionLimit?: RateLimitWindow
  weeklyLimit?: RateLimitWindow
}

export interface CodexQuotaLimit {
  name: string
  sessionUsedPct: number
  sessionWindowSec: number
  sessionResetsAt: number
  weeklyUsedPct?: number
  weeklyWindowSec?: number
  weeklyResetsAt?: number
}

export interface CodexQuota {
  planType: string
  /** ISO date of next billing renewal (from id_token JWT) */
  subscriptionEndsAt?: string
  sessionUsedPct: number
  sessionWindowSec: number
  sessionResetsAt: number
  weeklyUsedPct: number
  weeklyWindowSec: number
  weeklyResetsAt: number
  hasCredits: boolean
  creditBalance: string
  additionalLimits: CodexQuotaLimit[]
}

export const harmonyChannels = {
  openFolder: 'dialog:openFolder',
  listAvailableAgents: 'agent:listAvailable',
  listWorktrees: 'worktree:list',
  listBranches: 'worktree:branches',
  createWorktree: 'worktree:create',
  removeWorktree: 'worktree:remove',
  listWorkspaceChanges: 'workspace:changes',
  getContextInfo: 'context:get',
  getWorkspace: 'workspace:get',
  readFile: 'file:read',
  writeFile: 'file:write',
  stageWorkspaceChanges: 'git:stageAll',
  commitWorkspaceChanges: 'git:commit',
  publishBranch: 'git:publish',
  generateCommitMessage: 'git:generateCommitMessage',
  createTerminal: 'terminal:create',
  writeTerminal: 'terminal:write',
  resizeTerminal: 'terminal:resize',
  destroyTerminal: 'terminal:destroy',
  startAgent: 'agent:start',
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',
  agentUpdate: 'agent:update',
  listSessionStats: 'context:sessions',
  getUsageSummary: 'usage:summary',
  getCodexQuota: 'codex:quota',
  openExternalUrl: 'shell:openExternalUrl'
} as const

export interface WorktreeSummary {
  id: string
  name: string
  path: string
  repoRoot: string
  branch: string
  head: string
  isMain: boolean
  isLocked: boolean
}

export interface WorktreeCreatePayload {
  branch: string
  baseRef?: string
  path?: string
  /** Workspace path (folder or worktree) to determine which repo to create in */
  workspacePath?: string
}

export interface WorktreeRemovePayload {
  path: string
}

export interface WorkspaceEntry {
  name: string
  path: string
  kind: WorkspaceEntryKind
  children?: WorkspaceEntry[]
}

export interface WorkspaceSnapshot {
  rootPath: string
  entries: WorkspaceEntry[]
}

export interface WorkspaceChange {
  path: string
  status: string
}

export interface WorkspaceChangesSnapshot {
  isGitRepo: boolean
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  hasRemote: boolean
  publishRemote: string | null
  changes: WorkspaceChange[]
}

export interface SkillSummary {
  id: string
  name: string
  source: string
}

export interface McpServerSummary {
  id: string
  transport: string
}

export interface SubagentSummary {
  id: string
  name: string
  description: string
  model: string
  source: 'global' | 'project'
}

export interface ContextInfo {
  contextWindow: {
    maximum: string
    remaining: string
    note: string
  }
  skills: SkillSummary[]
  mcpServers: McpServerSummary[]
  subagents: SubagentSummary[]
}

export interface ReadFilePayload {
  workspacePath: string
  path: string
}

export interface FileDocument {
  path: string
  content: string
}

export interface SaveFilePayload {
  workspacePath: string
  path: string
  content: string
}

export interface GitActionPayload {
  workspacePath: string
}

export interface StageChangesPayload extends GitActionPayload {}

export interface CommitChangesPayload extends GitActionPayload {
  message: string
  stageAll?: boolean
}

export interface PublishBranchPayload extends GitActionPayload {
  remote?: string
}

export interface GenerateCommitMessagePayload extends GitActionPayload {}

export interface GenerateCommitMessageResult {
  message: string
  provider: string
  usedFallback: boolean
}

export interface GitActionResult {
  branch: string
  summary: string
}

export interface CreateTerminalPayload {
  cwd: string
}

export interface TerminalSession {
  sessionId: string
  cwd: string
  shell: string
}

export interface AvailableAgent {
  id: string
  name: string
  command: string
  binaryPath: string
}

export interface TerminalDataEvent {
  sessionId: string
  data: string
}

export interface TerminalExitEvent {
  sessionId: string
  exitCode: number
  signal?: number
}

export interface AgentStartPayload {
  sessionId: string
  workspacePath: string
  command: string
  displayName?: string
}

export interface AgentRun {
  runId: string
  sessionId: string
  workspacePath: string
  command: string
  displayName: string
  status: AgentStatus
  startedAt: string
  finishedAt?: string
  exitCode?: number
  signal?: number
  message?: string
}

export interface HarmonyApi {
  openFolder(): Promise<string | null>
  listAvailableAgents(): Promise<AvailableAgent[]>
  listWorktrees(workspacePaths?: string[]): Promise<WorktreeSummary[]>
  listBranches(workspacePath?: string): Promise<BranchInfo[]>
  createWorktree(payload: WorktreeCreatePayload): Promise<WorktreeSummary>
  removeWorktree(payload: WorktreeRemovePayload): Promise<void>
  listWorkspaceChanges(workspacePath: string): Promise<WorkspaceChangesSnapshot>
  getContextInfo(): Promise<ContextInfo>
  getWorkspace(workspacePath: string): Promise<WorkspaceSnapshot>
  readFile(payload: ReadFilePayload): Promise<FileDocument>
  writeFile(payload: SaveFilePayload): Promise<void>
  stageWorkspaceChanges(payload: StageChangesPayload): Promise<GitActionResult>
  commitWorkspaceChanges(payload: CommitChangesPayload): Promise<GitActionResult>
  publishBranch(payload: PublishBranchPayload): Promise<GitActionResult>
  generateCommitMessage(payload: GenerateCommitMessagePayload): Promise<GenerateCommitMessageResult>
  createTerminal(payload: CreateTerminalPayload): Promise<TerminalSession>
  writeTerminal(sessionId: string, data: string): void
  resizeTerminal(sessionId: string, cols: number, rows: number): void
  destroyTerminal(sessionId: string): void
  startAgent(payload: AgentStartPayload): Promise<AgentRun>
  onTerminalData(listener: (event: TerminalDataEvent) => void): () => void
  onTerminalExit(listener: (event: TerminalExitEvent) => void): () => void
  onAgentUpdate(listener: (event: AgentRun) => void): () => void
  listSessionStats(workspacePath: string): Promise<SessionStat[]>
  getUsageSummary(): Promise<AgentUsage[]>
  getCodexQuota(): Promise<CodexQuota | null>
  openExternalUrl(url: string): Promise<void>
}
