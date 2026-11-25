import { ChevronDown, ChevronRight, Cloud, Crosshair, Folder, FolderGit2, GitBranch, Tag } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { SearchField } from '../../components/ui/SearchField';
import { groupByPrefix } from '../../core/graph/ref-groups';
import { shortRef } from '../../core/graph/refs';
import { showContextMenu } from '../../services/context-menu';
import type { GitRef, Worktree } from '../../services/contracts';
import { useGitDesk } from '../../stores/gitdesk';
import { copy, openLocationFor } from '../menus/actions';
import { refMenu, worktreeMenu } from '../menus/menus';

const pageSize = 60;

function RefRow({ gitRef, leaf, current }: { gitRef: GitRef; leaf: string; current: boolean }) {
  const locate = useGitDesk((state) => state.locateCommit);
  const setScope = useGitDesk((state) => state.setScope);
  const focusedRef = useGitDesk((state) => state.focusedRef);
  const locatingReady = useGitDesk((state) => !state.local || state.history.phase === 'ready');
  const name = shortRef(gitRef.fullName);
  const Icon = gitRef.kind === 'local' ? GitBranch : gitRef.kind === 'remote' ? Cloud : Tag;

  return (
    <li data-focused={focusedRef === gitRef.fullName || undefined} data-current={current || undefined}>
      <button
        className="history-ref-name"
        title={current ? `${gitRef.fullName} (checked out)` : gitRef.fullName}
        aria-label={`Locate ${name}${current ? ', checked out' : ''}`}
        disabled={!locatingReady}
        onClick={() => { void locate(gitRef.targetOid); }}
        onContextMenu={(event) => {
          event.preventDefault();
          void showContextMenu(refMenu(
            { kind: gitRef.kind, fullName: gitRef.fullName, name, targetOid: gitRef.targetOid },
            { copy, locate: (oid) => { void locate(oid); }, focusBranch: (fullName) => { void setScope('ref', fullName); } },
          ), { x: event.clientX, y: event.clientY });
        }}
      >
        <Icon size={13} aria-hidden="true" />
        <span className="truncate">{leaf}</span>
        {current && <span className="ref-current-dot" aria-hidden="true" />}
      </button>
      {gitRef.kind !== 'tag' && (
        <button className="icon-button focus-ref" aria-label={`Focus branch ${name}`} title={`Focus branch ${name}`} onClick={() => { void setScope('ref', gitRef.fullName); }}>
          <Crosshair size={13} aria-hidden="true" />
        </button>
      )}
    </li>
  );
}

/** Refs of one kind (or one remote), with shared prefixes folded into folders. */
function RefTree({ refs, strip = '', currentRef, expandAll }: { refs: GitRef[]; strip?: string; currentRef: string | null; expandAll: boolean }) {
  const focusedRef = useGitDesk((state) => state.focusedRef);
  const [limit, setLimit] = useState(pageSize);
  const grouped = useMemo(
    () => groupByPrefix(refs, (ref) => shortRef(ref.fullName).slice(strip.length)),
    [refs, strip],
  );
  // Folders holding the checked-out or focused branch start open; the rest start closed.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(grouped.folders
    .filter(({ items }) => items.some(({ ref }) => ref.fullName === currentRef || ref.fullName === focusedRef))
    .map(({ prefix }) => prefix)));

  function toggle(prefix: string) {
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(prefix)) next.delete(prefix);
      else next.add(prefix);
      return next;
    });
  }

  return (
    <ul className="history-ref-list">
      {grouped.folders.map(({ prefix, items }) => {
        const expanded = expandAll || open.has(prefix);
        const holdsCurrent = items.some(({ ref }) => ref.fullName === currentRef);
        return (
          <li key={`folder:${prefix}`} className="ref-folder">
            <button className="ref-folder-toggle" aria-expanded={expanded} onClick={() => toggle(prefix)} disabled={expandAll}>
              {expanded ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
              <Folder size={13} aria-hidden="true" />
              <span className="truncate">{prefix}</span>
              {holdsCurrent && !expanded && <span className="ref-current-dot" title="Contains the checked-out branch" />}
              <span className="ref-folder-count">{items.length}</span>
            </button>
            {expanded && (
              <ul className="history-ref-list ref-folder-items">
                {items.map(({ ref, leaf }) => <RefRow key={ref.fullName} gitRef={ref} leaf={leaf} current={ref.fullName === currentRef} />)}
              </ul>
            )}
          </li>
        );
      })}
      {grouped.loose.slice(0, limit).map(({ ref, leaf }) => <RefRow key={ref.fullName} gitRef={ref} leaf={leaf} current={ref.fullName === currentRef} />)}
      {grouped.loose.length > limit && (
        <li><button className="history-ref-name more-refs" onClick={() => setLimit(limit + pageSize)}>Show {Math.min(pageSize, grouped.loose.length - limit)} more</button></li>
      )}
    </ul>
  );
}

