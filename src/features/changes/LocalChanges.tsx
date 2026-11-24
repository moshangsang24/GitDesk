import { useEffect, useState } from 'react';
import { Notice } from '../../components/ui/Notice';
import type { RepositoryView, Worktree, WorktreeChange } from '../../services/contracts';
import { displayError, useGitDesk } from '../../stores/gitdesk';
import { ChangesView } from './ChangesView';

export function LocalChanges({ worktree, snapshot, query, fileWidth, onResizeFiles }: {
  worktree: Worktree;
  snapshot: RepositoryView;
  query: string;
  fileWidth: number;
  onResizeFiles: (size: number) => void;
}) {
  const repoId = useGitDesk((state) => state.repoId);
  const review = useGitDesk((state) => state.service.review);
  const [result, setResult] = useState<{ changes?: WorktreeChange[]; error?: string; version: number } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!review || worktree.bare) return;
    const controller = new AbortController();
    void review.listChanges(repoId, worktree.id, controller.signal).then(
      (changes) => {
        if (!controller.signal.aborted) setResult((previous) => ({ changes, version: (previous?.version ?? 0) + 1 }));
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setResult((previous) => ({ ...previous, version: previous?.version ?? 0, error: displayError(error) }));
      },
    );
    return () => controller.abort();
  }, [review, repoId, worktree.id, worktree.bare, snapshot, attempt]);

  if (worktree.bare) return <Notice title="Bare repository">This repository has no working files.</Notice>;
  if (!review) return <Notice title="Worktree changes unavailable" />;
  if (!result) return <Notice title="Loading worktree changes…" kind="loading" />;
  if (!result.changes) return <Notice title="Could not read worktree changes" kind="error" onRetry={() => setAttempt(attempt + 1)}>{result.error}</Notice>;
  return (
    <>
      {result.error && <div className="workspace-banner workspace-warning" role="status">
        <span>Showing the last worktree changes. {result.error}</span>
        <button className="control" onClick={() => setAttempt(attempt + 1)}>Retry</button>
      </div>}
      <ChangesView changes={result.changes} revision={result.version} baseOid={worktree.head} query={query} fileWidth={fileWidth} onResizeFiles={onResizeFiles} />
    </>
  );
}
