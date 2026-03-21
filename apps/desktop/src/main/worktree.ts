import { randomUUID } from 'node:crypto'
import { promises as fs, watch as watchFs } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { ipcMain, type WebContents } from 'electron'
import type {
  WorkspaceChange,
  WorkspaceChangesSnapshot,
  FileDocument,
  ReadFilePayload,
  SaveFilePayload,
  WorkspaceWatchEvent,
  WorktreeCreatePayload,
  WorktreeSummary,
  WorkspaceEntry,
  WorkspaceSnapshot
} from '../shared/workbench'
import { harmonyChannels } from '../shared/workbench'
import { runGitCommand } from './git'

const SKIPPED_NAMES = new Set(['.git', 'node_modules', 'dist', 'out', '.DS_Store'])
const MAX_TREE_DEPTH = 4
const MAX_TREE_NODES = 600
const WORKSPACE_WATCH_POLL_INTERVAL_MS = 1500

let repositoryRootPromise: Promise<string | null> | null = null
const workspaceWatchers = new Map<string, WorkspaceWatchRegistration>()

interface WorkspaceWatcherHandle {
  close(): void
}

interface WorkspaceWatchRegistration {
  id: string
  workspacePath: string
  ownerId: number
  sender: WebContents
  watchers: WorkspaceWatcherHandle[]
}

async function getRepositoryRootFromPath(path: string): Promise<string> {
  return runGit(['rev-parse', '--show-toplevel'], resolve(path)).then((out) => resolve(out))
}

function runGit(args: string[], cwd: string): Promise<string> {
  return runGitCommand(args, { cwd })
}

async function getRepositoryRoot(): Promise<string | null> {
  if (!repositoryRootPromise) {
    repositoryRootPromise = runGit(['rev-parse', '--show-toplevel'], resolve(process.cwd()))
      .then((output) => resolve(output))
      .catch(() => null)
  }

  return repositoryRootPromise
}

async function getRepositoryRootOrThrow(action: 'list branches' | 'create worktrees'): Promise<string> {
  const repositoryRoot = await getRepositoryRoot()

  if (!repositoryRoot) {
    throw new Error(`Open a Git folder first to ${action}.`)
  }

  return repositoryRoot
}

function ensureInsideWorkspace(rootPath: string, targetPath: string): string {
  const resolvedPath = resolve(targetPath)
  const relativePath = relative(rootPath, resolvedPath)

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('Path is outside of the selected worktree.')
  }

  return resolvedPath
}

function sortEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return entries.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'directory' ? -1 : 1
    }

    return left.name.localeCompare(right.name)
  })
}

async function buildTree(
  directoryPath: string,
  depth = 0,
  state: { count: number } = { count: 0 }
): Promise<WorkspaceEntry[]> {
  if (depth > MAX_TREE_DEPTH || state.count >= MAX_TREE_NODES) {
    return []
  }

  let entries

  try {
    entries = await fs.readdir(directoryPath, { encoding: 'utf8', withFileTypes: true })
  } catch {
    return []
  }

  const nodes: WorkspaceEntry[] = []

  for (const entry of entries) {
    if (state.count >= MAX_TREE_NODES) {
      break
    }

    if (SKIPPED_NAMES.has(entry.name) || entry.isSymbolicLink()) {
      continue
    }

    const absolutePath = resolve(directoryPath, entry.name)

    if (entry.isDirectory()) {
      state.count += 1
      const children = await buildTree(absolutePath, depth + 1, state)
      nodes.push({
        name: entry.name,
        path: absolutePath,
        kind: 'directory',
        children
      })
      continue
    }

    if (entry.isFile()) {
      state.count += 1
      nodes.push({
        name: entry.name,
        path: absolutePath,
        kind: 'file'
      })
    }
  }

  return sortEntries(nodes)
}

