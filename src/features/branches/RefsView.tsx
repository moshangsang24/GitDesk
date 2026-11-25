import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Cloud, Folder, FolderGit2, GitBranch, History, Tag } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Notice } from '../../components/ui/Notice';
import { SearchField } from '../../components/ui/SearchField';
import { groupByPrefix } from '../../core/graph/ref-groups';
import { shortRef } from '../../core/graph/refs';
import { showContextMenu } from '../../services/context-menu';
import type { GitRef, Worktree } from '../../services/contracts';
import { useGitDesk } from '../../stores/gitdesk';
import { copy } from '../menus/actions';
import { refMenu } from '../menus/menus';
import { checkedOutIn, folderName, trackingFor, type Tracking } from './ref-info';

const operations = { merge: 'Merge', rebase: 'Rebase', cherryPick: 'Cherry-pick', other: 'Git operation' };

const changeGroups = [
  { key: 'staged', label: 'Staged' },
  { key: 'unstaged', label: 'Unstaged' },
  { key: 'untracked', label: 'Untracked' },
  { key: 'conflicts', label: 'Conflicts' },
] as const;

/** Working-tree counts on the left, synchronisation with the upstream on the right. */
export function WorktreeSummary({ worktree }: { worktree: Worktree }) {
  const { status } = worktree;
  const ahead = status.ahead ?? 0;
  const behind = status.behind ?? 0;
  const operation = status.operation && status.operation !== 'none' && status.operation !== 'unknown' ? operations[status.operation] : null;

  return (
    <div className="local-status" aria-label="Worktree status">
      <div className="status-cluster">
        {worktree.bare ? <span className="text-muted">Bare repository</span>
          : status.kind === 'unknown' ? <span className="summary-pill summary-unknown" title={status.detail ?? undefined}>Status unknown</span>
            : status.changes > 0
              ? <span className={`summary-pill ${status.kind === 'conflict' ? 'summary-conflict' : 'summary-dirty'}`}>{status.filterLimited ? '~' : ''}{status.changes} changed</span>
              : <span className="summary-pill summary-clean"><Check size={12} aria-hidden="true" />Clean</span>}
        {status.kind !== 'unknown' && !worktree.bare && (
          <ul className="change-counts" aria-label="Changes by group">
            {changeGroups.map(({ key, label }) => {
              const count = status[key];
              if (count === undefined) return null;
              return (
                <li key={key} className={`change-count change-${key}`} data-zero={count === 0 || undefined}>
                  <span className="change-dot" aria-hidden="true" />
                  <strong>{count}</strong> {label}
                </li>
              );
            })}
          </ul>
        )}
        {operation && <span className="summary-pill summary-conflict">{operation} in progress</span>}
      </div>
      <div className="status-cluster status-sync">
        {status.upstream ? (
          <>
            <span className="upstream-name truncate" title={`Upstream ${status.upstream}`}><Cloud size={13} aria-hidden="true" />{status.upstream}</span>
            {ahead === 0 && behind === 0 && status.ahead !== null
              ? <span className="sync-chip sync-even">Up to date</span>
              : <>
                {ahead > 0 && <span className="sync-chip sync-ahead" title={`${ahead} commits to push`}><ArrowUp size={11} aria-hidden="true" />{ahead}</span>}
                {behind > 0 && <span className="sync-chip sync-behind" title={`${behind} commits to pull`}><ArrowDown size={11} aria-hidden="true" />{behind}</span>}
              </>}
          </>
        ) : !worktree.bare && <span className="text-muted">No upstream</span>}
      </div>
      {(status.kind === 'unknown' || status.filterLimited) && !worktree.bare && status.detail && <span className="status-detail truncate" title={status.detail}>{status.detail}</span>}
    </div>
  );
}

