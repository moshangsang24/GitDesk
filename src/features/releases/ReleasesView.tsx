import { useEffect, useMemo, useState } from 'react';
import { Notice } from '../../components/ui/Notice';
import { shortRef } from '../../core/graph/refs';
import type { GitRef, Worktree } from '../../services/contracts';
import { stageNames } from '../../services/release';
import { fetchCoversRef, type FetchActivity } from '../../services/operations';
import type { ReleaseActions, Observation, ReleaseEvaluation, ReleaseOverview, ReleaseTask, StageSnapshot } from '../../services/release';
import { displayError, useGitDesk } from '../../stores/gitdesk';
import { TargetForm, TaskForm } from './ReleaseForms';
import { evidenceLabels, formatObservation, summarizeStage } from './stage';

const tasksPerPage = 12;

function EvidenceDetails({ snapshot }: { snapshot: StageSnapshot }) {
  const reveal = useGitDesk((state) => state.revealCommit);
  return (
    <>
      <p className="release-proof-meta">
        <span>{snapshot.target ? shortRef(snapshot.target) : 'Unconfigured'}</span>
        {snapshot.tip && <code title={snapshot.tip}>Tip {snapshot.tip.slice(0, 10)}</code>}
        <span>Observed {formatObservation(snapshot.observedAt)}</span>
      </p>
      {snapshot.reason && <p>{snapshot.reason}</p>}
      {snapshot.state === 'missing' && <p>The saved target ref is missing from the local repository.</p>}
      <ul className="release-evidence-list">
        {snapshot.evidence.map((entry) => (
          <li key={entry.oid}>
            <button className="release-link" title={entry.oid} onClick={() => { void reveal(entry.oid); }}>
              <code>{entry.oid.slice(0, 12)}</code>
              <span>View commit</span>
            </button>
            <span>{evidenceLabels[entry.status]}{entry.reason ? ` · ${entry.reason}` : ''}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function TaskEvidence({ release, repoId, task, stage, snapshot }: {
  release: ReleaseActions; repoId: string; task: ReleaseTask; stage: number; snapshot?: StageSnapshot;
}) {
  const [observed, setObserved] = useState<Observation[] | null>(null);
  const [issue, setIssue] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  useEffect(() => {
    if (!showHistory) return;
    let active = true;
    void release.observations(repoId, task.id).then(
      (entries) => { if (active) { setObserved(entries); setIssue(''); } },
      (error: unknown) => { if (active) setIssue(displayError(error)); },
    );
    return () => { active = false; };
  }, [release, repoId, task.id, snapshot, showHistory]);

  return (
    <section className="release-card release-detail" aria-label="Release evidence">
      <h2>{task.fields.title} · {stageNames[stage]} · v{task.revision}</h2>
      {snapshot ? <EvidenceDetails snapshot={snapshot} /> : <p>Calculating evidence…</p>}
      <button className="control" aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)}>Historical observations</button>
      {showHistory && (
        <div className="release-observations">
          {issue && <p role="alert">{issue}</p>}
          {observed === null && !issue && <p>Reading local observations…</p>}
          {observed?.length === 0 && <p>No saved observations yet.</p>}
          {!!observed?.length && <p className="text-muted">Shows recent local observations. Each stage retains up to 50 per task.</p>}
          {observed?.map((entry, index) => (
            <details key={`${entry.taskRevision}-${entry.targetRevision}-${entry.stage}-${entry.snapshot.observedAt}-${index}`}>
              <summary>
                {stageNames[entry.stage]} · {entry.snapshot.target ? shortRef(entry.snapshot.target) : 'Unconfigured'} ·
                {formatObservation(entry.snapshot.observedAt)} · task v{entry.taskRevision} / targets v{entry.targetRevision}
              </summary>
              <EvidenceDetails snapshot={entry.snapshot} />
            </details>
          ))}
        </div>
      )}
    </section>
  );
}

function StageCell({ snapshot, total, onClick, error, stale }: { snapshot?: StageSnapshot; total: number; onClick: () => void; error?: string; stale: boolean }) {
  const stage = summarizeStage(snapshot, total);
  return (
    <button className="release-stage-cell" data-tone={stage.tone} onClick={onClick} title={snapshot?.target ?? error}>
      <strong>{snapshot?.state === 'ready' ? `${stage.included}/${total}` : '—'}</strong>
      <span>{error ? 'Read failed' : stage.label}{stage.unknown && stage.included ? ` · ${stage.unknown} unknown` : ''}{stale && (snapshot?.state === 'ready' ? ' · Stale' : ' · Unverified')}</span>
    </button>
  );
}

type Filter = 'all' | 'archived' | 'test' | 'staging' | 'prod' | 'unknown';
const stageFilters: Filter[] = ['test', 'staging', 'prod'];

export function ReleasesView({ repoId, refs, shallowStamp, worktree, draft, onClearDraft }: {
  repoId: string; refs: GitRef[]; shallowStamp?: string | null; worktree: Worktree; draft: string[] | null; onClearDraft: () => void;
}) {
  const release = useGitDesk((state) => state.service.release);
  const operations = useGitDesk((state) => state.service.operations);
  const fetchVersion = useGitDesk((state) => state.operationLog[repoId]?.find((entry) => entry.input.action.kind === 'fetch')?.input.id);
  const successfulFetch = useGitDesk((state) => state.operationLog[repoId]?.find((entry) => entry.input.action.kind === 'fetch' && !entry.error)?.input.id);
  const [fetchActivity, setFetchActivity] = useState<FetchActivity>({});
  const [fetchActivityError, setFetchActivityError] = useState('');
  const [overview, setOverview] = useState<ReleaseOverview | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [panel, setPanel] = useState<'targets' | 'task' | null>(draft ? 'task' : null);
  const [edit, setEdit] = useState<ReleaseTask | undefined>();
  const [focus, setFocus] = useState<{ taskId: string; stage: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [run, setRun] = useState(0);
  const [page, setPage] = useState(0);
  const refsKey = useMemo(() => refs.filter((ref) => ref.kind === 'remote').map((ref) => `${ref.fullName}=${ref.targetOid}`).join('\n'), [refs]);
  const calculation = useMemo(() => ({ overview, run, shallowStamp, refsKey, successfulFetch }), [overview, run, shallowStamp, refsKey, successfulFetch]);
  const [results, setResults] = useState<{ key: object; tasks: Record<string, ReleaseEvaluation>; errors: Record<string, string> } | null>(null);
  const current = results?.key === calculation ? results : null;
  const tasks = overview?.tasks;
  const displayedTasks = useMemo(() => {
    const text = query.trim().toLowerCase();
    return (tasks ?? []).filter(({ fields }) => fields.archived === (filter === 'archived')
      && [fields.title, fields.issue, fields.source].some((value) => value.toLowerCase().includes(text)));
  }, [filter, query, tasks]);

  useEffect(() => {
    let active = true;
    void operations?.fetchActivity(repoId).then(
      (data) => { if (active) { setFetchActivity(data); setFetchActivityError(''); } },
      (failure: unknown) => { if (active) setFetchActivityError(displayError(failure)); },
    );
    return () => { active = false; };
  }, [operations, repoId, run, fetchVersion]);

  useEffect(() => {
    let active = true;
    if (!release) return;
    void release.overview(repoId).then(
      (data) => { if (active) { setOverview(data); setError(''); } },
      (failure: unknown) => { if (active) setError(displayError(failure)); },
    );
    return () => { active = false; };
  }, [release, repoId, run]);

  useEffect(() => {
    if (!calculation.overview || !release) return;
    const evaluateRelease = release.evaluate;
    const { targetRevision } = calculation.overview;
    const controller = new AbortController();
    async function evaluate() {
      const tasks: Record<string, ReleaseEvaluation> = {};
      const errors: Record<string, string> = {};
      for (const task of displayedTasks) {
        if (controller.signal.aborted) break;
        try {
          const result = await evaluateRelease(repoId, targetRevision, { kind: 'task', id: task.id, revision: task.revision }, controller.signal);
          if (result.targetRevision === targetRevision && result.taskRevision === task.revision) tasks[task.id] = result;
        } catch (failure) {
          if (!controller.signal.aborted) errors[task.id] = displayError(failure);
        }
        if (!controller.signal.aborted) setResults({ key: calculation, tasks: { ...tasks }, errors: { ...errors } });
      }
    }
    void evaluate();
    return () => controller.abort();
  }, [release, calculation, displayedTasks, repoId]);

  function closeForm() { setPanel(null); setEdit(undefined); onClearDraft(); }
  function saved(next: ReleaseOverview) {
    setOverview(next);
    setError('');
    closeForm();
  }

  async function updateTask(task: ReleaseTask, remove: boolean) {
    if (!release) return;
    setBusy(true);
    setError('');
    try {
      const next = remove ? await release.deleteTask(repoId, task.id, task.revision)
        : await release.saveTask(repoId, { id: task.id, revision: task.revision, fields: { ...task.fields, archived: !task.fields.archived } });
      setOverview(next);
      setConfirmDelete('');
      if (remove) setFocus(null);
    } catch (failure) { setError(displayError(failure)); }
    finally { setBusy(false); }
  }

  if (!release) return <Notice title="Releases unavailable" />;
  if (!overview) return <Notice title={error ? 'Could not open Releases' : 'Loading Releases…'} kind={error ? 'error' : 'loading'} onRetry={error ? () => setRun(run + 1) : undefined}>{error}</Notice>;

  const filtered = displayedTasks.filter((task) => {
    const result = current?.tasks[task.id];
    if (filter === 'all' || filter === 'archived') return true;
    if (!result) return Boolean(current?.errors[task.id] && filter === 'unknown');
    if (filter === 'unknown') return result.stages.some((snapshot) => summarizeStage(snapshot, task.fields.commitOids.length).unknown > 0);
    const index = stageFilters.indexOf(filter);
    const snapshot = result.stages[index];
    return snapshot?.state === 'ready' && snapshot.evidence.some(({ status }) => status === 'notContained');
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / tasksPerPage));
  const currentPage = Math.min(page, totalPages - 1);
  const rows = filtered.slice(currentPage * tasksPerPage, (currentPage + 1) * tasksPerPage);
  const selected = tasks?.find(({ id }) => id === focus?.taskId);
  const stageFetch = overview.targets.map((target) => {
    if (!target) return null;
    const matches = Object.keys(fetchActivity).filter((name) => target.startsWith(`refs/remotes/${name}/`));
    const remote = matches.sort((a, b) => b.length - a.length)[0];
    if (!remote) return { text: 'GitDesk Fetch unrecorded', stale: false, recorded: false };
    const record = fetchActivity[remote];
    const lastSuccess = record.fetchedAt ? `Last GitDesk Fetch ${formatObservation(record.fetchedAt)}` : 'No successful GitDesk Fetch';
    const mapped = record.fetchedAt && fetchCoversRef(record, target);
    return {
      text: `${lastSuccess}${record.fetchedAt && !mapped ? ' · Target outside last Fetch mappings' : ''}${record.failure ? ` · Latest Fetch failed or stopped: ${record.failure}` : ''}`,
      stale: !!record.failure,
      recorded: !!record.fetchedAt,
    };
  });
  const fetchNotes = new Map<string, string[]>();
  stageFetch.forEach((state, index) => {
    if (state) fetchNotes.set(state.text, [...(fetchNotes.get(state.text) ?? []), stageNames[index]]);
  });
  const observed = Math.max(0, ...Object.values(current?.tasks ?? {}).flatMap(({ stages }) => stages.filter((item) => item.target).map(({ observedAt }) => observedAt)));

  return (
    <div className="releases-view">
      <header className="release-toolbar">
        <div className="release-targets">
          {stageNames.map((stage, index) => <span key={stage}><strong>{stage}</strong><span className="truncate" title={overview.targets[index] ?? undefined}>{overview.targets[index] ? shortRef(overview.targets[index]!) : 'Unconfigured'}</span></span>)}
        </div>
        <button className="control" onClick={() => { setPanel('targets'); setEdit(undefined); onClearDraft(); }}>Configure targets</button>
        <button className="control" onClick={() => setRun(run + 1)}>Refresh local refs</button>
      </header>
      <p className="release-freshness">Local ref snapshot{observed ? ` · observed ${formatObservation(observed)}` : ''}</p>
      {fetchNotes.size > 0 && <ul className="release-fetch-status">
        {Array.from(fetchNotes, ([message, stages]) => <li key={message}><strong>{stages.join(', ')}</strong> · {message}</li>)}
      </ul>}
      {stageFetch.some((state) => state?.recorded) &&
        <p className="release-fetch-status">Deleted remote branches can remain in the local snapshot.</p>}
      {fetchActivityError && <p className="release-error" role="status">{fetchActivityError}</p>}
      {error && <p className="release-error" role="alert">{error}</p>}
      {panel === 'targets' && <TargetForm release={release} key={overview.targetRevision} repoId={repoId} refs={refs} overview={overview} onSave={saved} onClose={closeForm} />}
      {panel === 'task' && <TaskForm release={release} key={`${worktree.id}:${edit?.id ?? 'new'}`} repoId={repoId} refs={refs} worktree={worktree} inputOids={draft ?? []} task={edit} onSave={saved} onClose={closeForm} />}
      <div className="release-list-controls">
        <button className="control" onClick={() => { setPanel('task'); setEdit(undefined); }}>Add task</button>
        <input type="search" aria-label="Search tasks" placeholder="Search tasks…" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} />
        <select aria-label="Filter release tasks" className="control" value={filter} onChange={(event) => { setFilter(event.target.value as Filter); setPage(0); }}>
          <option value="all">Active tasks</option>
          <option value="test">Test incomplete</option>
          <option value="staging">Staging incomplete</option>
          <option value="prod">Prod incomplete</option>
          <option value="unknown">Unknown evidence</option>
          <option value="archived">Archived</option>
        </select>
      </div>
      {!rows.length ? <Notice title={tasks?.length ? 'No matching tasks yet' : 'No tracked tasks'}>{tasks?.length ? undefined : 'Choose commits from History or from a branch range.'}</Notice> : (
        <div className="release-table-wrap">
          <table className="worktree-table release-table">
            <thead><tr><th scope="col">Task</th><th scope="col">Commits</th>{stageNames.map((name) => <th scope="col" key={name}>{name}</th>)}<th scope="col">Actions</th></tr></thead>
            <tbody>
              {rows.map((task) => (
                <tr key={task.id} data-viewing={selected?.id === task.id || undefined}>
                  <td><strong>{task.fields.issue ? `${task.fields.issue} · ` : ''}{task.fields.title}</strong><small className="truncate" title={task.fields.source}>{task.fields.source}</small></td>
                  <td>{task.fields.commitOids.length}</td>
                  {stageNames.map((stage, index) => <td key={stage}><StageCell snapshot={current?.tasks[task.id]?.stages[index]} total={task.fields.commitOids.length} stale={!!stageFetch[index]?.stale} error={current?.errors[task.id]} onClick={() => setFocus({ taskId: task.id, stage: index })} /></td>)}
                  <td><div className="release-buttons">
                    <button className="control" aria-label={`Edit ${task.fields.title}`} onClick={() => { setPanel('task'); setEdit(task); }}>Edit</button>
                    <button className="control" aria-label={`${task.fields.archived ? 'Restore' : 'Archive'} ${task.fields.title}`} disabled={busy} onClick={() => { void updateTask(task, false); }}>{task.fields.archived ? 'Restore' : 'Archive'}</button>
                    <button className="control" aria-label={`Delete ${task.fields.title}`} disabled={busy} onClick={() => setConfirmDelete(task.id)}>Delete…</button>
                  </div>
                  {confirmDelete === task.id && <div className="release-confirm"><span>Delete local task and observations?</span><button className="control" disabled={busy} onClick={() => { void updateTask(task, true); }}>Confirm delete</button><button className="control" onClick={() => setConfirmDelete('')}>Cancel</button></div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {totalPages > 1 && <div className="release-buttons release-pagination">
        <button className="control" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Previous</button>
        <span>Page {currentPage + 1} of {totalPages}</span>
        <button className="control" disabled={currentPage + 1 === totalPages} onClick={() => setPage(currentPage + 1)}>Next</button>
      </div>}
      {selected && focus && (
        <>
          {current?.errors[selected.id] && <p className="release-error" role="alert">{current.errors[selected.id]}</p>}
          <TaskEvidence release={release} key={selected.id} repoId={repoId} task={selected} stage={focus.stage} snapshot={current?.tasks[selected.id]?.stages[focus.stage]} />
        </>
      )}
    </div>
  );
}
