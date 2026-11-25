// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitRef, HistoryCommit, Worktree } from '../../services/contracts';
import { useMenuState } from '../../services/context-menu';
import type { Candidates, ReleaseActions } from '../../services/release';
import { useGitDesk } from '../../stores/gitdesk';
import { ContextMenuHost } from '../menus/ContextMenuHost';
import { TaskForm } from './ReleaseForms';
import { ReleasesView } from './ReleasesView';
import { defaultTaskBase, taskFieldsFromSource } from './task-draft';

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const other = 'c'.repeat(40);
const branch = 'task/5111-period-causality-rework';
const worktree: Worktree = {
  id: 'worktree', path: '/tmp/worktree', branch, head, status: { kind: 'clean', changes: 0, ahead: 2, behind: 0 },
};
const master: GitRef = { fullName: 'refs/remotes/origin/master', targetOid: base, kind: 'remote', symbolicTarget: null };
const main: GitRef = { fullName: 'refs/heads/main', targetOid: other, kind: 'local', symbolicTarget: null };
const localMaster: GitRef = { ...main, fullName: 'refs/heads/master' };
const commits: HistoryCommit[] = [
  { oid: head, parents: [other], subject: 'Finish the feature', authorName: 'Example', authorTime: 1, shallowBoundary: false },
  { oid: other, parents: [base], subject: 'Start the feature', authorName: 'Example', authorTime: 0, shallowBoundary: false },
];

function releaseFixture(truncated = false) {
  const overview = { targetRevision: 0, targets: [null, null, null] as [null, null, null], tasks: [] };
  return {
    candidates: vi.fn<ReleaseActions['candidates']>(async () => ({ commits, baseOid: base, headOid: head, truncated })),
    saveTask: vi.fn(async () => overview),
    editLinks: vi.fn(async () => overview),
    overview: vi.fn(async () => overview), saveTargets: vi.fn(async () => overview), deleteTask: vi.fn(async () => overview),
    observations: vi.fn(async () => []), evaluate: vi.fn(async () => ({ targetRevision: 0, taskRevision: null, stages: [] })),
  } satisfies ReleaseActions;
}

afterEach(() => {
  cleanup();
  useGitDesk.setState(useGitDesk.getInitialState(), true);
  useMenuState.setState({ menu: null, toast: null, confirmation: null });
});

