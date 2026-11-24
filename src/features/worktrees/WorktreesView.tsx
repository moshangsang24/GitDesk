import { GitBranch, GitCommitVertical, LockKeyhole } from 'lucide-react';
import type { Repository } from '../../services/contracts';
import { useGitDesk } from '../../stores/gitdesk';
import { RepoStatus } from '../workspace/RepoStatus';

export function WorktreesView({ repo }: { repo: Repository }) {
  const selected = useGitDesk((state) => state.worktreeId);
  const openWorktree = useGitDesk((state) => state.openWorktree);

  return (
    <div className="worktrees-view">
      <table className="worktree-table">
        <caption className="sr-only">Worktrees for {repo.name}</caption>
        <thead>
          <tr>
            <th scope="col">Branch / HEAD</th>
            <th scope="col">Worktree path</th>
            <th scope="col">Status</th>
            <th scope="col"><span className="sr-only">Browse</span></th>
          </tr>
        </thead>
        <tbody>
          {repo.worktrees.map((tree) => {
            const active = selected === tree.id;
            return (
              <tr key={tree.id} data-viewing={active || undefined}>
                <td>
                  <span className="worktree-branch">
                    {tree.branch ? <GitBranch size={14} /> : <GitCommitVertical size={14} />}
                    <span className="truncate" title={tree.branch ?? tree.head ?? 'Unborn HEAD'}>
                      {tree.status.branchNameUnavailable ? 'Branch name unavailable' : tree.branch ?? (tree.bare ? 'Bare' : tree.head ? `Detached ${tree.head.slice(0, 7)}` : 'Unknown')}
                    </span>
                  </span>
                </td>
                <td>
                  <span className="worktree-path">
                    <span className="truncate" title={tree.path}>{tree.path}</span>
                    {tree.external && <span className="worktree-label">External</span>}
                    {tree.locked && <span className="worktree-label"><LockKeyhole size={11} /> Locked</span>}
                    {tree.prunable && <span className="worktree-label">Prunable</span>}
                  </span>
                </td>
                <td><RepoStatus status={tree.status} /></td>
                <td className="worktree-action">
                  <button
                    className={active ? 'control worktree-viewing' : 'control'}
                    aria-label={`${active ? 'Viewing' : 'View'} worktree ${tree.path}`}
                    aria-current={active || undefined}
                    aria-disabled={active || undefined}
                    onClick={(event) => {
                      event.currentTarget.focus({ preventScroll: true });
                      if (!active) void openWorktree(tree.id);
                    }}
                  >
                    {active ? 'Viewing' : 'View'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
