export interface LanePlacement {
  lane: number;
  colorId: number;
}

export interface GraphRow extends LanePlacement {
  oid: string;
  nodeKind: 'normal' | 'merge' | 'root' | 'boundary';
  incoming: boolean;
  through: LanePlacement[];
  parentEdges: Array<{ parentOid: string; destination: LanePlacement }>;
}

export const graphPalette = [
  'var(--lane-purple)',
  'var(--lane-amber)',
  'var(--lane-cyan)',
  'var(--lane-blue)',
  'var(--lane-green)',
  'var(--lane-pink)',
  'var(--lane-yellow)',
  'var(--lane-indigo)',
];

export const graphGeometry = { inset: 12, spacing: 14, height: 28, minWidth: 48 };
