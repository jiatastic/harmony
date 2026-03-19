import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import process from 'node:process'
import type { GitAvailability } from '../shared/workbench'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024

const COMMON_GIT_PATHS =
  process.platform === 'darwin'
    ? ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/opt/local/bin/git', '/usr/bin/git']
    : process.platform === 'linux'
      ? ['/usr/local/bin/git', '/usr/bin/git', '/bin/git']
      : ['git']

let gitBinaryPromise: Promise<string> | null = null

function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string
    timeout?: number
    maxBuffer?: number
  } = {}
): Promise<string> {
  const { cwd, timeout = DEFAULT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER_BYTES } = options
  return new Promise((resolveOutput, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        encoding: 'utf8',
        timeout,
        maxBuffer
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

async function isRunnableGit(binaryPath: string): Promise<boolean> {
  try {
    await runCommand(binaryPath, ['--version'])
    return true
  } catch {
    return false
  }
}

async function resolveGitFromShell(): Promise<string | null> {
  if (process.platform === 'win32') {
    return null
  }

  const shells = Array.from(
    new Set([process.env.SHELL, '/bin/zsh', '/bin/bash'].filter((value): value is string => Boolean(value)))
  )
  for (const shellPath of shells) {
    try {
      const resolved = await runCommand(shellPath, ['-lc', 'command -v git'])
      if (resolved && (await isRunnableGit(resolved))) {
        return resolved
      }
    } catch {
      // Try the next shell or fallback path.
    }
  }

  return null
}

async function resolveGitFromCommonPaths(): Promise<string | null> {
  for (const candidate of COMMON_GIT_PATHS) {
    try {
      await fs.access(candidate)
      if (await isRunnableGit(candidate)) {
        return candidate
      }
    } catch {
      // Try the next common install path.
    }
  }

  return null
}

export async function resolveGitBinary(): Promise<string> {
  if (!gitBinaryPromise) {
    gitBinaryPromise = (async () => {
      if (await isRunnableGit('git')) {
        return 'git'
      }

      const shellGit = await resolveGitFromShell()
      if (shellGit) {
        return shellGit
      }

      const commonPathGit = await resolveGitFromCommonPaths()
      if (commonPathGit) {
        return commonPathGit
      }

      throw new Error(
        'Git is not available. Install Git or Xcode Command Line Tools and relaunch Harmony.'
      )
    })().catch((error) => {
      gitBinaryPromise = null
      throw error
    })
  }

  return await gitBinaryPromise
}

export async function runGitCommand(
  args: string[],
  options: {
    cwd: string
    timeout?: number
    maxBuffer?: number
  }
): Promise<string> {
  const gitBinary = await resolveGitBinary()
  return await runCommand(gitBinary, args, options)
}

export async function getGitAvailability(): Promise<GitAvailability> {
  try {
    const binaryPath = await resolveGitBinary()
    return {
      available: true,
      binaryPath,
      installActionLabel: process.platform === 'linux' ? 'Get Git' : 'Install Git',
      helpText: 'Git is available.',
      canAutoInstall: process.platform === 'darwin' || process.platform === 'win32'
    }
  } catch {
    if (process.platform === 'darwin') {
      return {
        available: false,
        binaryPath: null,
        installActionLabel: 'Install Git',
        helpText: 'Git is required to detect repositories and create worktrees. Harmony can open the macOS Command Line Tools installer for you.',
        canAutoInstall: true
      }
    }

    if (process.platform === 'win32') {
      return {
        available: false,
        binaryPath: null,
        installActionLabel: 'Install Git',
        helpText: 'Git is required to detect repositories and create worktrees. Harmony can install Git with winget if it is available on this PC.',
        canAutoInstall: true
      }
    }

    return {
      available: false,
      binaryPath: null,
      installActionLabel: 'Get Git',
      helpText: 'Git is required to detect repositories and create worktrees. Harmony can open the Git download page for your system.',
      canAutoInstall: false
    }
  }
}

export async function installGit(): Promise<string> {
  if (process.platform === 'darwin') {
    try {
      await runCommand('xcode-select', ['--install'])
      return 'Opened the macOS Command Line Tools installer.'
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/already installed|software is already installed|install requested/i.test(message)) {
        return 'The macOS Command Line Tools installer is already open or Git is already installed.'
      }
      throw error
    }
  }

  if (process.platform === 'win32') {
    try {
      await runCommand('winget', ['install', '--id', 'Git.Git', '-e', '--source', 'winget'])
      return 'Started Git installation with winget.'
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        message
          ? `Failed to start Git installation with winget. ${message}`
          : 'Failed to start Git installation with winget.'
      )
    }
  }

  return 'OPEN_DOWNLOAD_PAGE'
}
