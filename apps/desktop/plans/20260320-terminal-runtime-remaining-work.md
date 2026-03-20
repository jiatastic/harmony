# Terminal Runtime Remaining Work

## Current status

The terminal runtime migration has partially completed:

- Phase 1 is done:
  - stable logical `sessionKey`
  - create-or-attach for live sessions
- Phase 2 is partially done:
  - explicit runtime states in the main process
  - `detachTerminal()` separated from destroy
  - exited state surfaced in the renderer
  - restart button for exited terminals
- Phase 3 has started in a minimal form:
  - local `node-pty` behavior now lives behind `terminalRuntime.ts`
  - `terminal.ts` now acts as the orchestration layer for ownership, lifecycle, and IPC

This means the terminal behavior is already more robust than before, but the architecture is not finished yet.

## What is still left

## Phase 2 follow-up

- Persist and expose more runtime metadata in the renderer if needed:
  - `signal`
  - whether the session is currently attached
  - clearer distinction between `destroyed` and `exited`
- Decide how agent tabs should behave after exit:
  - whether restart should relaunch the agent automatically every time
  - whether the previous run summary should remain visible
- Improve exited-state UX:
  - optional "Restart last command" vs generic restart
  - better copy for non-zero exit codes
  - optional inline action for closing exited tabs
- Add smoke tests for:
  - done at the runtime boundary for:
    - remount does not duplicate PTYs
    - component unmount only detaches
    - destroy removes the session immediately
    - exited terminal can restart cleanly
  - still worth adding one renderer-integrated smoke test for tab-close wiring

## Phase 3 remaining work

Phase 3 runtime extraction is now effectively complete for the local backend:

- `terminal.ts` no longer imports `node-pty` or tmux helpers directly
- the local runtime contract now covers:
  - `createOrAttach`
  - `write`
  - `resize`
  - `detach`
  - `destroy`
  - persistent session cleanup
- process spawning, PTY IO, exit handling, and attach reuse live inside `terminalRuntime.ts`

Follow-up work for this phase is now limited to polish:

- decide whether `signal` should become a first-class runtime method before a remote backend exists
- add an alternate runtime implementation only when daemon-backed or remote execution is ready

## Phase 4 remaining work

- Add a session metadata registry for restore behavior
- Decide what should be restorable:
  - local shell tabs
  - tmux-backed persistent tabs
  - agent tabs
- Define cold restore behavior for sessions that no longer have a live process
- Decide whether scrollback should be snapshotted, restored, or intentionally dropped

## Phase 5 remaining work

- Harden ordering guarantees for:
  - output events
  - exit events
  - detach events
  - destroy events
- Reduce race conditions around:
  - fast exit during remount
  - close-tab while exit is in flight
  - restart after immediate process termination
- Consider moving toward a subscription-style stream model if the current event model becomes too fragile

## Non-goals for now

These should not be mixed into the next small changeset unless they become necessary:

- full daemon mode
- remote execution
- terminal scrollback sync across windows
- multi-window shared terminal attachment

## Recommended next order

1. Decide Phase 4 restore rules before writing persistence code.
2. Harden stream ordering only after the runtime boundary is stable.
3. Add one renderer-integrated smoke test for close-tab and restart UX wiring.
4. Add another runtime implementation only when there is a concrete daemon or remote target.

## Suggested immediate next task

The best next implementation step is:

- decide restore semantics for local shell tabs, tmux-backed tabs, and agent tabs
- keep renderer changes small until those restore rules are explicit

The biggest architectural extraction and the first runtime smoke tests are done. The next highest-value work is restore policy and event-order hardening.
