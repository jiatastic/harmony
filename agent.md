# Harmony — Agent Guide

## What is Harmony?

Harmony is a desktop coding agent terminal built with Electron + React + TypeScript.
It allows developers to run multiple CLI coding agents (Claude Code, Codex, Gemini CLI, etc.)
in parallel, each isolated in their own git worktree, with a unified UI to monitor and review
their changes.

Think: Superset (https://github.com/superset-sh/superset) — but our own version.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop runtime | Electron 39 |
| Build tool | electron-vite + Vite |
| Package manager | Bun |
| Language | TypeScript (strict) |
| UI framework | React 19 |
| Terminal UI | @xterm/xterm 5 |
| PTY process | node-pty 1 |
| Styling | CSS Modules (default) or Tailwind (add if needed) |
| Git operations | child_process calling git CLI directly |

---

## Project Structure

```
harmony/
├── src/
│   ├── main/               # Electron main process (Node.js environment)
│   │   ├── index.ts        # App entry, window creation
│   │   ├── terminal.ts     # PTY management (to be created)
│   │   ├── worktree.ts     # Git worktree management (to be created)
│   │   └── agent.ts        # Agent process orchestration (to be created)
│   │
│   ├── preload/            # Bridge between main and renderer
│   │   ├── index.ts        # contextBridge API exposure
│   │   └── index.d.ts      # TypeScript types for window.api
│   │
│   └── renderer/           # React app (browser environment, no Node.js access)
│       └── src/
│           ├── App.tsx
│           ├── components/ # Reusable UI components
│           ├── pages/      # Page-level components
│           └── hooks/      # Custom React hooks
│
├── resources/              # Static assets (icons, etc.)
├── build/                  # Electron builder assets
├── electron.vite.config.ts
├── electron-builder.yml
└── package.json
```

---

## Electron Architecture (Critical)

Harmony has 3 process types — know which code runs where:

### 1. Main Process (`src/main/`)
- Full Node.js access
- Manages windows, PTY, git, file system
- **Cannot** directly access DOM
- Communicates with renderer via IPC

### 2. Preload Script (`src/preload/`)
- Runs in renderer context but with Node.js access
- Acts as a secure bridge
- Exposes APIs to renderer via `contextBridge.exposeInMainWorld('api', { ... })`

### 3. Renderer Process (`src/renderer/`)
- Pure browser environment — **no Node.js**
- React UI lives here
- Communicates with main process via `window.api.*` (exposed by preload)
- **Never** use `require`, `fs`, `child_process` here

---

## IPC Pattern

All communication between renderer and main follows this pattern:

### Renderer → Main (invoke/handle for async with return value):
```typescript
// renderer: call
const result = await window.api.terminal.create({ cwd: '/path/to/repo' })

// preload: expose
contextBridge.exposeInMainWorld('api', {
  terminal: {
    create: (opts) => ipcRenderer.invoke('terminal:create', opts)
  }
})

// main: handle
ipcMain.handle('terminal:create', async (_, opts) => {
  // create PTY, return id
  return terminalId
})
```

### Main → Renderer (send for one-way events):
```typescript
// main: push data
mainWindow.webContents.send('terminal:data', { id, data })

// preload: expose listener
contextBridge.exposeInMainWorld('api', {
  terminal: {
    onData: (cb) => ipcRenderer.on('terminal:data', (_, payload) => cb(payload))
  }
})

// renderer: listen
window.api.terminal.onData(({ id, data }) => { /* write to xterm */ })
```

---

## Key Modules to Build

### Terminal Manager (`src/main/terminal.ts`)
- Create/destroy PTY instances via `node-pty`
- Each terminal has a unique `id`
- Forward data between PTY and renderer via IPC
- Handle resize events

### Worktree Manager (`src/main/worktree.ts`)
- Create a new git worktree: `git worktree add <path> -b <branch>`
- List worktrees: `git worktree list --porcelain`
- Remove worktree: `git worktree remove <path>`
- Each workspace in the UI corresponds to one worktree

### Agent Runner (`src/main/agent.ts`)
- Spawn an agent CLI (e.g. `claude`, `codex`) inside a worktree's PTY
- Track agent status: `idle | running | waiting | done | error`
- Parse agent output to detect when input is needed

---

## Naming Conventions

- **Workspace**: A unit in the UI — one git worktree + one terminal + one agent task
- **Terminal**: The PTY process + xterm.js instance rendering it
- **Agent**: A CLI coding agent running inside a workspace (Claude Code, Codex, etc.)
- **Worktree**: The git worktree directory on disk

---

## Commands

```bash
# Development
bun run dev          # Start Electron app with HMR

# Build
bun run build:mac    # Build macOS app

# Type checking
bun run typecheck    # Check all TypeScript

# Lint
bun run lint         # ESLint
```

---

## Code Style

- Use TypeScript strict mode — no `any` unless absolutely necessary
- Prefer `async/await` over `.then()` chains
- All IPC channel names use `namespace:action` format (e.g. `terminal:create`, `worktree:list`)
- React components use function components + hooks only — no class components
- Keep main process modules small and focused (one file per domain)

---

## Do Not

- Do NOT access `fs`, `child_process`, or `node-pty` from renderer code
- Do NOT use `ipcRenderer` directly in renderer — always go through preload `window.api`
- Do NOT put business logic in preload — it's just a thin bridge
- Do NOT hardcode paths — use `app.getPath()` for user data, repos, etc.
