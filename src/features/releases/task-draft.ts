import { shortRef } from '../../core/graph/refs';
import type { GitRef, Worktree } from '../../services/contracts';

export function taskFieldsFromSource(source: string) {
  const match = /^([a-z][a-z0-9_-]*)\/(\d{1,80})-([^/\s]+)$/i.exec(source.trim());
  if (!match) return null;
  const [, prefix, issue, name] = match;
  const title = `${prefix}: ${name}`;
  return title.length <= 120 && new TextEncoder().encode(title).length <= 240 ? { issue, title } : null;
}

export function defaultTaskBase(refs: GitRef[], configuredMaster?: string | null) {
  if (configuredMaster) return refs.find(({ fullName, kind, symbolicTarget }) => fullName === configuredMaster && kind === 'remote' && !symbolicTarget);
  const names = ['refs/remotes/origin/master', 'refs/heads/master', 'refs/remotes/origin/main', 'refs/heads/main'];
  for (const name of names) {
    const ref = refs.find(({ fullName, symbolicTarget }) => fullName === name && !symbolicTarget);
    if (ref) return ref;
  }
}

export function taskSourceTip(source: string, refs: GitRef[], worktree: Worktree) {
  const name = source.trim();
  if (!name) return;
  const current = worktree.branch ?? worktree.path;
  if (worktree.head && (name === current || (worktree.branch && name === `refs/heads/${worktree.branch}`))) {
    return { name: worktree.branch ?? worktree.head.slice(0, 7), oid: worktree.head };
  }
  const branches = refs.filter(({ kind, symbolicTarget }) => kind !== 'tag' && !symbolicTarget);
  const ref = branches.find(({ fullName }) => fullName === name)
    ?? branches.find(({ fullName }) => fullName === `refs/heads/${name}`)
    ?? branches.find(({ fullName }) => fullName === `refs/remotes/${name}`);
  if (ref) return { name: shortRef(ref.fullName), oid: ref.targetOid };
}