function normalizeBranch(rawBranch: string | undefined): string {
  if (!rawBranch) {
    return 'detached'
  }

  return rawBranch.replace(/^refs\/heads\//, '')
}

function normalizeChangePath(path: string): string {
  const renamedMarker = path.lastIndexOf(' -> ')
  return renamedMarker === -1 ? path.trim() : path.slice(renamedMarker + 4).trim()
}

async function getWorkspaceChangeStats(rootPath: string): Promise<Map<string, { additions: number; deletions: number }>> {
  const stats = new Map<string, { additions: number; deletions: number }>()

  const merge = (path: string, additionsRaw: string, deletionsRaw: string): void => {
    const key = normalizeChangePath(path)
    if (!key) return
    const current = stats.get(key) ?? { additions: 0, deletions: 0 }
    current.additions += additionsRaw === '-' ? 0 : Number(additionsRaw) || 0
    current.deletions += deletionsRaw === '-' ? 0 : Number(deletionsRaw) || 0
    stats.set(key, current)
  }

  const parseNumstat = (output: string): void => {
    for (const line of output.split('\n').map((value) => value.trim()).filter(Boolean)) {
      const [additionsRaw = '0', deletionsRaw = '0', ...pathParts] = line.split('\t')
      const path = pathParts.join('\t').trim()
      if (!path) continue
      merge(path, additionsRaw, deletionsRaw)
    }
  }

  const [staged, unstaged] = await Promise.all([
    runGit(['diff', '--cached', '--numstat', '--no-ext-diff'], rootPath).catch(() => ''),
    runGit(['diff', '--numstat', '--no-ext-diff'], rootPath).catch(() => '')
  ])

  parseNumstat(staged)
  parseNumstat(unstaged)

  return stats
}

function sanitizeBranchName(branch: string): string {
  return branch
    .trim()
    .replace(/[^a-zA-Z0-9/_-]+/g, '-')
    .replace(/[\\/]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function sortWorktrees(worktrees: WorktreeSummary[]): WorktreeSummary[] {
  return worktrees.sort((left, right) => {
    if (left.isMain !== right.isMain) {
      return left.isMain ? -1 : 1
    }

    return left.branch.localeCompare(right.branch)
  })
}

async function parseWorktreeListFromRepo(repositoryRoot: string): Promise<WorktreeSummary[]> {
  const output = await runGit(['worktree', 'list', '--porcelain'], repositoryRoot)
  const blocks = output.split(/\n\s*\n/).filter(Boolean)

  const worktrees = blocks
    .map((block) => {
      const fields = block.split('\n')
      const attributes = new Map<string, string>()

      for (const line of fields) {
        const separatorIndex = line.indexOf(' ')

        if (separatorIndex === -1) {
          attributes.set(line, '')
          continue
        }

        const key = line.slice(0, separatorIndex)
        const value = line.slice(separatorIndex + 1).trim()
        attributes.set(key, value)
      }

      const worktreePath = attributes.get('worktree')

      if (!worktreePath) {
        return null
      }

      const resolvedPath = resolve(worktreePath)
      const branch = normalizeBranch(attributes.get('branch'))
      const name =
        resolvedPath === repositoryRoot
          ? `${basename(repositoryRoot)} (${branch})`
          : basename(resolvedPath)

      return {
        id: resolvedPath,
        name,
        path: resolvedPath,
        repoRoot: repositoryRoot,
        branch,
        head: attributes.get('HEAD') ?? '',
        isMain: resolvedPath === repositoryRoot,
        isLocked: attributes.has('locked')
      } satisfies WorktreeSummary
    })
    .filter((worktree): worktree is WorktreeSummary => Boolean(worktree))

  return sortWorktrees(worktrees)
}

async function listWorktreesMerged(workspacePaths?: string[]): Promise<WorktreeSummary[]> {
  const seen = new Map<string, WorktreeSummary>()
  const roots = new Set<string>()

  const addFromRoot = async (repoRoot: string): Promise<void> => {
    if (roots.has(repoRoot)) return
    roots.add(repoRoot)
    try {
      const wts = await parseWorktreeListFromRepo(repoRoot)
      for (const w of wts) {
        if (!seen.has(w.path)) seen.set(w.path, w)
      }
    } catch {
      /* skip repo if not a worktree root */
    }
  }

  const defaultRepositoryRoot = await getRepositoryRoot()
  if (defaultRepositoryRoot) {
    await addFromRoot(defaultRepositoryRoot)
  }
  if (workspacePaths?.length) {
    for (const p of workspacePaths) {
      try {
        const root = await getRepositoryRootFromPath(p)
        await addFromRoot(root)
      } catch {
        /* skip if not a git repo */
      }
    }
  }

  return sortWorktrees(Array.from(seen.values()))
}

async function ensureKnownWorktree(workspacePath: string): Promise<string> {
  const resolvedPath = resolve(workspacePath)
  const repoRoot = await getRepositoryRootFromPath(resolvedPath)
  const worktrees = await parseWorktreeListFromRepo(repoRoot)

  if (!worktrees.some((worktree) => worktree.path === resolvedPath)) {
    throw new Error('Unknown worktree path.')
  }

  return resolvedPath
}

async function resolveWorkspaceRoot(workspacePath: string): Promise<string> {
  try {
    return await ensureKnownWorktree(workspacePath)
  } catch {
    const resolved = resolve(workspacePath)
    const stat = await fs.stat(resolved).catch(() => null)
    if (!stat?.isDirectory()) {
      throw new Error('Path is not a valid directory.')
    }
    return resolved
  }
}

async function getWorkspaceSnapshot(workspacePath: string): Promise<WorkspaceSnapshot> {
  const rootPath = await resolveWorkspaceRoot(workspacePath)

  return {
    rootPath,
    entries: await buildTree(rootPath)
  }
}

async function resolveWorkspaceFilePath(
  workspacePath: string,
  targetPath: string,
  mode: 'read' | 'write'
): Promise<string> {
  const rootPath = await resolveWorkspaceRoot(workspacePath)
  const lexicalPath = ensureInsideWorkspace(rootPath, targetPath)
  const canonicalRoot = await fs.realpath(rootPath)

  if (mode === 'read') {
    const canonicalPath = await fs.realpath(lexicalPath)
    return ensureInsideWorkspace(canonicalRoot, canonicalPath)
  }

  try {
    const canonicalPath = await fs.realpath(lexicalPath)
    return ensureInsideWorkspace(canonicalRoot, canonicalPath)
  } catch {
    const canonicalParent = await fs.realpath(dirname(lexicalPath))
    ensureInsideWorkspace(canonicalRoot, canonicalParent)
    return resolve(canonicalParent, basename(lexicalPath))
  }
}

async function readWorkspaceFile(payload: ReadFilePayload): Promise<FileDocument> {
  const resolvedPath = await resolveWorkspaceFilePath(payload.workspacePath, payload.path, 'read')
  const content = await fs.readFile(resolvedPath, 'utf8')

  return {
    path: resolvedPath,
    content
  }
}

async function writeWorkspaceFile(payload: SaveFilePayload): Promise<void> {
  const resolvedPath = await resolveWorkspaceFilePath(payload.workspacePath, payload.path, 'write')
  await fs.writeFile(resolvedPath, payload.content, 'utf8')
}

function parseBranchSnapshot(statusOutput: string): {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
} {
  const header = statusOutput
    .split('\n')
    .map((line) => line.trimEnd())
    .find((line) => line.startsWith('## '))

  if (!header) {
    return { branch: null, upstream: null, ahead: 0, behind: 0 }
  }

  const value = header.slice(3).trim()

  if (value.startsWith('HEAD ') || value === 'HEAD') {
    return { branch: null, upstream: null, ahead: 0, behind: 0 }
  }

  const noCommitsMatch = /^No commits yet on (.+)$/.exec(value)
  const branchPayload = noCommitsMatch ? noCommitsMatch[1] : value
  const [branchPart, upstreamPart] = branchPayload.split('...')
  let upstream: string | null = null
  let ahead = 0
  let behind = 0

  if (upstreamPart) {
    const match = /^([^\[]+?)(?: \[(.+)\])?$/.exec(upstreamPart.trim())
    upstream = match?.[1]?.trim() || null
    const tracking = match?.[2] ?? ''
    const aheadMatch = /ahead (\d+)/.exec(tracking)
    const behindMatch = /behind (\d+)/.exec(tracking)
    ahead = aheadMatch ? Number(aheadMatch[1]) : 0
    behind = behindMatch ? Number(behindMatch[1]) : 0
  }

  return {
    branch: branchPart.trim() || null,
    upstream,
    ahead,
    behind
  }
}

async function listGitRemotes(rootPath: string): Promise<string[]> {
  const output = await runGit(['remote'], rootPath).catch(() => '')
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

async function listWorkspaceChanges(workspacePath: string): Promise<WorkspaceChangesSnapshot> {
  const rootPath = await resolveWorkspaceRoot(workspacePath)

  try {
    await runGit(['rev-parse', '--show-toplevel'], rootPath)
  } catch {
    return {
      isGitRepo: false,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      hasRemote: false,
      publishRemote: null,
      changes: []
    }
  }

  const [output, changeStats] = await Promise.all([
    runGit(['status', '--porcelain=v1', '--branch', '--untracked-files=all'], rootPath),
    getWorkspaceChangeStats(rootPath)
  ])
  const branchState = parseBranchSnapshot(output)
  const remotes = await listGitRemotes(rootPath)
  const publishRemote =
    (branchState.upstream ? branchState.upstream.split('/')[0] : null) ??
    (remotes.includes('origin') ? 'origin' : remotes[0] ?? null)

  const changes: WorkspaceChange[] = output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => Boolean(line) && !line.startsWith('## '))
    .map((line) => {
      const path = line.slice(3).trim()
      const normalizedPath = normalizeChangePath(path)
      const stat = changeStats.get(normalizedPath) ?? { additions: 0, deletions: 0 }
      return {
        status: line.slice(0, 2).trim() || '??',
        path,
        additions: stat.additions,
        deletions: stat.deletions
      }
    })

  return {
    isGitRepo: true,
    branch: branchState.branch,
    upstream: branchState.upstream,
    ahead: branchState.ahead,
    behind: branchState.behind,
    hasRemote: remotes.length > 0,
    publishRemote,
    changes
  }
}

async function resolveGitWatchPaths(workspacePath: string): Promise<string[]> {
  const rootPath = await resolveWorkspaceRoot(workspacePath)
  const paths = new Set<string>([rootPath])

  try {
    const [gitDirRaw, commonGitDirRaw] = await Promise.all([
      runGit(['rev-parse', '--git-dir'], rootPath),
      runGit(['rev-parse', '--git-common-dir'], rootPath)
    ])

    paths.add(resolve(rootPath, gitDirRaw))
    paths.add(resolve(rootPath, commonGitDirRaw))
  } catch {
    // Non-git folders still benefit from workspace file watching.
  }

  return Array.from(paths)
}

async function buildWorkspaceWatchSignature(workspacePath: string): Promise<string> {
  try {
    const snapshot = await listWorkspaceChanges(workspacePath)
    return JSON.stringify({
      branch: snapshot.branch,
      upstream: snapshot.upstream,
      ahead: snapshot.ahead,
      behind: snapshot.behind,
      hasRemote: snapshot.hasRemote,
      publishRemote: snapshot.publishRemote,
      changes: snapshot.changes.map((change) => ({
        path: change.path,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions
      }))
    })
  } catch {
    const stat = await fs.stat(workspacePath).catch(() => null)
    return `workspace:${stat?.mtimeMs ?? 0}`
  }
}

function createPollingWorkspaceWatcher(
  sender: WebContents,
  ownerId: number,
  watchId: string,
  workspacePath: string
): WorkspaceWatcherHandle {
  let disposed = false
  let inflight = false
  let lastSignature = ''

  void buildWorkspaceWatchSignature(workspacePath).then((signature) => {
    lastSignature = signature
  })

  const timer = setInterval(() => {
    if (disposed || inflight) {
      return
    }

    if (sender.isDestroyed()) {
      disposeWorkspaceWatchesForOwner(ownerId)
      return
    }

    inflight = true
    void buildWorkspaceWatchSignature(workspacePath)
      .then((signature) => {
        if (disposed) {
          return
        }

        if (!lastSignature) {
          lastSignature = signature
          return
        }

        if (signature === lastSignature) {
          return
        }

        lastSignature = signature
        sender.send(harmonyChannels.workspaceDidChange, {
          watchId,
          workspacePath
        } satisfies WorkspaceWatchEvent)
      })
      .finally(() => {
        inflight = false
      })
  }, WORKSPACE_WATCH_POLL_INTERVAL_MS)

  return {
    close() {
      disposed = true
      clearInterval(timer)
    }
  }
}

function disposeWorkspaceWatch(watchId: string): void {
  const registration = workspaceWatchers.get(watchId)
  if (!registration) {
    return
  }

  for (const watcher of registration.watchers) {
    watcher.close()
  }

  workspaceWatchers.delete(watchId)
}

function disposeWorkspaceWatchesForOwner(ownerId: number): void {
  for (const [watchId, registration] of workspaceWatchers.entries()) {
    if (registration.ownerId === ownerId) {
      disposeWorkspaceWatch(watchId)
    }
  }
}

async function startWorkspaceWatch(sender: WebContents, workspacePath: string): Promise<string> {
  const ownerId = sender.id
  const rootPath = await resolveWorkspaceRoot(workspacePath)
  const watchPaths = await resolveGitWatchPaths(rootPath)
  const watchers: WorkspaceWatcherHandle[] = []
  const watchId = randomUUID()

  const emitChange = (): void => {
    if (sender.isDestroyed()) {
      disposeWorkspaceWatchesForOwner(ownerId)
      return
    }

    sender.send(harmonyChannels.workspaceDidChange, {
      watchId,
      workspacePath: rootPath
    } satisfies WorkspaceWatchEvent)
  }

  for (const targetPath of watchPaths) {
    try {
      watchers.push(watchFs(targetPath, { recursive: true }, emitChange))
    } catch {
      // Ignore paths that cannot be watched on this platform.
    }
  }

  if (watchers.length === 0) {
    watchers.push(createPollingWorkspaceWatcher(sender, ownerId, watchId, rootPath))
  }

  const registration: WorkspaceWatchRegistration = {
    id: watchId,
    workspacePath: rootPath,
    ownerId,
    sender,
    watchers
  }

  workspaceWatchers.set(watchId, registration)
  sender.once('destroyed', () => {
    disposeWorkspaceWatchesForOwner(ownerId)
  })

  return watchId
}

export function disposeWorkspaceWatches(): void {
  for (const watchId of Array.from(workspaceWatchers.keys())) {
    disposeWorkspaceWatch(watchId)
  }
}

async function listBranches(workspacePath?: string): Promise<import('../shared/workbench').BranchInfo[]> {
  const repositoryRoot = workspacePath
    ? await getRepositoryRootFromPath(workspacePath)
    : await getRepositoryRootOrThrow('list branches')

  const [localOut, remoteOut] = await Promise.all([
    runGit(['branch', '--format=%(refname:short)', '--sort=-committerdate'], repositoryRoot),
    runGit(['branch', '-r', '--format=%(refname:short)', '--sort=-committerdate'], repositoryRoot).catch(
      () => ''
    )
  ])

  const localBranches = localOut
    .split('\n')
    .map((b) => b.trim())
    .filter(Boolean)
  const localSet = new Set(localBranches)

  // Remote-only branches: keep the full remote ref for tracking, but display the short branch name.
  const remoteBranches = remoteOut
    .split('\n')
    .map((b) => b.trim())
    .filter(Boolean)
    .filter((b) => !b.includes('HEAD'))
    .map((remoteRef) => ({
      remoteRef,
      name: remoteRef.replace(/^[^/]+\//, '')
    }))
    .filter((branch) => !localSet.has(branch.name))

  return [
    ...localBranches.map((name) => ({ name, remote: false })),
    ...remoteBranches.map(({ name, remoteRef }) => ({ name, remote: true, remoteRef }))
  ]
}

async function branchExists(branch: string, repositoryRoot: string): Promise<boolean> {
  try {
    const out = await runGit(['branch', '--list', branch], repositoryRoot)
    return out.trim().length > 0
  } catch {
    return false
  }
}

async function createWorktree(payload: WorktreeCreatePayload): Promise<WorktreeSummary> {
  const repositoryRoot = payload.workspacePath
    ? await getRepositoryRootFromPath(payload.workspacePath)
    : await getRepositoryRootOrThrow('create worktrees')
  const branch = payload.branch.trim()

  if (!branch) {
    throw new Error('Branch name is required.')
  }

  const worktreePath =
    payload.path?.trim() ||
    join(dirname(repositoryRoot), `${basename(repositoryRoot)}-${sanitizeBranchName(branch)}`)

  const exists = await branchExists(branch, repositoryRoot)
  const baseRef = payload.baseRef?.trim()
  const args = exists
    ? ['worktree', 'add', resolve(worktreePath), branch]
    : baseRef
      ? ['worktree', 'add', '--track', '-b', branch, resolve(worktreePath), baseRef]
      : ['worktree', 'add', '-b', branch, resolve(worktreePath)]

  await runGit(args, repositoryRoot)

  const worktrees = await parseWorktreeListFromRepo(repositoryRoot)
  const createdWorktree = worktrees.find((worktree) => worktree.path === resolve(worktreePath))

  if (!createdWorktree) {
    throw new Error('Worktree created but could not be reloaded.')
  }

  return createdWorktree
}

async function removeWorktree(payload: { path: string }): Promise<void> {
  const worktreePath = await ensureKnownWorktree(payload.path)
  const repositoryRoot = await getRepositoryRootFromPath(worktreePath)
  const worktrees = await parseWorktreeListFromRepo(repositoryRoot)
  const target = worktrees.find((worktree) => worktree.path === worktreePath)

  if (!target) {
    throw new Error('Unknown worktree path.')
  }

  if (target.isMain) {
    throw new Error('The main worktree cannot be removed.')
  }

  await runGit(['worktree', 'remove', worktreePath], repositoryRoot)
}

export function registerWorktreeIpc(): void {
  ipcMain.handle(harmonyChannels.listWorktrees, (_event, workspacePaths?: string[]) =>
    listWorktreesMerged(workspacePaths)
  )
  ipcMain.handle(harmonyChannels.listBranches, (_event, workspacePath?: string) =>
    listBranches(workspacePath)
  )
  ipcMain.handle(harmonyChannels.createWorktree, (_event, payload: WorktreeCreatePayload) =>
    createWorktree(payload)
  )
  ipcMain.handle(harmonyChannels.removeWorktree, (_event, payload: { path: string }) =>
    removeWorktree(payload)
  )
  ipcMain.handle(harmonyChannels.listWorkspaceChanges, (_event, workspacePath: string) =>
    listWorkspaceChanges(workspacePath)
  )
  ipcMain.handle(harmonyChannels.watchWorkspaceChangesStart, (event, workspacePath: string) =>
    startWorkspaceWatch(event.sender, workspacePath)
  )
  ipcMain.handle(harmonyChannels.watchWorkspaceChangesStop, (_event, watchId: string) => {
    disposeWorkspaceWatch(watchId)
  })
  ipcMain.handle(harmonyChannels.getWorkspace, (_event, workspacePath: string) =>
    getWorkspaceSnapshot(workspacePath)
  )
  ipcMain.handle(harmonyChannels.readFile, (_event, payload: ReadFilePayload) =>
    readWorkspaceFile(payload)
  )
  ipcMain.handle(harmonyChannels.writeFile, (_event, payload: SaveFilePayload) =>
    writeWorkspaceFile(payload)
  )
}
