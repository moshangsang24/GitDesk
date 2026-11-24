import type { Inclusion, StageSnapshot } from '../../services/release';

export const evidenceLabels: Record<Inclusion, string> = {
  included: 'Included',
  notContained: 'Original commit absent',
  unknown: 'Unknown',
};

export function summarizeStage(snapshot: StageSnapshot | undefined, total: number) {
  if (!snapshot) return { label: 'Calculating…', tone: 'muted', included: 0, unknown: 0 };
  if (snapshot.state !== 'ready') {
    return {
      label: { missing: 'Ref missing', unconfigured: 'Unconfigured', unknown: 'Unknown' }[snapshot.state],
      tone: 'muted', included: 0, unknown: snapshot.state === 'unconfigured' ? 0 : total,
    };
  }
  const included = snapshot.evidence.filter(({ status }) => status === 'included').length;
  const unknown = snapshot.evidence.filter(({ status }) => status === 'unknown').length;
  if (included === total) return { label: 'Included', tone: 'included', included, unknown };
  if (included > 0) return { label: 'Partial', tone: 'partial', included, unknown };
  return { label: unknown ? 'Unknown' : 'Original commits absent', tone: 'muted', included, unknown };
}

export function formatObservation(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(timestamp);
}
