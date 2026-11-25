import { describe, expect, it, vi } from 'vitest';
import type { CommitDetail, GitService, HistoryPage, OpenHistory, RepositoryView, WorkspaceActions, WorkspaceCatalog } from '../services/contracts';
import { createMockGitService } from '../services/mock';
import { createGitDeskStore } from './gitdesk';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

const mock = createMockGitService({ viewDelay: 0, detailDelay: 0 });

function localService(catalog: WorkspaceCatalog, read: GitService['getRepositoryView']) {
  const workspace: WorkspaceActions = {
    load: async () => catalog,
    addWorkspace: async () => null,
    addRepository: async () => null,
    rescan: async () => catalog,
    removeWorkspace: async () => catalog,
    removeRepository: async () => catalog,
    cancelScan: async () => undefined,
    saveSelection: vi.fn(async () => undefined),
    watch: vi.fn(async () => undefined),
    onInvalidation: async () => () => undefined,
  };
  return {
    ...mock, workspace,
    getCatalog: () => ({ workspaces: [], repositories: {} }),
    getRepositoryView: read,
  };
}

describe('GitDesk selection', () => {
  it('ignores a repository read that finishes after switching repositories', async () => {
    const pending = deferred<RepositoryView>();
    const store = createGitDeskStore({
      ...mock,
      getRepositoryView: (id, treeId, scope) => (
        id === 'conversation-agent' ? pending.promise : mock.getRepositoryView(id, treeId, scope)
      ),
    });

    const initial = store.getState().refresh();
    expect(store.getState().view.phase).toBe('loading');
    await store.getState().openRepository('backend');

    pending.resolve(await mock.getRepositoryView('conversation-agent', 'conversation-agent:primary', 'all'));
    await initial;

    expect(store.getState().repoId).toBe('backend');
    expect(store.getState().detail?.commit.subject).toBe('Handle request timeouts');
  });

  it('clears an old comparison when switching worktrees', async () => {
    const store = createGitDeskStore(mock);
    await store.getState().refresh();
    expect(store.getState().detail?.commit.subject).toBe('Improve agent routing logic');

    store.getState().setPage('worktrees');
    await store.getState().openWorktree('conversation-agent:staging');

    expect(store.getState()).toMatchObject({ page: 'worktrees', worktreeId: 'conversation-agent:staging', detail: null });
    expect(store.getState().view).toMatchObject({ phase: 'ready', data: { changes: [{ path: 'config/staging.toml' }] } });
  });

  it('does not reopen details when an in-flight request finishes after closing the panel', async () => {
    const pending = deferred<CommitDetail>();
    const getCommitDetail = vi.fn().mockImplementationOnce(mock.getCommitDetail).mockReturnValueOnce(pending.promise);
    const store = createGitDeskStore({ ...mock, getCommitDetail });

    await store.getState().refresh();
    const oid = store.getState().selectedCommitOid;
    if (!oid) throw new Error('Missing default selected commit');

    const opening = store.getState().openCommit(oid);
    expect(store.getState().detail?.result.phase).toBe('loading');
    store.getState().closeDetail();
    pending.resolve({ message: 'Late result', files: [] });
    await opening;
    expect(store.getState().detail).toBeNull();
  });
});

