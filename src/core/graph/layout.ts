import type { GraphRow, LanePlacement } from './types';

interface GraphCommit {
  oid: string;
  parents: string[];
  shallowBoundary?: boolean;
}

interface Lane extends LanePlacement {
  pendingOid: string;
}

const maxLanes = 256;
const maxSegments = 2_000_000;

export class HistoryLayout {
  private readonly slots: Array<Lane | null> = [];
  private readonly pending = new Map<string, Lane>();
  private readonly seen = new Set<string>();
  private nextColor = 0;
  private segmentCount = 0;

  // The owner keeps one layout per history session and discards it on error.
  append(commits: readonly GraphCommit[]): GraphRow[] {
    return commits.map((commit) => this.place(commit));
  }

  get hasPendingParents(): boolean {
    return this.pending.size > 0;
  }

  private freeSlot(start: number): number {
    return this.slots.findIndex((lane, index) => index >= start && lane === null);
  }

  private allocateSlot(preferred: number): number {
    const free = this.freeSlot(preferred);
    if (free !== -1) return free;
    const remaining = this.freeSlot(0);
    if (remaining !== -1) return remaining;
    if (this.slots.length < maxLanes) return this.slots.length;
    throw new Error(`This history exceeds the ${maxLanes}-lane limit. Try a narrower history scope.`);
  }

  private place(commit: GraphCommit): GraphRow {
    if (this.seen.has(commit.oid)) throw new Error('Git returned a duplicate commit. Refresh history.');
    this.seen.add(commit.oid);

    const existing = this.pending.get(commit.oid);
    const lane = existing?.lane ?? this.allocateSlot(0);
    const colorId = existing?.colorId ?? this.nextColor++;
    if (existing) this.pending.delete(commit.oid);
    this.slots[lane] = null;

    const through = this.slots.filter((slot): slot is Lane => slot !== null);
    const parents = [...new Set(commit.parents)];
    const parentEdges = parents.map((parentOid, index) => {
      if (this.seen.has(parentOid)) throw new Error('Git returned commits outside topological order. Refresh history.');
      let destination = this.pending.get(parentOid);
      if (!destination) {
        destination = {
          lane: index === 0 ? lane : this.allocateSlot(lane + 1),
          colorId: index === 0 ? colorId : this.nextColor++,
          pendingOid: parentOid,
        };
        this.slots[destination.lane] = destination;
        this.pending.set(parentOid, destination);
      }
      return { parentOid, destination };
    });

    while (this.slots.length && this.slots.at(-1) === null) this.slots.pop();
    this.segmentCount += through.length + parentEdges.length;
    if (this.segmentCount > maxSegments) throw new Error('This history exceeds the graph memory limit. Try a narrower history scope.');

    let nodeKind: GraphRow['nodeKind'] = 'normal';
    if (!parents.length) nodeKind = commit.shallowBoundary ? 'boundary' : 'root';
    else if (parents.length > 1) nodeKind = 'merge';
    return { oid: commit.oid, lane, colorId, nodeKind, incoming: !!existing, through, parentEdges };
  }
}