function TrackingCell({ tracking }: { tracking: Tracking }): ReactNode {
  switch (tracking.kind) {
    case 'upstream': {
      const ahead = tracking.ahead ?? 0;
      const behind = tracking.behind ?? 0;
      return (
        <span className="tracking">
          <span className="truncate text-secondary">{tracking.upstream}</span>
          {ahead > 0 && <span className="sync-chip sync-ahead" title={`${ahead} commits ahead`}><ArrowUp size={10} aria-hidden="true" />{ahead}</span>}
          {behind > 0 && <span className="sync-chip sync-behind" title={`${behind} commits behind`}><ArrowDown size={10} aria-hidden="true" />{behind}</span>}
          {!ahead && !behind && tracking.ahead !== null && <span className="sync-chip sync-even">Up to date</span>}
        </span>
      );
    }
    case 'same': return <span className="tracking"><span className="tracking-mark tracking-same" aria-hidden="true">=</span><span className="truncate">Same as {tracking.remote}</span></span>;
    case 'differs': return <span className="tracking"><span className="tracking-mark tracking-differs" aria-hidden="true">≠</span><span className="truncate">Differs from {tracking.remote}</span></span>;
    case 'local-only': return <span className="tracking text-muted">Local only</span>;
    case 'has-local': return <span className="tracking text-muted" title={`Local branch ${tracking.local}`}>Has local branch</span>;
    case 'no-local': return <span className="tracking text-muted">No local branch</span>;
    default: return null;
  }
}

interface RowContext {
  refs: GitRef[];
  worktrees: Worktree[];
  current: Worktree;
}

function RefRow({ gitRef, leaf, nested, context }: { gitRef: GitRef; leaf: string; nested: boolean; context: RowContext }) {
  const revealCommit = useGitDesk((state) => state.revealCommit);
  const setScope = useGitDesk((state) => state.setScope);
  const setPage = useGitDesk((state) => state.setPage);
  const name = shortRef(gitRef.fullName);
  const isCurrent = gitRef.kind === 'local' && name === context.current.branch;
  const trees = checkedOutIn(gitRef, context.worktrees);
  const Icon = gitRef.kind === 'local' ? GitBranch : gitRef.kind === 'remote' ? Cloud : Tag;
  const detail = gitRef.symbolicTarget ? `${gitRef.fullName} → ${gitRef.symbolicTarget}` : gitRef.fullName;
  const show = () => { void revealCommit(gitRef.targetOid); };

  return (
    <tr
      data-current={isCurrent || undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        void showContextMenu(refMenu({ kind: gitRef.kind, fullName: gitRef.fullName, name, targetOid: gitRef.targetOid }, {
          copy,
          locate: show,
          focusBranch: (fullName) => { void setScope('ref', fullName).then(() => setPage('history')); },
        }), { x: event.clientX, y: event.clientY });
      }}
    >
      <td>
        <span className={`ref-name${nested ? ' ref-name-nested' : ''}`} title={detail}>
          <Icon size={14} className={`ref-kind-icon ref-kind-${gitRef.kind}`} aria-hidden="true" />
          <span className="truncate">{leaf}</span>
          {isCurrent && <span className="ref-tag-current">Current</span>}
          {gitRef.symbolicTarget && <span className="truncate text-muted">→ {shortRef(gitRef.symbolicTarget)}</span>}
        </span>
      </td>
      <td><TrackingCell tracking={trackingFor(gitRef, context.refs, context.current)} /></td>
      <td>
        {trees.length > 0 && (
          <span className="ref-worktrees">
            {trees.map((tree) => (
              <span key={tree.id} className="worktree-label" title={tree.path}>
                <FolderGit2 size={11} aria-hidden="true" />{tree.id === context.current.id ? 'This worktree' : folderName(tree.path)}
              </span>
            ))}
          </span>
        )}
      </td>
      <td><code title={gitRef.targetOid}>{gitRef.targetOid.slice(0, 7)}</code></td>
      <td className="ref-actions">
        <button className="icon-button" aria-label={`Show ${name} in History`} title="Show in History" onClick={show}><History size={14} /></button>
      </td>
    </tr>
  );
}