describe('native History', () => {
  const repo = mock.getCatalog().repositories['conversation-agent'];
  const head = repo.worktrees[0].head!;
  const target = 'a'.repeat(40);
  const record = (oid: string, parents: string[] = []) => ({ oid, parents, authorName: 'Fixture', authorTime: 0, subject: oid, shallowBoundary: false });
  const first: OpenHistory = {
    head, shallowStamp: null, refs: [
      { fullName: 'refs/heads/main', kind: 'local', targetOid: head, symbolicTarget: null },
      { fullName: 'refs/remotes/origin/main', kind: 'remote', targetOid: head, symbolicTarget: null },
      { fullName: 'refs/tags/old', kind: 'tag', targetOid: target, symbolicTarget: null },
    ],
    page: { sequence: 0, commits: [record(head, [target])], hasMore: true, truncated: false },
  };
  const second: HistoryPage = { sequence: 1, commits: [record(target)], hasMore: false, truncated: false };

  function setup(loadPage: NonNullable<GitService['history']>['loadPage'], readRefs = () => first.refs, onInvalidation?: WorkspaceActions['onInvalidation'], read?: GitService['getRepositoryView']) {
    const workspace = { id: 'test', name: 'Test', rootPath: '/tmp/test-history', repositoryIds: [repo.id] };
    const service = localService({ workspaces: [workspace], repositories: { [repo.id]: repo } }, read ?? (async () => ({
      repository: repo, refs: readRefs(), commits: [], graphRows: [], changes: [], shallowStamp: null,
    })));
    if (onInvalidation) service.workspace.onInvalidation = onInvalidation;
    const open = vi.fn(async () => first);
    const close = vi.fn(async () => undefined);
    return { store: createGitDeskStore({ ...service, history: { open, close, loadPage } }), open, close };
  }

  it('shows a visited repository and its first page immediately, then opens a fresh paging session', async () => {
    const other = mock.getCatalog().repositories.backend;
    const workspace = { id: 'test', name: 'Test', rootPath: '/tmp/test-history', repositoryIds: [repo.id, other.id] };
    const repositories = { [repo.id]: repo, [other.id]: other };
    const returningView = deferred<RepositoryView>();
    const returningHistory = deferred<OpenHistory>();
    const snapshot = (repoId: string) => ({ repository: repositories[repoId], refs: first.refs, commits: [], graphRows: [], changes: [] });
    const newHead = 'e'.repeat(40);
    let returning = false;
    const service = localService({ workspaces: [workspace], repositories }, async (repoId) => {
      return repoId === repo.id && returning ? returningView.promise : snapshot(repoId);
    });
    const open = vi.fn(async (_sessionId: string, repoId: string) => {
      if (repoId === repo.id && returning) return returningHistory.promise;
      return repoId === repo.id ? first : {
        ...first, head: other.worktrees[0].head, page: { ...first.page, commits: [record('f'.repeat(40))], hasMore: false },
      };
    });
    const loadPage = vi.fn(async () => second);
    const close = vi.fn(async () => undefined);
    const store = createGitDeskStore({ ...service, history: { open, close, loadPage } });

    await store.getState().initialize();
    const earlier = store.getState().history;
    if (earlier.phase !== 'ready') throw new Error('Expected initial history');
    await store.getState().loadMoreHistory();
    await store.getState().openRepository(other.id);
    returning = true;
    const switching = store.getState().openRepository(repo.id);
    expect(store.getState()).toMatchObject({
      repoId: repo.id, viewRefreshing: true, view: { phase: 'ready', data: { repository: repo } },
      history: { phase: 'ready', data: { cacheStatus: 'refreshing', commits: [{ oid: head }], hasMore: false } },
    });
    expect(await store.getState().loadMoreHistory()).toBe(false);
    expect(loadPage).toHaveBeenCalledTimes(1);

    returningView.resolve(snapshot(repo.id));
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(3));
    expect(store.getState().history).toMatchObject({
      phase: 'ready', data: { cacheStatus: 'refreshing', tableKey: earlier.data.tableKey },
    });
    returningHistory.resolve({ ...first, head: newHead, page: { ...first.page, commits: [record(newHead)], hasMore: false } });
    await switching;
    const updated = store.getState().history;
    if (updated.phase !== 'ready') throw new Error('Expected revalidated history');
    expect(updated.data.cacheStatus).toBeUndefined();
    expect(updated.data.tableKey).toBe(earlier.data.tableKey);
    expect(updated.data.sessionId).not.toBe(earlier.data.sessionId);
    expect(updated.data.commits.map(({ oid }) => oid)).toEqual([newHead]);
    expect(close).toHaveBeenCalledWith(earlier.data.sessionId);

    await store.getState().openRepository(other.id);
    open.mockRejectedValueOnce(new Error('Git could not open the new history.'));
    await store.getState().openRepository(repo.id);
    expect(store.getState().history).toMatchObject({
      phase: 'ready', data: {
        cacheStatus: 'failed', stale: true, hasMore: false,
        commits: [{ oid: newHead }], pageMessage: expect.stringContaining('Git could not open the new history.'),
      },
    });
  });

  it('locates a reference across a page seam and remembers both display switches', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) });
    try {
      const loadPage = vi.fn(async () => second);
      const { store, open } = setup(loadPage);
      await store.getState().initialize();
      const before = store.getState().history;
      expect(before).toMatchObject({ phase: 'ready', data: { commits: [{ refs: [{ kind: 'head' }, { kind: 'local' }, { kind: 'remote' }] }] } });
      store.getState().toggleRefVisibility('local');
      store.getState().toggleRefVisibility('remote');
      expect(store.getState().history).toBe(before);
      expect(open).toHaveBeenCalledTimes(1);
      await store.getState().locateCommit(target);
      expect(loadPage).toHaveBeenCalledExactlyOnceWith(expect.any(String), 1);
      const after = store.getState().history;
      expect(after).toMatchObject({ phase: 'ready', data: { graphRows: [{ lane: 0 }, { lane: 0, incoming: true }], hasMore: false } });
      expect(store.getState().selectedCommitOid).toBe(target);

      const restored = setup(loadPage).store;
      await restored.getState().initialize();
      expect(restored.getState().refVisibility).toEqual({ local: false, remote: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('closes the old stream and ignores a late page when the history scope changes', async () => {
    const pending = deferred<HistoryPage>();
    const { store, close } = setup(() => pending.promise);
    await store.getState().initialize();
    const old = store.getState().history;
    if (old.phase !== 'ready') throw new Error('Missing initial history');
    const loading = store.getState().loadMoreHistory();
    await store.getState().setScope('current');
    expect(close).toHaveBeenCalledWith(old.data.sessionId);
    const current = store.getState().history;
    pending.resolve(second);
    expect(await loading).toBe(false);
    expect(store.getState().history).toBe(current);
  });

  it('saves the author and base and uses matching names for branch labels only', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) });
    try {
      const filter = { author: { name: 'Alex Example', email: 'first@example.invalid' }, baseRef: 'refs/heads/main' };
      const { store, open } = setup(async () => second);
      await store.getState().initialize();
      open.mockResolvedValueOnce({ ...first, myBranchRefs: ['refs/remotes/origin/main'] });
      await store.getState().showMyBranches(filter);
      expect(open).toHaveBeenLastCalledWith(expect.any(String), repo.id, repo.primaryWorktreeId, 'mine', null, filter);
      expect(store.getState().history).toMatchObject({
        phase: 'ready', data: {
          refs: first.refs,
          displayRefs: first.refs.slice(1),
          commits: [{ refs: [{ kind: 'head' }, { kind: 'remote' }] }],
        },
      });
      const reloaded = setup(async () => second);
      reloaded.open.mockResolvedValueOnce({ ...first, myBranchRefs: [] });
      await reloaded.store.getState().initialize();
      expect(reloaded.store.getState()).toMatchObject({ scope: 'mine', authorFilter: filter });
      expect(reloaded.open).toHaveBeenLastCalledWith(expect.any(String), repo.id, repo.primaryWorktreeId, 'mine', null, filter);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  function watchReads(read: GitService['getRepositoryView']) {
    vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: true }));
    vi.stubGlobal('window', Object.assign(new EventTarget(), { setInterval: () => 1, clearInterval: () => undefined }));
    let invalidate = () => {};
    const result = setup(async () => second, undefined, async (handler) => {
      invalidate = () => handler({ repoId: repo.id, worktreeId: repo.primaryWorktreeId });
      return () => undefined;
    }, read);
    const stop = result.store.getState().startLiveUpdates();
    return { ...result, invalidate: () => invalidate(), stop };
  }

  const view: RepositoryView = { repository: repo, refs: first.refs, shallowStamp: null, commits: [], graphRows: [], changes: [] };

  it('starts History after a silent snapshot recovers from an initial error', async () => {
    const read = vi.fn(async () => view).mockRejectedValueOnce(new Error('Temporary failure'));
    const { store, open, invalidate, stop } = watchReads(read);
    try {
      await store.getState().initialize();
      expect(store.getState().view.phase).toBe('error');
      expect(store.getState().history.phase).toBe('idle');
      invalidate();
      await vi.waitFor(() => expect(store.getState().history.phase).toBe('ready'));
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      vi.unstubAllGlobals();
    }
  });

  it('coalesces invalidations and gives manual refresh a newly scheduled snapshot', async () => {
    const stale = deferred<RepositoryView>();
    const fresh = deferred<RepositoryView>();
    const newRefs = first.refs.map((ref) => ref.kind === 'remote' ? { ...ref, targetOid: target } : ref);
    const read = vi.fn(async () => view).mockResolvedValueOnce(view)
      .mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
    const { store, invalidate, stop } = watchReads(read);
    try {
      await store.getState().initialize();
      invalidate();
      expect(read).toHaveBeenCalledTimes(2);
      invalidate();
      invalidate();
      const manual = store.getState().refresh();
      expect(read).toHaveBeenCalledTimes(2);
      stale.resolve(view);
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
      expect(store.getState().view.phase).toBe('loading');
      fresh.resolve({ ...view, refs: newRefs });
      await manual;
      expect(read).toHaveBeenCalledTimes(3);
      expect(store.getState().view).toMatchObject({ phase: 'ready', data: { refs: newRefs } });
    } finally {
      stop();
      vi.unstubAllGlobals();
    }
  });

  it('retains the loaded graph and marks it stale after a remote ref update', async () => {
    vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: true }));
    vi.stubGlobal('window', Object.assign(new EventTarget(), { setInterval: () => 1, clearInterval: () => undefined }));
    let refs = first.refs;
    let invalidate: () => void = () => undefined;
    const { store, close } = setup(async () => second, () => refs, async (handler) => {
      invalidate = () => handler({ repoId: repo.id, worktreeId: repo.primaryWorktreeId });
      return () => undefined;
    });
    const stop = store.getState().startLiveUpdates();
    try {
      await store.getState().initialize();
      const before = store.getState().history;
      if (before.phase !== 'ready') throw new Error('Missing initial history');
      refs = refs.map((ref) => ref.kind === 'remote' ? { ...ref, targetOid: target } : ref);
      invalidate();
      await vi.waitFor(() => expect(store.getState().history).toMatchObject({ phase: 'ready', data: { stale: true, hasMore: false } }));
      const after = store.getState().history;
      if (after.phase !== 'ready') throw new Error('Missing stale history');
      expect(after.data.graphRows).toBe(before.data.graphRows);
      expect(close).toHaveBeenCalledWith(before.data.sessionId);
    } finally {
      stop();
      vi.unstubAllGlobals();
    }
  });
});

