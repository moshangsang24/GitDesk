import { describe, expect, it } from 'vitest';
import { HistoryLayout } from './layout';
import type { GraphRow, LanePlacement } from './types';

function commit(oid: string, ...parents: string[]) {
  return { oid, parents };
}

function laneMap(lanes: LanePlacement[]) {
  return new Map(lanes.map(({ lane, colorId }) => [lane, colorId]));
}

function expectConnected(rows: GraphRow[]) {
  let active = new Map<number, number>();
  for (const row of rows) {
    const before = laneMap(row.incoming ? [...row.through, row] : row.through);
    expect(before).toEqual(active);
    active = laneMap([...row.through, ...row.parentEdges.map((edge) => edge.destination)]);
  }
  expect(active.size).toBe(0);
}

describe('HistoryLayout', () => {
  it('reuses one lane for linear history and marks shallow boundaries', () => {
    const layout = new HistoryLayout();
    const rows = layout.append([commit('C', 'B'), commit('B', 'A'), { ...commit('A'), shallowBoundary: true }]);
    expect(rows.map(({ lane, colorId, nodeKind }) => ({ lane, colorId, nodeKind }))).toEqual([
      { lane: 0, colorId: 0, nodeKind: 'normal' },
      { lane: 0, colorId: 0, nodeKind: 'normal' },
      { lane: 0, colorId: 0, nodeKind: 'boundary' },
    ]);
    expectConnected(rows);
  });

  it('keeps both merge parents and joins the branch at the common ancestor', () => {
    const layout = new HistoryLayout();
    const first = layout.append([commit('M', 'B', 'C'), commit('B', 'A')]);
    expect(layout.hasPendingParents).toBe(true);
    const next = layout.append([commit('C', 'A'), commit('A')]);
    expect(first[0].nodeKind).toBe('merge');
    expect(first[0].parentEdges.map(({ parentOid, destination }) => [parentOid, destination.lane])).toEqual([['B', 0], ['C', 1]]);
    expect(next[0].parentEdges[0].destination.lane).toBe(0);
    expect(next[1]).toMatchObject({ nodeKind: 'root', lane: 0, incoming: true });
    expect(layout.hasPendingParents).toBe(false);
    expectConnected([...first, ...next]);
  });

  it('shares pending lanes through octopus and criss-cross merges with independent tips', () => {
    const commits = [
      commit('U', 'V'), commit('M', 'C', 'B', 'F'), commit('N', 'B', 'C'),
      commit('C', 'X', 'Y'), commit('B', 'Y', 'X'), commit('F', 'X'),
      commit('V'), commit('X', 'A'), commit('Y', 'A'), commit('A'),
    ];
    const rows = new HistoryLayout().append(commits);
    expect(rows[1].parentEdges).toHaveLength(3);
    expect(rows[2].parentEdges.map(({ destination }) => destination.lane)).toEqual(
      rows[1].parentEdges.slice(0, 2).reverse().map(({ destination }) => destination.lane),
    );
    expectConnected(rows);
    for (let cut = 0; cut <= commits.length; cut++) {
      const layout = new HistoryLayout();
      expect([...layout.append(commits.slice(0, cut)), ...layout.append(commits.slice(cut))]).toEqual(rows);
    }
  });

  it('reports missing parent rows and rejects duplicate or non-topological records', () => {
    const layout = new HistoryLayout();
    layout.append([commit('A', 'missing')]);
    expect(layout.hasPendingParents).toBe(true);
    expect(() => layout.append([commit('A')])).toThrow('duplicate');
    expect(() => new HistoryLayout().append([commit('A'), commit('B', 'A')])).toThrow('topological');
  });

  it('preserves edge sets and geometry across pages of seeded random DAGs', () => {
    let seed = 417;
    const random = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return Math.floor(seed / 2 ** 32 * n);
    };
    for (let run = 0; run < 35; run++) {
      const commits = Array.from({ length: 55 }, (_, index) => {
        const count = Math.min(random(5), 54 - index);
        const parents = new Set<string>();
        while (parents.size < count) parents.add(String(index + 1 + random(54 - index)));
        return commit(String(index), ...parents);
      });
      const layout = new HistoryLayout();
      const rows: GraphRow[] = [];
      for (let index = 0; index < commits.length;) {
        const end = index + random(6) + 1;
        rows.push(...layout.append(commits.slice(index, end)));
        index = end;
      }
      expect(rows).toEqual(new HistoryLayout().append(commits));
      expect(rows.map(({ parentEdges }) => parentEdges.map(({ parentOid }) => parentOid))).toEqual(commits.map(({ parents }) => parents));
      expectConnected(rows);
    }
  });
});
