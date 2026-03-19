import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const MANAGED_COMMIT_MESSAGE_MARKER = '<!-- harmony-managed:commit-message:v1 -->'

const BUNDLED_COMMIT_MESSAGE_SKILL = `${MANAGED_COMMIT_MESSAGE_MARKER}
---
name: commit-message
description: >
  Generate concise, context-aware Conventional Commit messages from git changes.
  Use when writing a commit message, reviewing staged changes, or preparing a
  single commit for the current branch.
---

# commit-message

Generate Conventional Commit messages that explain the purpose of the change,
not just the file list.

## Workflow

1. Inspect git changes with \`git status --short\`, \`git diff --stat\`, and \`git diff\`.
2. Prefer staged changes when the user is preparing a commit, otherwise inspect all current changes.
3. Infer the business feature or module that changed, then choose the best commit type.
4. Return one concise commit subject unless the user explicitly asks for a body.

## Commit Types

- \`feat\`: new feature or capability
- \`fix\`: bug fix or regression fix
- \`refactor\`: internal code restructuring without behavior change
- \`docs\`: documentation-only change
- \`test\`: tests or test tooling
- \`chore\`: maintenance, tooling, build, or dependency work
- \`style\`: formatting-only changes

## Rules

- Use Conventional Commit format: \`type(scope): summary\`
- Keep the first line under 72 characters when possible
- Use active voice such as "add", "fix", "update", "refactor"
- Choose a business scope like \`auth\`, \`calendar\`, or \`source-control\`
- If there is no clear scope, omit it instead of guessing badly
- Focus on why the change matters
- Do not mention file counts, diffs, or generic phrases like "update code"

## Examples

- \`feat(source-control): add one-click branch publishing\`
- \`fix(worktree): handle detached HEAD when loading branch info\`
- \`chore(deps): update electron build tooling\`
- \`refactor(renderer): simplify sidebar state handling\`
`

const managedSkillTargets = [
  join(homedir(), '.cursor', 'rules', 'commit-message', 'SKILL.md'),
  join(homedir(), '.cursor', 'skills', 'commit-message', 'SKILL.md'),
  join(homedir(), '.agents', 'skills', 'commit-message', 'SKILL.md'),
  join(homedir(), '.codex', 'skills', 'commit-message', 'SKILL.md')
]

async function writeManagedSkill(targetPath: string, content: string): Promise<void> {
  const existing = await fs.readFile(targetPath, 'utf8').catch(() => '')

  // Do not overwrite user-managed skills that do not carry the Harmony marker.
  if (existing && !existing.includes(MANAGED_COMMIT_MESSAGE_MARKER)) {
    return
  }

  if (existing === content) {
    return
  }

  await fs.mkdir(dirname(targetPath), { recursive: true })
  await fs.writeFile(targetPath, content, 'utf8')
}

export async function ensureBundledSkillsInstalled(): Promise<void> {
  await Promise.all(
    managedSkillTargets.map((targetPath) => writeManagedSkill(targetPath, BUNDLED_COMMIT_MESSAGE_SKILL))
  )
}

export function getBundledCommitMessageSkill(): string {
  return BUNDLED_COMMIT_MESSAGE_SKILL
}
