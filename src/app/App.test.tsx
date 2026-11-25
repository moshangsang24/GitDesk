// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, expect, it } from 'vitest';
import { HistoryLayout } from '../core/graph/layout';
import { HistoryTable } from '../features/history/HistoryTable';
import type { HistoryCommit, Worktree } from '../services/contracts';
import { useGitDesk, type HistoryData } from '../stores/gitdesk';
import { App } from './App';

afterEach(() => {
  cleanup();
  useGitDesk.setState(useGitDesk.getInitialState(), true);
});

it('replaces release comparison when the worktree or history session changes', () => {
  const repo = useGitDesk.getInitialState().catalog.repositories['conversation-agent'];
  const [first, second] = repo.worktrees;
  function historyFor(tree: Worktree, sessionId: string): HistoryData {
    const commit: HistoryCommit = {
      oid: tree.head!, parents: [], subject: 'Test commit', authorName: 'Test', authorTime: 0, shallowBoundary: false,
    };
    return {
      sessionId, tableKey: sessionId, head: tree.head, shallowStamp: null,
      commits: [{ ...commit, refs: [] }], graphRows: new HistoryLayout().append([commit]),
      refs: [], displayRefs: [], hasMore: false, paging: false, stale: false, pageMessage: null,
      comparison: { head: tree.head, targetRevision: 1, targets: [null, null, null], tips: [null, null, null], shallowStamp: null },
    };
  }

  useGitDesk.setState({
    local: true, page: 'history', scope: 'releaseTargets', repoId: repo.id, worktreeId: first.id,
    view: { phase: 'ready', data: { repository: repo, commits: [], graphRows: [], changes: [] } },
    history: { phase: 'ready', data: historyFor(first, 'session-1') },
    initialize: async () => undefined, startLiveUpdates: () => () => undefined,
  });
  render(<App />);

  for (const [index, tree] of [second, first, first].entries()) {
    act(() => useGitDesk.setState({
      worktreeId: tree.id, history: { phase: 'ready', data: historyFor(tree, `session-${index + 2}`) },
    }));
    expect(within(screen.getByRole('region', { name: 'Release branch comparison' })).getByText(tree.branch!)).toBeDefined();
  }
});

it('keeps wide graphs compact until the full lane width is requested', () => {
  const commit = { oid: 'a'.repeat(40), parents: [], subject: 'Test commit', authorName: 'Test', authorTime: 0, shallowBoundary: false, refs: [] };
  const [row] = new HistoryLayout().append([commit]);
  const graph = { ...row, through: [{ lane: 16, colorId: 1 }] };
  render(<HistoryTable data={{ commits: [commit], graphRows: [graph] }} gridRef={createRef()} query=""
    matches={new Set()} showHash viewportWidth={810} />);
  const grid = screen.getByRole('grid', { name: 'Commit history' });
  expect(grid.style.getPropertyValue('--history-columns')).toContain('118px');
  fireEvent.click(screen.getByRole('button', { name: 'Show full graph' }));
  expect(grid.style.getPropertyValue('--history-columns')).toContain('248px');
  expect(screen.getByRole('button', { name: 'Show compact graph' }).getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Show compact graph' }));
  expect(grid.style.getPropertyValue('--history-columns')).toContain('118px');
});
