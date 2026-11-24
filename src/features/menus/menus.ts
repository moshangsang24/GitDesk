import type { Commit, GitRef } from '../../services/contracts';
import { separator, type MenuEntry } from '../../services/context-menu';

/**
 * Menu definitions. They are pure so tests can check what each menu offers.
 * Every item is read-only: Git writes join these menus only through the M5
 * confirmation flow.
 */

const desktopOnly = ' (Desktop App Only)';

export interface CopyAction { copy(text: string, what: string): void }

export function commitMenu(
  commit: Pick<Commit, 'oid' | 'subject' | 'refs'>,
  actions: CopyAction & { focusBranch(fullName: string): void },
): MenuEntry[] {
  const branches = commit.refs.filter(({ kind }) => kind === 'local').slice(0, 3);
  return [
    { kind: 'action', id: 'copy-hash', label: 'Copy Hash', shortcut: 'copy', run: () => actions.copy(commit.oid, 'commit hash') },
    { kind: 'action', id: 'copy-short-hash', label: 'Copy Short Hash', run: () => actions.copy(commit.oid.slice(0, 7), 'short hash') },
    { kind: 'action', id: 'copy-subject', label: 'Copy Subject', run: () => actions.copy(commit.subject, 'commit subject') },
    separator,
    ...branches.map(({ name }): MenuEntry => ({
      kind: 'action', id: `focus:${name}`, label: `Focus History on “${name}”`, run: () => actions.focusBranch(`refs/heads/${name}`),
    })),
  ];
}

export function refMenu(
  ref: { kind: GitRef['kind']; fullName: string; name: string; targetOid: string },
  actions: CopyAction & { locate(oid: string): void; focusBranch(fullName: string): void },
): MenuEntry[] {
  return [
    { kind: 'action', id: 'locate', label: 'Locate Commit', run: () => actions.locate(ref.targetOid) },
    ...(ref.kind === 'tag' ? [] : [{
      kind: 'action' as const, id: 'focus', label: 'Focus History on This Branch', run: () => actions.focusBranch(ref.fullName),
    }]),
    separator,
    { kind: 'action', id: 'copy-name', label: 'Copy Name', run: () => actions.copy(ref.name, 'name') },
  ];
}

interface LocationActions {
  reveal(): void;
  terminal(): void;
}

export function repositoryMenu(
  repository: { active: boolean; path: string; local: boolean; available: boolean },
  actions: CopyAction & LocationActions & { open(): void; refresh(): void; remove(): void },
): MenuEntry[] {
  const unavailable = !repository.local ? desktopOnly : !repository.available ? ' (Worktree Unavailable)' : '';
  return [
    repository.active
      ? { kind: 'action', id: 'refresh', label: 'Refresh', shortcut: 'refresh', run: actions.refresh }
      : { kind: 'action', id: 'open', label: 'Open Repository', run: actions.open },
    separator,
    { kind: 'action', id: 'reveal', label: `Reveal in Finder${unavailable}`, disabled: !!unavailable, run: actions.reveal },
    { kind: 'action', id: 'terminal', label: `Open in Terminal${unavailable}`, disabled: !!unavailable, run: actions.terminal },
    { kind: 'action', id: 'copy-path', label: 'Copy Path', run: () => actions.copy(repository.path, 'path') },
    separator,
    ...(repository.local ? [{ kind: 'action' as const, id: 'remove', label: 'Remove from Workspace…', run: actions.remove }] : []),
  ];
}

export function fileMenu(
  file: { path: string; fullPath: string | null },
  actions: CopyAction & { show(): void },
): MenuEntry[] {
  return [
    { kind: 'action', id: 'show', label: 'Show Diff', run: actions.show },
    separator,
    { kind: 'action', id: 'copy-path', label: 'Copy Path', run: () => actions.copy(file.path, 'path') },
    ...(file.fullPath ? [{ kind: 'action' as const, id: 'copy-full-path', label: 'Copy Full Path', run: () => actions.copy(file.fullPath!, 'full path') }] : []),
  ];
}

export function worktreeMenu(
  worktree: { active: boolean; path: string; local: boolean; prunable: boolean },
  actions: CopyAction & LocationActions & { browse(): void },
): MenuEntry[] {
  const unavailable = !worktree.local ? desktopOnly : worktree.prunable ? ' (Worktree Missing)' : '';
  return [
    ...(worktree.active ? [] : [{ kind: 'action' as const, id: 'browse', label: 'Browse This Worktree', run: actions.browse }]),
    separator,
    { kind: 'action', id: 'reveal', label: `Reveal in Finder${unavailable}`, disabled: !!unavailable, run: actions.reveal },
    { kind: 'action', id: 'terminal', label: `Open in Terminal${unavailable}`, disabled: !!unavailable, run: actions.terminal },
    { kind: 'action', id: 'copy-path', label: 'Copy Path', run: () => actions.copy(worktree.path, 'path') },
  ];
}
