import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ipcMain } from 'electron'
import type {
  CommitChangesPayload,
  GenerateCommitMessagePayload,
  GenerateCommitMessageResult,
  GitActionResult,
  PublishBranchPayload,
  StageChangesPayload
} from '../shared/workbench'
import { harmonyChannels } from '../shared/workbench'
import { ensureBundledSkillsInstalled, getBundledCommitMessageSkill } from './bundledSkills'
import { runGitCommand } from './git'

const DEFAULT_GIT_TIMEOUT_MS = 30_000
const PUSH_TIMEOUT_MS = 120_000
const AI_TIMEOUT_MS = 120_000
const MAX_BUFFER_BYTES = 8 * 1024 * 1024
const MAX_DIFF_SECTION_CHARS = 12_000

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeout = DEFAULT_GIT_TIMEOUT_MS
): Promise<string> {
  if (command === 'git') {
    return runGitCommand(args, { cwd, timeout, maxBuffer: MAX_BUFFER_BYTES })
  }

  return new Promise((resolveOutput, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        encoding: 'utf8',
        timeout,
        maxBuffer: MAX_BUFFER_BYTES
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = stderr.trim() || stdout.trim() || error.message
          reject(new Error(message))
          return
        }

        resolveOutput(stdout.trim())
      }
    )
  })
}

function runGit(args: string[], cwd: string, timeout = DEFAULT_GIT_TIMEOUT_MS): Promise<string> {
  return runCommand('git', args, cwd, timeout)
}

async function ensureGitWorkspaceRoot(workspacePath: string): Promise<string> {
  const cwd = resolve(workspacePath)
  const stat = await fs.stat(cwd).catch(() => null)

  if (!stat?.isDirectory()) {
    throw new Error('Path is not a valid directory.')
  }

  return resolve(await runGit(['rev-parse', '--show-toplevel'], cwd))
}

function truncateSection(content: string, maxChars = MAX_DIFF_SECTION_CHARS): string {
  if (!content) {
    return '(none)'
  }

  if (content.length <= maxChars) {
    return content
  }

  return `${content.slice(0, maxChars)}\n[truncated ${content.length - maxChars} chars]`
}

