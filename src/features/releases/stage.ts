import type { Inclusion, StageSnapshot } from '../../services/release';
import { fetchCoversRef, type FetchActivity } from '../../services/operations';

export const evidenceLabels: Record<Inclusion, string> = {
  included: 'Included',
  notContained: 'Original commit absent',
  unknown: 'Unknown',
};

export function summarizeStage(snapshot: StageSnapshot | undefined, total: number) {
  if (!snapshot) return { label: 'Calculating…', tone: 'muted', included: 0, unknown: 0, linked: 0 };
  if (snapshot.state !== 'ready') {
    return {
      label: { missing: 'Ref missing', unconfigured: 'Unconfigured', unknown: 'Unknown' }[snapshot.state],
      tone: 'muted', included: 0, unknown: snapshot.state === 'unconfigured' ? 0 : total, linked: 0,
    };
  }
  const included = snapshot.evidence.filter(({ status }) => status === 'included').length;
  const unknown = snapshot.evidence.filter(({ status }) => status === 'unknown').length;
  const linked = snapshot.evidence.filter(({ status, matchedOid }) => status === 'included' && matchedOid).length;
  if (included === total) return { label: 'Included', tone: 'included', included, unknown, linked };
  if (included > 0) return { label: 'Partial', tone: 'partial', included, unknown, linked };
  return { label: unknown ? 'Unknown' : 'Original commits absent', tone: 'muted', included, unknown, linked };
}

export function formatObservation(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(timestamp);
}

export function targetFetchStatus(target: string, activity: FetchActivity) {
  const remote = Object.keys(activity).filter((name) => target.startsWith(`refs/remotes/${name}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (!remote) return { text: 'GitDesk Fetch unrecorded', shortText: 'Fetch unrecorded', stale: false, recorded: false };
  const record = activity[remote];
  const time = record.fetchedAt ? formatObservation(record.fetchedAt) : null;
  const covered = time && fetchCoversRef(record, target);
  const text = !time ? 'No successful GitDesk Fetch' : covered
    ? `Last GitDesk Fetch ${time}` : `Target outside last Fetch mappings (${time})`;
  const shortText = !time ? 'Fetch unrecorded' : covered ? `Fetch ${time}` : 'Not covered by last Fetch';
  return { text: `${text}${record.failure ? ` · Latest Fetch failed or stopped: ${record.failure}` : ''}`, shortText, stale: !!record.failure, recorded: !!time };
}
