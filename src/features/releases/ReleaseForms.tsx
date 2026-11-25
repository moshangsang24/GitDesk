import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { shortRef } from '../../core/graph/refs';
import type { GitRef, Worktree } from '../../services/contracts';
import { stageNames, taskIds } from '../../services/release';
import type { Candidates, ReleaseActions, ReleaseOverview, ReleaseTask, Targets, TaskFields } from '../../services/release';
import { displayError } from '../../stores/gitdesk';
import { defaultTaskBase, taskFieldsFromSource, taskSourceTip } from './task-draft';

const suggested = ['origin/test', 'origin/staging', 'origin/master'];

export function TargetForm({ release, repoId, refs, overview, onSave }: {
  release: ReleaseActions; repoId: string; refs: GitRef[]; overview: ReleaseOverview; onSave: (overview: ReleaseOverview) => void;
}) {
  const remotes = refs.filter((ref) => ref.kind === 'remote' && !ref.symbolicTarget);
  const [targets, setTargets] = useState<Targets>(() => overview.targets.map((target, index) =>
    target ?? (overview.targetRevision === 0 ? remotes.find(({ fullName }) => shortRef(fullName) === suggested[index])?.fullName : null) ?? null,
  ) as Targets);
  const [query, setQuery] = useState('');
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
    <form className="release-form" onSubmit={(event) => { void save(event); }}>
      <label>Find a target branch <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
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
              {remotes.filter(({ fullName }) => fullName === targets[index] || shortRef(fullName).toLowerCase().includes(query.trim().toLowerCase()))
                .map(({ fullName }) => <option key={fullName} value={fullName}>{shortRef(fullName)}</option>)}
            </select>
          </label>
        ))}
      </div>
      {!remotes.length && <p className="text-muted">No remote-tracking branches in the local repository yet.</p>}
      {error && <p role="alert">{error}</p>}
      <div className="release-buttons">
        <button className="control" type="submit" disabled={busy}>Save targets</button>
      </div>
    </form>
  );
}

function parseCommitIds(text: string) {
  return [...new Set(text.trim().split(/\s+/).filter(Boolean).map((oid) => oid.toLowerCase()))];
}

