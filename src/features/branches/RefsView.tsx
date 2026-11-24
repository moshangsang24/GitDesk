import { useState } from 'react';
import type { RefObject } from 'react';
import { Notice } from '../../components/ui/Notice';
import { SearchField } from '../../components/ui/SearchField';
import { shortRef } from '../../core/graph/refs';
import type { GitRef, Worktree } from '../../services/contracts';
import { RepoStatus } from '../workspace/RepoStatus';

const operations = { merge: 'Merge', rebase: 'Rebase', cherryPick: 'Cherry-pick', other: 'Git operation' };

export function WorktreeSummary({ worktree }: { worktree: Worktree }) {
  const { status } = worktree;
  const groups = [
    ['Staged', status.staged],
    ['Unstaged', status.unstaged],
    ['Untracked', status.untracked],
    ['Conflicts', status.conflicts],
  ] as const;

  return (
    <div className="local-status" aria-label="Worktree status">
      {worktree.bare ? <span className="text-muted">Bare repository</span> : <RepoStatus status={status} />}
      {status.kind !== 'unknown' && (
        <dl>
          {groups.map(([label, number]) => number !== undefined && (
            <div key={label}><dt>{label}</dt><dd>{number}</dd></div>
          ))}
        </dl>
      )}
      {status.upstream && <span className="truncate" title={status.upstream}>Upstream {status.upstream}</span>}
      {status.operation && status.operation !== 'none' && status.operation !== 'unknown' && (
        <span className="worktree-label">{operations[status.operation]} in progress</span>
      )}
      {(status.kind === 'unknown' || status.filterLimited) && !worktree.bare && status.detail && <span className="truncate" title={status.detail}>{status.detail}</span>}
    </div>
  );
}

const kinds: GitRef['kind'][] = ['local', 'remote', 'tag'];
const labels = { local: 'Local branches', remote: 'Remote-tracking branches', tag: 'Tags' };

export function RefsView({ refs, worktree, search }: { refs: GitRef[]; worktree: Worktree; search: RefObject<HTMLInputElement | null> }) {
  const [query, setQuery] = useState('');
  const filter = query.trim().toLowerCase();
  const visible = refs.filter(({ fullName, targetOid }) => fullName.toLowerCase().includes(filter) || targetOid.startsWith(filter));

  return (
    <div className="local-refs">
      <WorktreeSummary worktree={worktree} />
      <div className="refs-search">
        <SearchField inputRef={search} label="Search branches and tags" value={query} onChange={setQuery} onEscape={() => { setQuery(''); search.current?.blur(); }} />
      </div>
      {!visible.length ? (
        <Notice title={filter ? 'No matching references' : 'No branches or tags yet'} />
      ) : (
        <table className="worktree-table refs-table">
          <caption className="sr-only">Branches and tags</caption>
          <thead><tr><th scope="col">Name</th><th scope="col">Commit</th></tr></thead>
          {kinds.map((kind) => {
            const group = visible.filter((ref) => ref.kind === kind);
            if (!group.length) return null;
            return (
              <tbody key={kind}>
                <tr className="refs-group"><th colSpan={2} scope="rowgroup">{labels[kind]}</th></tr>
                {group.map((ref) => {
                  const current = kind === 'local' && shortRef(ref.fullName) === worktree.branch;
                  const detail = ref.symbolicTarget ? `${ref.fullName} → ${ref.symbolicTarget}` : ref.fullName;
                  return (
                    <tr key={ref.fullName} data-current={current || undefined}>
                      <td><span className="ref-name" title={detail}>
                        <span className="truncate">{shortRef(ref.fullName)}</span>
                        {current && <span className="worktree-label">Current</span>}
                        {ref.symbolicTarget && <span className="truncate text-muted">→ {shortRef(ref.symbolicTarget)}</span>}
                      </span></td>
                      <td><code title={ref.targetOid}>{ref.targetOid.slice(0, 7)}</code></td>
                    </tr>
                  );
                })}
              </tbody>
            );
          })}
        </table>
      )}
    </div>
  );
}
