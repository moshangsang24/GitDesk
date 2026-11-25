import { Settings2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { shortRef } from '../../core/graph/refs';
import type { ComparisonAnswer, ComparisonDirection, ReleaseComparison } from '../../services/comparison';
import type { FetchActivity } from '../../services/operations';
import { stageNames } from '../../services/release';
import { displayError, useGitDesk } from '../../stores/gitdesk';
import { formatObservation, targetFetchStatus } from '../releases/stage';

type Summary = Extract<ComparisonAnswer, { kind: 'summary' }>;
type Page = Extract<ComparisonAnswer, { kind: 'commits' }>;
type Side = { stage: number; direction: ComparisonDirection };

function DifferenceList({ comparison, side, onClose }: { comparison: ReleaseComparison; side: Side; onClose: () => void }) {
  const compare = useGitDesk((state) => state.service.history?.compareRelease);
  const repoId = useGitDesk((state) => state.repoId);
  const worktreeId = useGitDesk((state) => state.worktreeId);
  const locate = useGitDesk((state) => state.locateCommit);
  const [offsets, setOffsets] = useState([0]);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ offset: number; page?: Page; error?: string } | null>(null);
  const offset = offsets[offsets.length - 1];
  const current = result?.offset === offset ? result : null;
  const { stage, direction } = side;

  useEffect(() => {
    if (!compare) return;
    const controller = new AbortController();
    void compare(repoId, worktreeId, comparison, { kind: 'commits', stage, direction, offset }, controller.signal).then(
      (answer) => {
        if (controller.signal.aborted || answer.kind !== 'commits') return;
        setResult({ offset, page: answer });
        if (!offset && answer.commits[0]) void locate(answer.commits[0].oid);
      },
      (error: unknown) => { if (!controller.signal.aborted) setResult({ offset, error: displayError(error) }); },
    );
    return () => controller.abort();
  }, [compare, repoId, worktreeId, comparison, stage, direction, offset, attempt, locate]);

  return <section className="comparison-differences" aria-label="Branch differences">
    <div className="comparison-list-header">
      <strong>{direction === 'current' ? 'Only in this worktree branch' : `Only in ${shortRef(comparison.targets[stage] ?? stageNames[stage])}`}</strong>
      <button className="control" onClick={onClose}>Close differences</button>
    </div>
    {!current && <p role="status">Reading differences…</p>}
    {current?.error && <p role="alert">{current.error} <button className="control" onClick={() => { setResult(null); setAttempt(attempt + 1); }}>Retry</button></p>}
    {current?.page && <>
      <ul className="comparison-commits">
        {current.page.commits.map((commit) => <li key={commit.oid}>
          <button onClick={() => { void locate(commit.oid); }} title={commit.subject}>
            <code>{commit.oid.slice(0, 7)}</code><span className="truncate">{commit.subject || '(No subject)'}</span>
          </button>
        </li>)}
      </ul>
      {!current.page.commits.length && <p>No commits on this side.</p>}
      {current.page.truncated && <p>Showing the first 100,000 differences.</p>}
    </>}
    {(offset > 0 || current?.page?.hasMore) && <div className="release-buttons">
      <button className="control" disabled={!offset} onClick={() => { setResult(null); setOffsets(offsets.slice(0, -1)); }}>Previous differences</button>
      <button className="control" disabled={!current?.page?.hasMore} onClick={() => {
        if (current?.page?.hasMore) { setResult(null); setOffsets([...offsets, offset + current.page.commits.length]); }
      }}>More differences</button>
    </div>}
  </section>;
}