describe('local workspace restoration', () => {
  const full = mock.getCatalog().repositories['conversation-agent'];
  const workspace = { id: 'fixture', name: 'Fixture', rootPath: '/tmp/fixture', repositoryIds: [full.id] };
  const linked = full.worktrees[1];

  it('restores a linked worktree after reading the full repository snapshot', async () => {
    const selection = { repoId: full.id, worktreeId: linked.id, page: 'worktrees' } as const;
    const adapter = localService({
      workspaces: [workspace], selection,
      repositories: { [full.id]: { ...full, worktrees: [full.worktrees[0]] } },
    }, async () => ({ repository: full, refs: [], commits: [], graphRows: [], changes: [] }));
    const store = createGitDeskStore(adapter);
    await store.getState().initialize();

    expect(store.getState()).toMatchObject({ local: true, ...selection, catalogLoading: false });
    expect(adapter.workspace.watch).toHaveBeenCalledWith(full.id, linked.id);
    expect(adapter.workspace.saveSelection).toHaveBeenCalledWith(selection);
  });

  it('presents native read failures as unknown instead of displaying mock status', async () => {
    const adapter = localService({ workspaces: [workspace], repositories: { [full.id]: full } }, async () => {
      throw { code: 'PATH_UNAVAILABLE', message: 'The repository folder was moved.' };
    });
    const store = createGitDeskStore(adapter);
    await store.getState().initialize();

    expect(store.getState().view).toEqual({ phase: 'error', message: 'The repository folder was moved.' });
    expect(store.getState().catalog.repositories[full.id].worktrees.every(({ status }) => status.kind === 'unknown')).toBe(true);
  });

  it('selects a remaining repository after removing the active one', async () => {
    const next = mock.getCatalog().repositories.backend;
    const remaining = { ...workspace, repositoryIds: [next.id] };
    const repositories = { [full.id]: full, [next.id]: next };
    const adapter = localService({
      workspaces: [{ ...workspace, repositoryIds: [full.id, next.id] }], repositories,
    }, async (repoId) => ({ repository: repositories[repoId], refs: [], commits: [], graphRows: [], changes: [] }));
    const removeRepository = vi.fn(async () => ({ workspaces: [remaining], repositories: { [next.id]: next } }));
    adapter.workspace.removeRepository = removeRepository;
    const store = createGitDeskStore(adapter);
    await store.getState().initialize();

    await store.getState().removeRepository(workspace.id, full.id);

    expect(removeRepository).toHaveBeenCalledWith(workspace.id, full.id);
    expect(store.getState().repoId).toBe(next.id);
    expect(store.getState().catalog.repositories[full.id]).toBeUndefined();
  });
});
