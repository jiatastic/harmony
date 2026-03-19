<div align="center">

# Harmony

### A desktop workspace for running CLI coding agents across terminals, repos, and worktrees

[Download v0.0.1](https://github.com/jiatastic/harmony/releases/tag/v0.0.1) · [GitHub](https://github.com/jiatastic/harmony)

</div>

Harmony is an Electron app for people who like terminal-based coding agents, but do not want to manage everything through scattered shells and branches.

It brings your local terminals, Git worktrees, repository state, and agent sessions into one desktop workspace.

## Why Harmony

Most CLI agents are fast, but the workflow around them gets messy fast:

- too many terminals
- too many branches
- no clean overview of what each agent changed
- too much context switching between terminal, Git, and filesystem

Harmony is built to solve that layer around the agent.

## What Harmony Does

| Area | What you get |
| --- | --- |
| Terminals | Run raw terminal sessions directly inside each workspace |
| Agents | Launch CLI agents like Codex, Claude Code, Cursor, Gemini, and OpenCode |
| Worktrees | Create isolated Git worktrees for parallel tasks |
| Source Control | Review changes, generate commit messages, commit, and publish |
| Workspace View | Keep multiple repos and folders open in one desktop app |
| Context | Inspect skills, MCP servers, usage, and session metadata |

## Current Product Shape

Harmony is currently focused on the desktop app.

- The primary agent experience is the raw terminal
- The repository already uses a monorepo layout
- A future website can live in the same repo without another migration

## Repository Structure

```text
apps/
  desktop/   Electron app
  web/       Future website
```

## Getting Started

### Install

```bash
npm install
```

### Run locally

```bash
npm run dev
```

### Type-check

```bash
npm run typecheck
```

### Build

```bash
npm run build
```

## Platform Builds

```bash
npm run build:mac
npm run build:win
npm run build:linux
```

For local macOS smoke tests without signing:

```bash
npm run build:mac:unsigned
```

## Release Flow

Harmony releases are published from Git tags.

```bash
git tag v0.0.1
git push origin v0.0.1
```

The GitHub release workflow installs dependencies from the monorepo root and builds the desktop app from `apps/desktop`.

## Tech Stack

- Electron
- React
- TypeScript
- electron-vite
- xterm.js
- node-pty

## Roadmap

- Make the desktop UX feel great for agent-heavy workflows
- Add a proper web experience in `apps/web`
- Extract shared modules once desktop and web begin overlapping
- Improve onboarding, docs, and release automation

## macOS Signing

Public macOS releases should be signed and notarized.

`npm run build:mac` will notarize the app when one of these credential sets is available:

- `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`

Use `npm run build:mac:unsigned` only for local testing.
