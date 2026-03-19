import { useEffect, useMemo, useRef, useState } from 'react'
import type { BranchInfo, GitAvailability, WorktreeSummary } from '../../../shared/workbench'

export type WorkspaceItem = WorktreeSummary & { isOpenedFolder?: boolean }

interface WorktreePanelProps {
  workspaces: WorkspaceItem[]
  openedTerminalsByWorkspace?: Record<string, Array<{ id: string; title: string; status?: string; isAgent?: boolean }>>
  selectedPath: string | null
  gitAvailability: GitAvailability | null
  gitActionPending: boolean
  onSelect: (path: string) => void
  onOpenTerminalTab: (workspacePath: string, tabId: string) => void
  onCreate: (branch: BranchInfo, workspacePath?: string) => Promise<void>
  onOpenFolder: () => Promise<void>
  onRemove: (path: string, isOpenedFolder: boolean) => Promise<void>
  onInstallGit: () => Promise<void>
  onRetryGit: () => Promise<void>
}

function stripBranchSuffix(name: string): string {
  return name.replace(/\s*\([^)]+\)$/, '')
}

function leafPath(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? path
}

function terminalStatusLabel(status?: string, isAgent?: boolean): string | null {
  if (!isAgent) {
    return null
  }

  switch (status) {
    case 'idle':
      return 'ready'
    case 'running':
      return 'working'
    case 'waiting':
      return 'waiting'
    case 'done':
      return 'completed'
    case 'error':
      return 'failed'
    default:
      return null
  }
}

/** Highlight the matched portion of `text` given a search `query`. */
function Highlight({ text, query }: { text: string; query: string }): React.JSX.Element {
  if (!query) return <>{text}</>
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark className="wt-highlight">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  )
}

