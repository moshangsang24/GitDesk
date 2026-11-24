import { copyWithNotice, notify, requestConfirmation } from '../../services/context-menu';
import { displayError, useGitDesk } from '../../stores/gitdesk';

export function copy(text: string, what: string) {
  void copyWithNotice(text, what);
}

/** Opens a specific worktree in Finder or Terminal without switching the browsing context. */
export async function openLocationFor(repoId: string, worktreeId: string, destination: 'finder' | 'terminal') {
  const review = useGitDesk.getState().service.review;
  if (!review) {
    notify('Finder and Terminal are available in the desktop app.', true);
    return;
  }
  try {
    await review.open(repoId, worktreeId, destination);
  } catch (error) {
    notify(displayError(error), true);
  }
}

export async function confirmRemoveRepository(workspace: { id: string; name: string }, repository: { id: string; name: string }) {
  const confirmed = await requestConfirmation({
    title: `Remove “${repository.name}” from ${workspace.name}?`,
    message: 'GitDesk stops showing this repository. Its files and Git data on disk are not changed, and you can add it again later.',
    confirmLabel: 'Remove',
  });
  if (confirmed) await useGitDesk.getState().removeRepository(workspace.id, repository.id);
}

/** Absolute path of a repository-relative file inside the worktree being browsed. */
export function worktreeFilePath(relative: string): string | null {
  const { catalog, repoId, worktreeId } = useGitDesk.getState();
  const root = catalog.repositories[repoId]?.worktrees.find(({ id }) => id === worktreeId)?.path;
  if (!root) return null;
  return `${root.replace(/\/+$/u, '')}/${relative}`;
}
