import { ArrowDown, ArrowDownToLine, ArrowUp, ChevronDown, FolderOpen, GitBranch, History, X } from 'lucide-react';
import { useState } from 'react';
import { OperationDialog, worktreeBlock, type OperationPanel } from '../../features/operations/OperationDialog';
import { operationLabels } from '../../services/operations';
import type { GitRef, Repository, Worktree } from '../../services/contracts';
import { useGitDesk } from '../../stores/gitdesk';

export function RepositoryToolbar({ repo, worktree, refs }: { repo: Repository; worktree: Worktree; refs: GitRef[] }) {
  const local = useGitDesk((state) => state.local);
  const operations = useGitDesk((state) => state.service.operations);
  const openLocation = useGitDesk((state) => state.openLocation);
  const pending = useGitDesk((state) => state.pendingOperations[repo.id]);
  const last = useGitDesk((state) => state.operationLog[repo.id]?.[0]);
  const [dismissed, setDismissed] = useState('');
  const [cancelRequested, setCancelRequested] = useState('');
  const [panel, setPanel] = useState<OperationPanel | null>(null);
  const disabled = !operations ? 'Git operations require a local repository.' : pending ? 'A Git operation is running.' : worktree.prunable ? 'The worktree is unavailable.' : undefined;
  const syncDisabled = disabled ?? worktreeBlock(worktree) ?? (!worktree.branch ? 'Switch to a local branch first.' : undefined);
  const branch = worktree.status.branchNameUnavailable ? 'Branch name unavailable' : worktree.branch ?? (worktree.bare ? 'Bare' : worktree.head ? `Detached ${worktree.head.slice(0, 7)}`
    : worktree.status.kind === 'unknown' ? 'Unknown branch' : 'Unborn HEAD');

  return (
    <>
    <header className="repository-toolbar">
      <div className="repo-toolbar-heading">
        <h1 className="truncate" title={repo.name}>{repo.name}</h1>
        <button className="branch-chip" disabled={!!disabled} aria-label={`Local branches · ${branch}`} title={disabled ?? `Local branches · ${branch}`} onClick={() => setPanel('branches')}>
          <GitBranch size={12} aria-hidden="true" />
          <span className="truncate">{branch}</span>
          <ChevronDown size={11} aria-hidden="true" />
        </button>
        <span className="toolbar-path truncate" title={worktree.path}>{worktree.path}</span>
      </div>
      <div className="repo-toolbar-actions">
        <div className="repo-git-actions" role="group" aria-label="Git synchronization">
          <button className="control fetch-action" disabled={!!disabled} title={disabled ?? 'Fetch a remote'} onClick={() => setPanel('fetch')}><ArrowDownToLine size={13} /> Fetch</button>
          <button className="control" disabled={!!syncDisabled} title={syncDisabled ?? 'Pull fast-forward only'} onClick={() => setPanel('pull')}><ArrowDown size={13} /> Pull</button>
          <button className="control" disabled={!!syncDisabled} title={syncDisabled ?? 'Push to the upstream branch'} onClick={() => setPanel('push')}><ArrowUp size={13} /> Push</button>
        </div>
        {operations && <button className="icon-button" aria-label="Git operation log" title="Git operation log" onClick={() => setPanel('log')}><History size={14} /></button>}
        <button className="control stash-action" disabled aria-label="Stash (planned)" title="Stash is planned for a later release">Stash <small>Planned</small></button>
        {local && !worktree.prunable ? (
          <details className="ref-visibility">
            <summary className="icon-button open-folder" aria-label="Open worktree" title="Open worktree"><FolderOpen size={15} aria-hidden="true" /></summary>
            <div className="ref-visibility-menu open-location-menu">
              <button className="control" onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); void openLocation('finder'); }}>Open in Finder</button>
              <button className="control" onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); void openLocation('terminal'); }}>Open in Terminal</button>
            </div>
          </details>
        ) : <button className="icon-button open-folder" disabled aria-label="Open worktree unavailable" title="A local worktree is required">
          <FolderOpen size={15} aria-hidden="true" />
        </button>}
      </div>
    </header>
    {(pending || (last && dismissed !== last.input.id)) && (
      <div className={`workspace-banner operation-banner${!pending && (last?.error || last?.warning) ? ' workspace-warning' : ''}`} role="status">
        {pending ? <>
          <span>{operationLabels[pending.action.kind]} in progress…</span>
          {pending.action.kind === 'fetch' && <button className="control" disabled={cancelRequested === pending.id} onClick={() => {
            setCancelRequested(pending.id);
            void operations?.cancel(pending.id).catch(() => setCancelRequested(''));
          }}>{cancelRequested === pending.id ? 'Cancelling…' : 'Cancel Fetch'}</button>}
        </> : last && <>
          <span>{operationLabels[last.input.action.kind]} · {last.target} · {last.error ?? 'Completed'}{last.warning ? ` · ${last.warning}` : ''}</span>
          <button className="icon-button" aria-label="Dismiss Git operation result" onClick={() => setDismissed(last.input.id)}><X size={14} /></button>
        </>}
      </div>
    )}
    {panel && operations && <OperationDialog operations={operations} panel={panel} repo={repo} worktree={worktree} refs={refs} onClose={() => setPanel(null)} />}
    </>
  );
}
