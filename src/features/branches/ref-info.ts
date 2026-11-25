import { shortRef } from '../../core/graph/refs';
import type { GitRef, Worktree } from '../../services/contracts';

export type Tracking =
  | { kind: 'upstream'; upstream: string; ahead: number | null; behind: number | null }
  | { kind: 'same'; remote: string }
  | { kind: 'differs'; remote: string }
  | { kind: 'local-only' }
  | { kind: 'has-local'; local: string }
  | { kind: 'no-local' }
  | { kind: 'none' };

/**
 * Tracking information that can be derived without extra Git calls.
 * The checked-out branch uses the real upstream and ahead/behind counts from
 * `git status`; other local branches are compared with a remote-tracking
 * branch of the same name (same commit or not, without counts).
 */
export function trackingFor(ref: GitRef, refs: readonly GitRef[], current: Worktree | undefined): Tracking {
  const name = shortRef(ref.fullName);
  if (ref.kind === 'local') {
    if (current?.branch === name && current.status.upstream) {
      return { kind: 'upstream', upstream: current.status.upstream, ahead: current.status.ahead, behind: current.status.behind };
    }
    const remotes = refs.filter((other) => other.kind === 'remote' && !other.symbolicTarget && shortRef(other.fullName).endsWith(`/${name}`)
      && shortRef(other.fullName).indexOf('/') === shortRef(other.fullName).length - name.length - 1);
    const match = remotes.find((other) => shortRef(other.fullName).startsWith('origin/')) ?? remotes[0];
    if (!match) return { kind: 'local-only' };
    const remote = shortRef(match.fullName);
    return match.targetOid === ref.targetOid ? { kind: 'same', remote } : { kind: 'differs', remote };
  }
  if (ref.kind === 'remote') {
    if (ref.symbolicTarget) return { kind: 'none' };
    const remoteName = shortRef(ref.fullName);
    const branch = remoteName.slice(remoteName.indexOf('/') + 1);
    return refs.some((other) => other.kind === 'local' && shortRef(other.fullName) === branch)
      ? { kind: 'has-local', local: branch } : { kind: 'no-local' };
  }
  return { kind: 'none' };
}

/** Worktrees that have this local branch checked out. */
export function checkedOutIn(ref: GitRef, worktrees: readonly Worktree[]): Worktree[] {
  if (ref.kind !== 'local') return [];
  const name = shortRef(ref.fullName);
  return worktrees.filter(({ branch }) => branch === name);
}

export function folderName(path: string) {
  return path.replace(/\/+$/u, '').split('/').at(-1) || path;
}
