import type { Worktree } from './contracts';

export type OperationAction =
  | { kind: 'create' | 'switch'; name: string }
  | { kind: 'fetch'; remote: string }
  | { kind: 'pull' | 'push' };

export const operationLabels = {
  create: 'Create branch',
  switch: 'Switch branch',
  fetch: 'Fetch',
  pull: 'Pull',
  push: 'Push',
} as const;

export type RepositoryProxy = { mode: 'git' } | { mode: 'direct' } | { mode: 'custom'; url: string };

export const proxyLabels: Record<RepositoryProxy['mode'], string> = {
  git: 'Use Git settings',
  direct: 'Direct (no proxy)',
  custom: 'Custom proxy',
};

export interface OperationInput {
  id: string;
  repoId: string;
  worktreeId: string;
  head: Pick<Worktree, 'branch' | 'head'>;
  action: OperationAction;
}

export interface OperationConfirmation {
  target: string;
  remote: string | null;
  remoteHost: string | null;
  proxyMode?: RepositoryProxy['mode'] | null;
  trackedRef: string | null;
  commit: string | null;
  path: string;
}

export interface OperationOutcome {
  error: { code: string; message: string; exitCode?: number } | null;
  warning: string | null;
  completedAt: number;
}

export interface FetchRecord {
  fetchedAt: number | null;
  specs: { source: string; destination: string | null }[];
  failure: string | null;
}

export type FetchActivity = Record<string, FetchRecord>;

export interface OperationActions {
  remotes(repoId: string, worktreeId: string): Promise<string[]>;
  prepare(input: OperationInput): Promise<OperationConfirmation>;
  execute(id: string): Promise<OperationOutcome>;
  cancel(id: string): Promise<void>;
  fetchActivity(repoId: string): Promise<FetchActivity>;
  getProxy(repoId: string): Promise<RepositoryProxy>;
  saveProxy(repoId: string, proxy: RepositoryProxy): Promise<RepositoryProxy>;
}

function matchRef(pattern: string, ref: string) {
  const wildcard = pattern.indexOf('*');
  if (wildcard < 0) return pattern === ref ? '' : null;
  const prefix = pattern.slice(0, wildcard);
  const suffix = pattern.slice(wildcard + 1);
  if (ref.length < prefix.length + suffix.length || !ref.startsWith(prefix) || !ref.endsWith(suffix)) return null;
  return ref.slice(prefix.length, ref.length - suffix.length);
}

export function fetchCoversRef(record: FetchRecord, ref: string): boolean {
  return record.specs.some(({ source, destination }) => {
    if (!destination) return false;
    const wildcard = matchRef(destination, ref);
    if (wildcard === null) return false;
    const sourceRef = source.replace('*', () => wildcard);
    return !record.specs.some((spec) => spec.destination === null && matchRef(spec.source, sourceRef) !== null);
  });
}