function RefRows({ refs, strip, context, expandAll }: { refs: GitRef[]; strip: string; context: RowContext; expandAll: boolean }) {
  const grouped = useMemo(() => groupByPrefix(refs, (ref) => shortRef(ref.fullName).slice(strip.length)), [refs, strip]);
  const currentRef = context.current.branch ? `refs/heads/${context.current.branch}` : null;
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(grouped.folders
    .filter(({ items }) => items.some(({ ref }) => ref.fullName === currentRef)).map(({ prefix }) => prefix)));

  function toggle(prefix: string) {
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(prefix)) next.delete(prefix);
      else next.add(prefix);
      return next;
    });
  }

  return (
    <>
      {grouped.folders.map(({ prefix, items }) => {
        const expanded = expandAll || open.has(prefix);
        return [
          <tr key={`folder:${prefix}`} className="refs-folder">
            <td colSpan={5}>
              <button className="ref-folder-toggle" aria-expanded={expanded} disabled={expandAll} onClick={() => toggle(prefix)}>
                {expanded ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
                <Folder size={14} aria-hidden="true" />
                <span>{prefix}</span>
                <span className="ref-folder-count">{items.length}</span>
                {!expanded && items.some(({ ref }) => ref.fullName === currentRef) && <span className="ref-tag-current">Current inside</span>}
              </button>
            </td>
          </tr>,
          ...(expanded ? items.map(({ ref, leaf }) => <RefRow key={ref.fullName} gitRef={ref} leaf={leaf} nested context={context} />) : []),
        ];
      })}
      {grouped.loose.map(({ ref, leaf }) => <RefRow key={ref.fullName} gitRef={ref} leaf={leaf} nested={false} context={context} />)}
    </>
  );
}

const sections = [
  { kind: 'local' as const, label: 'Local branches', Icon: GitBranch },
  { kind: 'remote' as const, label: 'Remote-tracking branches', Icon: Cloud },
  { kind: 'tag' as const, label: 'Tags', Icon: Tag },
];

export function RefsView({ refs, worktree, worktrees, search }: { refs: GitRef[]; worktree: Worktree; worktrees: Worktree[]; search: RefObject<HTMLInputElement | null> }) {
  const [query, setQuery] = useState('');
  const filter = query.trim().toLowerCase();
  const visible = refs.filter(({ fullName, targetOid }) => fullName.toLowerCase().includes(filter) || targetOid.startsWith(filter));
  const context: RowContext = { refs, worktrees, current: worktree };
  const counts = sections.map(({ kind }) => refs.filter((ref) => ref.kind === kind && !ref.symbolicTarget).length);
  const expandAll = !!filter;

  return (
    <div className="local-refs">
      <WorktreeSummary worktree={worktree} />
      <div className="refs-toolbar">
        <div className="refs-search">
          <SearchField inputRef={search} label="Search branches and tags" value={query} onChange={setQuery} onEscape={() => { setQuery(''); search.current?.blur(); }} />
        </div>
        <span className="refs-counts">{counts[0]} local · {counts[1]} remote · {counts[2]} tags</span>
      </div>
      {!visible.length ? (
        <Notice title={filter ? 'No matching references' : 'No branches or tags yet'} />
      ) : (
        <table className="worktree-table refs-table">
          <caption className="sr-only">Branches and tags</caption>
          <thead><tr><th scope="col">Name</th><th scope="col">Tracking</th><th scope="col">Worktree</th><th scope="col">Commit</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          {sections.map(({ kind, label, Icon }) => {
            const group = visible.filter((ref) => ref.kind === kind);
            if (!group.length) return null;
            const byRemote = new Map<string, GitRef[]>();
            if (kind === 'remote') {
              for (const ref of group) {
                const [remote] = shortRef(ref.fullName).split('/', 1);
                byRemote.set(remote, [...(byRemote.get(remote) ?? []), ref]);
              }
            }
            return (
              <tbody key={kind}>
                <tr className="refs-group"><th colSpan={5} scope="rowgroup"><Icon size={13} aria-hidden="true" />{label}<span className="ref-folder-count">{group.length}</span></th></tr>
                {kind === 'remote'
                  ? Array.from(byRemote, ([remote, items]) => [
                    <tr key={`remote:${remote}`} className="refs-subgroup"><th colSpan={5} scope="rowgroup">{remote}<span className="ref-folder-count">{items.length}</span></th></tr>,
                    <RefRows key={`${remote}:${expandAll}`} refs={items} strip={`${remote}/`} context={context} expandAll={expandAll} />,
                  ])
                  : <RefRows key={`${kind}:${expandAll}`} refs={group} strip="" context={context} expandAll={expandAll} />}
              </tbody>
            );
          })}
        </table>
      )}
    </div>
  );
}
