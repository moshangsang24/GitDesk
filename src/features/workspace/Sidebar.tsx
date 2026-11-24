import {
  ChevronDown, ChevronRight, FolderGit2, GitBranch, PanelLeftClose,
  Plus, RefreshCw, Search, Settings, X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { SearchField } from '../../components/ui/SearchField';
import { useGitDesk } from '../../stores/gitdesk';
import { RepoStatus } from './RepoStatus';

interface Props {
  inputRef: RefObject<HTMLInputElement | null>;
  searchOpen: boolean;
  onSearch: () => void;
  onCloseSearch: () => void;
  onCollapse: () => void;
  onSettings: () => void;
}

export function Sidebar({ inputRef, searchOpen, onSearch, onCloseSearch, onCollapse, onSettings }: Props) {
  const catalog = useGitDesk((state) => state.catalog);
  const local = useGitDesk((state) => state.local);
  const repoId = useGitDesk((state) => state.repoId);
  const worktreeId = useGitDesk((state) => state.worktreeId);
  const openRepository = useGitDesk((state) => state.openRepository);
  const refresh = useGitDesk((state) => state.refresh);
  const addWorkspace = useGitDesk((state) => state.addWorkspace);
  const addRepository = useGitDesk((state) => state.addRepository);
  const rescanWorkspace = useGitDesk((state) => state.rescanWorkspace);
  const removeWorkspace = useGitDesk((state) => state.removeWorkspace);
  const removeRepository = useGitDesk((state) => state.removeRepository);
  const busy = useGitDesk((state) => state.scan !== null || state.catalogLoading || state.updatingCatalog);
  const [collapsed, setCollapsed] = useState(() => {
    if (!local) return new Set(['personal']);
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('gitdesk.workspace-folds') ?? '[]');
      return new Set<string>(Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : []);
    } catch {
      return new Set<string>();
    }
  });
  const [query, setQuery] = useState('');
  const search = searchOpen ? query.trim().toLowerCase() : '';
  const toggleSearchRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (searchOpen) inputRef.current?.focus();
  }, [inputRef, searchOpen]);

  useEffect(() => {
    if (!local) return;
    try {
      localStorage.setItem('gitdesk.workspace-folds', JSON.stringify([...collapsed]));
    } catch {
      // Folding remains available for this session.
    }
  }, [collapsed, local]);

  function toggleWorkspace(id: string) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function closeSearch() {
    setQuery('');
    onCloseSearch();
    toggleSearchRef.current?.focus();
  }

  const groups = catalog.workspaces.map((workspace) => ({
    workspace,
    repositories: workspace.repositoryIds
      .map((id) => catalog.repositories[id])
      .filter((repository) => !search || repository.name.toLowerCase().includes(search)
        || repository.worktrees.some(({ path }) => path.toLowerCase().includes(search))),
  }));
  const activeWorkspace = catalog.workspaces.find(({ repositoryIds }) => repositoryIds.includes(repoId)) ?? catalog.workspaces[0];

  return (
    <aside className="sidebar" aria-label="Workspaces">
      <div className="sidebar-heading">
        <span className="section-caption">Workspaces</span>
        <div className="sidebar-heading-actions">
          <button ref={toggleSearchRef} className="icon-button" aria-label="Find repository (⌘K)" title="Find repository (⌘K)" onClick={onSearch}>
            <Search size={15} />
          </button>
          <button className="icon-button" aria-label="Collapse sidebar" title="Collapse sidebar" onClick={onCollapse}>
            <PanelLeftClose size={15} />
          </button>
          <button className="icon-button" disabled={!local || busy} aria-label={local ? 'Add workspace' : 'Add workspace (desktop only)'} title={local ? 'Add workspace' : 'Choose a folder in the desktop app'} onClick={() => { void addWorkspace(); }}>
            <Plus size={17} />
          </button>
        </div>
      </div>

      {searchOpen && (
        <div className="sidebar-search">
          <SearchField
            inputRef={inputRef}
            label="Search repositories"
            value={query}
            onChange={setQuery}
            onEscape={closeSearch}
            onEnter={() => {
              const first = groups.find(({ repositories }) => repositories.length > 0)?.repositories[0];
              if (first) { void openRepository(first.id); closeSearch(); }
            }}
          />
        </div>
      )}

      <div className="sidebar-scroll">
        {groups.map(({ workspace, repositories }) => {
          if (search && repositories.length === 0) return null;
          const isExpanded = !collapsed.has(workspace.id) || !!search;
          return (
            <section key={workspace.id} className="workspace-group">
              <div className="workspace-heading-row">
                <button
                  className="workspace-title"
                  aria-expanded={isExpanded}
                  aria-controls={`workspace-${workspace.id}`}
                  disabled={!!search}
                  title={workspace.warning ?? workspace.rootPath}
                  onClick={() => toggleWorkspace(workspace.id)}
              >
                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span>{workspace.name}</span>
                  {workspace.missing && <span className="workspace-missing">Missing</span>}
                  <span className="workspace-count">{repositories.length}</span>
                </button>
                {local && !search && (
                  <div className="workspace-actions">
                    <button className="icon-button" disabled={busy} aria-label={`Add repository to ${workspace.name}`} title="Add repository to this workspace" onClick={() => { void addRepository(workspace.id); }}><Plus size={13} /></button>
                    <button className="icon-button" disabled={busy} aria-label={`Rescan ${workspace.name}`} title="Rescan workspace" onClick={() => { void rescanWorkspace(workspace.id); }}><RefreshCw size={13} /></button>
                    <button className="icon-button" disabled={busy} aria-label={`Remove ${workspace.name} from GitDesk`} title="Remove from GitDesk" onClick={() => { void removeWorkspace(workspace.id); }}><X size={13} /></button>
                  </div>
                )}
              </div>
              <ul id={`workspace-${workspace.id}`} className="repository-list" hidden={!isExpanded}>
                {local && repositories.length === 0 && <li className="sidebar-empty">No repositories</li>}
                {repositories.map((repository) => {
                  const active = repository.id === repoId;
                  const tree = (active && repository.worktrees.find(({ id }) => id === worktreeId)) || repository.worktrees[0];
                  const branch = tree.status.branchNameUnavailable ? 'Branch name unavailable' : tree.branch ?? (tree.head ? `Detached ${tree.head.slice(0, 7)}` : tree.bare ? 'Bare repository' : 'Unknown branch');
                  return (
                    <li key={repository.id} className={local ? 'local-repository-row' : undefined}>
                      <button
                        className="repository-button"
                        aria-current={active ? 'true' : undefined}
                        title={`${repository.name}\n${tree.path}`}
                        onClick={(event) => {
                          event.currentTarget.focus({ preventScroll: true });
                          void openRepository(repository.id);
                        }}
                      >
                        <GitBranch size={18} strokeWidth={1.6} className="repository-icon" aria-hidden="true" />
                        <span className="repository-label">
                          <span className="truncate">{repository.name}</span>
                          <span className="repository-branch truncate">{branch}</span>
                        </span>
                        <RepoStatus status={tree.status} compact />
                      </button>
                      {local && (
                        <button
                          className="icon-button remove-repository"
                          aria-label={`Remove ${repository.name} from ${workspace.name}`}
                          title="Remove from this workspace"
                          disabled={busy}
                          onClick={(event) => {
                            const heading = event.currentTarget.closest('section')?.querySelector<HTMLButtonElement>('.workspace-title');
                            (search ? inputRef.current : heading)?.focus({ preventScroll: true });
                            void removeRepository(workspace.id, repository.id);
                          }}
                        ><X size={13} /></button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}

        {search && groups.every(({ repositories }) => repositories.length === 0) && (
          <p className="sidebar-empty" role="status">No matching repositories.</p>
        )}
      </div>

      <div className="sidebar-footer">
        <button className="sidebar-action" disabled={!local || !activeWorkspace || busy} title={activeWorkspace && local ? `Add a repository to ${activeWorkspace.name}` : 'Add a workspace first in the desktop app'} onClick={() => { if (activeWorkspace) void addRepository(activeWorkspace.id); }}>
          <FolderGit2 size={14} aria-hidden="true" /> Add repository
        </button>
        <button className="sidebar-action" disabled={!repoId} title="Refresh the current repository (⌘R)" onClick={() => { void refresh(); }}>
          <RefreshCw size={13} aria-hidden="true" /> Refresh repository
        </button>
        <button className="sidebar-action" onClick={onSettings}>
          <Settings size={14} aria-hidden="true" /> Settings
        </button>
      </div>
    </aside>
  );
}
