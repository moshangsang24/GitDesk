import { CircleAlert, Ellipsis, Plus, RefreshCw, Settings2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Notice } from '../../components/ui/Notice';
import { SearchField } from '../../components/ui/SearchField';
import { shortRef } from '../../core/graph/refs';
import { requestConfirmation, separator, showContextMenu } from '../../services/context-menu';
import type { GitRef, Worktree } from '../../services/contracts';
import { stageNames, taskIds } from '../../services/release';
import type { FetchActivity } from '../../services/operations';
import type { ReleaseActions, Observation, ReleaseEvaluation, ReleaseOverview, ReleaseTask, StageSnapshot } from '../../services/release';
import { displayError, useGitDesk } from '../../stores/gitdesk';
import { CommitLinksForm } from './CommitLinksForm';
import { TaskForm } from './ReleaseForms';
import { evidenceLabels, formatObservation, summarizeStage, targetFetchStatus } from './stage';

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
      {(['notContained', 'unknown', 'included'] as const).map((status) => {
        const entries = snapshot.evidence.filter((entry) => entry.status === status);
        return entries.length > 0 && <div key={status}>
          <h3>{status === 'notContained' ? 'Missing original commits' : status === 'unknown' ? 'Needs review' : 'Included'} · {entries.length}</h3>
          <ul className="release-evidence-list">{entries.map(({ oid, status, reason, matchedOid }) => (
            <li key={oid}>
              <button className="release-link" title={oid} onClick={() => { void reveal(oid); }}>
                <code>{oid.slice(0, 12)}</code>
                <span>View commit</span>
              </button>
              {matchedOid ? <button className="release-link" title={matchedOid} onClick={() => { void reveal(matchedOid); }}>
                <span>Manual match</span><code>{matchedOid.slice(0, 12)}</code>
              </button> : <span>{evidenceLabels[status]}{reason ? ` · ${reason}` : ''}</span>}
            </li>
          ))}</ul>
        </div>;
      })}
    </>
  );
}

