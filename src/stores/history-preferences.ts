import type { AuthorFilter, HistoryScope, RefVisibility } from '../services/contracts';

interface HistoryPreferences {
  scope: HistoryScope;
  focusedRef: string | null;
  refVisibility: RefVisibility;
  authorFilter: AuthorFilter | null;
}

const defaults: HistoryPreferences = { scope: 'all', focusedRef: null, refVisibility: { local: true, remote: true }, authorFilter: null };

export function readHistoryPreferences(repoId: string): HistoryPreferences {
  try {
    const saved = JSON.parse(globalThis.localStorage.getItem(`gitdesk.history.${repoId}`) ?? 'null') as Partial<HistoryPreferences> | null;
    if (!saved) return defaults;
    const focusedRef = typeof saved.focusedRef === 'string' ? saved.focusedRef : null;
    const filter = saved.authorFilter;
    const authorFilter = typeof filter?.baseRef === 'string' && !!filter.baseRef && typeof filter.author?.name === 'string'
      && !!filter.author.name && typeof filter.author.email === 'string' ? filter : null;
    const scope = saved.scope === 'current' || saved.scope === 'local' || saved.scope === 'releaseTargets' || (saved.scope === 'ref' && focusedRef)
      || (saved.scope === 'mine' && authorFilter) ? saved.scope : 'all';
    return { scope, focusedRef, authorFilter, refVisibility: { local: saved.refVisibility?.local !== false, remote: saved.refVisibility?.remote !== false } };
  } catch {
    return defaults;
  }
}

export function saveHistoryPreferences(repoId: string, { scope, focusedRef, refVisibility, authorFilter }: HistoryPreferences) {
  try {
    globalThis.localStorage.setItem(`gitdesk.history.${repoId}`, JSON.stringify({ scope, focusedRef, refVisibility, authorFilter }));
  } catch {
    // Preferences can still be used for the current view when storage is unavailable.
  }
}

interface Inspection { oid: string; parentOid: string | null }

export function readInspection(repoId: string, worktreeId: string): Inspection | null {
  try {
    const value = JSON.parse(localStorage.getItem(`gitdesk.inspection.${repoId}.${worktreeId}`) ?? 'null') as Inspection | null;
    const isOid = (candidate: unknown) => typeof candidate === 'string' && /^(?:[\da-f]{40}|[\da-f]{64})$/i.test(candidate);
    return value && isOid(value.oid) && (value.parentOid === null || isOid(value.parentOid)) ? value : null;
  } catch { return null; }
}

export function saveInspection(repoId: string, worktreeId: string, selection: Inspection | null) {
  try {
    const key = `gitdesk.inspection.${repoId}.${worktreeId}`;
    if (selection) localStorage.setItem(key, JSON.stringify(selection));
    else localStorage.removeItem(key);
  } catch { /* The current selection remains available in the window. */ }
}