export function ReleaseComparisonBar({ comparison, observedAt, branch, onSettings, onRefresh }: {
  comparison: ReleaseComparison;
  observedAt?: number;
  branch: string | null;
  onSettings: () => void;
  onRefresh: () => void;
}) {
  const compare = useGitDesk((state) => state.service.history?.compareRelease);
  const operations = useGitDesk((state) => state.service.operations);
  const repoId = useGitDesk((state) => state.repoId);
  const worktreeId = useGitDesk((state) => state.worktreeId);
  const latestFetch = useGitDesk((state) => state.operationLog[repoId]?.find(({ input }) => input.action.kind === 'fetch')?.input.id);
  const cancelNavigation = useGitDesk((state) => state.cancelHistoryNavigation);
  const [activity, setActivity] = useState<FetchActivity>({});
  const [fetchError, setFetchError] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  const [side, setSide] = useState<Side | null>(null);
  const hasComparableTarget = !!comparison.head && comparison.tips.some(Boolean);
  const fetchByStage = comparison.targets.map((target) => target ? targetFetchStatus(target, activity) : null);
  const stale = fetchByStage.some((fetch) => fetch?.stale);
  const fetchLabels = new Set(fetchByStage.flatMap((fetch) => fetch ? [fetch.shortText] : []));
  const fetched = stale ? 'Fetch stale' : fetchLabels.size === 1 ? [...fetchLabels][0] : fetchLabels.size ? 'Fetch varies by target' : '';
  const observed = observedAt === undefined ? '' : `Local refs · ${formatObservation(observedAt)}`;
  const fetchDetails = [observed, ...fetchByStage.flatMap((fetch, index) => fetch ? [`${stageNames[index]} · ${fetch.text}`] : [])].filter(Boolean).join('\n');

  function showSide(next: Side | null) {
    cancelNavigation();
    setSide(next);
  }

  useEffect(() => {
    if (!compare || !hasComparableTarget) return;
    const controller = new AbortController();
    void compare(repoId, worktreeId, comparison, { kind: 'summary' }, controller.signal).then(
      (answer) => { if (!controller.signal.aborted && answer.kind === 'summary') setSummary(answer); },
      (failure: unknown) => { if (!controller.signal.aborted) setError(displayError(failure)); },
    );
    return () => controller.abort();
  }, [compare, repoId, worktreeId, comparison, hasComparableTarget]);

  useEffect(() => {
    if (!operations) return;
    let active = true;
    void operations.fetchActivity(repoId).then(
      (records) => { if (active) { setActivity(records); setFetchError(''); } },
      (failure: unknown) => { if (active) setFetchError(displayError(failure)); },
    );
    return () => { active = false; };
  }, [operations, repoId, latestFetch]);

  return <section className="release-comparison" aria-label="Release branch comparison">
    <div className="comparison-strip">
      <div className="comparison-targets">
        {stageNames.map((name, stage) => {
          const target = comparison.targets[stage];
          const count = summary?.stages[stage];
          const fetch = fetchByStage[stage];
          const label = [target && shortRef(target), fetch?.text].filter(Boolean).join(' · ');
          return <div key={name} className="comparison-target" role="group" aria-label={label ? `${name} · ${label}` : name}>
            <strong title={label || undefined}>{name}</strong>
            {count?.state === 'ready' ? <div className="comparison-counts">
              <button className="comparison-count" data-direction="current" disabled={!count.ahead} title="Only on this worktree branch"
                aria-label={`${name}: ${count.ahead} only on my branch`} aria-pressed={side?.stage === stage && side.direction === 'current'} onClick={() => showSide({ stage, direction: 'current' })}>↑{count.ahead}</button>
              <button className="comparison-count" data-direction="target" disabled={!count.behind} title={`Only on ${shortRef(target ?? name)}`}
                aria-label={`${name}: ${count.behind} only on target branch`} aria-pressed={side?.stage === stage && side.direction === 'target'} onClick={() => showSide({ stage, direction: 'target' })}>↓{count.behind}</button>
            </div> : <span className="text-muted" title={count?.state === 'unknown' ? count.reason : undefined}
              aria-label={count?.state === 'unknown' ? `Unknown: ${count.reason}` : undefined}>
              {!target ? 'Unconfigured' : !comparison.tips[stage] ? 'Ref missing' : !comparison.head ? 'No HEAD to compare' : error || count?.state === 'unknown' ? 'Unknown' : 'Comparing…'}
            </span>}
          </div>;
        })}
      </div>
      <div className="comparison-context">
        <span className="comparison-branch truncate" title={branch ?? undefined}>{branch ?? (comparison.head ? `Detached ${comparison.head.slice(0, 7)}` : 'No HEAD commit')}</span>
        {(fetched || observed) && <span className="comparison-observed" data-stale={stale || undefined} title={fetchDetails}>{fetched || 'Local refs'}</span>}
        <button className="icon-button" title="Configure targets" aria-label="Configure targets" onClick={onSettings}><Settings2 size={14} aria-hidden="true" /></button>
      </div>
    </div>
    {error && <p role="alert">{error} <button className="control" onClick={onRefresh}>Refresh History</button></p>}
    {fetchError && <p role="status" className="text-muted">{fetchError}</p>}
    {side && <DifferenceList key={`${side.stage}:${side.direction}`} side={side} comparison={comparison} onClose={() => showSide(null)} />}
  </section>;
}
