// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitRef, HistoryCommit, Worktree } from '../../services/contracts';
import type { Candidates, ReleaseActions } from '../../services/release';
import { TaskForm } from './ReleaseForms';
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
    candidates: vi.fn(async (): Promise<Candidates> => ({ commits, baseOid: base, headOid: head, truncated })),
    saveTask: vi.fn(async () => overview),
    overview: vi.fn(async () => overview), saveTargets: vi.fn(async () => overview), deleteTask: vi.fn(async () => overview),
    observations: vi.fn(async () => []), evaluate: vi.fn(async () => ({ targetRevision: 0, taskRevision: null, stages: [] })),
  } satisfies ReleaseActions;
}

afterEach(cleanup);

describe('quick release tasks', () => {
  it('prefers master and falls back to main without using aliases', () => {
    expect(defaultTaskBase([main, localMaster, master])).toBe(master);
    expect(defaultTaskBase([main, localMaster])).toBe(localMaster);
    expect(defaultTaskBase([{ ...master, symbolicTarget: 'refs/heads/main' }, main])).toBe(main);
    expect(defaultTaskBase([])).toBeUndefined();
    expect(taskFieldsFromSource('feature/5111-period-causality-rework')).toBeNull();
  });

  it('fills task metadata and prepares a selected, editable range relative to origin/master', async () => {
    const release = releaseFixture();
    render(<TaskForm release={release} repoId="repo" refs={[main, master]} worktree={worktree} inputOids={[]} onSave={vi.fn()} onClose={vi.fn()} />);
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('task: period-causality-rework');
    expect((screen.getByLabelText('Task ID') as HTMLInputElement).value).toBe('5111');

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

  it('leaves unmatched fields editable and preserves manual values', () => {
    const release = releaseFixture();
    render(<TaskForm release={release} repoId="repo" refs={[]} worktree={{ ...worktree, branch: 'feature/no-task-id' }} inputOids={[]} onSave={vi.fn()} onClose={vi.fn()} />);
    const title = screen.getByLabelText('Title') as HTMLInputElement;
    const id = screen.getByLabelText('Task ID') as HTMLInputElement;
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
});
