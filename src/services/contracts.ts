import type { GraphRow } from '../core/graph/types';
import type { OperationActions } from './operations';
import type { ReleaseActions } from './release';

export type Oid = string;
export type HistoryScope = 'all' | 'current' | 'local' | 'ref' | 'mine';

export interface CommitAuthor {
  name: string;
  email: string;
}

export interface AuthorFilter {
  author: CommitAuthor;
  baseRef: string;
}

export interface RefVisibility {
  local: boolean;
  remote: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  repositoryIds: string[];
  missing?: boolean;
  warning?: string | null;
}

export interface WorktreeStatus {
  kind: 'clean' | 'dirty' | 'conflict' | 'unknown';
  changes: number;
  ahead: number | null;
  behind: number | null;
  staged?: number;
  unstaged?: number;
  untracked?: number;
  conflicts?: number;
  upstream?: string | null;
  operation?: 'none' | 'merge' | 'rebase' | 'cherryPick' | 'other' | 'unknown';
  detail?: string | null;
  filterLimited?: boolean;
  branchNameUnavailable?: boolean;
}

export interface Worktree {
  id: string;
  path: string;
  branch: string | null;
  head: Oid | null;
  external?: boolean;
  locked?: boolean;
  prunable?: boolean;
  bare?: boolean;
  status: WorktreeStatus;
}

export interface Repository {
  id: string;
  name: string;
  worktrees: Worktree[];
  primaryWorktreeId: string;
  bare?: boolean;
}

export interface WorkspaceCatalog {
  workspaces: Workspace[];
  repositories: Record<string, Repository>;
  selection?: WorkspaceSelection | null;
  warning?: string | null;
}

export type RepositoryPage = 'history' | 'changes' | 'worktrees' | 'refs' | 'releases';

export interface WorkspaceSelection {
  repoId: string;
  worktreeId: string;
  page: RepositoryPage;
}

export interface GitRef {
  fullName: string;
  kind: 'local' | 'remote' | 'tag';
  targetOid: Oid;
  symbolicTarget: string | null;
}

export interface ScanProgress {
  directories: number;
  repositories: number;
}

export interface WorkspaceActions {
  load(): Promise<WorkspaceCatalog>;
  addWorkspace(requestId: string, progress: (event: ScanProgress) => void): Promise<WorkspaceCatalog | null>;
  addRepository(workspaceId: string, requestId: string): Promise<WorkspaceCatalog | null>;
  rescan(workspaceId: string, requestId: string, progress: (event: ScanProgress) => void): Promise<WorkspaceCatalog>;
  cancelScan(requestId: string): Promise<void>;
  removeWorkspace(workspaceId: string): Promise<WorkspaceCatalog>;
  removeRepository(workspaceId: string, repoId: string): Promise<WorkspaceCatalog>;
  saveSelection(selection: WorkspaceSelection): Promise<void>;
  watch(repoId: string, worktreeId: string): Promise<void>;
  onInvalidation(listener: (event: Pick<WorkspaceSelection, 'repoId' | 'worktreeId'>) => void): Promise<() => void>;
}

export interface RefLabel {
  name: string;
  kind: 'head' | 'local' | 'remote' | 'tag';
  tone?: 'purple' | 'amber' | 'cyan';
}

export interface Commit {
  oid: Oid;
  parents: Oid[];
  subject: string;
  authorName: string;
  authorTime: number;
  refs: RefLabel[];
}

export type HistoryCommit = Omit<Commit, 'refs'> & { shallowBoundary: boolean };

export interface HistoryPage {
  sequence: number;
  commits: HistoryCommit[];
  hasMore: boolean;
  truncated: boolean;
}

export interface OpenHistory {
  page: HistoryPage;
  head: Oid | null;
  refs: GitRef[];
  shallowStamp: string | null;
  myBranchRefs?: string[];
}

export interface HistoryActions {
  open(sessionId: string, repoId: string, worktreeId: string, scope: HistoryScope, refName: string | null, authorFilter?: AuthorFilter): Promise<OpenHistory>;
  listAuthors?(repoId: string, signal: AbortSignal): Promise<CommitAuthor[]>;
  loadPage(sessionId: string, sequence: number): Promise<HistoryPage>;
  close(sessionId: string): Promise<void>;
}

export type DiffLine =
  | { kind: 'context'; text: string; oldLine: number; newLine: number }
  | { kind: 'add'; text: string; newLine: number }
  | { kind: 'delete'; text: string; oldLine: number };

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export type FileDiff =
  | { kind: 'text'; hunks: DiffHunk[]; truncated?: boolean }
  | { kind: 'binary' | 'empty' | 'large' | 'deferred' }
  | { kind: 'unavailable'; reason: string };

export type FileSource = { kind: 'commit'; oid: Oid; parentOid: Oid | null } | { kind: 'changes'; group: ChangeGroup };

export interface ChangedFile {
  id: string;
  path: string;
  oldPath?: string;
  status: 'A' | 'M' | 'D' | 'R' | 'U';
  diff: FileDiff;
  stats?: { added: number; deleted: number };
}

export type ChangeGroup = 'Staged' | 'Unstaged' | 'Untracked' | 'Conflicts';

export interface WorktreeChange extends ChangedFile {
  group: ChangeGroup;
  revision?: string;
}

export interface RepositoryView {
  commits: Commit[];
  // M1 supplies fixture placements. Production layout belongs in graph core.
  graphRows: GraphRow[];
  changes: WorktreeChange[];
  repository?: Repository;
  refs?: GitRef[];
  shallowStamp?: string | null;
}

export interface CommitDetail {
  message: string;
  files: ChangedFile[];
  committerName?: string;
  committerTime?: number;
  boundary?: boolean;
}

export interface GitService {
  operations?: OperationActions;
  release?: ReleaseActions;
  workspace?: WorkspaceActions;
  history?: HistoryActions;
  getCatalog(): WorkspaceCatalog;
  getRepositoryView(repoId: string, worktreeId: string, scope: HistoryScope, refName?: string | null, signal?: AbortSignal): Promise<RepositoryView>;
  getCommitDetail(repoId: string, oid: Oid, parentOid: Oid | null, signal?: AbortSignal): Promise<CommitDetail>;
  review?: {
    listChanges(repoId: string, worktreeId: string, signal: AbortSignal): Promise<WorktreeChange[]>;
    preview(repoId: string, worktreeId: string, source: FileSource, fileId: string, signal: AbortSignal): Promise<FileDiff>;
    open(repoId: string, worktreeId: string, destination: 'finder' | 'terminal'): Promise<void>;
  };
}
