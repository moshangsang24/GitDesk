import { Cloud, Crosshair, FolderGit2, GitBranch, Tag } from 'lucide-react';
import { useRef, useState } from 'react';
import { SearchField } from '../../components/ui/SearchField';
import { shortRef } from '../../core/graph/refs';
import type { GitRef, Worktree } from '../../services/contracts';
import { useGitDesk } from '../../stores/gitdesk';

const pageSize = 60;

function RefRows({ refs, remote }: { refs: GitRef[]; remote?: string }) {
  const [limit, setLimit] = useState(pageSize);
  const locate = useGitDesk((state) => state.locateCommit);
  const setScope = useGitDesk((state) => state.setScope);
  const focusedRef = useGitDesk((state) => state.focusedRef);
  const locatingReady = useGitDesk((state) => !state.local || state.history.phase === 'ready');

  return (
    <ul className="history-ref-list">
      {refs.slice(0, limit).map((ref) => {
        const name = shortRef(ref.fullName);
        const Icon = ref.kind === 'local' ? GitBranch : ref.kind === 'remote' ? Cloud : Tag;
        return (
          <li key={ref.fullName} data-focused={focusedRef === ref.fullName || undefined}>
            <button className="history-ref-name" title={ref.fullName} aria-label={`Locate ${name}`} disabled={!locatingReady} onClick={() => { void locate(ref.targetOid); }}>
              <Icon size={13} aria-hidden="true" />
              <span className="truncate">{remote ? name.slice(remote.length + 1) : name}</span>
            </button>
            {ref.kind !== 'tag' && (
              <button className="icon-button focus-ref" aria-label={`Focus branch ${name}`} title={`Focus branch ${name}`} onClick={() => { void setScope('ref', ref.fullName); }}>
                <Crosshair size={13} aria-hidden="true" />
              </button>
            )}
          </li>
        );
      })}
      {refs.length > limit && (
        <li><button className="history-ref-name more-refs" onClick={() => setLimit(limit + pageSize)}>Show {Math.min(pageSize, refs.length - limit)} more</button></li>
      )}
    </ul>
  );
}

export function HistoryRefs({ refs, worktrees, worktreeId }: { refs: GitRef[]; worktrees: Worktree[]; worktreeId: string }) {
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const visibility = useGitDesk((state) => state.refVisibility);
  const openWorktree = useGitDesk((state) => state.openWorktree);
  const filter = query.trim().toLowerCase();
  const visible = refs.filter((ref) => !ref.symbolicTarget && (
    ref.fullName.toLowerCase().includes(filter) || ref.targetOid.startsWith(filter)
  ));
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
  const trees = worktrees.filter(({ path, branch }) => `${path} ${branch ?? ''}`.toLowerCase().includes(filter));

  return (
    <aside className="history-refs" aria-label="History references" id="history-references">
      <div className="history-ref-search">
        <SearchField inputRef={search} label="Find references" value={query} onChange={setQuery} onEscape={() => { setQuery(''); search.current?.blur(); }} />
      </div>
      <div className="history-ref-groups">
        {visibility.local && (
          <details open>
            <summary>Local <span>{locals.length}</span></summary>
            <RefRows refs={locals} />
          </details>
        )}
        {visibility.remote && (
          <details open={!!filter}>
            <summary>Remote <span>{visible.filter(({ kind }) => kind === 'remote').length}</span></summary>
            {Array.from(remotes, ([remote, items]) => (
              <details key={remote} className="history-remote-group" open>
                <summary>{remote} <span>{items.length}</span></summary>
                <RefRows refs={items} remote={remote} />
              </details>
            ))}
          </details>
        )}
        <details open={!!filter}>
          <summary>Tags <span>{tags.length}</span></summary>
          <RefRows refs={tags} />
        </details>
        <details open={!!filter}>
          <summary>Worktrees <span>{trees.length}</span></summary>
          <ul className="history-ref-list">
            {trees.map((tree) => (
              <li key={tree.id} data-focused={tree.id === worktreeId || undefined}>
                <button className="history-ref-name" title={tree.path} aria-current={tree.id === worktreeId || undefined} onClick={() => { void openWorktree(tree.id); }}>
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
