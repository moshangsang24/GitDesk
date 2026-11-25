import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { shortRef } from '../../core/graph/refs';
import type { GitRef, Worktree } from '../../services/contracts';
import { stageNames } from '../../services/release';
import type { Candidates, ReleaseActions, ReleaseOverview, ReleaseTask, Targets, TaskFields } from '../../services/release';
import { displayError } from '../../stores/gitdesk';
import { defaultTaskBase, taskFieldsFromSource } from './task-draft';

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

function parseCommitIds(text: string) {
  return [...new Set(text.trim().split(/\s+/).filter(Boolean).map((oid) => oid.toLowerCase()))];
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
  const [source, setSource] = useState(task?.fields.source ?? worktree.branch ?? worktree.path);
  const [title, setTitle] = useState(() => task?.fields.title ?? taskFieldsFromSource(source)?.title ?? '');
  const [issue, setIssue] = useState(() => task?.fields.issue ?? taskFieldsFromSource(source)?.issue ?? '');
  const [commitText, setCommitText] = useState((task?.fields.commitOids ?? inputOids).join('\n'));
  const [base, setBase] = useState(task?.fields.baseOid ?? '');
  const [head, setHead] = useState(task?.fields.headOid ?? worktree.head ?? '');
  const [range, setRange] = useState<Candidates | null>(null);
  const [rangeMode, setRangeMode] = useState(false);
  const [quickRange, setQuickRange] = useState<{ baseName: string; headName: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<TaskFields | null>(null);
  const request = useRef<AbortController | null>(null);
  const titleEdited = useRef(false);
  const issueEdited = useRef(false);
  useEffect(() => () => request.current?.abort(), []);

  const baseline = task ? undefined : defaultTaskBase(refs);
  const oids = parseCommitIds(commitText);
  const rangeReady = range?.baseOid === base.trim().toLowerCase() && range?.headOid === head.trim().toLowerCase();
  const old = task?.fields.commitOids ?? [];

  function changeSource(value: string) {
    setSource(value);
    if (task) return;
    const suggested = taskFieldsFromSource(value);
    if (!titleEdited.current) setTitle(suggested?.title ?? '');
    if (!issueEdited.current) setIssue(suggested?.issue ?? '');
  }

  function toggle(oid: string) {
    setCommitText((oids.includes(oid) ? oids.filter((item) => item !== oid) : [...oids, oid]).join('\n'));
  }

  async function findCandidates(baseOid: string, headOid: string, quick?: { baseName: string; headName: string }) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setQuickRange(quick ?? null);
    setRange(null);
    setError('');
    setBusy(true);
    try {
      const result = await release.candidates(repoId, baseOid, headOid, controller.signal);
      if (controller.signal.aborted) return;
      setRange(result);
      if (quick && !result.truncated) {
        setCommitText((text) => parseCommitIds(text).length ? text : result.commits.map(({ oid }) => oid).join('\n'));
      }
    } catch (failure) { if (!controller.signal.aborted) setError(displayError(failure)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }

  function reviewBranch() {
    if (!baseline || !worktree.head) return;
    setRangeMode(false);
    setBase(baseline.targetOid);
    setHead(worktree.head);
    void findCandidates(baseline.targetOid, worktree.head, {
      baseName: shortRef(baseline.fullName), headName: worktree.branch ?? worktree.head.slice(0, 7),
    });
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
    if (busy || !title.trim() || !oids.length || oids.length > 200) return;
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
        <label>Title <input required maxLength={120} value={title} onChange={(event) => { titleEdited.current = true; setTitle(event.target.value); }} /></label>
        <label>Task ID <input maxLength={80} value={issue} onChange={(event) => { issueEdited.current = true; setIssue(event.target.value); }} /></label>
        <label>Source <input maxLength={1024} value={source} onChange={(event) => changeSource(event.target.value)} /></label>
      </div>
      <div className="release-buttons">
        {baseline && worktree.head && <button className="control" type="button" disabled={busy} onClick={reviewBranch}>
          Review commits vs {shortRef(baseline.fullName)}
        </button>}
        <button className="control" type="button" disabled={busy} aria-expanded={rangeMode} onClick={() => setRangeMode(!rangeMode)}>Choose commits from a branch range</button>
      </div>
      {quickRange && (busy || rangeReady) && <p role="status">
        {busy ? 'Reading' : 'Compared'} {quickRange.headName} against {quickRange.baseName}
      </p>}
      {rangeMode && (
        <div className="release-range">
          <div className="release-task-fields">
            <label>Base commit <input list="release-refs" disabled={busy} spellCheck={false} maxLength={64} value={base} onChange={(event) => { setQuickRange(null); setBase(event.target.value); }} /></label>
            <label>Head commit <input list="release-refs" disabled={busy} spellCheck={false} maxLength={64} value={head} onChange={(event) => { setQuickRange(null); setHead(event.target.value); }} /></label>
            <datalist id="release-refs">{refs.filter(({ symbolicTarget }) => !symbolicTarget).map((ref) => <option label={shortRef(ref.fullName)} key={ref.fullName} value={ref.targetOid} />)}</datalist>
            <button className="control" type="button" disabled={busy || !base.trim() || !head.trim()} onClick={() => { void findCandidates(base.trim(), head.trim()); }}>{busy ? 'Reading…' : 'List candidates'}</button>
          </div>
        </div>
      )}
      {rangeReady && (rangeMode || quickRange) && (
        <div className="release-range">
          {range.commits.length ? (
            <>
              <p>Review which commits to track. This range may include commits brought in by merges.</p>
              {range.truncated && <p>Showing the first 200 candidates. Select commits individually or use a shorter range.</p>}
              <div className="release-candidates">
                {range.commits.map((commit) => (
                  <label key={commit.oid}>
                    <input type="checkbox" checked={oids.includes(commit.oid)} disabled={!oids.includes(commit.oid) && oids.length >= 200} onChange={() => toggle(commit.oid)} />
                    <code title={commit.oid}>{commit.oid.slice(0, 7)}</code>
                    <span className="truncate" title={commit.subject}>{commit.subject}</span>
                    <span className="text-muted truncate" title={commit.authorName}>{commit.authorName}</span>
                  </label>
                ))}
              </div>
            </>
          ) : <p>No non-merge commits in this range.</p>}
        </div>
      )}
      <label>Selected commits · {oids.length}
        <textarea aria-label="Selected commit IDs" value={commitText} onChange={(event) => setCommitText(event.target.value)} rows={Math.min(5, Math.max(2, oids.length))} spellCheck={false} placeholder="Full commit IDs, one per line" />
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="release-buttons">
        <button className="control" type="submit" disabled={busy || !title.trim() || !oids.length || oids.length > 200}>Save task</button>
        <button className="control" type="button" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}
