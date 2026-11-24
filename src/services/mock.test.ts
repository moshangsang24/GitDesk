import { describe, expect, it } from 'vitest';
import { searchCommits } from '../features/history/history-search';
import { createMockGitService } from './mock';

const service = createMockGitService({ viewDelay: 0, detailDelay: 0 });
const repoId = 'conversation-agent';
const primaryId = 'conversation-agent:primary';
const stagingId = 'conversation-agent:staging';

describe('mock GitService', () => {
  it('links every fixture row to the actual parent commits, in topological order', async () => {
    const catalog = service.getCatalog();
    expect(catalog.workspaces).toHaveLength(2);
    expect(Object.keys(catalog.repositories).length).toBeGreaterThanOrEqual(6);

    const { commits, graphRows } = await service.getRepositoryView(repoId, primaryId, 'all');
    expect(commits).toHaveLength(24);
    expect(graphRows).toHaveLength(commits.length);
    expect(graphRows[0].nodeKind).toBe('merge');
    expect(graphRows.at(-1)?.nodeKind).toBe('root');

    for (const [index, commit] of commits.entries()) {
      const row = graphRows[index];
      expect(row.oid).toBe(commit.oid);
      expect(row.parentEdges.map(({ parentOid }) => parentOid)).toEqual(commit.parents);
      expect(new Set(row.through.map(({ lane }) => lane)).size).toBe(row.through.length);

      for (const { parentOid, destination } of row.parentEdges) {
        const parent = commits.findIndex(({ oid }) => oid === parentOid);
        expect(parent).toBeGreaterThan(index);
        expect(destination.lane).toBe(graphRows[parent].lane);
        expect(destination.colorId).toBe(graphRows[parent].colorId);
        expect(graphRows[parent].incoming).toBe(true);
      }
    }
  });

  it('scopes current history and working changes to the selected worktree', async () => {
    const [primary, staging] = await Promise.all([
      service.getRepositoryView(repoId, primaryId, 'current'),
      service.getRepositoryView(repoId, stagingId, 'current'),
    ]);
    expect(primary.commits[0].subject).toBe('Improve agent routing logic');
    expect(staging.commits[0].subject).toBe('Merge task/router into staging');
    expect(primary.changes.map(({ group }) => group)).toEqual(['Staged', 'Unstaged', 'Untracked']);
    expect(staging.changes.map(({ path }) => path)).toEqual(['config/staging.toml']);
  });

  it('returns distinct merge comparisons for each parent', async () => {
    const { commits: [merge] } = await service.getRepositoryView(repoId, primaryId, 'all');
    const [first, second] = await Promise.all(merge.parents.map((parent) => service.getCommitDetail(repoId, merge.oid, parent)));

    expect(first.files.map(({ path }) => path)).toContain('agent/router.py');
    expect(second.files.map(({ diff }) => diff.kind)).toContain('binary');
    await expect(service.getCommitDetail(repoId, merge.oid, merge.oid)).rejects.toThrow('comparison base');
  });

  it('supports empty and unavailable repositories', async () => {
    await expect(service.getRepositoryView('empty-repo', 'empty-repo:primary', 'all'))
      .resolves.toEqual({ commits: [], graphRows: [], changes: [] });
    await expect(service.getRepositoryView('archive-api', 'archive-api:primary', 'all'))
      .rejects.toThrow('could not be read');
  });

  it('finds case-insensitive matches by subject, author and full hash without dropping rows', async () => {
    const { commits } = await service.getRepositoryView(repoId, primaryId, 'all');
    expect(searchCommits(commits, '  ROUTING LOGIC ')).toEqual([commits[2]]);
    expect(searchCommits(commits, 'alex').every(({ authorName }) => authorName === 'Alex')).toBe(true);
    expect(searchCommits(commits, commits[2].oid)).toEqual([commits[2]]);
    expect(commits).toHaveLength(24);
  });
});
