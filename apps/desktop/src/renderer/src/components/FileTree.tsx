import { useMemo, useState } from 'react'
import type { WorkspaceEntry } from '../../../shared/workbench'

function FolderIcon({ open }: { open: boolean }): React.JSX.Element {
  return open ? (
    <svg className="tree-icon tree-icon-dir" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1.5 5a1 1 0 0 1 1-1h3.086l1.207 1.207A1 1 0 0 0 7.5 5.5H13.5a1 1 0 0 1 1 1V6H1.5V5z" fill="currentColor" opacity="0.9"/>
      <path d="M1.5 6.5h13l-1.3 5.8a1 1 0 0 1-.976.7H3.776a1 1 0 0 1-.976-.8L1.5 6.5z" fill="currentColor"/>
    </svg>
  ) : (
    <svg className="tree-icon tree-icon-dir" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1.5 4a1 1 0 0 1 1-1h3.086l1.207 1.207A1 1 0 0 0 7.5 4.5H13.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4z" fill="currentColor"/>
    </svg>
  )
}

function FileIcon(): React.JSX.Element {
  return (
    <svg className="tree-icon tree-icon-file" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 1.5h5.5L13 5v9.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-13A.5.5 0 0 1 4 1.5z" stroke="currentColor" strokeWidth="1" fill="none"/>
      <path d="M9.5 1.5V5H13" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" fill="none"/>
    </svg>
  )
}

interface FileTreeProps {
  entries: WorkspaceEntry[]
  selectedPath: string | null
  onSelect: (path: string) => void
}

function FileNode({
  entry,
  depth,
  expanded,
  onToggle,
  onSelect,
  selectedPath
}: {
  entry: WorkspaceEntry
  depth: number
  expanded: Record<string, boolean>
  onToggle: (path: string) => void
  onSelect: (path: string) => void
  selectedPath: string | null
}): React.JSX.Element {
  const isDir = entry.kind === 'directory'
  const isOpen = expanded[entry.path] ?? depth < 1
  const pad = 12 + depth * 14

  if (isDir) {
    return (
      <div>
        <button
          className="tree-row"
          style={{ paddingLeft: pad }}
          type="button"
          onClick={() => onToggle(entry.path)}
        >
          <span className="tree-caret">{isOpen ? '\u25BE' : '\u25B8'}</span>
          <FolderIcon open={isOpen} />
          <span className="tree-name">{entry.name}</span>
        </button>
        {isOpen && entry.children?.length
          ? entry.children.map((c) => (
              <FileNode
                key={c.path}
                depth={depth + 1}
                entry={c}
                expanded={expanded}
                onSelect={onSelect}
                onToggle={onToggle}
                selectedPath={selectedPath}
              />
            ))
          : null}
      </div>
    )
  }

  return (
    <button
      className={`tree-row${selectedPath === entry.path ? ' is-selected' : ''}`}
      style={{ paddingLeft: pad }}
      type="button"
      onClick={() => onSelect(entry.path)}
    >
      <span className="tree-caret tree-caret-hidden">{'\u25B8'}</span>
      <FileIcon />
      <span className="tree-name">{entry.name}</span>
    </button>
  )
}

export function FileTree({ entries, selectedPath, onSelect }: FileTreeProps): React.JSX.Element {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const visible = useMemo(() => {
    const next = { ...expanded }
    for (const e of entries) {
      if (e.kind === 'directory' && next[e.path] === undefined) {
        next[e.path] = true
      }
    }
    return next
  }, [entries, expanded])

  const toggle = (path: string): void => {
    setExpanded((c) => ({ ...c, [path]: !(c[path] ?? true) }))
  }

  if (entries.length === 0) {
    return <div className="empty-state">No files yet.</div>
  }

  return (
    <div>
      {entries.map((e) => (
        <FileNode
          key={e.path}
          depth={0}
          entry={e}
          expanded={visible}
          onSelect={onSelect}
          onToggle={toggle}
          selectedPath={selectedPath}
        />
      ))}
    </div>
  )
}
