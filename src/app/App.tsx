import { ChevronDown, ChevronUp, PanelLeft, SlidersHorizontal, UserRound } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RepositoryToolbar } from '../components/layout/RepositoryToolbar';
import { StatusBar } from '../components/layout/StatusBar';
import { TitleBar } from '../components/layout/TitleBar';
import { Notice } from '../components/ui/Notice';
import { ResizeHandle } from '../components/ui/ResizeHandle';
import { SearchField } from '../components/ui/SearchField';
import { AuthorFilterDialog } from '../features/branches/AuthorFilterDialog';
import { RefsView, WorktreeSummary } from '../features/branches/RefsView';
import { ChangesView } from '../features/changes/ChangesView';
import { LocalChanges } from '../features/changes/LocalChanges';
import { CommitDetails } from '../features/history/CommitDetails';
import { HistoryRefs } from '../features/history/HistoryRefs';
import { HistoryTable } from '../features/history/HistoryTable';
import { matchesCommit, searchCommits } from '../features/history/history-search';
import { ReleasesView } from '../features/releases/ReleasesView';
import { SettingsDialog } from '../features/settings/SettingsDialog';
import { useAppearance } from '../features/settings/useAppearance';
import { Sidebar } from '../features/workspace/Sidebar';
import { WorktreesView } from '../features/worktrees/WorktreesView';
import type { HistoryScope } from '../services/contracts';
import { useGitDesk } from '../stores/gitdesk';
import type { Page } from '../stores/gitdesk';

const tabs: Array<{ id: Page; label: string }> = [
  { id: 'history', label: 'History' },
  { id: 'changes', label: 'Changes' },
  { id: 'worktrees', label: 'Worktrees' },
];

function readReleaseColumns(repoId: string): boolean {
  try { return localStorage.getItem(`gitdesk.releaseColumns.${repoId}`) === '1'; } catch { return false; }
}