function sanitizeCommitMessage(rawMessage: string): string {
  const candidate = rawMessage
    .replace(/^```[\w-]*\s*/g, '')
    .replace(/```$/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)

  return (candidate ?? '')
    .replace(/^commit message:\s*/i, '')
    .replace(/^['"`]|['"`]$/g, '')
    .trim()
}

function parseStatusEntries(statusOutput: string): Array<{ path: string; status: string }> {
  return statusOutput
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith('## '))
    .map((line) => ({
      status: line.slice(0, 2).trim() || '??',
      path: line.slice(3).trim()
    }))
}

function inferCommitType(files: Array<{ path: string; status: string }>): string {
  const paths = files.map((file) => file.path.toLowerCase())

  if (paths.length === 0) {
    return 'chore'
  }

  if (paths.every((path) => path.endsWith('.md') || path.startsWith('docs/'))) {
    return 'docs'
  }

  if (paths.some((path) => ['package.json', 'package-lock.json', 'bun.lock', 'pnpm-lock.yaml', 'yarn.lock'].includes(path))) {
    return 'chore'
  }

  if (paths.every((path) => path.includes('test') || path.includes('spec'))) {
    return 'test'
  }

  if (files.some((file) => file.status.includes('??') || file.status.includes('A'))) {
    return 'feat'
  }

  if (files.some((file) => file.status.includes('D') || file.status.includes('R'))) {
    return 'refactor'
  }

  return 'chore'
}

function inferCommitScope(files: Array<{ path: string; status: string }>): string | null {
  const paths = files.map((file) => file.path)

  if (paths.some((path) => path.startsWith('src/renderer/'))) {
    return 'renderer'
  }

  if (paths.some((path) => path.startsWith('src/main/'))) {
    return 'main'
  }

  if (paths.some((path) => path.startsWith('src/shared/'))) {
    return 'shared'
  }

  if (paths.some((path) => ['package.json', 'package-lock.json', 'bun.lock', 'pnpm-lock.yaml', 'yarn.lock'].includes(path))) {
    return 'deps'
  }

  return null
}

function buildFallbackCommitMessage(statusOutput: string): string {
  const files = parseStatusEntries(statusOutput)
  const type = inferCommitType(files)
  const scope = inferCommitScope(files)
  const summary =
    scope === 'deps'
      ? 'update project dependencies'
      : scope === 'renderer'
        ? 'update source control workflow in the renderer'
        : scope === 'main'
          ? 'add source control commands in the main process'
          : scope === 'shared'
            ? 'update shared source control contracts'
            : 'update workspace changes'

  return scope ? `${type}(${scope}): ${summary}` : `${type}: ${summary}`
}

function parseBranchDetails(statusOutput: string): {
  branch: string
  upstream: string | null
  ahead: number
  behind: number
} {
  const header = statusOutput
    .split('\n')
    .map((line) => line.trimEnd())
    .find((line) => line.startsWith('## '))

  if (!header) {
    throw new Error('Unable to determine the current branch.')
  }

  const value = header.slice(3).trim()

  if (value.startsWith('HEAD ') || value === 'HEAD') {
    throw new Error('Cannot publish from a detached HEAD state.')
  }

  const noCommitsMatch = /^No commits yet on (.+)$/.exec(value)
  const branchPayload = noCommitsMatch ? noCommitsMatch[1] : value
  const [branchPart, upstreamPart] = branchPayload.split('...')
  const branch = branchPart.trim()
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

  if (!branch) {
    throw new Error('Unable to determine the current branch.')
  }

  return { branch, upstream, ahead, behind }
}

async function listRemotes(cwd: string): Promise<string[]> {
  const output = await runGit(['remote'], cwd).catch(() => '')
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function remoteFromUpstream(upstream: string | null): string | null {
  if (!upstream) {
    return null
  }

  const slashIndex = upstream.indexOf('/')
  return slashIndex === -1 ? upstream : upstream.slice(0, slashIndex)
}

async function resolvePublishRemote(cwd: string, upstream: string | null, preferredRemote?: string): Promise<string> {
  const explicitRemote = preferredRemote?.trim()
  if (explicitRemote) {
    return explicitRemote
  }

  const upstreamRemote = remoteFromUpstream(upstream)
  if (upstreamRemote) {
    return upstreamRemote
  }

  const remotes = await listRemotes(cwd)
  if (remotes.includes('origin')) {
    return 'origin'
  }

  const firstRemote = remotes[0]
  if (!firstRemote) {
    throw new Error('No git remote found. Add a remote before publishing this branch.')
  }

  return firstRemote
}

async function stageWorkspaceChanges(payload: StageChangesPayload): Promise<GitActionResult> {
  const cwd = await ensureGitWorkspaceRoot(payload.workspacePath)
  const branch = await runGit(['branch', '--show-current'], cwd).then((value) => value || 'detached')

  await runGit(['add', '--all'], cwd)

  return {
    branch,
    summary: 'Staged all workspace changes.'
  }
}

async function commitWorkspaceChanges(payload: CommitChangesPayload): Promise<GitActionResult> {
  const message = payload.message.replace(/\r\n/g, '\n').trim()

  if (!message) {
    throw new Error('Commit message is required.')
  }

  const cwd = await ensureGitWorkspaceRoot(payload.workspacePath)
  const statusBefore = await runGit(['status', '--porcelain=v1', '--branch', '--untracked-files=all'], cwd)
  const changes = parseStatusEntries(statusBefore)

  if (changes.length === 0) {
    throw new Error('No changes to commit.')
  }

  if (payload.stageAll !== false) {
    await runGit(['add', '--all'], cwd)
  }

  await runGit(['commit', '-m', message], cwd, PUSH_TIMEOUT_MS)

  const branch = await runGit(['branch', '--show-current'], cwd).then((value) => value || 'detached')
  const shortSha = await runGit(['rev-parse', '--short', 'HEAD'], cwd)

  return {
    branch,
    summary: `Created commit ${shortSha}.`
  }
}

async function publishBranch(payload: PublishBranchPayload): Promise<GitActionResult> {
  const cwd = await ensureGitWorkspaceRoot(payload.workspacePath)
  const statusOutput = await runGit(['status', '--porcelain=v1', '--branch', '--untracked-files=all'], cwd)
  const { branch, upstream } = parseBranchDetails(statusOutput)
  const remote = await resolvePublishRemote(cwd, upstream, payload.remote)

  if (payload.remote?.trim()) {
    await runGit(['push', '-u', remote, 'HEAD'], cwd, PUSH_TIMEOUT_MS)
  } else if (upstream) {
    await runGit(['push'], cwd, PUSH_TIMEOUT_MS)
  } else {
    await runGit(['push', '-u', remote, 'HEAD'], cwd, PUSH_TIMEOUT_MS)
  }

  return {
    branch,
    summary: upstream
      ? `Pushed ${branch} to ${upstream}.`
      : `Published ${branch} to ${remote}.`
  }
}

async function runCodexCommitMessage(cwd: string, prompt: string): Promise<string | null> {
  const tempDir = await fs.mkdtemp(join(tmpdir(), 'harmony-commit-message-'))
  const outputPath = join(tempDir, 'message.txt')

  try {
    await runCommand(
      'codex',
      ['exec', '--ephemeral', '--color', 'never', '-s', 'read-only', '-C', cwd, '-o', outputPath, prompt],
      cwd,
      AI_TIMEOUT_MS
    )

    const output = await fs.readFile(outputPath, 'utf8').catch(() => '')
    const message = sanitizeCommitMessage(output)
    return message || null
  } catch {
    return null
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function buildAiPrompt(cwd: string): Promise<string> {
  const [statusOutput, stagedStat, unstagedStat, stagedDiff, unstagedDiff] = await Promise.all([
    runGit(['status', '--short', '--branch', '--untracked-files=all'], cwd),
    runGit(['diff', '--cached', '--stat', '--no-ext-diff'], cwd).catch(() => ''),
    runGit(['diff', '--stat', '--no-ext-diff'], cwd).catch(() => ''),
    runGit(['diff', '--cached', '--unified=0', '--no-ext-diff'], cwd).catch(() => ''),
    runGit(['diff', '--unified=0', '--no-ext-diff'], cwd).catch(() => '')
  ])

  return [
    'Use the following commit-message skill guidance.',
    getBundledCommitMessageSkill(),
    '',
    'Task: Generate exactly one English Conventional Commit subject for the current git changes.',
    'Return only the commit subject on one line.',
    'Do not use markdown, bullets, quotes, or explanations.',
    'Consider both staged and unstaged changes.',
    '',
    'git status --short --branch --untracked-files=all',
    statusOutput || '(none)',
    '',
    'git diff --cached --stat --no-ext-diff',
    truncateSection(stagedStat),
    '',
    'git diff --stat --no-ext-diff',
    truncateSection(unstagedStat),
    '',
    'git diff --cached --unified=0 --no-ext-diff',
    truncateSection(stagedDiff),
    '',
    'git diff --unified=0 --no-ext-diff',
    truncateSection(unstagedDiff)
  ].join('\n')
}

async function generateCommitMessage(
  payload: GenerateCommitMessagePayload
): Promise<GenerateCommitMessageResult> {
  await ensureBundledSkillsInstalled()

  const cwd = await ensureGitWorkspaceRoot(payload.workspacePath)
  const statusOutput = await runGit(['status', '--short', '--branch', '--untracked-files=all'], cwd)
  const changes = parseStatusEntries(statusOutput)

  if (changes.length === 0) {
    throw new Error('No changes found to describe.')
  }

  const prompt = await buildAiPrompt(cwd)
  const codexMessage = await runCodexCommitMessage(cwd, prompt)

  if (codexMessage) {
    return {
      message: codexMessage,
      provider: 'Codex',
      usedFallback: false
    }
  }

  return {
    message: buildFallbackCommitMessage(statusOutput),
    provider: 'Built-in fallback',
    usedFallback: true
  }
}

export function registerSourceControlIpc(): void {
  ipcMain.handle(harmonyChannels.stageWorkspaceChanges, (_event, payload: StageChangesPayload) =>
    stageWorkspaceChanges(payload)
  )
  ipcMain.handle(harmonyChannels.commitWorkspaceChanges, (_event, payload: CommitChangesPayload) =>
    commitWorkspaceChanges(payload)
  )
  ipcMain.handle(harmonyChannels.publishBranch, (_event, payload: PublishBranchPayload) =>
    publishBranch(payload)
  )
  ipcMain.handle(harmonyChannels.generateCommitMessage, (_event, payload: GenerateCommitMessagePayload) =>
    generateCommitMessage(payload)
  )
}
