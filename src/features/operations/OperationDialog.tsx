import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { shortRef } from '../../core/graph/refs';
import type { GitRef, Repository, Worktree } from '../../services/contracts';
import { operationLabels, type OperationAction, type OperationConfirmation, type OperationInput, type OperationActions } from '../../services/operations';
import { displayError, useGitDesk } from '../../stores/gitdesk';

export type OperationPanel = 'branches' | 'fetch' | 'pull' | 'push' | 'log';

export function worktreeBlock(worktree: Worktree): string | undefined {
  if (worktree.prunable || worktree.status.kind === 'unknown') return 'The worktree is unavailable.';
  if (worktree.bare) return 'A worktree with working files is required.';
  if (worktree.status.kind === 'conflict') return 'Resolve worktree conflicts first.';
  if (worktree.status.operation && worktree.status.operation !== 'none') return 'Finish the current Git operation first.';
  if (worktree.status.branchNameUnavailable) return 'GitDesk cannot safely operate on this branch name.';
  if (worktree.status.filterLimited) return worktree.status.detail ?? 'Worktree status is limited by disabled Git clean filters.';
  if (worktree.status.kind === 'dirty') return 'A clean worktree is required.';
  if (!worktree.head) return 'This worktree needs an initial commit.';
}

export function OperationDialog({ operations, panel, repo, worktree, refs, onClose }: {
  operations: OperationActions; panel: OperationPanel; repo: Repository; worktree: Worktree; refs: GitRef[]; onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pendingPreview = useRef<string | null>(null);
  const runOperation = useGitDesk((state) => state.runOperation);
  const log = useGitDesk((state) => state.operationLog[repo.id]);
  const [remotes, setRemotes] = useState<string[] | null>(null);
  const [remote, setRemote] = useState('');
  const [mode, setMode] = useState<'switch' | 'create'>('switch');
  const [branch, setBranch] = useState('');
  const [query, setQuery] = useState('');
  const [confirmation, setConfirmation] = useState<{ input: OperationInput; data: OperationConfirmation } | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    return () => {
      if (pendingPreview.current) {
        void operations.cancel(pendingPreview.current).catch(() => undefined);
        pendingPreview.current = null;
      }
    };
  }, [operations]);

  useEffect(() => {
    if (panel !== 'fetch') return;
    let active = true;
    void operations.remotes(repo.id, worktree.id).then((names) => {
      if (!active) return;
      setRemotes(names);
      const defaults = names.filter((name) => worktree.status.upstream?.startsWith(`${name}/`));
      setRemote(defaults.sort((a, b) => b.length - a.length)[0] ?? (names.includes('origin') ? 'origin' : names[0] ?? ''));
    }, (failure: unknown) => { if (active) setError(displayError(failure)); });
    return () => { active = false; };
  }, [operations, panel, repo.id, worktree.id, worktree.status.upstream]);

  const candidates = refs.filter((ref) => ref.kind === 'local' && !ref.symbolicTarget);
  const activeBranch = candidates.find((ref) => shortRef(ref.fullName) === branch);
  const matches = candidates.filter((ref) => shortRef(ref.fullName).toLowerCase().includes(query.trim().toLowerCase()));
  const label = panel === 'branches' ? 'Local branches' : panel === 'log' ? 'Git operations' : operationLabels[panel];
  const action: OperationAction | null = panel === 'fetch' ? (remote ? { kind: 'fetch', remote } : null)
    : panel === 'pull' || panel === 'push' ? { kind: panel }
      : panel === 'branches' && branch && (mode === 'create' || (activeBranch && branch !== worktree.branch))
        ? { kind: mode, name: branch } : null;
  const block = panel === 'fetch' ? undefined : worktreeBlock(worktree);

  async function review(next: OperationAction) {
    const id = crypto.randomUUID();
    const input = { id, repoId: repo.id, worktreeId: worktree.id, head: { branch: worktree.branch, head: worktree.head }, action: next };
    pendingPreview.current = id;
    setChecking(true);
    setError('');
    try {
      const data = await operations.prepare(input);
      if (pendingPreview.current !== id) {
        void operations.cancel(id).catch(() => undefined);
        return;
      }
      setConfirmation({ input, data });
    } catch (failure) {
      if (pendingPreview.current === id) setError(displayError(failure));
    } finally {
      if (pendingPreview.current === id) setChecking(false);
    }
  }

  function back() {
    if (pendingPreview.current) void operations.cancel(pendingPreview.current).catch(() => undefined);
    pendingPreview.current = null;
    setConfirmation(null);
  }

  return (
    <dialog ref={dialog} className="settings-dialog operation-dialog" aria-labelledby="git-operation-title" onCancel={onClose}>
      <header>
        <h2 id="git-operation-title">{confirmation ? operationLabels[confirmation.input.action.kind] : label}</h2>
        <button type="button" className="icon-button" aria-label="Close Git operations" onClick={onClose}><X size={16} /></button>
      </header>
      {panel === 'log' ? (
        <div className="settings-content release-form">
          {!log?.length ? <p>No Git operations in this session.</p> : (
            <ol className="operation-log">
              {log.map((entry) => <li key={entry.input.id}>
                <strong>{operationLabels[entry.input.action.kind]} · {entry.target}</strong>
                <time dateTime={new Date(entry.completedAt).toISOString()}>{new Date(entry.completedAt).toLocaleTimeString()}</time>
                <p>{entry.error ?? 'Completed'}{entry.warning ? ` · ${entry.warning}` : ''}</p>
              </li>)}
            </ol>
          )}
        </div>
      ) : (
        <form className="settings-content release-form" onSubmit={(event) => {
          event.preventDefault();
          if (confirmation) {
            pendingPreview.current = null;
            void runOperation(confirmation.input, confirmation.data);
            onClose();
          } else if (action && !block && !checking) void review(action);
        }}>
          {confirmation ? (
            <>
              <dl className="operation-summary">
                <dt>Worktree</dt><dd>{confirmation.data.path}</dd>
                <dt>Target</dt><dd>{confirmation.data.remote && confirmation.input.action.kind !== 'fetch' ? `${confirmation.data.remote} · ` : ''}{confirmation.data.trackedRef || confirmation.input.action.kind === 'push' ? shortRef(confirmation.data.target) : confirmation.data.target}</dd>
                {confirmation.data.remoteHost && <><dt>Remote host</dt><dd>{confirmation.data.remoteHost}</dd></>}
                {confirmation.data.trackedRef && <><dt>Tracking ref</dt><dd>{shortRef(confirmation.data.trackedRef)}</dd></>}
                {confirmation.input.head.branch && confirmation.input.action.kind !== 'fetch' && (
                  <><dt>Current branch</dt><dd>{confirmation.input.head.branch}</dd></>
                )}
                {confirmation.data.commit && <><dt>Commit</dt><dd><code>{confirmation.data.commit}</code></dd></>}
              </dl>
              {panel === 'pull' && <p>Fetch the upstream branch and fast-forward this worktree if Git allows it.</p>}
              {panel === 'push' && <p>Send the displayed commit to the upstream branch. Git will enforce the remote’s update rules.</p>}
              {panel === 'fetch' && <p>Update configured remote-tracking branches and refresh release evidence.</p>}
              {confirmation.input.action.kind === 'create' && <p>Create a local branch at this commit and keep the current worktree on its branch.</p>}
              <div className="release-buttons">
                <button type="submit" className="control">Confirm {operationLabels[confirmation.input.action.kind].toLowerCase()}</button>
                <button type="button" className="control" onClick={back}>Back</button>
              </div>
            </>
          ) : (
            <>
              {panel === 'branches' && (
                <>
                  <div className="release-buttons">
                    <button type="button" className="control" aria-pressed={mode === 'switch'} onClick={() => { setMode('switch'); setBranch(''); }}>Switch existing</button>
                    <button type="button" className="control" aria-pressed={mode === 'create'} onClick={() => { setMode('create'); setBranch(''); }}>Create local branch</button>
                  </div>
                  {mode === 'switch' ? (
                    <>
                      <label>Find a local branch<input type="search" placeholder="Branch name" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
                      <label>Local branch
                        <select className="control" value={branch} onChange={(event) => setBranch(event.target.value)}>
                          <option value="">Choose a branch</option>
                          {matches.map((ref) => {
                            const name = shortRef(ref.fullName);
                            const used = repo.worktrees.find((tree) => tree.branch === name && tree.id !== worktree.id);
                            return <option key={ref.fullName} value={name} disabled={name === worktree.branch || !!used}>{name}{used ? ' · Another worktree' : name === worktree.branch ? ' · Current' : ''}</option>;
                          })}
                          {activeBranch && !matches.includes(activeBranch) && <option value={branch}>{branch}</option>}
                        </select>
                      </label>
                    </>
                  ) : <label>New branch name<input required maxLength={240} value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="feature/name" /></label>}
                </>
              )}
              {panel === 'fetch' && (
                <label>Remote
                  <select className="control" value={remote} onChange={(event) => setRemote(event.target.value)} disabled={!remotes?.length}>
                    {!remotes?.length && <option value="">{error ? 'Remotes unavailable' : remotes ? 'No configured remotes' : 'Reading remotes…'}</option>}
                    {remotes?.map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                </label>
              )}
              {(panel === 'pull' || panel === 'push') && <p>{worktree.branch}{worktree.status.upstream ? ` → ${worktree.status.upstream}` : ''}</p>}
              {block && <p role="status">{block}</p>}
              {error && <p className="release-error" role="alert">{error}</p>}
              <div className="release-buttons">
                <button className="control" type="submit" disabled={!action || !!block || checking}>
                  {checking ? 'Checking Git…' : action ? `Review ${operationLabels[action.kind].toLowerCase()}` : 'Review'}
                </button>
                <button className="control" type="button" onClick={onClose}>Cancel</button>
              </div>
            </>
          )}
        </form>
      )}
    </dialog>
  );
}
