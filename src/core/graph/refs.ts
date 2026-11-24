import type { GitRef, Oid, RefLabel } from '../../services/contracts';

export function shortRef(name: string): string {
  return name.replace(/^refs\/(heads|remotes|tags)\//, '');
}

const prefixes = { local: 'refs/heads/', remote: 'refs/remotes/', tag: 'refs/tags/' };

export function longRef(kind: GitRef['kind'], name: string): string {
  return `${prefixes[kind]}${name}`;
}

export function labelsByOid(refs: GitRef[], head: Oid | null): Map<Oid, RefLabel[]> {
  const labels = new Map<Oid, RefLabel[]>();
  if (head) labels.set(head, [{ kind: 'head', name: 'HEAD' }]);
  for (const kind of ['local', 'remote', 'tag'] as const) {
    for (const ref of refs) {
      if (ref.kind !== kind || ref.symbolicTarget) continue;
      const label = { kind, name: shortRef(ref.fullName) };
      const existing = labels.get(ref.targetOid);
      if (existing) existing.push(label);
      else labels.set(ref.targetOid, [label]);
    }
  }
  return labels;
}
