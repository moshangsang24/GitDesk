import { isTauri } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { HistoryLayout } from '../core/graph/layout';
import { labelsByOid } from '../core/graph/refs';
import type {
  AuthorFilter, Commit, CommitDetail, GitRef, GitService, HistoryPage, HistoryScope, Oid, RefLabel, RefVisibility, Repository, RepositoryPage,
  RepositoryView, ScanProgress, WorkspaceCatalog, WorkspaceSelection,
} from '../services/contracts';
import type { OperationConfirmation, OperationInput } from '../services/operations';
import { createMockGitService } from '../services/mock';
import { tauriGitService } from '../services/tauri';
import { readHistoryPreferences, readInspection, saveHistoryPreferences, saveInspection } from './history-preferences';

export type Page = RepositoryPage;

type Loadable<T> =
  | { phase: 'idle' | 'loading' }
  | { phase: 'ready'; data: T }
  | { phase: 'error'; message: string };

interface DetailState {
  commit: Commit;
  parentOid: Oid | null;
  result: Loadable<CommitDetail>;
}

interface ScanState {
  requestId: string;
  progress: ScanProgress | null;
}

export interface HistoryData extends Pick<RepositoryView, 'commits' | 'graphRows'> {
  sessionId: string;
  head: Oid | null;
  shallowStamp: string | null;
  refs: GitRef[];
  displayRefs: GitRef[];
  hasMore: boolean;
  paging: boolean;
  stale: boolean;
  pageMessage: string | null;
}

interface HistorySession {
  id: string;
  layout: HistoryLayout;
  labels: Map<Oid, RefLabel[]>;
  sequence: number;
  request: Promise<boolean> | null;
}

interface HistoryNavigation {
  phase: 'finding' | 'missing' | 'continue';
  message: string;
  oid?: Oid;
}

interface OperationLogEntry {
  input: OperationInput;
  target: string;
  error: string | null;
  warning: string | null;
  completedAt: number;
}

interface SnapshotRead {
  controller: AbortController;
  promise: Promise<RepositoryView>;
  next?: SnapshotRead;
}

interface GitDeskState {
  service: GitService;
  pendingOperations: Record<string, OperationInput | undefined>;
  operationLog: Record<string, OperationLogEntry[] | undefined>;
  runOperation: (input: OperationInput, confirmation: OperationConfirmation) => Promise<void>;
  local: boolean;
  catalog: WorkspaceCatalog;
  catalogLoading: boolean;
  updatingCatalog: boolean;
  workspaceNotice: string | null;
  scan: ScanState | null;
  repoId: string;
  worktreeId: string;
  page: Page;
  scope: HistoryScope;
  focusedRef: string | null;
  authorFilter: AuthorFilter | null;
  refVisibility: RefVisibility;
  view: Loadable<RepositoryView>;
  history: Loadable<HistoryData>;
  historyNavigation: HistoryNavigation | null;
  scrollSelection: number;
  selectedCommitOid: Oid | null;
  detail: DetailState | null;
  initialize: () => Promise<void>;
  startLiveUpdates: () => () => void;
  addWorkspace: () => Promise<void>;
  addRepository: (workspaceId: string) => Promise<void>;
  rescanWorkspace: (workspaceId: string) => Promise<void>;
  removeWorkspace: (workspaceId: string) => Promise<void>;
  removeRepository: (workspaceId: string, repoId: string) => Promise<void>;
  cancelScan: () => Promise<void>;
  openRepository: (repoId: string) => Promise<void>;
  openWorktree: (worktreeId: string) => Promise<void>;
  setPage: (page: Page) => void;
  setScope: (scope: HistoryScope, refName?: string) => Promise<void>;
  showMyBranches: (filter: AuthorFilter) => Promise<void>;
  toggleRefVisibility: (kind: keyof RefVisibility) => void;
  loadMoreHistory: () => Promise<boolean>;
  locateCommit: (oid: Oid) => Promise<void>;
  searchOlderHistory: (predicate: (commit: Commit) => boolean) => Promise<void>;
  cancelHistoryNavigation: () => void;
  refresh: () => Promise<void>;
  openCommit: (oid: Oid, parentOid?: Oid | null) => Promise<void>;
  closeDetail: () => void;
  openLocation: (destination: 'finder' | 'terminal') => Promise<void>;
  revealCommit: (oid: Oid) => Promise<void>;
}

