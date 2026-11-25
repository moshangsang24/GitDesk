import { describe, expect, it } from 'vitest';
import type { GitRef, Worktree } from '../../services/contracts';
import { checkedOutIn, folderName, trackingFor } from './ref-info';

const oid = (char: string) => char.repeat(40);
const ref = (fullName: string, target: string, kind: GitRef['kind'] = fullName.startsWith('refs/heads/') ? 'local' : fullName.startsWith('refs/tags/') ? 'tag' : 'remote'): GitRef =>
  ({ fullName, kind, targetOid: oid(target), symbolicTarget: null });
const tree = (branch: string | null, status: Partial<Worktree['status']> = {}): Worktree => ({
  id: branch ?? 'detached', path: `/work/${branch ?? 'detached'}`, branch, head: oid('a'),
  status: { kind: 'clean', changes: 0, ahead: null, behind: null, ...status },
});

const refs = [
  ref('refs/heads/main', 'a'), ref('refs/remotes/origin/main', 'a'),
  ref('refs/heads/feat/x', 'b'), ref('refs/remotes/origin/feat/x', 'c'),
  ref('refs/heads/solo', 'd'), ref('refs/remotes/origin/gone', 'e'),
  ref('refs/remotes/upstream/feat/x', 'b'), ref('refs/tags/v1', 'a'),
];

describe('trackingFor', () => {
  it('uses the real upstream counts for the checked-out branch', () => {
    const current = tree('main', { upstream: 'origin/main', ahead: 2, behind: 5 });
    expect(trackingFor(refs[0], refs, current)).toEqual({ kind: 'upstream', upstream: 'origin/main', ahead: 2, behind: 5 });
  });

  it('compares other local branches with the same-named origin branch', () => {
    expect(trackingFor(refs[0], refs, tree('solo'))).toEqual({ kind: 'same', remote: 'origin/main' });
    expect(trackingFor(refs[2], refs, undefined)).toEqual({ kind: 'differs', remote: 'origin/feat/x' });
    expect(trackingFor(refs[4], refs, undefined)).toEqual({ kind: 'local-only' });
  });

  it('does not match a remote branch whose name only ends the same way', () => {
    const tricky = [ref('refs/heads/x', 'a'), ref('refs/remotes/origin/feat/x', 'a')];
    expect(trackingFor(tricky[0], tricky, undefined)).toEqual({ kind: 'local-only' });
  });

  it('reports whether a remote branch has a local counterpart', () => {
    expect(trackingFor(refs[1], refs, undefined)).toEqual({ kind: 'has-local', local: 'main' });
    expect(trackingFor(refs[5], refs, undefined)).toEqual({ kind: 'no-local' });
    expect(trackingFor(refs[7], refs, undefined)).toEqual({ kind: 'none' });
  });
});

describe('checkedOutIn', () => {
  it('lists worktrees that have the branch checked out', () => {
    const trees = [tree('main'), tree('feat/x'), tree(null)];
    expect(checkedOutIn(refs[2], trees).map(({ id }) => id)).toEqual(['feat/x']);
    expect(checkedOutIn(refs[1], trees)).toEqual([]);
  });

  it('names a worktree by its folder', () => {
    expect(folderName('/Users/me/work/app-hotfix/')).toBe('app-hotfix');
  });
});
