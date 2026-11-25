import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { GitRef, GitService, Repository, ScanProgress, WorkspaceSelection } from './contracts';
import type { ReleaseActions } from './release';

function progressChannel(handler: (progress: ScanProgress) => void) {
  const channel = new Channel<ScanProgress>();
  channel.onmessage = handler;
  return channel;
}

function reviewRequest<T>(command: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const requestId = crypto.randomUUID();
  const cancel = () => { void invoke('cancel_review', { requestId }).catch(() => undefined); };
  signal?.addEventListener('abort', cancel, { once: true });
  return invoke<T>(command, { ...args, requestId }).finally(() => signal?.removeEventListener('abort', cancel));
}

const releaseService: ReleaseActions = {
  overview: (repoId) => invoke('get_release_overview', { repoId }),
  saveTargets: (repoId, targets, revision, signal) => reviewRequest('save_release_targets', { repoId, targets, revision }, signal),
  saveTask: (repoId, edit, signal) => reviewRequest('save_release_task', { repoId, edit }, signal),
  editLinks: (repoId, edit, signal) => reviewRequest('edit_release_links', { repoId, edit }, signal),
  deleteTask: (repoId, taskId, revision) => invoke('delete_release_task', { repoId, taskId, revision }),
  observations: (repoId, taskId) => invoke('list_release_observations', { repoId, taskId }),
  candidates: (repoId, baseOid, headOid, signal) => reviewRequest('release_candidates', { repoId, baseOid, headOid }, signal),
  evaluate: (repoId, revision, subject, signal) => reviewRequest('evaluate_release', { repoId, revision, subject }, signal),
};

export const tauriGitService: GitService = {
  release: releaseService,
  operations: {
    remotes: (repoId, worktreeId) => invoke('list_operation_remotes', { repoId, worktreeId }),
    prepare: (input) => invoke('prepare_git_operation', { input }),
    execute: (id) => invoke('execute_git_operation', { id }),
    cancel: (id) => invoke('cancel_git_operation', { id }),
    fetchActivity: (repoId) => invoke('get_fetch_activity', { repoId }),
    getProxy: (repoId) => invoke('get_repository_proxy', { repoId }),
    saveProxy: (repoId, proxy) => invoke('save_repository_proxy', { repoId, proxy }),
  },

  getCatalog: () => ({ workspaces: [], repositories: {} }),

  async getRepositoryView(repoId, _worktreeId, _scope, _refName, signal) {
    const snapshot = await reviewRequest<{ repository: Repository; refs: GitRef[]; shallowStamp: string | null }>('get_repository_snapshot', { repoId }, signal);
    return { ...snapshot, commits: [], graphRows: [], changes: [] };
  },

  getCommitDetail(repoId, oid, parentOid, signal) {
    return reviewRequest('get_commit_detail', { repoId, oid, parentOid }, signal);
  },

  review: {
    listChanges: (repoId, worktreeId, signal) => reviewRequest('list_worktree_changes', { repoId, worktreeId }, signal),
    preview: (repoId, worktreeId, source, fileId, signal) => reviewRequest('get_file_preview', { repoId, worktreeId, source, fileId }, signal),
    open: (repoId, worktreeId, destination) => invoke('open_worktree_location', { repoId, worktreeId, destination }),
  },

  history: {
    open: (sessionId, repoId, worktreeId, scope, refName, authorFilter) => invoke('open_history', { sessionId, repoId, worktreeId, scope, refName, authorFilter }),
    listAuthors: (repoId, signal) => reviewRequest('list_commit_authors', { repoId }, signal),
    compareRelease: (repoId, worktreeId, expected, query, signal) => reviewRequest('compare_release_branches', { repoId, worktreeId, expected, query }, signal),
    loadPage: (sessionId, sequence) => invoke('load_history_page', { sessionId, sequence }),
    close: (sessionId) => invoke('close_history', { sessionId }),
  },

  workspace: {
    load: () => invoke('load_workspace'),
    addWorkspace: (requestId, handler) => invoke('add_workspace', { requestId, progress: progressChannel(handler) }),
    addRepository: (workspaceId, requestId) => invoke('add_repository', { workspaceId, requestId }),
    rescan: (workspaceId, requestId, handler) => invoke('rescan_workspace', { workspaceId, requestId, progress: progressChannel(handler) }),
    cancelScan: (requestId) => invoke('cancel_scan', { requestId }),
    removeWorkspace: (workspaceId) => invoke('remove_workspace', { workspaceId }),
    removeRepository: (workspaceId, repoId) => invoke('remove_repository', { workspaceId, repoId }),
    saveSelection: (selection) => invoke('save_workspace_selection', { selection }),
    watch: (repoId, worktreeId) => invoke('watch_workspace_worktree', { repoId, worktreeId }),
    onInvalidation: (handler) => listen<Pick<WorkspaceSelection, 'repoId' | 'worktreeId'>>('repository-invalidated', ({ payload }) => handler(payload)),
  },
};
