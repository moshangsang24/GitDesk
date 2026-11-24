import { describe, expect, it, vi } from 'vitest';
import { normalizeMenu, separator, type MenuEntry } from '../../services/context-menu';
import { commitMenu, fileMenu, refMenu, repositoryMenu, worktreeMenu } from './menus';

const labels = (entries: MenuEntry[]) => normalizeMenu(entries).map((entry) => entry.kind === 'separator' ? '—' : entry.label);
const find = (entries: MenuEntry[], id: string) => entries.find((entry) => entry.kind === 'action' && entry.id === id);
const run = (entries: MenuEntry[], id: string) => {
  const entry = find(entries, id);
  if (entry?.kind !== 'action') throw new Error(`missing ${id}`);
  entry.run();
};
const noop = () => undefined;
const oid = 'a'.repeat(40);

/** Words that would indicate a Git write sneaking into a read-only menu. */
const writeWords = /\b(checkout|switch|reset|revert|cherry|merge|rebase|push|pull|fetch|delete|stash|commit to|create branch)\b/iu;

describe('context menu definitions', () => {
  it('normalises separators left by hidden items', () => {
    const action: MenuEntry = { kind: 'action', id: 'x', label: 'X', run: noop };
    expect(normalizeMenu([separator, action, separator, separator, action, separator])).toEqual([action, separator, action]);
  });

  it('offers copy actions and focus for each local branch on a commit', () => {
    const copy = vi.fn();
    const focusBranch = vi.fn();
    const entries = commitMenu({ oid, subject: 'Fix routing', refs: [
      { kind: 'head', name: 'HEAD' }, { kind: 'local', name: 'main' }, { kind: 'remote', name: 'origin/main' }, { kind: 'tag', name: 'v1' },
    ] }, { copy, focusBranch });
    expect(labels(entries)).toEqual(['Copy Hash', 'Copy Short Hash', 'Copy Subject', '—', 'Focus History on “main”']);
    run(entries, 'copy-hash');
    run(entries, 'copy-short-hash');
    run(entries, 'focus:main');
    expect(copy).toHaveBeenNthCalledWith(1, oid, 'commit hash');
    expect(copy).toHaveBeenNthCalledWith(2, 'aaaaaaa', 'short hash');
    expect(focusBranch).toHaveBeenCalledWith('refs/heads/main');
  });

  it('hides branch focus for commits without local branches', () => {
    expect(labels(commitMenu({ oid, subject: 's', refs: [] }, { copy: noop, focusBranch: noop }))).toEqual(['Copy Hash', 'Copy Short Hash', 'Copy Subject']);
  });

  it('only offers branch focus for branches, not tags', () => {
    const actions = { copy: noop, locate: noop, focusBranch: noop };
    expect(labels(refMenu({ kind: 'remote', fullName: 'refs/remotes/origin/main', name: 'origin/main', targetOid: oid }, actions)))
      .toEqual(['Locate Commit', 'Focus History on This Branch', '—', 'Copy Name']);
    expect(labels(refMenu({ kind: 'tag', fullName: 'refs/tags/v1', name: 'v1', targetOid: oid }, actions)))
      .toEqual(['Locate Commit', '—', 'Copy Name']);
  });

  it('acts on a repository row without switching to it', () => {
    const actions = { copy: noop, open: vi.fn(), refresh: vi.fn(), reveal: noop, terminal: noop, remove: noop };
    const inactive = repositoryMenu({ active: false, path: '/w/app', local: true, available: true }, actions);
    expect(labels(inactive)).toEqual(['Open Repository', '—', 'Reveal in Finder', 'Open in Terminal', 'Copy Path', '—', 'Remove from Workspace…']);
    const active = repositoryMenu({ active: true, path: '/w/app', local: true, available: true }, actions);
    expect(find(active, 'refresh')).toMatchObject({ shortcut: 'refresh' });
  });

  it('explains unavailable locations and hides removal in the browser preview', () => {
    const actions = { copy: noop, open: noop, refresh: noop, reveal: noop, terminal: noop, remove: noop };
    const preview = repositoryMenu({ active: true, path: '/w/app', local: false, available: true }, actions);
    expect(find(preview, 'reveal')).toMatchObject({ disabled: true, label: 'Reveal in Finder (Desktop App Only)' });
    expect(find(preview, 'remove')).toBeUndefined();
    const missing = worktreeMenu({ active: false, path: '/w/gone', local: true, prunable: true }, { copy: noop, browse: noop, reveal: noop, terminal: noop });
    expect(find(missing, 'terminal')).toMatchObject({ disabled: true, label: 'Open in Terminal (Worktree Missing)' });
  });

  it('omits Browse for the worktree already being viewed', () => {
    const actions = { copy: noop, browse: noop, reveal: noop, terminal: noop };
    expect(labels(worktreeMenu({ active: true, path: '/w', local: true, prunable: false }, actions)))
      .toEqual(['Reveal in Finder', 'Open in Terminal', 'Copy Path']);
  });

  it('copies full file paths only when the worktree root is known', () => {
    expect(labels(fileMenu({ path: 'a.txt', fullPath: '/w/a.txt' }, { copy: noop, show: noop }))).toEqual(['Show Diff', '—', 'Copy Path', 'Copy Full Path']);
    expect(labels(fileMenu({ path: 'a.txt', fullPath: null }, { copy: noop, show: noop }))).toEqual(['Show Diff', '—', 'Copy Path']);
  });

  it('never offers Git write operations', () => {
    const all = [
      ...commitMenu({ oid, subject: 's', refs: [{ kind: 'local', name: 'main' }] }, { copy: noop, focusBranch: noop }),
      ...refMenu({ kind: 'local', fullName: 'refs/heads/main', name: 'main', targetOid: oid }, { copy: noop, locate: noop, focusBranch: noop }),
      ...repositoryMenu({ active: false, path: '/w', local: true, available: true }, { copy: noop, open: noop, refresh: noop, reveal: noop, terminal: noop, remove: noop }),
      ...fileMenu({ path: 'a', fullPath: '/w/a' }, { copy: noop, show: noop }),
      ...worktreeMenu({ active: false, path: '/w', local: true, prunable: false }, { copy: noop, browse: noop, reveal: noop, terminal: noop }),
    ];
    for (const entry of all) if (entry.kind === 'action') expect(entry.label).not.toMatch(writeWords);
  });
});