export function HistoryRefs({ refs, worktrees, worktreeId }: { refs: GitRef[]; worktrees: Worktree[]; worktreeId: string }) {
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const visibility = useGitDesk((state) => state.refVisibility);
  const openWorktree = useGitDesk((state) => state.openWorktree);
  const repoId = useGitDesk((state) => state.repoId);
  const local = useGitDesk((state) => state.local);
  const filter = query.trim().toLowerCase();
  const visible = refs.filter((ref) => !ref.symbolicTarget && (
    ref.fullName.toLowerCase().includes(filter) || ref.targetOid.startsWith(filter)
  ));
  const branch = worktrees.find(({ id }) => id === worktreeId)?.branch;
  const currentRef = branch ? `refs/heads/${branch}` : null;
  const locals = visible.filter(({ kind }) => kind === 'local');
  const tags = visible.filter(({ kind }) => kind === 'tag');
  const remotes = new Map<string, GitRef[]>();
  for (const ref of visible) {
    if (ref.kind !== 'remote') continue;
    const [remote] = shortRef(ref.fullName).split('/', 1);
    const group = remotes.get(remote);
    if (group) group.push(ref);
    else remotes.set(remote, [ref]);
  }
  const trees = worktrees.filter(({ path, branch: name }) => `${path} ${name ?? ''}`.toLowerCase().includes(filter));
  const expandAll = !!filter;

  return (
    <aside className="history-refs" aria-label="History references" id="history-references">
      <div className="history-ref-search">
        <SearchField inputRef={search} label="Find references" value={query} onChange={setQuery} onEscape={() => { setQuery(''); search.current?.blur(); }} />
      </div>
      <div className="history-ref-groups">
        {visibility.local && (
          <details open>
            <summary>Local <span>{locals.length}</span></summary>
            <RefTree key={`local:${expandAll}`} refs={locals} currentRef={currentRef} expandAll={expandAll} />
          </details>
        )}
        {visibility.remote && (
          <details open={!!filter}>
            <summary>Remote <span>{visible.filter(({ kind }) => kind === 'remote').length}</span></summary>
            {Array.from(remotes, ([remote, items]) => (
              <details key={remote} className="history-remote-group" open>
                <summary>{remote} <span>{items.length}</span></summary>
                <RefTree key={`${remote}:${expandAll}`} refs={items} strip={`${remote}/`} currentRef={null} expandAll={expandAll} />
              </details>
            ))}
          </details>
        )}
        <details open={!!filter}>
          <summary>Tags <span>{tags.length}</span></summary>
          <RefTree key={`tags:${expandAll}`} refs={tags} currentRef={null} expandAll={expandAll} />
        </details>
        <details open={!!filter}>
          <summary>Worktrees <span>{trees.length}</span></summary>
          <ul className="history-ref-list">
            {trees.map((tree) => (
              <li key={tree.id} data-focused={tree.id === worktreeId || undefined}>
                <button
                  className="history-ref-name"
                  title={tree.path}
                  aria-current={tree.id === worktreeId || undefined}
                  onClick={() => { void openWorktree(tree.id); }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    void showContextMenu(worktreeMenu(
                      { active: tree.id === worktreeId, path: tree.path, local, prunable: !!tree.prunable },
                      {
                        copy,
                        browse: () => { void openWorktree(tree.id); },
                        reveal: () => { void openLocationFor(repoId, tree.id, 'finder'); },
                        terminal: () => { void openLocationFor(repoId, tree.id, 'terminal'); },
                      },
                    ), { x: event.clientX, y: event.clientY });
                  }}
                >
                  <FolderGit2 size={13} aria-hidden="true" />
                  <span className="truncate">{tree.status.branchNameUnavailable ? 'Branch name unavailable' : tree.branch ?? (tree.head ? `Detached ${tree.head.slice(0, 7)}` : 'No commits')}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      </div>
    </aside>
  );
}