export function App() {
  const local = useGitDesk((state) => state.local);
  const catalog = useGitDesk((state) => state.catalog);
  const catalogLoading = useGitDesk((state) => state.catalogLoading);
  const workspaceNotice = useGitDesk((state) => state.workspaceNotice);
  const scan = useGitDesk((state) => state.scan);
  const addWorkspace = useGitDesk((state) => state.addWorkspace);
  const cancelScan = useGitDesk((state) => state.cancelScan);
  const initialize = useGitDesk((state) => state.initialize);
  const startLiveUpdates = useGitDesk((state) => state.startLiveUpdates);
  const repo = useGitDesk((state) => state.catalog.repositories[state.repoId]);
  const worktreeId = useGitDesk((state) => state.worktreeId);
  const page = useGitDesk((state) => state.page);
  const scope = useGitDesk((state) => state.scope);
  const focusedRef = useGitDesk((state) => state.focusedRef);
  const authorFilter = useGitDesk((state) => state.authorFilter);
  const showMyBranches = useGitDesk((state) => state.showMyBranches);
  const refVisibility = useGitDesk((state) => state.refVisibility);
  const toggleRefVisibility = useGitDesk((state) => state.toggleRefVisibility);
  const history = useGitDesk((state) => state.history);
  const historyNavigation = useGitDesk((state) => state.historyNavigation);
  const loadMoreHistory = useGitDesk((state) => state.loadMoreHistory);
  const locateCommit = useGitDesk((state) => state.locateCommit);
  const searchOlderHistory = useGitDesk((state) => state.searchOlderHistory);
  const cancelHistoryNavigation = useGitDesk((state) => state.cancelHistoryNavigation);
  const view = useGitDesk((state) => state.view);
  const detail = useGitDesk((state) => state.detail);
  const selectedOid = useGitDesk((state) => state.selectedCommitOid);
  const setPage = useGitDesk((state) => state.setPage);
  const setScope = useGitDesk((state) => state.setScope);
  const refresh = useGitDesk((state) => state.refresh);
  const openCommit = useGitDesk((state) => state.openCommit);
  const closeDetail = useGitDesk((state) => state.closeDetail);
  const worktree = repo?.worktrees.find(({ id }) => id === worktreeId) ?? repo?.worktrees[0];
  const hasRelease = useGitDesk((state) => !!state.service.release);
  const hasAuthorPicker = useGitDesk((state) => !!state.service.history?.listAuthors);
  const pages = local ? [tabs[0], { id: 'refs' as const, label: 'Branches' }, ...tabs.slice(1)] : [...tabs];
  if (hasRelease) pages.push({ id: 'releases', label: 'Releases' });

  const repositorySearch = useRef<HTMLInputElement>(null);
  const refsSearch = useRef<HTMLInputElement>(null);
  const historySearch = useRef<HTMLInputElement>(null);
  const changesSearch = useRef<HTMLInputElement>(null);
  const historyGrid = useRef<HTMLDivElement>(null);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(252);
  const [detailHeight, setDetailHeight] = useState<number | null>(null);
  const [windowSize, setWindowSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const [fileWidth, setFileWidth] = useState(220);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [authorPickerRepo, setAuthorPickerRepo] = useState<string | null>(null);
  const [appearance, setAppearance] = useAppearance();
  const [showHash, setShowHash] = useState(true);
  const [refPanelOverride, setRefPanelOverride] = useState<boolean | null>(null);
  const [historyQuery, setHistoryQuery] = useState('');
  const [changesQuery, setChangesQuery] = useState('');
  const [tracking, setTracking] = useState<{ sessionId: string; ids: string[] } | null>(null);
  const [releaseDraft, setReleaseDraft] = useState<{ repoId: string; ids: string[] } | null>(null);
  const [releaseColumns, setReleaseColumns] = useState<Record<string, boolean>>({});

  const repositoryWidth = windowSize.width - (sidebarCollapsed ? 0 : sidebarWidth + 6);
  const showRefs = refPanelOverride ?? repositoryWidth >= 950;
  const refsWidth = Math.max(146, Math.min(196, windowSize.width * 0.14));
  const historyWidth = repositoryWidth - (showRefs ? refsWidth : 0);
  const data = view.phase === 'ready' ? view.data : null;
  const authorPickerVisible = hasAuthorPicker && !!repo && authorPickerRepo === repo.id;
  const localHistory = history.phase === 'ready' ? history.data : null;
  const navigationOid = historyNavigation?.oid;
  const historyData = local ? localHistory : data;
  const activeTracking = tracking && tracking.sessionId === localHistory?.sessionId ? tracking : null;
  const showReleaseColumns = hasRelease && !!repo && !!(releaseColumns[repo.id] ?? readReleaseColumns(repo.id));
  const historyCommits = historyData?.commits;
  const matches = useMemo(() => searchCommits(historyCommits ?? [], historyQuery), [historyCommits, historyQuery]);
  const matchIds = useMemo(() => new Set(matches.map(({ oid }) => oid)), [matches]);
  const maxDetailHeight = Math.max(150, windowSize.height - 250);
  const defaultDetailHeight = Math.max(150, Math.round((windowSize.height - 60) * 0.31));
  const shownDetailHeight = Math.min(maxDetailHeight, detailHeight ?? defaultDetailHeight);

  useEffect(() => {
    void initialize();
    return startLiveUpdates();
  }, [initialize, startLiveUpdates]);

  useEffect(() => {
    function update() { setWindowSize({ width: window.innerWidth, height: window.innerHeight }); }
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const findRepository = useCallback(() => {
    setSidebarCollapsed(false);
    setSidebarSearchOpen(true);
    repositorySearch.current?.focus();
  }, []);

  const dismissDetail = useCallback(() => {
    closeDetail();
    historyGrid.current?.focus({ preventScroll: true });
  }, [closeDetail]);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (settingsOpen || authorPickerVisible || event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey) {
        switch (event.key.toLowerCase()) {
          case 'k': event.preventDefault(); findRepository(); break;
          case 'f':
            event.preventDefault();
            if (local && page === 'refs') refsSearch.current?.focus();
            else if (page === 'history') historySearch.current?.focus();
            else if (page === 'changes') changesSearch.current?.focus();
            else findRepository();
            break;
          case 'r': event.preventDefault(); void refresh(); break;
          case ',': event.preventDefault(); setSettingsOpen(true); break;
        }
      } else if (event.key === 'Escape' && detail && page === 'history') {
        dismissDetail();
      }
    }

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [authorPickerVisible, detail, dismissDetail, findRepository, local, page, refresh, settingsOpen]);

  function jumpToMatch(reverse: boolean) {
    if (!matches.length) {
      if (localHistory?.hasMore) searchOlder();
      return;
    }
    const current = matches.findIndex(({ oid }) => oid === selectedOid);
    const next = current < 0
      ? reverse ? matches.length - 1 : 0
      : (current + (reverse ? -1 : 1) + matches.length) % matches.length;
    void openCommit(matches[next].oid);
  }

  function searchOlder() {
    const query = historyQuery.trim().toLowerCase();
    if (query) void searchOlderHistory((commit) => matchesCommit(commit, query));
  }

  function updateHistoryQuery(query: string) {
    cancelHistoryNavigation();
    setHistoryQuery(query);
  }

  function toggleReleaseColumns(repoId: string) {
    const value = !showReleaseColumns;
    setReleaseColumns((saved) => ({ ...saved, [repoId]: value }));
    try { localStorage.setItem(`gitdesk.releaseColumns.${repoId}`, value ? '1' : '0'); } catch { /* View preferences stay available for this session. */ }
  }

  function trackTask() {
    const ids = activeTracking?.ids.length ? activeTracking.ids : selectedOid ? [selectedOid] : [];
    if (!repo || !ids.length) return;
    setReleaseDraft({ repoId: repo.id, ids });
    setTracking(null);
    setPage('releases');
  }

  async function showAllAndLocate(oid: string) {
    const { repoId, worktreeId } = useGitDesk.getState();
    await setScope('all');
    const active = useGitDesk.getState();
    if (active.repoId === repoId && active.worktreeId === worktreeId && active.page === 'history' && active.scope === 'all') await locateCommit(oid);
  }

  return (
    <div className="app-shell">
      <TitleBar native={local} sidebarCollapsed={sidebarCollapsed} onOpenSidebar={() => setSidebarCollapsed(false)} onSearch={findRepository} />
      <div className="app-content">
        {!sidebarCollapsed && (
          <>
            <div className="sidebar-slot" style={{ width: sidebarWidth }}>
              <Sidebar
                inputRef={repositorySearch}
                searchOpen={sidebarSearchOpen}
                onSearch={findRepository}
                onCloseSearch={() => setSidebarSearchOpen(false)}
                onCollapse={() => setSidebarCollapsed(true)}
                onSettings={() => setSettingsOpen(true)}
              />
            </div>
            <ResizeHandle axis="x" label="Resize sidebar" value={sidebarWidth} min={200} max={360} onResize={setSidebarWidth} />
          </>
        )}
        <main className="repository-main" aria-label="Repository">
          {scan && (
            <div className="workspace-banner" role="status">
              <span>{scan.progress ? `Scanning · ${scan.progress.directories} directories · ${scan.progress.repositories} Git roots` : 'Waiting for folder selection…'}</span>
              {scan.progress && <button className="control" onClick={() => { void cancelScan(); }}>Cancel scan</button>}
            </div>
          )}
          {(workspaceNotice || catalog.warning) && <div className="workspace-banner workspace-warning" role="status">{workspaceNotice ?? catalog.warning}</div>}
          {!repo || !worktree ? (
            catalogLoading ? <Notice title="Loading workspaces…" kind="loading" /> : (
              <div className="notice workspace-empty">
                <strong>{catalog.workspaces.length ? 'No repositories in this workspace' : 'Open a workspace'}</strong>
                <p>{catalog.workspaces.length ? 'Rescan a workspace or add a Git repository from the sidebar.' : 'Choose a local folder to find its Git repositories.'}</p>
                <button className="control" disabled={!!scan} onClick={() => { void addWorkspace(); }}>Add workspace</button>
              </div>
            )
          ) : (
            <>
              <RepositoryToolbar key={worktree.id} repo={repo} worktree={worktree} refs={data?.refs ?? []} />
              <div className="tab-bar">
                <nav aria-label="Repository views">
                  {pages.map(({ id, label }) => (
                    <button key={id} aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}>
                      {label}
                      {id === 'changes' && worktree.status.changes > 0 && <span className="tab-count">{worktree.status.changes}</span>}
                    </button>
                  ))}
                </nav>
                {page === 'history' && (
                  <div className="tab-tools">
                    <button className="icon-button" aria-label={showRefs ? 'Hide reference panel' : 'Show reference panel'} aria-controls={showRefs ? 'history-references' : undefined} aria-pressed={showRefs} title={showRefs ? 'Hide reference panel' : 'Show reference panel'} onClick={() => setRefPanelOverride(!showRefs)}>
                      <PanelLeft size={15} aria-hidden="true" />
                    </button>
                    <details className="ref-visibility">
                      <summary className="icon-button" aria-label="Show references" title="Show references"><SlidersHorizontal size={14} aria-hidden="true" /></summary>
                      <div className="ref-visibility-menu">
                        <label><input type="checkbox" checked={refVisibility.local} onChange={() => toggleRefVisibility('local')} /> Local branches</label>
                        <label><input type="checkbox" checked={refVisibility.remote} onChange={() => toggleRefVisibility('remote')} /> Remote branches</label>
                        {local && <label><input type="checkbox" checked={showReleaseColumns} onChange={() => toggleReleaseColumns(repo.id)} /> Release status</label>}
                      </div>
                    </details>
                    <select className="scope-select" data-scope={scope} value={scope} title={focusedRef ?? undefined} aria-label="History scope" onChange={(event) => {
                      const next = event.target.value as HistoryScope;
                      if (next === 'mine' && !authorFilter) setAuthorPickerRepo(repo.id);
                      else void setScope(next);
                    }}>
                      <option value="all">All refs</option>
                      <option value="current">Current branch</option>
                      <option value="local">Local branches</option>
                      {hasAuthorPicker && <option value="mine">My branches</option>}
                      {scope === 'ref' && <option value="ref">Focused branch</option>}
                    </select>
                    {scope === 'mine' && authorFilter && (
                      <button className="icon-button" aria-label="Change commit author" title={`${authorFilter.author.name} <${authorFilter.author.email}>`} onClick={() => setAuthorPickerRepo(repo.id)}>
                        <UserRound size={15} aria-hidden="true" />
                      </button>
                    )}
                    <div className="history-search">
                      <SearchField
                        inputRef={historySearch}
                        label="Search commits"
                        value={historyQuery}
                        onChange={updateHistoryQuery}
                        onEscape={() => { updateHistoryQuery(''); historySearch.current?.blur(); historyGrid.current?.focus(); }}
                        onEnter={jumpToMatch}
                      />
                      {historyQuery.trim() && (
                        <div className="search-navigation">
                          <span role="status" className="match-count" aria-label={`${matches.length} matching commits${localHistory?.hasMore ? ' in loaded history' : ''}`}>{matches.length}</span>
                          <button className="icon-button" title="Previous match" aria-label="Previous match" disabled={!matches.length} onClick={() => jumpToMatch(true)}><ChevronUp size={14} /></button>
                          <button className="icon-button" title="Next match" aria-label="Next match" disabled={!matches.length} onClick={() => jumpToMatch(false)}><ChevronDown size={14} /></button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {page === 'changes' && (
                  <div className="tab-tools">
                    <SearchField inputRef={changesSearch} label="Search changes" value={changesQuery} onChange={setChangesQuery} onEscape={() => { setChangesQuery(''); changesSearch.current?.blur(); }} />
                  </div>
                )}
                {page === 'refs' && hasAuthorPicker && <div className="tab-tools">
                  <button className="control" onClick={() => setAuthorPickerRepo(repo.id)}>My branches…</button>
                </div>}
              </div>

              <div className="repository-page">
                {view.phase === 'error' ? (
                  <Notice title={local ? 'Could not read repository' : 'Could not open sample repository'} kind="error" onRetry={() => { void refresh(); }}>{view.message}</Notice>
                ) : !data && local ? (
                  <Notice title={`Loading ${repo.name}…`} kind="loading" />
                ) : page === 'worktrees' ? (
                  <WorktreesView repo={repo} />
                ) : !data ? (
                  <Notice title={`Loading ${repo.name}…`} kind="loading" />
                ) : page === 'refs' ? (
                  <RefsView key={repo.id} search={refsSearch} refs={data.refs ?? []} worktree={worktree} worktrees={repo.worktrees} />
                ) : page === 'releases' ? (
                  <ReleasesView key={repo.id} repoId={repo.id} refs={data.refs ?? []} shallowStamp={data.shallowStamp} worktree={worktree} draft={releaseDraft?.repoId === repo.id ? releaseDraft.ids : null} onClearDraft={() => setReleaseDraft(null)} />
                ) : page === 'changes' ? (
                  local ? (
                    <>
                      <WorktreeSummary worktree={worktree} />
                      <LocalChanges key={worktree.id} worktree={worktree} snapshot={data} query={changesQuery} fileWidth={fileWidth} onResizeFiles={setFileWidth} />
                    </>
                  ) : (
                    <>
                      <WorktreeSummary worktree={worktree} />
                      <ChangesView key={worktreeId} changes={data.changes} query={changesQuery} fileWidth={fileWidth} onResizeFiles={setFileWidth} />
                    </>
                  )
                ) : history.phase === 'error' ? (
                  <Notice title="Could not read commit history" kind="error" onRetry={() => { void refresh(); }}>{history.message}</Notice>
                ) : (
                  <div className="history-workspace">
                    {showRefs && <HistoryRefs key={repo.id} refs={localHistory?.displayRefs ?? (scope === 'mine' ? [] : historyData?.refs ?? data.refs ?? [])} worktrees={repo.worktrees} worktreeId={worktreeId} />}
                    <div className="history-main">
                      {!historyData ? <Notice title="Loading commits…" kind="loading" /> : historyData.commits.length ? (
                        <HistoryTable key={localHistory?.sessionId ?? `${worktreeId}-${scope}-${focusedRef}`} data={historyData} gridRef={historyGrid} query={historyQuery} matches={matchIds} showHash={showHash} viewportWidth={historyWidth} hasMore={localHistory?.hasMore} paging={localHistory?.paging} releaseStatus={local && showReleaseColumns} tracking={activeTracking ? { ids: activeTracking.ids, onToggle: (oid) => setTracking({ ...activeTracking, ids: activeTracking.ids.includes(oid) ? activeTracking.ids.filter((id) => id !== oid) : activeTracking.ids.length < 200 ? [...activeTracking.ids, oid] : activeTracking.ids }) } : undefined} />
                      ) : <Notice title={scope === 'mine' ? 'No branches match this author' : scope === 'all' ? 'No commits yet' : 'No commits in this history scope'} />}
                      {(localHistory?.commits.length || localHistory?.hasMore || localHistory?.pageMessage || historyNavigation) ? (
                        <div className="history-footer">
                          <span role="status">{historyNavigation?.message ?? localHistory?.pageMessage ?? (localHistory?.paging ? 'Loading older commits…' : `${localHistory?.commits.length.toLocaleString()} commits loaded`)}</span>
                          {historyNavigation?.phase === 'finding' ? <button className="control" onClick={cancelHistoryNavigation}>Cancel</button> : (
                            <>
                              {historyNavigation?.phase === 'missing' && navigationOid && scope !== 'all' && <button className="control" onClick={() => { void showAllAndLocate(navigationOid); }}>All refs</button>}
                              {historyNavigation?.phase === 'continue' && navigationOid && localHistory?.hasMore && <button className="control" onClick={() => { void locateCommit(navigationOid); }}>Keep looking</button>}
                              {localHistory?.hasMore && historyQuery.trim() && <button className="control" onClick={searchOlder}>Search older</button>}
                              {localHistory?.hasMore && <button className="control" disabled={localHistory.paging} onClick={() => { void loadMoreHistory(); }}>Load older</button>}
                              {localHistory?.pageMessage && <button className="control" onClick={() => { void refresh(); }}>Refresh</button>}
                              {localHistory && !!localHistory.commits.length && (
                                <>
                                  <button className="control" aria-pressed={!!activeTracking} onClick={() => setTracking(activeTracking ? null : { sessionId: localHistory.sessionId, ids: selectedOid ? [selectedOid] : [] })}>{activeTracking ? 'Cancel selection' : 'Select commits'}</button>
                                  <button className="control" disabled={activeTracking ? !activeTracking.ids.length : !selectedOid} onClick={trackTask}>Track as task{activeTracking ? ` (${activeTracking.ids.length})` : ''}</button>
                                </>
                              )}
                            </>
                          )}
                        </div>
                      ) : null}
                      {detail && (
                        <>
                          <ResizeHandle axis="y" label="Resize commit details" value={shownDetailHeight} min={150} max={maxDetailHeight} reverse onResize={setDetailHeight} />
                          <CommitDetails key={detail.commit.oid} height={shownDetailHeight} fileWidth={fileWidth} onResizeFiles={setFileWidth} onClose={dismissDetail} />
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </main>
      </div>
      <StatusBar />
      {repo && authorPickerVisible && <AuthorFilterDialog
        key={repo.id}
        repoId={repo.id}
        refs={data?.refs ?? []}
        saved={authorFilter}
        onClose={() => setAuthorPickerRepo(null)}
        onApply={(filter) => { setAuthorPickerRepo(null); void showMyBranches(filter); }}
      />}
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} showHash={showHash} setShowHash={setShowHash} appearance={appearance} setAppearance={setAppearance} local={local} />
    </div>
  );
}
