import { useEffect, useMemo, useState } from 'react';
import { Notice } from '../../components/ui/Notice';
import type { ChangedFile, FileDiff, FileSource } from '../../services/contracts';
import { displayError, useGitDesk } from '../../stores/gitdesk';
import { DiffView } from './DiffView';

interface Props {
  file: ChangedFile;
  source: FileSource;
  revision?: string;
}

export function FilePreview({ file, source, revision }: Props) {
  const repoId = useGitDesk((state) => state.repoId);
  const worktreeId = useGitDesk((state) => state.worktreeId);
  const review = useGitDesk((state) => state.service.review);
  const oid = source.kind === 'commit' ? source.oid : null;
  const parentOid = source.kind === 'commit' ? source.parentOid : null;
  const group = source.kind === 'changes' ? source.group : null;
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([repoId, worktreeId, file.id, oid, parentOid, group]);
  const request = useMemo(() => ({ key, revision, attempt }), [key, revision, attempt]);
  const [result, setResult] = useState<{ request: typeof request; diff?: FileDiff; error?: string } | null>(null);

  useEffect(() => {
    if (!review || file.diff.kind !== 'deferred') return;
    const controller = new AbortController();
    const base: FileSource = group !== null ? { kind: 'changes', group } : { kind: 'commit', oid: oid!, parentOid };
    void review.preview(repoId, worktreeId, base, file.id, controller.signal).then(
      (diff) => { if (!controller.signal.aborted) setResult({ request, diff }); },
      (error: unknown) => {
        if (!controller.signal.aborted) setResult((previous) => ({
          request,
          diff: previous?.request.key === request.key ? previous.diff : undefined,
          error: displayError(error),
        }));
      },
    );
    return () => controller.abort();
  }, [review, file.diff.kind, file.id, request, oid, parentOid, group, repoId, worktreeId]);

  if (file.diff.kind !== 'deferred') return <DiffView key={key} file={file} />;
  if (!review) return <Notice title="File preview unavailable" />;
  const current = result?.request.key === key ? result : null;
  const error = current?.request === request ? current.error : undefined;
  const retry = () => setAttempt(attempt + 1);
  if (current?.diff) return (
    <DiffView
      key={key}
      file={{ ...file, diff: current.diff }}
      busy={current.request !== request}
      notice={error && <div className="workspace-banner workspace-warning" role="status">
        <span>Showing the last preview. {error}</span>
        <button className="control" onClick={retry}>Retry</button>
      </div>}
    />
  );
  if (error) return <Notice title="Could not preview file" kind="error" onRetry={retry}>{error}</Notice>;
  return <Notice title="Loading file preview…" kind="loading" />;
}
