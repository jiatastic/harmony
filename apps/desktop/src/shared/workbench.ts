import type {
  TerminalDaemonSessionPatch,
  TerminalDaemonSessionRecord
} from './terminalDaemon'

export type WorkspaceEntryKind = 'file' | 'directory'

export interface BranchInfo {
  name: string
  remote: boolean
  remoteRef?: string
}
export type AgentStatus = 'idle' | 'running' | 'waiting' | 'done' | 'error'
export type TerminalLifecycleState = 'running' | 'exited' | 'destroyed'

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

export interface SessionStatsRequest {
  workspacePath: string
  activeHint?: {
    agent?: 'opencode' | 'codex'
    externalSessionId?: string
  }
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

export interface ClaudeUsageWindow {
  sessionCount: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheTokens: number
  totalCostUSD?: number
}

export interface ClaudeQuotaWindow {
  usedPct: number
  resetAt?: number
  resetLabel?: string
}

export interface ClaudeQuotaLimit {
  name: string
  usedPct: number
  resetAt?: number
  resetLabel?: string
}

export interface ClaudeQuota {
  source: 'cli'
  planType: string
  email?: string
  organization?: string
  loginMethod?: string
  session?: ClaudeQuotaWindow
  weekly?: ClaudeQuotaWindow
  additionalLimits: ClaudeQuotaLimit[]
}

export type AppUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'unsupported'

export interface AppUpdateState {
  phase: AppUpdatePhase
  currentVersion: string
  availableVersion?: string
  releaseName?: string
  releaseDate?: string
  releaseNotes?: string
  progressPercent?: number
  downloadedBytes?: number
  totalBytes?: number
  message?: string
  checkedAt?: string
}

export const harmonyChannels = {
  openFolder: 'dialog:openFolder',
  gitStatus: 'git:status',
  installGit: 'git:install',
  listAvailableAgents: 'agent:listAvailable',
  listWorktrees: 'worktree:list',
  listBranches: 'worktree:branches',
  createWorktree: 'worktree:create',
  removeWorktree: 'worktree:remove',
  listWorkspaceChanges: 'workspace:changes',
  watchWorkspaceChangesStart: 'workspace:watch:start',
  watchWorkspaceChangesStop: 'workspace:watch:stop',
  workspaceDidChange: 'workspace:didChange',
  getContextInfo: 'context:get',
  searchSkillsMarketplace: 'skills:marketplace:search',
  auditSkillFromMarketplace: 'skills:marketplace:audit',
  installSkillFromMarketplace: 'skills:marketplace:install',
  getWorkspace: 'workspace:get',
  readFile: 'file:read',
  writeFile: 'file:write',
  stageWorkspaceChanges: 'git:stageAll',
  commitWorkspaceChanges: 'git:commit',
  publishBranch: 'git:publish',
  generateCommitMessage: 'git:generateCommitMessage',
  getWorkspaceDiff: 'git:workspaceDiff',
  createTerminal: 'terminal:create',
  writeTerminal: 'terminal:write',
  resizeTerminal: 'terminal:resize',
  detachTerminal: 'terminal:detach',
  destroyTerminal: 'terminal:destroy',
  destroyPersistentTerminal: 'terminal:destroyPersistent',
  listTerminalSessions: 'terminal:listSessions',
  updateTerminalSessionMetadata: 'terminal:updateSessionMetadata',
  getPersistentShellSupport: 'terminal:getPersistentShellSupport',
  getPersistedTerminalLayout: 'terminalLayout:get',
  savePersistedTerminalLayout: 'terminalLayout:save',
  getArchivedTabs: 'terminalArchive:get',
  saveArchivedTabs: 'terminalArchive:save',
  startAgent: 'agent:start',
  restoreAgent: 'agent:restore',
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',
  terminalState: 'terminal:state',
  agentUpdate: 'agent:update',
  listSessionStats: 'context:sessions',
  getUsageSummary: 'usage:summary',
  getCodexQuota: 'codex:quota',
  getClaudeQuota: 'claude:quota',
  openExternalUrl: 'shell:openExternalUrl',
  getUpdateState: 'app:update:getState',
  checkForUpdates: 'app:update:check',
  downloadUpdate: 'app:update:download',
  installUpdate: 'app:update:install',
  updateState: 'app:update:state'
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
  additions: number
  deletions: number
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

export interface WorkspaceWatchEvent {
  watchId: string
  workspacePath: string
}

export interface SkillSummary {
  id: string
  name: string
  source: string
}

export interface McpServerSummary {
  id: string
  transport: string
  iconUrl?: string
  status: 'connected' | 'disconnected' | 'error'
  statusDetail?: string
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

export interface SkillMarketplaceItem {
  id: string
  skillId: string
  name: string
  installs: number
  source: string
}

export interface SkillMarketplaceSearchPayload {
  query: string
  limit?: number
}

export interface SkillMarketplaceSearchResult {
  query: string
  count: number
  durationMs: number
  items: SkillMarketplaceItem[]
}

export interface SkillMarketplaceInstallPayload {
  source: string
  skill: string
}

export type SkillMarketplaceRisk = 'safe' | 'low' | 'medium' | 'high' | 'critical' | 'unknown'

export interface SkillMarketplaceAuditPayload {
  source: string
  skill: string
}

export interface SkillMarketplaceAuditResult {
  risk: SkillMarketplaceRisk
  alerts: number | null
  score: number | null
  analyzedAt: string | null
}

export interface SkillMarketplaceInstallResult {
  summary: string
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

export interface StageChangesPayload extends GitActionPayload {
  path?: string
}

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

export interface WorkspaceDiffPayload extends GitActionPayload {
  staged?: boolean
  path?: string
}

export interface WorkspaceDiffResult {
  diff: string
  truncated: boolean
}

export interface GitActionResult {
  branch: string
  summary: string
}

export interface CreateTerminalPayload {
  cwd: string
  themeHint?: 'light' | 'dark'
  /** Stable logical terminal identity, usually the renderer tab id */
  sessionKey?: string
  persistentId?: string
  initialCommand?: string
}

export interface TerminalSession {
  sessionId: string
  cwd: string
  shell: string
  state: TerminalLifecycleState
  attached: boolean
  restored?: boolean
  snapshot?: string
  exitCode?: number
  signal?: number
}

export type PersistedTerminalTab = {
  id: string
  type: 'terminal'
  workspacePath: string
  title: string
  customTitle?: boolean
  agent?: AvailableAgent
  agentRun?: AgentRun
  agentViewMode?: 'chat' | 'terminal'
  lastKnownStatus?: AgentRun['status']
}

export type PersistedBrowserTab = {
  id: string
  type: 'browser'
  workspacePath: string
  title: string
  url: string
  draftUrl: string
  customTitle?: boolean
}

export type PersistedPanelTab = PersistedTerminalTab | PersistedBrowserTab

export interface PersistedTerminalLayout {
  tabs: PersistedPanelTab[]
  activeTabIds: Record<string, string | null>
}

export type ArchivedTerminalTab = PersistedTerminalTab & {
  archivedAt: string
  archivedSessionId?: string
}

export type ArchivedBrowserTab = PersistedBrowserTab & {
  archivedAt: string
}

export type ArchivedPanelTab = ArchivedTerminalTab | ArchivedBrowserTab

export interface AvailableAgent {
  id: string
  name: string
  command: string
  binaryPath: string
}

export interface GitAvailability {
  available: boolean
  binaryPath: string | null
  installActionLabel: string
  helpText: string
  canAutoInstall: boolean
}

export interface PersistentShellSupport {
  available: boolean
  required: boolean
  binaryPath: string | null
  reason?: string
  installHint?: string
}

export interface TerminalDataEvent {
  sessionId: string
  sessionKey?: string
  data: string
}

export interface TerminalExitEvent {
  sessionId: string
  exitCode: number
  signal?: number
}

export interface TerminalStateEvent {
  sessionId: string
  state: TerminalLifecycleState
  exitCode?: number
  signal?: number
}

export interface AgentStartPayload {
  sessionId: string
  workspacePath: string
  command: string
  displayName?: string
  suggestedTitle?: string
}

export interface AgentRestorePayload {
  sessionId: string
  workspacePath: string
  command: string
  displayName?: string
  externalSessionId?: string
  suggestedTitle?: string
  status?: AgentStatus
  startedAt?: string
  finishedAt?: string
  exitCode?: number
  signal?: number
  message?: string
}

export interface AgentRun {
  runId: string
  sessionId: string
  workspacePath: string
  command: string
  displayName: string
  externalSessionId?: string
  suggestedTitle?: string
  status: AgentStatus
  startedAt: string
  finishedAt?: string
  exitCode?: number
  signal?: number
  message?: string
}

export interface HarmonyApi {
  openFolder(): Promise<string | null>
  getGitAvailability(): Promise<GitAvailability>
  installGit(): Promise<string>
  listAvailableAgents(): Promise<AvailableAgent[]>
  listWorktrees(workspacePaths?: string[]): Promise<WorktreeSummary[]>
  listBranches(workspacePath?: string): Promise<BranchInfo[]>
  createWorktree(payload: WorktreeCreatePayload): Promise<WorktreeSummary>
  removeWorktree(payload: WorktreeRemovePayload): Promise<void>
  listWorkspaceChanges(workspacePath: string): Promise<WorkspaceChangesSnapshot>
  watchWorkspaceChanges(
    workspacePath: string,
    listener: (event: WorkspaceWatchEvent) => void
  ): Promise<() => Promise<void>>
  getContextInfo(): Promise<ContextInfo>
  searchSkillsMarketplace(payload: SkillMarketplaceSearchPayload): Promise<SkillMarketplaceSearchResult>
  auditSkillFromMarketplace(payload: SkillMarketplaceAuditPayload): Promise<SkillMarketplaceAuditResult>
  installSkillFromMarketplace(payload: SkillMarketplaceInstallPayload): Promise<SkillMarketplaceInstallResult>
  getWorkspace(workspacePath: string): Promise<WorkspaceSnapshot>
  readFile(payload: ReadFilePayload): Promise<FileDocument>
  writeFile(payload: SaveFilePayload): Promise<void>
  stageWorkspaceChanges(payload: StageChangesPayload): Promise<GitActionResult>
  commitWorkspaceChanges(payload: CommitChangesPayload): Promise<GitActionResult>
  publishBranch(payload: PublishBranchPayload): Promise<GitActionResult>
  generateCommitMessage(payload: GenerateCommitMessagePayload): Promise<GenerateCommitMessageResult>
  getWorkspaceDiff(payload: WorkspaceDiffPayload): Promise<WorkspaceDiffResult>
  createTerminal(payload: CreateTerminalPayload): Promise<TerminalSession>
  listTerminalSessions(): Promise<TerminalDaemonSessionRecord[]>
  updateTerminalSessionMetadata(
    sessionId: string,
    patch: TerminalDaemonSessionPatch
  ): Promise<TerminalDaemonSessionRecord>
  getPersistentShellSupport(): Promise<PersistentShellSupport>
  getPersistedTerminalLayout(): Promise<PersistedTerminalLayout>
  savePersistedTerminalLayout(layout: PersistedTerminalLayout): Promise<void>
  getArchivedTabs(): Promise<ArchivedPanelTab[]>
  saveArchivedTabs(tabs: ArchivedPanelTab[]): Promise<void>
  writeTerminal(sessionId: string, data: string): void
  resizeTerminal(sessionId: string, cols: number, rows: number): void
  detachTerminal(sessionId: string): void
  destroyTerminal(sessionId: string): void
  destroyPersistentTerminal(persistentId: string): void
  startAgent(payload: AgentStartPayload): Promise<AgentRun>
  restoreAgent(payload: AgentRestorePayload): Promise<AgentRun>
  onTerminalData(listener: (event: TerminalDataEvent) => void): () => void
  onTerminalExit(listener: (event: TerminalExitEvent) => void): () => void
  onTerminalState(listener: (event: TerminalStateEvent) => void): () => void
  onAgentUpdate(listener: (event: AgentRun) => void): () => void
  listSessionStats(payload: SessionStatsRequest): Promise<SessionStat[]>
  getUsageSummary(): Promise<AgentUsage[]>
  getCodexQuota(): Promise<CodexQuota | null>
  getClaudeQuota(): Promise<ClaudeQuota | null>
  openExternalUrl(url: string): Promise<void>
  getUpdateState(): Promise<AppUpdateState>
  checkForUpdates(): Promise<AppUpdateState>
  downloadUpdate(): Promise<void>
  installUpdateAndRestart(): Promise<void>
  onUpdateState(listener: (event: AppUpdateState) => void): () => void
}
