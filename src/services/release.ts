import type { HistoryCommit, Oid } from './contracts';

export const stageNames = ['Test', 'Staging', 'Master'] as const;
export type Targets = [string | null, string | null, string | null];
export interface CommitLink { sourceOid: Oid; targetOid: Oid }
export interface LinkEdit {
  taskId: string;
  revision: number;
  targetRevision: number;
  stage: number;
  sourceOids: Oid[];
  targetOid: Oid;
  expectedTip: Oid | null;
  remove: boolean;
}

export interface TaskFields {
  title: string;
  /** Comma-separated task numbers stored with the tracked record. */
  issue: string;
  source: string;
  commitOids: Oid[];
  baseOid: Oid | null;
  headOid: Oid | null;
  archived: boolean;
  links?: CommitLink[];
}

export function taskIds(value: string): string[] {
  return [...new Set(value.split(/[,，]/).map((id) => id.trim()).filter(Boolean))];
}

export interface ReleaseTask { id: string; revision: number; fields: TaskFields }
export interface ReleaseOverview { targetRevision: number; targets: Targets; tasks: ReleaseTask[] }
export type Inclusion = 'included' | 'notContained' | 'unknown';
export interface Evidence { oid: Oid; status: Inclusion; reason: string | null; matchedOid?: Oid }
export interface StageSnapshot {
  target: string | null;
  tip: Oid | null;
  state: 'ready' | 'unconfigured' | 'missing' | 'unknown';
  observedAt: number;
  reason: string | null;
  evidence: Evidence[];
}
export interface ReleaseEvaluation { targetRevision: number; taskRevision: number | null; stages: StageSnapshot[] }
export interface Observation { taskId: string; taskRevision: number; targetRevision: number; stage: number; snapshot: StageSnapshot }
export interface Candidates { commits: HistoryCommit[]; truncated: boolean; baseOid: Oid; headOid: Oid }
export type ReleaseSubject = { kind: 'task'; id: string; revision: number } | { kind: 'commits'; oids: Oid[] };

export interface ReleaseActions {
  overview(repoId: string): Promise<ReleaseOverview>;
  saveTargets(repoId: string, targets: Targets, revision: number, signal?: AbortSignal): Promise<ReleaseOverview>;
  saveTask(repoId: string, edit: { id: string; revision: number | null; fields: TaskFields }, signal?: AbortSignal): Promise<ReleaseOverview>;
  editLinks(repoId: string, edit: LinkEdit, signal?: AbortSignal): Promise<ReleaseOverview>;
  deleteTask(repoId: string, taskId: string, revision: number): Promise<ReleaseOverview>;
  observations(repoId: string, taskId: string): Promise<Observation[]>;
  candidates(repoId: string, baseOid: Oid, headOid: Oid, signal: AbortSignal): Promise<Candidates>;
  evaluate(repoId: string, revision: number, subject: ReleaseSubject, signal: AbortSignal): Promise<ReleaseEvaluation>;
}