export function TaskForm({ release, repoId, refs, worktree, inputOids, task, masterRef, onSave, onClose }: {
  release: ReleaseActions;
  repoId: string;
  refs: GitRef[];
  worktree: Worktree;
  inputOids: string[];
  task?: ReleaseTask;
  masterRef?: string | null;
  onSave: (overview: ReleaseOverview) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState(task?.fields.source ?? worktree.branch ?? worktree.path);
  const [title, setTitle] = useState(() => task?.fields.title ?? taskFieldsFromSource(source)?.title ?? '');
  const [issue, setIssue] = useState(() => task?.fields.issue ?? taskFieldsFromSource(source)?.issue ?? '');
  const [selection, setSelection] = useState({ text: (task?.fields.commitOids ?? inputOids).join('\n'), quickOids: [] as string[] });
  const [base, setBase] = useState(task?.fields.baseOid ?? '');
  const [head, setHead] = useState(task?.fields.headOid ?? taskSourceTip(source, refs, worktree)?.oid ?? '');
  const [range, setRange] = useState<Candidates | null>(null);
  const [rangeMode, setRangeMode] = useState(false);
  const [quickRange, setQuickRange] = useState<{ baseName: string; headName: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<TaskFields | null>(null);
  const request = useRef<AbortController | null>(null);
  const titleEdited = useRef(false);
  const issueEdited = useRef(false);
  const sourceList = useId();
  useEffect(() => () => request.current?.abort(), []);

  const baseline = task ? undefined : defaultTaskBase(refs, masterRef);
  const sourceTip = taskSourceTip(source, refs, worktree);
  const oids = parseCommitIds(selection.text);
  const rangeReady = range?.baseOid === base.trim().toLowerCase() && range?.headOid === head.trim().toLowerCase();
  const candidates = rangeReady ? range.commits : [];
  const candidateIds = new Set(candidates.map(({ oid }) => oid));
  const selectedCount = oids.filter((oid) => candidateIds.has(oid)).length;
  const allSelected = selectedCount === candidates.length;
  const canSelectAll = oids.length + candidates.length - selectedCount <= 200;
  const old = task?.fields.commitOids ?? [];

  function clearQuickSelection() {
    setSelection((value) => value.quickOids.length ? {
      text: parseCommitIds(value.text).filter((oid) => !value.quickOids.includes(oid)).join('\n'),
      quickOids: [],
    } : value);
  }

  function changeSource(value: string) {
    setSource(value);
    if (task) return;
    const nextTip = taskSourceTip(value, refs, worktree);
    if (nextTip?.name !== sourceTip?.name || nextTip?.oid !== sourceTip?.oid) {
      clearQuickSelection();
      if (quickRange) {
        setQuickRange(null);
        setRange(null);
        setError('');
      }
      if (!rangeMode || quickRange) setHead(nextTip?.oid ?? '');
    }
    const suggested = taskFieldsFromSource(value);
    if (!titleEdited.current) setTitle(suggested?.title ?? '');
    if (!issueEdited.current) setIssue(suggested?.issue ?? '');
  }

  function toggle(oid: string) {
    const checked = oids.includes(oid);
    const quickOids = checked ? selection.quickOids.filter((item) => item !== oid)
      : quickRange ? [...selection.quickOids, oid] : selection.quickOids;
    setSelection({ text: (checked ? oids.filter((item) => item !== oid) : [...oids, oid]).join('\n'), quickOids });
  }

  function toggleAllCandidates() {
    const outside = oids.filter((oid) => !candidateIds.has(oid));
    const retainedQuick = selection.quickOids.filter((oid) => !candidateIds.has(oid));
    if (allSelected) {
      setSelection({ text: outside.join('\n'), quickOids: retainedQuick });
    } else if (canSelectAll) {
      const added = candidates.filter(({ oid }) => !oids.includes(oid)).map(({ oid }) => oid);
      setSelection({ text: [...oids, ...added].join('\n'), quickOids: quickRange ? [...selection.quickOids, ...added] : selection.quickOids });
    }
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
      if (!result.truncated) {
        const quickOids = result.commits.map(({ oid }) => oid);
        setSelection((value) => parseCommitIds(value.text).length ? value : { text: quickOids.join('\n'), quickOids: quick ? quickOids : [] });
      }
    } catch (failure) { if (!controller.signal.aborted) setError(displayError(failure)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }

  function reviewBranch() {
    if (!baseline || !sourceTip) return;
    if (base !== baseline.targetOid || head !== sourceTip.oid) clearQuickSelection();
    setRangeMode(false);
    setBase(baseline.targetOid);
    setHead(sourceTip.oid);
    void findCandidates(baseline.targetOid, sourceTip.oid, {
      baseName: shortRef(baseline.fullName), headName: sourceTip.name,
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
      title, issue: taskIds(issue).join(', '), source, commitOids: oids, archived: task?.fields.archived ?? false,
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
    <form className="release-card release-form release-task-form" onSubmit={submit}>
      <h2>{task ? 'Edit tracked task' : 'Add task'}</h2>
      <div className="release-task-fields">
        <label>Title <input required maxLength={120} placeholder="Task title" value={title} onChange={(event) => { titleEdited.current = true; setTitle(event.target.value); }} /></label>
        <label>Task IDs <input maxLength={120} spellCheck={false} placeholder="e.g. 3848, 3745" title="Separate task IDs with commas" value={issue}
          onChange={(event) => { issueEdited.current = true; setIssue(event.target.value); }} /></label>
        <label>Source <input maxLength={1024} list={sourceList} spellCheck={false} disabled={busy} value={source} onChange={(event) => changeSource(event.target.value)} /></label>
        <datalist id={sourceList}>{refs.filter(({ kind, symbolicTarget }) => kind !== 'tag' && !symbolicTarget).map(({ fullName }) => <option key={fullName} value={shortRef(fullName)} />)}</datalist>
      </div>
      <div className="release-buttons">
        {baseline && <button className="control" type="button" disabled={busy || !sourceTip} onClick={reviewBranch}>
          Review commits vs {shortRef(baseline.fullName)}
        </button>}
        <button className="control" type="button" disabled={busy} aria-expanded={rangeMode} onClick={() => setRangeMode(!rangeMode)}>Choose commits from a branch range</button>
      </div>
      {!task && masterRef && !baseline && <p role="status">Configured Master ref {shortRef(masterRef)} is missing locally.</p>}
      {baseline && !sourceTip && <p role="status">Choose a Source branch available locally or use a custom range.</p>}
      {quickRange && (busy || rangeReady) && <p role="status" className="release-compare-summary">
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
        <section className="release-commit-panel" aria-label="Candidate commits">
          {candidates.length ? (
            <>
              <header className="release-commit-heading">
                <h3>Commits to track</h3>
                <span>{selectedCount} / {candidates.length} selected</span>
              </header>
              <div className="release-candidate-toolbar">
                <label>
                  <input type="checkbox" checked={allSelected}
                    ref={(checkbox) => { if (checkbox) checkbox.indeterminate = selectedCount > 0 && !allSelected; }}
                    disabled={busy || (!allSelected && !canSelectAll)}
                    title={canSelectAll ? undefined : 'A task can track up to 200 commits'}
                    onChange={toggleAllCandidates} />
                  {range.truncated ? 'Select all shown' : 'Select all'}
                </label>
                <span>Author</span>
              </div>
              <div className="release-candidates" aria-label="Commits in range">
                {candidates.map((commit) => (
                  <label key={commit.oid} className={oids.includes(commit.oid) ? 'release-candidate-selected' : undefined}>
                    <input type="checkbox" checked={oids.includes(commit.oid)} disabled={!oids.includes(commit.oid) && oids.length >= 200} onChange={() => toggle(commit.oid)} />
                    <code title={commit.oid}>{commit.oid.slice(0, 7)}</code>
                    <span className="truncate" title={commit.subject}>{commit.subject}</span>
                    <span className="text-muted truncate" title={commit.authorName}>{commit.authorName}</span>
                  </label>
                ))}
              </div>
              {range.truncated && <p className="release-candidate-warning">Showing the first 200 commits. Select the ones you want to track.</p>}
            </>
          ) : <p className="release-candidate-warning">No non-merge commits in this range.</p>}
        </section>
      )}
      <details className="release-commit-ids">
        <summary>Edit commit IDs</summary>
        <textarea aria-label="Selected commit IDs" value={selection.text} onChange={(event) => {
          const text = event.target.value;
          setSelection((value) => ({ ...value, text }));
        }} rows={Math.min(5, Math.max(2, oids.length))} spellCheck={false} placeholder="Full commit IDs, one per line" />
      </details>
      {error && <p role="alert">{error}</p>}
      <div className="release-buttons release-task-footer">
        <span>{oids.length} {oids.length === 1 ? 'commit' : 'commits'} selected</span>
        <button className="control" type="button" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="control release-save-task" type="submit" disabled={busy || !title.trim() || !oids.length || oids.length > 200}>Save task</button>
      </div>
    </form>
  );
}
