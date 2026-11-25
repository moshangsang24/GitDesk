import type { HistoryCommit, Oid } from './contracts';
import type { Targets } from './release';

export interface ReleaseComparison {
  head: Oid | null;
  targetRevision: number;
  targets: Targets;
  tips: Targets;
  shallowStamp: string | null;
}

export type ComparisonDirection = 'current' | 'target';

export type ComparisonQuery =
  | { kind: 'summary' }
  | { kind: 'commits'; stage: number; direction: ComparisonDirection; offset: number };

export type BranchCount = { state: 'ready'; ahead: number; behind: number } | { state: 'unknown'; reason: string };
export type ComparisonAnswer =
  | { kind: 'summary'; stages: Array<BranchCount | null> }
  | { kind: 'commits'; commits: HistoryCommit[]; hasMore: boolean; truncated: boolean };