function TaskEvidence({ release, repoId, task, stage, snapshot, targetRevision, onSave }: {
  release: ReleaseActions; repoId: string; task: ReleaseTask; stage: number; snapshot?: StageSnapshot;
  targetRevision: number; onSave: (overview: ReleaseOverview) => void;
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
      <CommitLinksForm key={`${task.revision}:${targetRevision}:${stage}:${snapshot?.tip}`}
        release={release} repoId={repoId} task={task} stage={stage} targetRevision={targetRevision} snapshot={snapshot} onSave={onSave} />
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

function StageCell({ name, snapshot, total, onClick, error, stale, active }: { name: string; snapshot?: StageSnapshot; total: number; onClick: () => void; error?: string; stale: boolean; active: boolean }) {
  const stage = summarizeStage(snapshot, total);
  const missing = stage.label === 'Original commits absent';
  const fraction = snapshot?.state === 'ready' && (stage.included || missing) ? `${stage.included}/${total}` : '—';
  const glyph = error ? '!' : stage.tone === 'included' ? '✓' : stage.tone === 'partial' ? '◐' : missing ? '–' : stage.unknown ? '?' : '';
  const caption = `${error ? 'Read failed' : missing ? 'Originals absent' : stage.label}${stage.linked ? ` · ${stage.linked} manual` : ''}${stage.unknown && stage.included ? ` · ${stage.unknown} unknown` : ''}`;
  const freshness = stale ? (snapshot?.state === 'ready' ? ' · Stale' : ' · Unverified') : '';
  return (
    <button className="release-stage-cell" aria-label={`${name} ${fraction} ${caption}${freshness}`} aria-expanded={active}
      data-tone={stage.tone} onClick={onClick} title={error ?? [snapshot?.target, caption + freshness].filter(Boolean).join(' · ')}>
      <strong className="release-stage-value">{glyph && <span aria-hidden="true">{glyph}</span>}{fraction}</strong>
      <span className="release-stage-caption">{caption}</span>
    </button>
  );
}

type Filter = 'all' | 'archived' | 'unknown' | `missing-${number}` | `review-${number}`;

export function ReleasesView({ repoId, refs, shallowStamp, worktree, draft, onClearDraft, onConfigure }: {
  repoId: string; refs: GitRef[]; shallowStamp?: string | null; worktree: Worktree; draft: string[] | null;
  onClearDraft: () => void; onConfigure: () => void;
}) {
  const release = useGitDesk((state) => state.service.release);
  const targetsSaved = useGitDesk((state) => state.releaseTargetVersions[repoId]);
  const operations = useGitDesk((state) => state.service.operations);
  const fetchVersion = useGitDesk((state) => state.operationLog[repoId]?.find((entry) => entry.input.action.kind === 'fetch')?.input.id);
  const successfulFetch = useGitDesk((state) => state.operationLog[repoId]?.find((entry) => entry.input.action.kind === 'fetch' && !entry.error)?.input.id);
  const [fetchActivity, setFetchActivity] = useState<FetchActivity>({});
  const [fetchActivityError, setFetchActivityError] = useState('');
  const [overview, setOverview] = useState<ReleaseOverview | null>(null);
  const publishOverview = useCallback((next: ReleaseOverview) => {
    setOverview((current) => current && current.targetRevision > next.targetRevision ? current : next);
  }, []);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [panel, setPanel] = useState<'task' | null>(draft ? 'task' : null);
  const [edit, setEdit] = useState<ReleaseTask | undefined>();
  const [focus, setFocus] = useState<{ taskId: string; stage: number } | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [run, setRun] = useState(0);
  const [page, setPage] = useState(0);
  const refsKey = useMemo(() => refs.filter((ref) => ref.kind === 'remote').map((ref) => `${ref.fullName}=${ref.targetOid}`).join('\n'), [refs]);
  const calculation = useMemo(() => ({ overview, run, shallowStamp, refsKey, successfulFetch }), [overview, run, shallowStamp, refsKey, successfulFetch]);
  const [results, setResults] = useState<{ key: object; tasks: Record<string, ReleaseEvaluation>; errors: Record<string, string> } | null>(null);
  const current = results?.key === calculation && (overview?.targetRevision ?? -1) >= (targetsSaved ?? 0) ? results : null;
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
      (data) => { if (active) { publishOverview(data); setError(''); } },
      (failure: unknown) => { if (active) setError(displayError(failure)); },
    );
    return () => { active = false; };
  }, [release, repoId, run, targetsSaved, publishOverview]);

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
    publishOverview(next);
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
      publishOverview(next);
      if (remove) setFocus((current) => current?.taskId === task.id ? null : current);
    } catch (failure) { setError(displayError(failure)); }
    finally { setBusy(false); }
  }

  function openTaskMenu(task: ReleaseTask, button: HTMLButtonElement) {
    button.focus({ preventScroll: true });
    const bounds = button.getBoundingClientRect();
    void showContextMenu([
      { kind: 'action', id: 'edit-task', label: 'Edit', run: () => { setPanel('task'); setEdit(task); } },
      { kind: 'action', id: 'archive-task', label: task.fields.archived ? 'Restore' : 'Archive', run: () => { void updateTask(task, false); } },
      separator,
      { kind: 'action', id: 'delete-task', label: 'Delete…', run: () => {
        void requestConfirmation({ title: 'Delete tracked task?', message: `Delete “${task.fields.title}” and its release observations from GitDesk.`, confirmLabel: 'Delete task' })
          .then((confirmed) => { if (confirmed) return updateTask(task, true); });
      } },
    ], { x: bounds.left, y: bounds.bottom });
  }

  function changeQuery(value: string) { setQuery(value); setPage(0); }

  if (!release) return <Notice title="Releases unavailable" />;
  if (!overview) return <Notice title={error ? 'Could not open Releases' : 'Loading Releases…'} kind={error ? 'error' : 'loading'} onRetry={error ? () => setRun(run + 1) : undefined}>{error}</Notice>;

  const filtered = displayedTasks.filter((task) => {
    const result = current?.tasks[task.id];
    if (filter === 'all' || filter === 'archived') return true;
    if (!result) return Boolean(current?.errors[task.id] && (filter === 'unknown' || filter.startsWith('review-')));
    if (filter === 'unknown') return result.stages.some((snapshot) => summarizeStage(snapshot, task.fields.commitOids.length).unknown > 0);
    const [mode, stage] = filter.split('-');
    const snapshot = result.stages[Number(stage)];
    const missing = snapshot?.state === 'ready' && snapshot.evidence.some(({ status }) => status === 'notContained');
    return missing || (mode === 'review' && summarizeStage(snapshot, task.fields.commitOids.length).unknown > 0);
  });
  const checking = filter !== 'all' && filter !== 'archived'
    && displayedTasks.some(({ id }) => !current?.tasks[id] && !current?.errors[id]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / tasksPerPage));
  const currentPage = Math.min(page, totalPages - 1);
  const rows = filtered.slice(currentPage * tasksPerPage, (currentPage + 1) * tasksPerPage);
  const selected = tasks?.find(({ id }) => id === focus?.taskId);
  const stageFetch = overview.targets.map((target) => target ? targetFetchStatus(target, fetchActivity) : null);
  const fetchNotes = new Map<string, string[]>();
  stageFetch.forEach((state, index) => {
    if (state) fetchNotes.set(state.text, [...(fetchNotes.get(state.text) ?? []), stageNames[index]]);
  });
  const staleStages = stageNames.filter((_, index) => stageFetch[index]?.stale);
  const fetchCaption = staleStages.length ? `Fetch stale · ${staleStages.join(', ')}` : fetchNotes.size === 1
    ? stageFetch.find((status) => status)?.shortText : 'Fetch status by target';
  const observed = Math.max(0, ...Object.values(current?.tasks ?? {}).flatMap(({ stages }) => stages.filter((item) => item.target).map(({ observedAt }) => observedAt)));

  return (
    <div className="releases-view">
      <header className="release-toolbar">
        <div className="release-filters">
          <SearchField inputRef={searchInput} label="Search tasks" value={query} onChange={changeQuery} onEscape={() => changeQuery('')} />
          <select aria-label="Filter release tasks" className="control" value={filter} onChange={(event) => { setFilter(event.target.value as Filter); setPage(0); }}>
            <option value="all">Active tasks</option>
            <optgroup label="Missing originals">{stageNames.map((stage, index) => <option key={stage} value={`missing-${index}`}>{stage} missing originals</option>)}</optgroup>
            <optgroup label="Needs review">{stageNames.map((stage, index) => <option key={stage} value={`review-${index}`}>{stage} needs review</option>)}</optgroup>
            <option value="unknown">Unknown evidence</option>
            <option value="archived">Archived</option>
          </select>
        </div>
        <div className="release-actions">
          <button className="icon-button" aria-label="Configure targets" title="Configure targets" onClick={onConfigure}><Settings2 size={15} aria-hidden="true" /></button>
          <button className="icon-button" aria-label="Refresh local refs" title="Refresh local refs" onClick={() => setRun(run + 1)}><RefreshCw size={14} aria-hidden="true" /></button>
          <button className="control control-primary" onClick={() => { setPanel('task'); setEdit(undefined); }}><Plus size={14} aria-hidden="true" />Add task</button>
        </div>
      </header>
      <div className="release-snapshot">
        <span>Local ref snapshot{observed ? ` · ${formatObservation(observed)}` : ''}</span>
        {fetchNotes.size > 0 && <details className="release-fetch-details" data-stale={staleStages.length > 0 || undefined}>
          <summary>{staleStages.length > 0 && <CircleAlert size={12} aria-hidden="true" />}{fetchCaption}</summary>
          <ul>{Array.from(fetchNotes, ([message, stages]) => <li key={message}><strong>{stages.join(', ')}</strong> · {message}</li>)}</ul>
          {stageFetch.some((state) => state?.recorded) && <p>Deleted remote branches can remain in the local snapshot.</p>}
        </details>}
      </div>
      {fetchActivityError && <p className="release-error" role="status">{fetchActivityError}</p>}
      {error && <p className="release-error" role="alert">{error}</p>}
      {panel === 'task' && <TaskForm release={release} key={`${worktree.id}:${edit?.id ?? 'new'}`} repoId={repoId} refs={refs} worktree={worktree} inputOids={draft ?? []} task={edit} masterRef={overview.targets[2]} onSave={saved} onClose={closeForm} />}
      <div className="release-table-wrap">
        <table className="worktree-table release-table">
          <thead><tr><th scope="col">Task</th><th scope="col">Commits</th>{stageNames.map((name, index) => {
            const ref = overview.targets[index];
            return <th scope="col" key={name}>{name}<small className="release-target-ref truncate" title={ref ?? undefined}>{ref ? shortRef(ref) : 'Unconfigured'}</small></th>;
          })}<th scope="col" aria-label="Actions" /></tr></thead>
          <tbody>
            {rows.map((task) => (
              <tr key={task.id} data-viewing={selected?.id === task.id || undefined}>
                <td>
                  <strong className="release-task-title">{task.fields.title}</strong>
                  <small className="release-task-source truncate" title={task.fields.source}>{task.fields.source}</small>
                  {task.fields.issue && <ul className="release-issues" aria-label="Task IDs">{taskIds(task.fields.issue).map((id) => <li key={id}>{id}</li>)}</ul>}
                </td>
                <td>{task.fields.commitOids.length}</td>
                {stageNames.map((stage, index) => {
                  const active = focus?.taskId === task.id && focus.stage === index;
                  return <td key={stage}><StageCell name={stage} snapshot={current?.tasks[task.id]?.stages[index]}
                    total={task.fields.commitOids.length} stale={!!stageFetch[index]?.stale} error={current?.errors[task.id]}
                    active={active} onClick={() => setFocus(active ? null : { taskId: task.id, stage: index })} /></td>;
                })}
                <td><button className="icon-button release-task-menu" aria-haspopup="menu" aria-label={`Actions for ${task.fields.title}`}
                  title="Task actions" disabled={busy} onClick={(event) => openTaskMenu(task, event.currentTarget)}><Ellipsis size={16} aria-hidden="true" /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && <Notice title={checking ? 'Checking tracked tasks…' : tasks?.length ? 'No matching tasks' : 'No tracked tasks'} kind={checking ? 'loading' : undefined}>{tasks?.length ? undefined : 'Choose commits from History or from a branch range.'}</Notice>}
      {totalPages > 1 && <div className="release-buttons release-pagination">
        <button className="control" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Previous</button>
        <span>Page {currentPage + 1} of {totalPages}</span>
        <button className="control" disabled={currentPage + 1 === totalPages} onClick={() => setPage(currentPage + 1)}>Next</button>
      </div>}
      {selected && focus && (
        <>
          {current?.errors[selected.id] && <p className="release-error" role="alert">{current.errors[selected.id]}</p>}
          <TaskEvidence release={release} key={selected.id} repoId={repoId} task={selected} stage={focus.stage} snapshot={current?.tasks[selected.id]?.stages[focus.stage]} targetRevision={overview.targetRevision} onSave={publishOverview} />
        </>
      )}
    </div>
  );
}
