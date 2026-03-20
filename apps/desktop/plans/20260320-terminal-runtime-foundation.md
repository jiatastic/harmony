# Terminal Runtime Upgrade Plan

## Why this exists

Harmony's current terminal implementation is intentionally small:

- renderer owns one `xterm.js` instance per tab
- main process spawns one `node-pty` process per mounted terminal
- session identity is mostly the transient `sessionId`
- persistence for non-agent shells depends on `tmux`, not on a terminal runtime contract

That is enough for a functional embedded terminal, but it is not enough for the kind of
behavior seen in apps like Superset Desktop:

- stable terminal identities that survive UI remounts
- create-or-attach instead of always create
- explicit session lifecycle semantics
- backend-agnostic runtime boundaries
- future room for daemon-backed or remote execution

This plan upgrades Harmony in phases so we improve behavior without freezing the app in a
large rewrite.

## Current problems

### 1. Session identity is too ephemeral

- `sessionId` is generated on every terminal creation
- the renderer tab id is stable, but the backend session id is not
- there is no first-class "logical terminal session" identity

### 2. Creation semantics are always "spawn"

- `createTerminal()` always creates a new PTY
- if a terminal host remounts, Harmony has no create-or-attach path

### 3. Lifecycle semantics are implicit

- running, exited, and destroyed are not modelled separately
- exit currently results in immediate cleanup of the PTY record
- there is no detach concept

### 4. Renderer and backend are tightly coupled

- terminal behavior is spread across `TerminalPanel.tsx` and `main/terminal.ts`
- the current API assumes a local in-process PTY backend

### 5. Persistence is partial

- non-agent tabs can persist indirectly through `tmux`
- agent tabs do not have a runtime abstraction for restore/attach
- scrollback ownership is still mostly a renderer concern

## Target direction

We want Harmony terminals to evolve toward these invariants:

1. A tab has a stable logical terminal identity.
2. Terminal creation is "create or attach", not always "create".
3. Exit is a state transition, not the same thing as destroy.
4. Backend selection should be hidden behind a runtime interface.
5. Future local daemon or remote backends should not force a renderer rewrite.

## Phases

### Phase 1: Stable identity + create-or-attach

Goal:

- introduce a stable logical session key from the renderer tab id
- allow the main process to reuse an existing live PTY for that logical session
- keep current UI and IPC mostly unchanged

Implementation:

- add `sessionKey?: string` to terminal creation payloads
- key live backend sessions by `sessionKey`
- if a live terminal already exists for the same key, return it instead of spawning a new PTY
- continue using `sessionId` as the low-level process/session identifier

Success criteria:

- terminal remounts do not accidentally create duplicate PTYs for the same tab
- renderer begins to treat tab identity and backend session identity as separate concepts

### Phase 2: Explicit lifecycle + detach semantics

Goal:

- define terminal states: `running`, `exited`, `destroyed`
- add explicit detach behavior so UI lifetime and process lifetime are no longer identical

Implementation:

- model terminal session state in the main process
- add `detachTerminal()` IPC
- keep destroy explicit and separate from detach
- stop treating exit as automatic destroy for all cases

Success criteria:

- session lifetime is understandable and race-safe
- tab close, window unmount, and process exit are no longer conflated

### Phase 3: Runtime abstraction

Goal:

- make the current in-process PTY backend an implementation detail

Implementation:

- introduce a small runtime interface:
  - `createOrAttach`
  - `write`
  - `resize`
  - `signal`
  - `destroy`
  - `detach`
- move current `node-pty` logic behind a local backend implementation

Success criteria:

- renderer no longer cares whether terminals are local, daemon-backed, or remote

### Phase 4: Persistence and restore

Goal:

- improve restore behavior without forcing full daemon mode immediately

Implementation:

- keep a session metadata registry
- add optional scrollback snapshot and restore hooks
- define cold-restore behavior for terminals that can be resumed

Success criteria:

- terminal restore behavior is deliberate instead of incidental

### Phase 5: Streaming contract hardening

Goal:

- reduce lifecycle and ordering bugs

Implementation:

- make exit a stream event, not an implicit stream shutdown
- define event ordering guarantees for output, exit, and detach
- prepare for a subscription-style stream model if needed

Success criteria:

- fewer race conditions around exit, tail output, and reattach

## What we have implemented so far

The current terminal runtime foundation now covers **Phase 1** and the first minimal slice of
**Phase 2**:

- add a stable terminal `sessionKey`
- upgrade terminal creation to create-or-attach semantics for live sessions
- model session lifecycle in the main process with `running`, `exited`, and `destroyed`
- add `detachTerminal()` so UI unmount is no longer the same thing as terminal destruction
- make tab close explicitly destroy the terminal instead of relying on component teardown

This is still intentionally incremental. It improves lifecycle semantics without taking on daemon
persistence, scrollback restore, remote execution, or a full runtime abstraction in one jump.
