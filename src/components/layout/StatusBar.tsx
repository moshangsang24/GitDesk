import { useGitDesk } from '../../stores/gitdesk';

export function StatusBar() {
  const catalog = useGitDesk((state) => state.catalog);
  const repoId = useGitDesk((state) => state.repoId);
  const phase = useGitDesk((state) => state.view.phase);
  const local = useGitDesk((state) => state.local);
  const workspace = catalog.workspaces.find(({ repositoryIds }) => repositoryIds.includes(repoId));
  const ids = workspace?.repositoryIds ?? [];
  const changed = ids.filter((id) => catalog.repositories[id].worktrees.some(({ status }) => status.changes > 0)).length;
  const unknown = ids.filter((id) => catalog.repositories[id].worktrees.some(({ status }) => status.kind === 'unknown')).length;
  const summary = `${ids.length} repositories · ${changed} modified${local && unknown ? ` · ${unknown} with unknown status` : ''}`;
  const loading = phase === 'idle' || phase === 'loading';
  const status = !repoId ? (catalog.workspaces.length ? 'No repository selected' : 'No workspaces')
    : loading ? `Loading ${local ? '' : 'sample '}repository…`
    : phase === 'error' ? 'Repository unavailable' : summary;

  return (
    <footer className="status-bar">
      <span className={`workspace-status status-${phase}`}>
        <span className="status-dot" aria-hidden="true" />
        {status}
      </span>
      <span className="mock-indicator" title={local ? 'Git operations run on this Mac after you confirm them' : 'GitDesk is displaying simulated repository data'}>
        <strong>{local ? 'Local Git' : 'Mock mode'}</strong>{!local && <><span aria-hidden="true">·</span><span>v0.1 prototype</span></>}
      </span>
    </footer>
  );
}
