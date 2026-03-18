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

For local smoke tests without Apple signing credentials:

```bash
npm run build:mac:unsigned
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

- Public macOS downloads should be built with a valid `Developer ID Application`
  certificate so `electron-builder` can code-sign the app.
- `npm run build:mac` will notarize the macOS app when one of these credential
  sets is present:
  - `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`
  - `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
- Use `npm run build:mac:unsigned` only for local testing. Unsigned builds are
  expected to trigger macOS security warnings when shared with other users.
- If local signing fails with `com.apple.provenance`, rebuild in a clean CI
  environment or reinstall `electron` from a non-quarantined source before
  creating the release artifact.