describe('quick release tasks', () => {
  it('prefers master and falls back to main without using aliases', () => {
    expect(defaultTaskBase([main, localMaster, master])).toBe(master);
    expect(defaultTaskBase([main, localMaster])).toBe(localMaster);
    expect(defaultTaskBase([{ ...master, symbolicTarget: 'refs/heads/main' }, main])).toBe(main);
    expect(defaultTaskBase([])).toBeUndefined();
    expect(taskFieldsFromSource('feature/period-causality-rework')).toBeNull();
  });

  it('fills task metadata and prepares a selected, editable range relative to origin/master', async () => {
    const release = releaseFixture();
    render(<TaskForm release={release} repoId="repo" refs={[main, master]} worktree={worktree} inputOids={[]} onSave={vi.fn()} onClose={vi.fn()} />);
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('task: period-causality-rework');
    expect((screen.getByLabelText('Task IDs') as HTMLInputElement).value).toBe('5111');

    fireEvent.click(screen.getByRole('button', { name: 'Review commits vs origin/master' }));
    const finish = await screen.findByRole('checkbox', { name: /Finish the feature/ }) as HTMLInputElement;
    expect(release.candidates).toHaveBeenCalledExactlyOnceWith('repo', base, head, expect.any(AbortSignal));
    expect(finish.checked).toBe(true);
    expect(screen.queryByLabelText('Base commit')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /Start the feature/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await waitFor(() => expect(release.saveTask).toHaveBeenCalled());
    expect(release.saveTask).toHaveBeenCalledWith('repo', expect.objectContaining({
      fields: { title: 'task: period-causality-rework', issue: '5111', source: branch, commitOids: [head], baseOid: base, headOid: head, archived: false },
    }), expect.any(AbortSignal));
  });

  it('normalizes multiple task IDs and preserves them when the Source is edited', async () => {
    const release = releaseFixture();
    render(<TaskForm release={release} repoId="repo" refs={[]} worktree={worktree} inputOids={[head]} onSave={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Task IDs'), { target: { value: ' 5111，3745, 5111, ' } });
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'fix/4091-another-branch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await waitFor(() => expect(release.saveTask).toHaveBeenCalledWith('repo', expect.objectContaining({
      fields: expect.objectContaining({ issue: '5111, 3745', commitOids: [head] }),
    }), expect.any(AbortSignal)));
  });

  it('finds either task ID and shows separate records sharing a task ID', async () => {
    const release = releaseFixture();
    const fields = { title: 'Backend changes', issue: '3848, 3745', source: 'fix/backend', commitOids: [head], baseOid: null, headOid: null, archived: false };
    const overview = {
      targetRevision: 0, targets: [null, null, null] as [null, null, null], tasks: [
        { id: 'backend', revision: 1, fields },
        { id: 'frontend', revision: 1, fields: { ...fields, title: 'Frontend changes', issue: '3745', source: 'fix/frontend' } },
      ],
    };
    useGitDesk.setState((state) => ({ service: { ...state.service, release: { ...release, overview: async () => overview } } }));
    render(<>
      <ReleasesView repoId="repo" refs={[]} worktree={worktree} draft={null} onClearDraft={vi.fn()} onConfigure={vi.fn()} />
      <ContextMenuHost />
    </>);
    const backend = await screen.findByRole('row', { name: /Backend changes/ });
    expect(within(backend).getByText('3848')).toBeDefined();
    expect(within(backend).getByText('3745')).toBeDefined();
    const search = screen.getByRole('searchbox', { name: 'Search tasks' });
    fireEvent.change(search, { target: { value: '3745' } });
    expect(screen.getByText('Backend changes')).toBeDefined();
    expect(screen.getByText('Frontend changes')).toBeDefined();
    fireEvent.change(search, { target: { value: '3848' } });
    expect(screen.getByText('Backend changes')).toBeDefined();
    expect(screen.queryByText('Frontend changes')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Backend changes' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect((screen.getByRole('textbox', { name: 'Task IDs' }) as HTMLInputElement).value).toBe('3848, 3745');
  });

  it('uses the saved Master ref for task candidates and reports a missing saved ref', () => {
    const release = releaseFixture();
    const configured: GitRef = { ...master, fullName: 'refs/remotes/upstream/main' };
    const props = { release, repoId: 'repo', worktree, inputOids: [], masterRef: configured.fullName, onSave: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(<TaskForm {...props} refs={[master, configured]} />);
    expect(screen.getByRole('button', { name: 'Review commits vs upstream/main' })).toBeDefined();
    rerender(<TaskForm {...props} refs={[master]} />);
    expect(screen.queryByRole('button', { name: /Review commits vs/ })).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('upstream/main is missing');
  });

  it('reviews the Source branch tip and removes the old branch’s suggested commits', async () => {
    const issueBranch = 'fix/4091';
    const sourceRef: GitRef = { ...main, fullName: `refs/heads/${issueBranch}`, targetOid: other };
    const release = releaseFixture();
    release.candidates.mockImplementation(async (_repo, baseOid, headOid): Promise<Candidates> => ({
      baseOid, headOid, truncated: false, commits: headOid === other ? [commits[1]] : [commits[0]],
    }));
    render(<TaskForm release={release} repoId="repo" refs={[sourceRef, master]}
      worktree={{ ...worktree, branch: 'fix/5162' }} inputOids={[]} onSave={vi.fn()} onClose={vi.fn()} />);
    const source = screen.getByLabelText('Source');
    const selected = screen.getByLabelText('Selected commit IDs') as HTMLTextAreaElement;
    const review = screen.getByRole('button', { name: 'Review commits vs origin/master' });
    fireEvent.click(review);
    await waitFor(() => expect(selected.value).toBe(head));

    fireEvent.change(source, { target: { value: issueBranch } });
    expect(selected.value).toBe('');
    fireEvent.click(review);
    expect(release.candidates).toHaveBeenLastCalledWith('repo', base, other, expect.any(AbortSignal));
    await waitFor(() => expect(selected.value).toBe(other));
    expect(screen.getByRole('status').textContent).toContain('Compared fix/4091 against origin/master');
  });

  it('keeps an explicit commit selection when the Source cannot be resolved', () => {
    const release = releaseFixture();
    render(<TaskForm release={release} repoId="repo" refs={[master]} worktree={worktree}
      inputOids={[other]} onSave={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'fix/missing' } });

    expect((screen.getByRole('button', { name: 'Review commits vs origin/master' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Selected commit IDs') as HTMLTextAreaElement).value).toBe(other);
    expect(release.candidates).not.toHaveBeenCalled();
  });

  it('fills metadata from a fix branch and preserves commits selected in History', () => {
    const release = releaseFixture();
    render(<TaskForm release={release} repoId="repo" refs={[master]} worktree={{ ...worktree, branch: 'fix/3704-poc' }} inputOids={[other]} onSave={vi.fn()} onClose={vi.fn()} />);
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('fix: poc');
    expect((screen.getByLabelText('Task IDs') as HTMLInputElement).value).toBe('3704');
    expect((screen.getByLabelText('Selected commit IDs') as HTMLTextAreaElement).value).toBe(other);
  });

  it('leaves unmatched fields editable and preserves manual values', () => {
    const release = releaseFixture();
    render(<TaskForm release={release} repoId="repo" refs={[]} worktree={{ ...worktree, branch: 'feature/no-task-id' }} inputOids={[]} onSave={vi.fn()} onClose={vi.fn()} />);
    const title = screen.getByLabelText('Title') as HTMLInputElement;
    const id = screen.getByLabelText('Task IDs') as HTMLInputElement;
    expect(title.value).toBe('');
    expect(id.value).toBe('');
    fireEvent.change(title, { target: { value: 'Edited title' } });
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: branch } });
    expect(title.value).toBe('Edited title');
    expect(id.value).toBe('5111');
  });

  it('requires manual selection for a truncated range', async () => {
    const release = releaseFixture(true);
    render(<TaskForm release={release} repoId="repo" refs={[master]} worktree={worktree} inputOids={[]} onSave={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review commits vs origin/master' }));
    const checkbox = await screen.findByRole('checkbox', { name: /Finish the feature/ }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect((screen.getByRole('button', { name: 'Save task' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('starts with a complete candidate range checked and toggles all candidates', async () => {
    const release = releaseFixture();
    render(<TaskForm release={release} repoId="repo" refs={[master]} worktree={worktree} inputOids={[]} onSave={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose commits from a branch range' }));
    fireEvent.change(screen.getByLabelText('Base commit'), { target: { value: base } });
    fireEvent.click(screen.getByRole('button', { name: 'List candidates' }));
    const all = await screen.findByRole('checkbox', { name: 'Select all' }) as HTMLInputElement;
    const first = screen.getByRole('checkbox', { name: /Start the feature/ }) as HTMLInputElement;
    expect(all.checked).toBe(true);
    expect(first.checked).toBe(true);
    fireEvent.click(first);
    expect(all.indeterminate).toBe(true);
    fireEvent.click(all);
    expect(all.checked).toBe(true);
    fireEvent.click(all);
    expect(first.checked).toBe(false);
    expect((screen.getByLabelText('Selected commit IDs') as HTMLTextAreaElement).value).toBe('');
  });
});
