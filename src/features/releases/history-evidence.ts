import { useEffect, useMemo, useState } from 'react';
import type { ReleaseEvaluation } from '../../services/release';
import { displayError, useGitDesk } from '../../stores/gitdesk';

export function useHistoryEvidence(enabled: boolean, oids: string[], repoId: string) {
  const release = useGitDesk((state) => state.service.release);
  const refs = useGitDesk((state) => state.view.phase === 'ready' ? state.view.data.refs : undefined);
  const shallow = useGitDesk((state) => state.view.phase === 'ready' ? state.view.data.shallowStamp : null);
  const tips = useMemo(() => refs?.filter((ref) => ref.kind === 'remote').map(({ fullName, targetOid }) => `${fullName}=${targetOid}`).join('\n') ?? '', [refs]);
  const key = oids.join(' ');
  const request = useMemo(() => ({ repoId, key, tips, shallow, enabled }), [repoId, key, tips, shallow, enabled]);
  const [result, setResult] = useState<{ request: object; value?: ReleaseEvaluation; error?: string } | null>(null);

  useEffect(() => {
    if (!release || !request.key || !request.enabled) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const profile = await release.overview(request.repoId);
        if (controller.signal.aborted) return;
        const value = await release.evaluate(request.repoId, profile.targetRevision, { kind: 'commits', oids: request.key.split(' ') }, controller.signal);
        if (!controller.signal.aborted && value.targetRevision === profile.targetRevision) setResult({ request, value });
      } catch (failure) {
        if (!controller.signal.aborted) setResult({ request, error: displayError(failure) });
      }
    }, 150);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [release, request]);

  return result?.request === request ? result : null;
}