export function WorktreePanel({
  workspaces,
  openedTerminalsByWorkspace,
  selectedPath,
  gitAvailability,
  gitActionPending,
  onSelect,
  onOpenTerminalTab,
  onCreate,
  onOpenFolder,
  onRemove,
  onInstallGit,
  onRetryGit
}: WorktreePanelProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [opening, setOpening] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [createContextPath, setCreateContextPath] = useState<string | null>(null)
  const [allBranches, setAllBranches] = useState<BranchInfo[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const worktreeItems = workspaces.filter((ws) => !ws.isOpenedFolder)
  const folderItems = workspaces.filter((ws) => ws.isOpenedFolder)
  const repoGroups = useMemo(() => {
    const groups = new Map<string, WorkspaceItem[]>()
    for (const ws of worktreeItems) {
      if (!groups.has(ws.repoRoot)) groups.set(ws.repoRoot, [])
      groups.get(ws.repoRoot)!.push(ws)
    }
    return Array.from(groups.entries()).map(([repoRoot, items]) => ({
      repoRoot,
      items,
      repoName:
        items.find((ws) => ws.isMain)?.name.replace(/\s*\([^)]+\)$/, '') ??
        stripBranchSuffix(items[0]?.name ?? leafPath(repoRoot))
    }))
  }, [worktreeItems])

  const activeCreateGroup =
    repoGroups.find((group) => group.repoRoot === createContextPath) ?? null
  const checkedOutBranches = new Set(activeCreateGroup?.items.map((ws) => ws.branch) ?? [])

  const trimmed = query.trim()

  // Filter: exclude already-checked-out branches; apply text search
  const existingMatches = allBranches.filter(
    (b) =>
      !checkedOutBranches.has(b.name) &&
      (trimmed === '' || b.name.toLowerCase().includes(trimmed.toLowerCase()))
  )

  const showNewOption =
    trimmed.length > 0 && !allBranches.some((b) => b.name === trimmed)

  const options: Array<{ kind: 'new' | 'existing'; branch: BranchInfo }> = [
    ...(showNewOption ? [{ kind: 'new' as const, branch: { name: trimmed, remote: false } }] : []),
    ...existingMatches.map((b) => ({ kind: 'existing' as const, branch: b }))
  ]

  useEffect(() => {
    if (!showCreate || !createContextPath) return
    setBranchesLoading(true)
    void window.api.listBranches(createContextPath).then((branches) => {
      setAllBranches(branches)
      setBranchesLoading(false)
    })
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [showCreate, createContextPath])

  useEffect(() => {
    setActiveIdx(0)
  }, [query])

  const openCreate = (workspacePath: string): void => {
    setQuery('')
    setCreateContextPath(workspacePath)
    setShowCreate(true)
  }

  const cancelCreate = (): void => {
    setShowCreate(false)
    setCreateContextPath(null)
    setQuery('')
    setAllBranches([])
    setBranchesLoading(false)
  }

  const commitCreate = async (branch: BranchInfo): Promise<void> => {
    const b = branch.name.trim()
    if (!b) return
    setCreating(true)
    try {
      await onCreate({ ...branch, name: b }, createContextPath ?? undefined)
      cancelCreate()
    } finally {
      setCreating(false)
    }
  }

  const handleOpenFolder = async (): Promise<void> => {
    setOpening(true)
    try {
      await onOpenFolder()
    } finally {
      setOpening(false)
    }
  }

  const handleRemove = async (path: string, isFolder: boolean): Promise<void> => {
    setRemoving(path)
    try {
      await onRemove(path, isFolder)
    } finally {
      setRemoving(null)
    }
  }

  const renderCreatePicker = (): React.JSX.Element => (
    <div className="wt-picker">
      <div className="wt-picker-bar">
        <input
          ref={inputRef}
          className="wt-create-input"
          type="text"
          placeholder="New or existing branch…"
          aria-label="Branch name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActiveIdx((i) => Math.min(i + 1, options.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActiveIdx((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const opt = options[activeIdx]
              if (opt) void commitCreate(opt.branch)
              else if (trimmed) void commitCreate({ name: trimmed, remote: false })
            } else if (e.key === 'Escape') {
              cancelCreate()
            }
          }}
        />
        <button
          className="btn btn-ghost wt-create-cancel"
          type="button"
          aria-label="Cancel"
          onClick={cancelCreate}
        >
          ✕
        </button>
      </div>

      {branchesLoading && <div className="wt-picker-loading">Loading branches…</div>}

      {!branchesLoading && options.length > 0 && (
        <div className="wt-picker-list" role="listbox" aria-label="Branch options">
          {options.map((opt, i) => (
            <button
              key={`${opt.kind}:${opt.branch.remoteRef ?? opt.branch.name}`}
              className={`wt-picker-item${i === activeIdx ? ' is-active' : ''}${opt.kind === 'new' ? ' is-new' : ''}`}
              type="button"
              role="option"
              aria-selected={i === activeIdx}
              disabled={creating}
              onClick={() => void commitCreate(opt.branch)}
              onMouseEnter={() => setActiveIdx(i)}
            >
              {opt.kind === 'new' ? (
                <>
                  <span className="wt-picker-new-icon" aria-hidden="true">+</span>
                  <span>Create <strong>{opt.branch.name}</strong></span>
                </>
              ) : (
                <>
                  {opt.branch.remote ? (
                    <svg className="wt-picker-remote-icon" width="10" height="10" viewBox="0 0 16 16" fill="none" aria-label="remote" aria-hidden="true">
                      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1ZM3.5 8c0-.6.07-1.18.2-1.73L6 8.5V9a1 1 0 0 0 1 1v1.5A4.5 4.5 0 0 1 3.5 8Zm7.83 3.07A1 1 0 0 0 10 10H9V9a1 1 0 0 0-1-1H6V6h1a1 1 0 0 0 1-1V4.07A4.5 4.5 0 0 1 12.5 8a4.46 4.46 0 0 1-1.17 3.07Z" fill="currentColor"/>
                    </svg>
                  ) : (
                    <span className="wt-branch-dot" aria-hidden="true" />
                  )}
                  <span className="wt-picker-branch">
                    <Highlight text={opt.branch.name} query={trimmed} />
                  </span>
                  {opt.branch.remote && (
                    <span className="wt-picker-remote-badge">remote</span>
                  )}
                </>
              )}
            </button>
          ))}
        </div>
      )}

      {!branchesLoading && !creating && options.length === 0 && trimmed && (
        <div className="wt-picker-loading">No matching branches</div>
      )}

      {creating && <div className="wt-picker-loading">Creating…</div>}
    </div>
  )

  const renderOpenedTerminals = (workspacePath: string): React.JSX.Element | null => {
    const tabs = openedTerminalsByWorkspace?.[workspacePath] ?? []
    if (tabs.length === 0) {
      return null
    }

    return (
      <div className="wt-open-terminals" role="list" aria-label="Opened terminals">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className="wt-open-terminal-chip"
            type="button"
            role="listitem"
            title={tab.title}
            onClick={() => onOpenTerminalTab(workspacePath, tab.id)}
          >
            {terminalStatusLabel(tab.status, tab.isAgent) && (
              <span className={`wt-open-terminal-status${tab.status ? ` is-${tab.status}` : ''}`}>
                <span className={`wt-open-terminal-dot${tab.status ? ` is-${tab.status}` : ''}`} aria-hidden="true" />
                {terminalStatusLabel(tab.status, tab.isAgent)}
              </span>
            )}
            <span className="wt-open-terminal-name">{tab.title}</span>
          </button>
        ))}
      </div>
    )
  }

  return (
    <>
      <div className="section-header">
        <div>
          <div className="section-label">Workspaces</div>
          <div className="section-title">Projects</div>
        </div>
        <div className="section-header-actions">
          <button
            className="btn btn-ghost workspace-add"
            type="button"
            disabled={opening}
            aria-label="Open folder"
            title="Open folder"
            onClick={() => void handleOpenFolder()}
          >
            +
          </button>
        </div>
      </div>

      {gitAvailability && !gitAvailability.available && (
        <div className="git-notice" role="alert">
          <div className="git-notice-title">Git required</div>
          <div className="git-notice-copy">{gitAvailability.helpText}</div>
          <div className="git-notice-actions">
            <button
              className="btn btn-primary git-notice-btn"
              type="button"
              disabled={gitActionPending}
              onClick={() => void onInstallGit()}
            >
              {gitActionPending ? 'Working…' : gitAvailability.installActionLabel}
            </button>
            <button
              className="btn btn-ghost git-notice-btn"
              type="button"
              disabled={gitActionPending}
              onClick={() => void onRetryGit()}
            >
              Retry
            </button>
          </div>
        </div>
      )}

      <div className="worktree-scroll">
        {/* ── Git worktrees grouped by repo ── */}
        {repoGroups.map((group) => (
          <div key={group.repoRoot} className="wt-group">
            <div className="wt-group-hd">
              <svg
                className="wt-group-icon"
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
              >
                <circle cx="4" cy="4" r="2" stroke="currentColor" strokeWidth="1.5" />
                <circle cx="4" cy="12" r="2" stroke="currentColor" strokeWidth="1.5" />
                <circle cx="12" cy="4" r="2" stroke="currentColor" strokeWidth="1.5" />
                <path
                  d="M4 6v4M4 6c0 2 8 2 8-2"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
              <span className="wt-group-name">{group.repoName}</span>
              <span className="badge">{group.items.length}</span>
              <button
                className="wt-group-add"
                type="button"
                aria-label="Add branch worktree"
                title="New branch"
                onClick={() => openCreate(group.repoRoot)}
              >
                +
              </button>
            </div>

            {group.items.map((ws) => {
              const active = ws.path === selectedPath
              return (
                <div key={ws.path} className="wt-branch-block">
                  <div className={`wt-branch-row${active ? ' is-active' : ''}`}>
                    <button
                      className="wt-branch-select"
                      type="button"
                      onClick={() => onSelect(ws.path)}
                    >
                      <span className={`wt-branch-dot${active ? ' is-active' : ''}`} aria-hidden="true" />
                      <span className="wt-branch-name">{ws.branch}</span>
                    </button>
                    {ws.isMain ? (
                      <span className="wt-main-badge">main</span>
                    ) : (
                      <button
                        className="wt-remove-btn"
                        type="button"
                        disabled={removing === ws.path}
                        aria-label={`Remove ${ws.branch}`}
                        onClick={() => {
                          void handleRemove(ws.path, false)
                        }}
                      >
                        ×
                      </button>
                    )}
                  </div>
                  {renderOpenedTerminals(ws.path)}
                </div>
              )
            })}

            {showCreate && createContextPath === group.repoRoot && renderCreatePicker()}
          </div>
        ))}

        {/* ── Opened folders ── */}
        {folderItems.length > 0 && (
          <div className="wt-group">
            <div className="wt-group-hd">
              <svg
                className="wt-group-icon"
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M1 4a1 1 0 0 1 1-1h4.586a1 1 0 0 1 .707.293L8.414 4.5A1 1 0 0 0 9.121 4.793H14a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </svg>
              <span className="wt-group-name">Folders</span>
              <span className="badge">{folderItems.length}</span>
            </div>

            {folderItems.map((ws) => {
              const active = ws.path === selectedPath
              return (
                <div key={ws.path} className="wt-branch-block">
                  <div className={`wt-branch-row${active ? ' is-active' : ''}`}>
                    <button
                      className="wt-branch-select"
                      type="button"
                      onClick={() => onSelect(ws.path)}
                    >
                      <span className={`wt-branch-dot${active ? ' is-active' : ''}`} aria-hidden="true" />
                      <span className="wt-branch-name">{ws.name}</span>
                    </button>
                    <button
                      className="wt-remove-btn"
                      type="button"
                      disabled={removing === ws.path}
                      aria-label={`Remove ${ws.name}`}
                      onClick={() => {
                        void handleRemove(ws.path, true)
                      }}
                    >
                      ×
                    </button>
                  </div>
                  {renderOpenedTerminals(ws.path)}
                </div>
              )
            })}
          </div>
        )}

        {workspaces.length === 0 && (
          <div className="empty-state">No workspaces open.</div>
        )}
      </div>
    </>
  )
}
