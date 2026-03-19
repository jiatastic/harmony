# Harmony

Harmony is a desktop workspace for coding with multiple terminal-based agents, Git worktrees, and local repositories in one place.

It is designed for people who want the speed of CLI agents without losing visibility over branches, diffs, terminals, and repository context.

## Why Harmony

- Run multiple agent sessions side by side
- Keep work isolated with Git worktrees
- See repository changes without leaving the app
- Switch between raw terminals and source control quickly
- Build on a monorepo foundation that can grow into desktop + web

## What You Can Do

| Feature | What it gives you |
| --- | --- |
| Multi-workspace view | Open repositories and folders in one desktop app |
| Built-in terminals | Run shell sessions directly inside each workspace |
| Agent launchers | Start CLI agents such as Codex, Claude Code, Cursor, Gemini, and OpenCode |
| Worktree management | Create and manage isolated branches for parallel work |
| Source control panel | Stage, commit, and publish changes from the UI |
| Context inspection | Inspect skills, MCP servers, session stats, and usage |

## Repository Structure

Harmony now uses a monorepo layout so the desktop app and future website can evolve together.

```text
apps/
  desktop/   Electron app
  web/       Future website
```

Today, the desktop app is the main product. The `web` workspace is intentionally lightweight and ready for the next phase.

## Quick Start

### Install dependencies

```bash
npm install
```

### Run the desktop app in development

```bash
npm run dev
```

### Type-check the desktop app

```bash
npm run typecheck
```

## Build

### Build the desktop app

```bash
npm run build
```

### Build macOS locally without signing

```bash
npm run build:mac:unsigned
```

### Platform builds

```bash
npm run build:mac
npm run build:win
npm run build:linux
```

Desktop release artifacts are generated from `apps/desktop`.

## Release Notes

GitHub Releases are published from version tags:

```bash
git tag v0.0.1
git push origin v0.0.1
```

The release workflow installs dependencies at the monorepo root and builds the desktop app from `apps/desktop`.

## Tech Stack

- Electron
- React
- TypeScript
- electron-vite
- xterm.js
- node-pty

## Roadmap

- Polish the desktop UX for agent-heavy workflows
- Add a proper website in `apps/web`
- Extract shared modules when desktop and web start overlapping
- Expand release automation and onboarding docs

## macOS Signing and Notarization

Public macOS releases should be signed and notarized.

`npm run build:mac` will notarize the app when one of these credential sets is available:

- `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`

Use `npm run build:mac:unsigned` only for local testing.
