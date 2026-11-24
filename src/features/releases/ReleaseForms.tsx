import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { shortRef } from '../../core/graph/refs';
import type { GitRef, Worktree } from '../../services/contracts';
import { stageNames } from '../../services/release';
import type { Candidates, ReleaseActions, ReleaseOverview, ReleaseTask, Targets, TaskFields } from '../../services/release';
import { displayError } from '../../stores/gitdesk';

const suggested = ['origin/test', 'origin/staging', 'origin/master'];

export function TargetForm({ release, repoId, refs, overview, onSave, onClose }: {
  release: ReleaseActions; repoId: string; refs: GitRef[]; overview: ReleaseOverview; onSave: (overview: ReleaseOverview) => void; onClose: () => void;
}) {
  const remotes = refs.filter((ref) => ref.kind === 'remote' && !ref.symbolicTarget);
  const [targets, setTargets] = useState<Targets>(() => overview.targets.map((target, index) =>
    target ?? (overview.targetRevision === 0 ? remotes.find(({ fullName }) => shortRef(fullName) === suggested[index])?.fullName : null) ?? null,
  ) as Targets);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try { onSave(await release.saveTargets(repoId, targets, overview.targetRevision)); }
    catch (failure) { setError(displayError(failure)); }
    finally { setBusy(false); }
  }
  return (
    <form className="release-card release-form" onSubmit={(event) => { void save(event); }}>
      <h2>Configure targets</h2>
      <div className="release-target-form">
        {stageNames.map((stage, index) => (
          <label key={stage}>{stage}
            <select className="control" value={targets[index] ?? ''} onChange={(event) => {
              const next = [...targets] as Targets;
              next[index] = event.target.value || null;
              setTargets(next);
            }}>
              <option value="">Unconfigured</option>
              {targets[index] && !remotes.some(({ fullName }) => fullName === targets[index]) &&
                <option value={targets[index]!}>{shortRef(targets[index]!)} (missing)</option>}
              {remotes.map(({ fullName }) => <option key={fullName} value={fullName}>{shortRef(fullName)}</option>)}
            </select>
          </label>
        ))}
      </div>
      {!remotes.length && <p className="text-muted">No remote-tracking branches in the local repository yet.</p>}
      {error && <p role="alert">{error}</p>}
      <div className="release-buttons">
        <button className="control" type="submit" disabled={busy}>Save targets</button>
        <button className="control" type="button" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

export function TaskForm({ release, repoId, refs, worktree, inputOids, task, onSave, onClose }: {
  release: ReleaseActions;
  repoId: string;
  refs: GitRef[];
  worktree: Worktree;
  inputOids: string[];
  task?: ReleaseTask;
  onSave: (overview: ReleaseOverview) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(task?.fields.title ?? '');
  const [issue, setIssue] = useState(task?.fields.issue ?? '');
  const [source, setSource] = useState(task?.fields.source ?? worktree.branch ?? worktree.path);
  const [commitText, setCommitText] = useState((task?.fields.commitOids ?? inputOids).join('\n'));
  const [base, setBase] = useState(task?.fields.baseOid ?? '');
  const [head, setHead] = useState(task?.fields.headOid ?? worktree.head ?? '');
  const [range, setRange] = useState<Candidates | null>(null);
  const [rangeMode, setRangeMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<TaskFields | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  const oids = [...new Set(commitText.trim().split(/\s+/).filter(Boolean).map((oid) => oid.toLowerCase()))];
  const rangeReady = range?.baseOid === base.trim() && range?.headOid === head.trim();
  const old = task?.fields.commitOids ?? [];
  function toggle(oid: string) {
    setCommitText((oids.includes(oid) ? oids.filter((item) => item !== oid) : [...oids, oid]).join('\n'));
  }

  async function findCandidates() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setError('');
    setBusy(true);
    try {
      const result = await release.candidates(repoId, base.trim(), head.trim(), controller.signal);
      if (!controller.signal.aborted) setRange(result);
    } catch (failure) { if (!controller.signal.aborted) setError(displayError(failure)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }

  async function save(fields: TaskFields) {
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const result = await release.saveTask(repoId, { id: task?.id ?? crypto.randomUUID(), revision: task?.revision ?? null, fields }, controller.signal);
      if (!controller.signal.aborted) onSave(result);
    } catch (failure) { if (!controller.signal.aborted) setError(displayError(failure)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields: TaskFields = {
      title, issue, source, commitOids: oids, archived: task?.fields.archived ?? false,
      baseOid: rangeReady ? range.baseOid : task?.fields.baseOid ?? null,
      headOid: rangeReady ? range.headOid : task?.fields.headOid ?? null,
    };
    if (task && (old.length !== oids.length || old.some((oid) => !oids.includes(oid)))) setConfirm(fields);
    else void save(fields);
  }

  if (confirm) return (
    <section className="release-card release-form">
      <h2>Review updated commit list</h2>
      <p>{old.length} previous · {confirm.commitOids.length} selected</p>
      <div className="release-review">
        <div><strong>Added</strong>{confirm.commitOids.filter((oid) => !old.includes(oid)).map((oid) => <code key={oid}>{oid}</code>)}</div>
        <div><strong>Removed</strong>{old.filter((oid) => !confirm.commitOids.includes(oid)).map((oid) => <code key={oid}>{oid}</code>)}</div>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="release-buttons">
        <button className="control" disabled={busy} onClick={() => { void save(confirm); }}>Save new version</button>
        <button className="control" disabled={busy} onClick={() => setConfirm(null)}>Back</button>
      </div>
    </section>
  );

  return (
    <form className="release-card release-form" onSubmit={submit}>
      <h2>{task ? 'Edit tracked task' : 'Add task'}</h2>
      <div className="release-task-fields">
        <label>Title <input required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>Task ID <input maxLength={80} value={issue} onChange={(event) => setIssue(event.target.value)} /></label>
        <label>Source <input maxLength={1024} value={source} onChange={(event) => setSource(event.target.value)} /></label>
      </div>
      <button className="control release-range-toggle" type="button" aria-expanded={rangeMode} onClick={() => setRangeMode(!rangeMode)}>Choose commits from a branch range</button>
      {rangeMode && (
        <div className="release-range">
          <div className="release-task-fields">
            <label>Base commit <input list="release-refs" spellCheck={false} maxLength={64} value={base} onChange={(event) => setBase(event.target.value)} /></label>
            <label>Head commit <input list="release-refs" spellCheck={false} maxLength={64} value={head} onChange={(event) => setHead(event.target.value)} /></label>
            <datalist id="release-refs">{refs.filter(({ symbolicTarget }) => !symbolicTarget).map((ref) => <option label={shortRef(ref.fullName)} key={ref.fullName} value={ref.targetOid} />)}</datalist>
            <button className="control" type="button" disabled={busy || !base.trim() || !head.trim()} onClick={() => { void findCandidates(); }}>{busy ? 'Reading…' : 'List candidates'}</button>
          </div>
          {rangeReady && (
            <div>
              <p>Review the commits to track. A branch range can include changes brought in by merges.</p>
              {range.truncated && <p>Showing the first 200 candidates. Use a shorter range to review older commits.</p>}
              {range.commits.length ? (
                <div className="release-candidates">
                  {range.commits.map((commit) => (
                    <label key={commit.oid}>
                      <input type="checkbox" checked={oids.includes(commit.oid)} onChange={() => toggle(commit.oid)} />
                      <code title={commit.oid}>{commit.oid.slice(0, 7)}</code>
                      <span className="truncate" title={commit.subject}>{commit.subject}</span>
                      <span className="text-muted truncate" title={commit.authorName}>{commit.authorName}</span>
                    </label>
                  ))}
                </div>
              ) : <p>No non-merge commits in this range.</p>}
            </div>
          )}
        </div>
      )}
      <label>Selected commits · {oids.length}
        <textarea aria-label="Selected commit IDs" value={commitText} onChange={(event) => setCommitText(event.target.value)} rows={Math.min(5, Math.max(2, oids.length))} spellCheck={false} placeholder="Full commit IDs, one per line" />
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="release-buttons">
        <button className="control" type="submit" disabled={busy || !oids.length || oids.length > 200}>Save task</button>
        <button className="control" type="button" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}
