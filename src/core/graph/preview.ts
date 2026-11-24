import type { GraphRow, LanePlacement } from './types';

interface PreviewCommit {
  oid: string;
  parents: string[];
}

// Convert authored lanes into rows for the M1 fixtures.
export function materializePreviewRows(
  commits: PreviewCommit[],
  placements: ReadonlyMap<string, LanePlacement>,
): GraphRow[] {
  const pending = new Map<string, LanePlacement>();
  return commits.map((commit) => {
    const placement = placements.get(commit.oid);
    if (!placement) throw new Error('Missing mock commit placement');

    const incoming = pending.delete(commit.oid);
    const through = Array.from(pending.values());
    const parentEdges = commit.parents.map((parentOid) => {
      const destination = placements.get(parentOid);
      if (!destination) throw new Error('Missing mock parent placement');
      pending.set(parentOid, destination);
      return { parentOid, destination };
    });

    let nodeKind: GraphRow['nodeKind'] = 'normal';
    if (commit.parents.length === 0) nodeKind = 'root';
    if (commit.parents.length > 1) nodeKind = 'merge';

    return { oid: commit.oid, ...placement, nodeKind, incoming, through, parentEdges };
  });
}

export function commitsReachableFrom<T extends PreviewCommit>(commits: T[], roots: Iterable<string>): T[] {
  const reachable = new Set(roots);
  // Mock fixtures are already in child-before-parent order.
  return commits.filter(({ oid, parents }) => {
    if (!reachable.has(oid)) return false;
    for (const parent of parents) reachable.add(parent);
    return true;
  });
}
