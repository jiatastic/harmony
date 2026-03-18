# Harmony

Harmony is a desktop workspace for managing Git worktrees, local terminals, and AI coding agents in one place.

## What It Does

- Open multiple repositories and folders side by side
- Create and manage Git worktrees from the app
- View file trees and workspace changes
- Run local terminal sessions inside each workspace
- Track agent context, skills, MCP servers, and token usage
- Generate commit messages and handle common source control actions

## Tech Stack

- Electron
- React
- TypeScript
- electron-vite

## Getting Started

### Install dependencies

```bash
npm install
```

### Start development

```bash
npm run dev
```

### Type-check

```bash
npm run typecheck
```

## Build

### Build for macOS

```bash
npm run build:mac
```

### Build for Windows

```bash
npm run build:win
```

### Build for Linux

```bash
npm run build:linux
```

Packaged artifacts are written to `dist/`.

## Release Artifacts

- macOS: `Harmony-<version>-<arch>.dmg` and `Harmony-<version>-<arch>-mac.zip`
- Windows: `Harmony-<version>-<arch>-setup.exe`
- Linux: `Harmony-<version>-<arch>.AppImage` and distro-specific packages

## Notes

- Local macOS builds in this repo are currently unsigned.
- On first launch, macOS may ask you to confirm that you want to open the app.