export function displayError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  if (typeof error === 'string') return error;
  return 'An unexpected error occurred.';
}

export function createGitDeskStore(service: GitService) {
  const native = service.workspace;
  const historyActions = service.history;
  const catalog = service.getCatalog();
  const initialRepo = catalog.repositories['conversation-agent'] ?? Object.values(catalog.repositories)[0];
  let viewRequest = 0;
  let detailRequest = 0;
  let catalogRevision = 0;
  let scanSequence = 0;
  let initialized = false;

  return create<GitDeskState>((set, get) => {
    let watchKey = '';
    let saving = Promise.resolve();
    let backgroundIndex = 0;
    let backgroundRunning = false;
    let session: HistorySession | null = null;
    let navigation = 0;
    let detailRead: AbortController | null = null;
    const inFlight = new Map<string, SnapshotRead>();

    function cancelRead(read: SnapshotRead | undefined) {
      read?.controller.abort();
      read?.next?.controller.abort();
    }

    function read(repoId: string, worktreeId: string, scope: HistoryScope, fresh = false) {
      if (!native) return service.getRepositoryView(repoId, worktreeId, scope, get().focusedRef);
      const active = inFlight.get(repoId);
      if (active && !fresh && !active.controller.signal.aborted) return active.promise;
      if (active?.next && !active.next.controller.signal.aborted) return active.next.promise;

      const controller = new AbortController();
      const start = async () => {
        controller.signal.throwIfAborted();
        return service.getRepositoryView(repoId, worktreeId, scope, undefined, controller.signal);
      };
      const job: SnapshotRead = {
        controller,
        promise: active ? active.promise.then(start, start) : start(),
      };
      if (active) active.next = job;
      else inFlight.set(repoId, job);
      const finish = () => {
        if (inFlight.get(repoId) !== job) return;
        if (job.next) inFlight.set(repoId, job.next);
        else inFlight.delete(repoId);
      };
      void job.promise.then(finish, finish);
      return job.promise;
    }

    function stopHistory() {
      if (session) void historyActions?.close(session.id).catch(() => undefined);
      session = null;
      navigation += 1;
      set({ history: { phase: 'idle' }, historyNavigation: null });
    }

    function appendHistory(current: HistorySession, page: HistoryPage, data: HistoryData): HistoryData {
      if (page.sequence !== current.sequence) throw new Error('History pages arrived out of sequence. Refresh history.');
      const rows = current.layout.append(page.commits);
      const commits = page.commits.map((commit): Commit => ({ ...commit, refs: current.labels.get(commit.oid) ?? [] }));
      const pageMessage = page.truncated ? 'History reached the 100,000-commit limit. Try a narrower scope.'
        : !page.hasMore && current.layout.hasPendingParents ? 'Some parent commits are unavailable in this history.' : null;
      current.sequence += 1;
      return {
        ...data,
        commits: [...data.commits, ...commits],
        graphRows: [...data.graphRows, ...rows],
        hasMore: page.hasMore,
        paging: false,
        pageMessage,
      };
    }

    function clearInspection() {
      ++detailRequest;
      detailRead?.abort();
      set({ detail: null });
    }

    async function startHistory(preferredOid = get().selectedCommitOid, reopen = true) {
      if (!historyActions) return;
      const { repoId, worktreeId, scope, focusedRef, authorFilter, page } = get();
      if (page !== 'history' || !repoId || !worktreeId || get().view.phase !== 'ready') return;
      stopHistory();
      const current: HistorySession = { id: crypto.randomUUID(), layout: new HistoryLayout(), labels: new Map(), sequence: 0, request: null };
      session = current;
      set({ history: { phase: 'loading' } });
      try {
        const selectedAuthor = scope === 'mine' ? authorFilter ?? undefined : undefined;
        const { page: first, refs, head, shallowStamp, myBranchRefs } = await historyActions.open(current.id, repoId, worktreeId, scope, focusedRef, selectedAuthor);
        if (session !== current) {
          void historyActions.close(current.id).catch(() => undefined);
          return;
        }
        const matching = myBranchRefs && new Set(myBranchRefs);
        const displayRefs = matching ? refs.filter((ref) => ref.kind === 'tag' || matching.has(ref.fullName)) : refs;
        current.labels = labelsByOid(displayRefs, head);
        const data = appendHistory(current, first, {
          sessionId: current.id, refs, displayRefs, head, shallowStamp, commits: [], graphRows: [], hasMore: false, paging: false, stale: false, pageMessage: null,
        });
        const remembered = reopen && service.review ? readInspection(repoId, worktreeId) : null;
        const recorded = data.commits.find(({ oid }) => oid === remembered?.oid);
        const selected = recorded ?? data.commits.find(({ oid }) => oid === preferredOid) ?? data.commits[0];
        set({ history: { phase: 'ready', data }, selectedCommitOid: selected?.oid ?? null });
        if (recorded && remembered) {
          const parent = remembered.parentOid && recorded.parents.includes(remembered.parentOid) ? remembered.parentOid : undefined;
          await get().openCommit(recorded.oid, parent);
        }
      } catch (error) {
        if (session !== current) return;
        stopHistory();
        set({ history: { phase: 'error', message: displayError(error) } });
      }
    }

    function verifyHistorySnapshot(snapshot: RepositoryView, worktreeId: string) {
      const { history } = get();
      if (!historyActions || history.phase !== 'ready' || history.data.stale) return;
      const refs = snapshot.refs ?? [];
      const tree = snapshot.repository?.worktrees.find(({ id }) => id === worktreeId);
      const headChanged = tree && tree.head !== history.data.head;
      const refsChanged = refs.length !== history.data.refs.length || refs.some((ref, index) => {
        const before = history.data.refs[index];
        return ref.fullName !== before.fullName || ref.targetOid !== before.targetOid || ref.symbolicTarget !== before.symbolicTarget;
      });
      if (!headChanged && !refsChanged && (snapshot.shallowStamp ?? null) === history.data.shallowStamp) return;
      stopHistory();
      set({ history: { phase: 'ready', data: { ...history.data, stale: true, hasMore: false, paging: false, pageMessage: 'Repository history changed. Refresh to see the latest history.' } } });
    }

    async function navigateHistory(predicate: (commit: Commit) => boolean, older: boolean, oid?: Oid) {
      const current = ++navigation;
      const active = () => current === navigation;
      const initial = get().history;
      if (initial.phase !== 'ready') {
        const view = get().view;
        if (!historyActions && oid && view.phase === 'ready' && view.data.commits.some((commit) => commit.oid === oid)) {
          await get().openCommit(oid);
        } else if (!historyActions) {
          set({ historyNavigation: { phase: 'missing', message: 'Commit is outside this history scope.', oid } });
        }
        return;
      }
      let cursor = older ? initial.data.commits.length : 0;
      for (let loaded = 0; active(); loaded++) {
        const history = get().history;
        if (history.phase !== 'ready') return;
        const found = history.data.commits.slice(cursor).find(predicate);
        if (found) {
          set({ historyNavigation: null });
          await get().openCommit(found.oid);
          return;
        }
        if (!history.data.hasMore) {
          const message = history.data.pageMessage ?? (older ? 'No more matching commits in this history.' : 'Commit is outside this history scope.');
          set({ historyNavigation: { phase: history.data.pageMessage ? 'continue' : 'missing', message, oid } });
          return;
        }
        if (loaded === 12) {
          set({ historyNavigation: { phase: 'continue', message: 'More history is available.', oid } });
          return;
        }
        cursor = history.data.commits.length;
        set({ historyNavigation: { phase: 'finding', message: older ? 'Searching older commits…' : 'Locating commit…' } });
        if (!await get().loadMoreHistory() && active()) {
          set({ historyNavigation: null });
          return;
        }
      }
    }

    function persistSelection() {
      if (!native) return;
      const { repoId, worktreeId, page, catalog } = get();
      if (!catalog.repositories[repoId]?.worktrees.some(({ id }) => id === worktreeId)) return;
      const selection = { repoId, worktreeId, page };
      saving = saving.then(() => native.saveSelection(selection)).catch((error) => {
        set({ workspaceNotice: displayError(error) });
      });
    }

    function updateWatcher(repoId: string, worktreeId: string) {
      if (!native) return;
      const key = [repoId, worktreeId].join('/');
      if (key === watchKey) return;
      watchKey = key;
      void native.watch(repoId, worktreeId).catch(() => {
        if (watchKey === key && repoId) {
          set({ workspaceNotice: 'File watching is unavailable for this worktree. Periodic refresh remains active.' });
        }
      });
    }

    function openHead(data: RepositoryView, repoId: string, worktreeId: string) {
      const head = get().catalog.repositories[repoId]?.worktrees.find(({ id }) => id === worktreeId)?.head;
      const commit = data.commits.find(({ oid }) => oid === head) ?? data.commits[0];
      if (commit) return get().openCommit(commit.oid);
    }

    function publishRepository(repository: Repository) {
      const current = get().catalog;
      if (!current.repositories[repository.id]) return;
      set({ catalog: { ...current, repositories: { ...current.repositories, [repository.id]: repository } } });
    }

    function unknownRepository(repoId: string, message: string) {
      const previous = get().catalog.repositories[repoId];
      if (!previous) return;
      publishRepository({
        ...previous,
        worktrees: previous.worktrees.map((tree) => ({
          ...tree, status: { kind: 'unknown', changes: 0, ahead: null, behind: null, detail: message },
        })),
      });
    }

    async function loadView(repoId: string, worktreeId: string, scope: HistoryScope, silent = false, fresh = false) {
      if (!repoId) return;
      const request = ++viewRequest;
      const revision = catalogRevision;
      const previous = get();
      const observedSession = previous.history.phase === 'ready' ? session : null;
      const preferredOid = previous.repoId === repoId && previous.worktreeId === worktreeId ? previous.selectedCommitOid : null;
      if (!silent) {
        if (previous.repoId !== repoId) cancelRead(inFlight.get(previous.repoId));
        clearInspection();
        stopHistory();
        set({ repoId, worktreeId, scope, view: { phase: 'loading' }, selectedCommitOid: null, detail: null });
      }

      try {
        const data = await read(repoId, worktreeId, scope, fresh);
        if (revision !== catalogRevision || request !== viewRequest) return;

        if (data.repository) {
          const repository = data.repository;
          const treeId = repository.worktrees.some(({ id }) => id === worktreeId)
            ? worktreeId : repository.primaryWorktreeId;
          publishRepository(repository);
          set({ worktreeId: treeId, view: { phase: 'ready', data } });
          if (!silent || treeId !== worktreeId) persistSelection();
          updateWatcher(repoId, treeId);
          if (!silent || treeId !== worktreeId || get().history.phase === 'idle') await startHistory(preferredOid);
          else if (observedSession && session === observedSession) verifyHistorySnapshot(data, treeId);
        } else {
          set({ view: { phase: 'ready', data } });
          if (get().page === 'history') await openHead(data, repoId, worktreeId);
        }
      } catch (error) {
        if (revision !== catalogRevision || request !== viewRequest) return;
        const message = displayError(error);
        if (native) unknownRepository(repoId, message);
        set({ view: { phase: 'error', message } });
      }
    }

    async function refreshBackground(initial = false) {
      if (!native || backgroundRunning) return;
      const revision = catalogRevision;
      const ids = Object.keys(get().catalog.repositories).filter((id) => id !== get().repoId);
      if (!ids.length) return;
      backgroundRunning = true;
      try {
        const limit = initial ? ids.length : Math.min(ids.length, 4);
        for (let offset = 0; offset < limit; offset += 4) {
          if (revision !== catalogRevision || globalThis.document?.hidden) break;
          const batch = Array.from({ length: Math.min(4, limit - offset) }, (_, index) => ids[(backgroundIndex + offset + index) % ids.length]);
          await Promise.all(batch.map(async (id) => {
            if (get().repoId === id) return;
            try {
              const result = await read(id, '', 'all');
              if (revision === catalogRevision && get().repoId !== id && result.repository) publishRepository(result.repository);
            } catch (error) {
              if (revision === catalogRevision && get().repoId !== id) unknownRepository(id, displayError(error));
            }
          }));
        }
        backgroundIndex = (backgroundIndex + limit) % ids.length;
      } finally {
        backgroundRunning = false;
      }
    }

    async function applyCatalog(next: WorkspaceCatalog, prefer: WorkspaceSelection | null) {
      catalogRevision += 1;
      for (const read of inFlight.values()) cancelRead(read);
      const fallback = next.workspaces.flatMap(({ repositoryIds }) => repositoryIds).find((id) => next.repositories[id]);
      const repoId = prefer && next.repositories[prefer.repoId] ? prefer.repoId : fallback ?? '';
      const page = repoId && repoId === prefer?.repoId ? prefer.page : 'history';
      const worktreeId = repoId && repoId === prefer?.repoId
        ? prefer.worktreeId : next.repositories[repoId]?.primaryWorktreeId ?? '';
      const previous = get();
      const selectedCommitOid = previous.repoId === repoId && previous.worktreeId === worktreeId ? previous.selectedCommitOid : null;
      set({ catalog: next, repoId, worktreeId, page, selectedCommitOid, catalogLoading: false, ...readHistoryPreferences(repoId) });
      if (!repoId) {
        ++viewRequest;
        stopHistory();
        set({ view: { phase: 'idle' }, detail: null, selectedCommitOid: null });
        updateWatcher('', '');
        return;
      }
      await loadView(repoId, worktreeId, get().scope);
      void refreshBackground(true);
    }

    function currentSelection(): WorkspaceSelection {
      const { repoId, worktreeId, page } = get();
      return { repoId, worktreeId, page };
    }

    async function runScan(
      perform: (requestId: string, onProgress: (event: ScanProgress) => void) => Promise<WorkspaceCatalog | null>,
      chooseNew = false,
      started = false,
    ) {
      if (get().scan || get().updatingCatalog) return;
      const requestId = String(++scanSequence);
      const known = new Set(get().catalog.workspaces.map(({ id }) => id));
      set({ scan: { requestId, progress: started ? { directories: 0, repositories: 0 } : null }, workspaceNotice: null });
      try {
        const next = await perform(requestId, (progress) => {
          if (get().scan?.requestId === requestId) set({ scan: { requestId, progress } });
        });
        if (!next) return;
        set({ scan: null });
        let preferred = currentSelection();
        if (chooseNew) {
          const addedRepo = next.workspaces.find(({ id }) => !known.has(id))?.repositoryIds[0];
          if (addedRepo) preferred = { repoId: addedRepo, worktreeId: next.repositories[addedRepo].primaryWorktreeId, page: 'history' };
        }
        await applyCatalog(next, preferred);
      } catch (error) {
        const cancelled = typeof error === 'object' && error !== null && 'code' in error && error.code === 'CANCELLED';
        set({ workspaceNotice: cancelled ? 'Scan cancelled.' : displayError(error) });
      } finally {
        if (get().scan?.requestId === requestId) set({ scan: null });
      }
    }

    async function changeCatalog(mutation: () => Promise<WorkspaceCatalog>) {
      if (get().scan || get().updatingCatalog) return;
      set({ updatingCatalog: true, workspaceNotice: null });
      try {
        await applyCatalog(await mutation(), currentSelection());
      } catch (error) {
        set({ workspaceNotice: displayError(error) });
      } finally {
        set({ updatingCatalog: false });
      }
    }

    return {
      service,
      local: !!native,
      catalog,
      catalogLoading: !!native,
      updatingCatalog: false,
      workspaceNotice: null,
      scan: null,
      repoId: initialRepo?.id ?? '',
      worktreeId: initialRepo?.primaryWorktreeId ?? '',
      ...readHistoryPreferences(initialRepo?.id ?? ''),
      page: 'history',
      view: { phase: 'idle' },
      history: { phase: 'idle' },
      historyNavigation: null,
      scrollSelection: 0,
      selectedCommitOid: null,
      detail: null,

      pendingOperations: {},
      operationLog: {},

      async runOperation(input, confirmation) {
        if (!service.operations || get().pendingOperations[input.repoId]) return;
        const { repoId } = input;
        set({ pendingOperations: { ...get().pendingOperations, [repoId]: input } });
        let entry: OperationLogEntry;
        try {
          const result = await service.operations.execute(input.id);
          entry = { input, target: confirmation.target, error: result.error?.message ?? null, warning: result.warning, completedAt: result.completedAt };
        } catch (error) {
          entry = { input, target: confirmation.target, error: displayError(error), warning: null, completedAt: Date.now() };
        }
        set((state) => ({
          pendingOperations: { ...state.pendingOperations, [repoId]: undefined },
          operationLog: { ...state.operationLog, [repoId]: [entry, ...(state.operationLog[repoId] ?? [])].slice(0, 20) },
        }));

        const revision = catalogRevision;
        const current = get();
        if (current.repoId === repoId) {
          await loadView(repoId, current.worktreeId, current.scope, true, true);
          const refreshed = get();
          if (refreshed.repoId === repoId && refreshed.history.phase === 'ready' && refreshed.history.data.stale) {
            clearInspection();
            await startHistory();
          }
        } else if (current.catalog.repositories[repoId]) {
          try {
            const result = await read(repoId, '', 'all', true);
            if (revision === catalogRevision && get().repoId !== repoId && result.repository) publishRepository(result.repository);
          } catch (error) {
            if (revision === catalogRevision && get().repoId !== repoId) unknownRepository(repoId, displayError(error));
          }
        }
      },

      async initialize() {
        if (initialized) return;
        initialized = true;
        if (!native) {
          await get().refresh();
          return;
        }
        try {
          const loaded = await native.load();
          await applyCatalog(loaded, loaded.selection ?? null);
        } catch (error) {
          initialized = false;
          set({ catalogLoading: false, workspaceNotice: displayError(error) });
        }
      },

      startLiveUpdates() {
        if (!native) return () => undefined;
        let stopped = false;
        let unlisten: (() => void) | undefined;
        const refreshCurrent = () => {
          if (stopped) return;
          const { repoId, worktreeId, scope } = get();
          if (repoId) void loadView(repoId, worktreeId, scope, true, true);
        };
        const refreshVisible = () => {
          if (document.hidden) return;
          refreshCurrent();
          void refreshBackground();
        };
        void native.onInvalidation(({ repoId, worktreeId }) => {
          const state = get();
          if (state.repoId === repoId && state.worktreeId === worktreeId) refreshCurrent();
        }).then((dispose) => {
          if (stopped) dispose();
          else unlisten = dispose;
        }).catch(() => { /* Focus and periodic refresh are available if event delivery fails. */ });
        const timer = window.setInterval(refreshVisible, 45000);
        window.addEventListener('focus', refreshVisible);
        document.addEventListener('visibilitychange', refreshVisible);
        return () => {
          stopped = true;
          unlisten?.();
          // Strict Mode reattaches this listener without changing the current History view.
          window.clearInterval(timer);
          window.removeEventListener('focus', refreshVisible);
          document.removeEventListener('visibilitychange', refreshVisible);
        };
      },

      async addWorkspace() {
        if (native) await runScan(native.addWorkspace, true);
      },

      async addRepository(workspaceId) {
        if (native) await runScan((requestId) => native.addRepository(workspaceId, requestId));
      },

      async rescanWorkspace(workspaceId) {
        if (native) await runScan((requestId, progress) => native.rescan(workspaceId, requestId, progress), false, true);
      },

      async removeWorkspace(workspaceId) {
        if (native) await changeCatalog(() => native.removeWorkspace(workspaceId));
      },

      async removeRepository(workspaceId, repoId) {
        if (native) await changeCatalog(() => native.removeRepository(workspaceId, repoId));
      },

      async cancelScan() {
        const scan = get().scan;
        if (!native || !scan) return;
        try {
          await native.cancelScan(scan.requestId);
        } catch (error) {
          set({ workspaceNotice: displayError(error) });
        }
      },

      async openRepository(repoId) {
        const repo = get().catalog.repositories[repoId];
        if (!repo || repoId === get().repoId) return;
        set({ page: 'history', ...readHistoryPreferences(repoId) });
        await loadView(repoId, repo.primaryWorktreeId, get().scope);
      },

      async openWorktree(worktreeId) {
        const { repoId, scope, worktreeId: activeId, catalog } = get();
        if (worktreeId === activeId || !catalog.repositories[repoId]?.worktrees.some(({ id }) => id === worktreeId)) return;
        await loadView(repoId, worktreeId, scope);
      },

      setPage(page) {
        if (get().page === page) return;
        set({ page });
        if (native) {
          clearInspection();
          persistSelection();
          if (page === 'history') void startHistory();
          else stopHistory();
          return;
        }
        const { view, repoId, worktreeId, selectedCommitOid } = get();
        if (page === 'history' && view.phase === 'ready' && !selectedCommitOid) {
          void openHead(view.data, repoId, worktreeId);
        }
      },

      async setScope(scope, refName) {
        const { repoId, worktreeId, scope: activeScope, focusedRef, authorFilter, view } = get();
        const nextRef = scope === 'ref' ? refName ?? focusedRef : null;
        if (scope === 'ref' && !nextRef) return;
        if (scope === 'mine' && (!historyActions || !authorFilter)) return;
        if (scope === activeScope && nextRef === focusedRef) return;
        if (native) clearInspection();
        set({ scope, focusedRef: nextRef });
        saveHistoryPreferences(repoId, get());
        if (historyActions && view.phase === 'ready') await startHistory();
        else await loadView(repoId, worktreeId, scope);
      },

      async showMyBranches(authorFilter) {
        const { repoId, worktreeId, view } = get();
        if (!historyActions || !repoId || !worktreeId) return;
        clearInspection();
        set({ authorFilter, scope: 'mine', focusedRef: null, page: 'history' });
        saveHistoryPreferences(repoId, get());
        persistSelection();
        if (view.phase === 'ready') await startHistory();
        else await loadView(repoId, worktreeId, 'mine');
      },

      toggleRefVisibility(kind) {
        const { repoId, refVisibility } = get();
        set({ refVisibility: { ...refVisibility, [kind]: !refVisibility[kind] } });
        saveHistoryPreferences(repoId, get());
      },

      async loadMoreHistory() {
        const current = session;
        const { history } = get();
        if (!historyActions || !current || history.phase !== 'ready' || !history.data.hasMore) return false;
        if (current.request) return current.request;
        const data = history.data;
        set({ history: { phase: 'ready', data: { ...data, paging: true } } });
        current.request = (async () => {
          try {
            const page = await historyActions.loadPage(current.id, current.sequence);
            if (session !== current) return false;
            set({ history: { phase: 'ready', data: appendHistory(current, page, data) } });
            return true;
          } catch (error) {
            if (session !== current) return false;
            void historyActions.close(current.id).catch(() => undefined);
            session = null;
            set({ history: { phase: 'ready', data: { ...data, paging: false, hasMore: false, pageMessage: displayError(error) } } });
            return false;
          } finally {
            current.request = null;
          }
        })();
        return current.request;
      },

      locateCommit(oid) {
        return navigateHistory((commit) => commit.oid === oid, false, oid);
      },

      searchOlderHistory(predicate) {
        return navigateHistory(predicate, true);
      },

      cancelHistoryNavigation() {
        navigation += 1;
        set({ historyNavigation: null });
      },

      async refresh() {
        const { repoId, worktreeId, scope } = get();
        await loadView(repoId, worktreeId, scope, false, true);
      },

      async openCommit(oid, parentOid) {
        const { view, history, repoId, worktreeId, scrollSelection } = get();
        const rows = historyActions ? history : view;
        if (rows.phase !== 'ready') return;
        const commit = rows.data.commits.find((item) => item.oid === oid);
        if (!commit) return;
        if (historyActions && !service.review) {
          set({ selectedCommitOid: oid, scrollSelection: scrollSelection + 1 });
          return;
        }
        const base = parentOid === undefined ? commit.parents[0] ?? null : parentOid;
        if (service.review) saveInspection(repoId, worktreeId, { oid, parentOid: base });
        detailRead?.abort();
        const read = new AbortController();
        detailRead = read;
        const request = ++detailRequest;
        set({ selectedCommitOid: oid, scrollSelection: scrollSelection + 1, detail: { commit, parentOid: base, result: { phase: 'loading' } } });
        try {
          const data = await service.getCommitDetail(repoId, oid, base, read.signal);
          if (request === detailRequest) set({ detail: { commit, parentOid: base, result: { phase: 'ready', data } } });
        } catch (error) {
          if (request === detailRequest) {
            set({ detail: { commit, parentOid: base, result: { phase: 'error', message: displayError(error) } } });
          }
        }
      },

      closeDetail() {
        const { repoId, worktreeId } = get();
        if (service.review) saveInspection(repoId, worktreeId, null);
        clearInspection();
      },

      async openLocation(destination) {
        const { repoId, worktreeId } = get();
        try { await service.review?.open(repoId, worktreeId, destination); }
        catch (error) { set({ workspaceNotice: displayError(error) }); }
      },

      async revealCommit(oid) {
        const { repoId, worktreeId, page, scope } = get();
        if (page !== 'history' || scope !== 'all') {
          clearInspection();
          set({ page: 'history', scope: 'all', focusedRef: null });
          persistSelection();
          saveHistoryPreferences(repoId, get());
          await startHistory(oid, false);
        }
        const active = get();
        if (active.page === 'history' && active.repoId === repoId && active.worktreeId === worktreeId) await active.locateCommit(oid);
      },
    };
  });
}

export const useGitDesk = createGitDeskStore(isTauri() ? tauriGitService : createMockGitService());
