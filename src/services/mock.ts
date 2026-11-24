import { commitsReachableFrom, materializePreviewRows } from '../core/graph/preview';
import { longRef } from '../core/graph/refs';
import type {
  Commit,
  GitRef, GitService,
  Repository,
  WorkspaceCatalog,
  Worktree,
  WorktreeChange,
} from './contracts';
import { routingFiles, stagingComparison, summaryFile, textDiff } from './mock-diff';
import { conversationHistory, linearHistory } from './mock-history';

const histories = {
  frontend: linearHistory(2, 'staging', ['Improve navigation focus', 'Add workspace switcher', 'Tighten toolbar spacing', 'Update dashboard tests', 'Initialize frontend']),
  backend: linearHistory(3, 'master', ['Handle request timeouts', 'Add API pagination', 'Update project dependencies', 'Initialize backend']),
  'conversation-agent': conversationHistory,
  'simulation-agent': linearHistory(4, 'master', ['Trace simulation outcomes', 'Add regression scenarios', 'Keep fixture runs deterministic', 'Initialize simulation runner']),
  'report-agent': linearHistory(5, 'staging', ['Support Markdown exports', 'Include linked artifacts', 'Add weekly summary format', 'Initialize report agent']),
  'common-utils': linearHistory(6, 'master', ['Normalize relative paths', 'Add retry utility', 'Initialize utilities']),
  dotfiles: linearHistory(7, 'main', ['Update shell aliases', 'Track editor settings', 'Add bootstrap script']),
  notes: linearHistory(8, 'main', ['Summarize workspace research', 'Add architecture notes', 'Initialize notebook']),
  'empty-repo': linearHistory(9, 'main', []),
  'archive-api': linearHistory(10, 'main', []),
};

const changesByWorktree: Record<string, WorktreeChange[]> = {
  'conversation-agent:primary': [
    {
      ...routingFiles[1],
      group: 'Staged',
      diff: textDiff([
        ['context', 'class RoutingState:'],
        ['context', '    context: Context | None'],
        ['add', '    trace_id: str | None = None'],
      ], 14, 14),
    },
    {
      ...routingFiles[0],
      group: 'Unstaged',
      diff: textDiff([
        ['context', '    if context is None:'],
        ['context', '        if state.task_route:'],
        ['add', '            state.record_attempt("task")'],
        ['context', '            return task_route(state)'],
      ], 41, 41),
    },
    {
      id: 'timeout-fixture',
      path: 'tests/fixtures/router-timeout.json',
      status: 'A',
      group: 'Untracked',
      diff: textDiff([['add', '{ "route": "task", "timeoutMs": 250 }']], 0),
    },
  ],
  'conversation-agent:staging': [
    {
      id: 'release-worktree',
      path: 'config/staging.toml',
      status: 'M',
      group: 'Unstaged',
      diff: textDiff([
        ['context', '[routing]'],
        ['delete', 'timeout_ms = 250'],
        ['add', 'timeout_ms = 400'],
      ]),
    },
  ],
  'report-agent:primary': [
    {
      id: 'exports',
      path: 'reports/export.py',
      status: 'U',
      group: 'Conflicts',
      diff: textDiff([
        ['context', 'def export(report):'],
        ['add', '<<<<<<< HEAD'],
        ['add', '    return render_markdown(report)'],
        ['add', '======='],
        ['add', '    return render_text(report)'],
        ['add', '>>>>>>> feature/export'],
      ]),
    },
    {
      id: 'snapshot',
      path: 'tests/fixtures/snapshot.json',
      status: 'M',
      group: 'Unstaged',
      diff: { kind: 'large' },
    },
  ],
};

interface WorktreeFixture {
  id: string;
  path: string;
  branch: string | null;
  head: string | null;
  ahead?: number;
  behind?: number;
  external?: boolean;
  locked?: boolean;
  unavailable?: boolean;
}

function worktree({ ahead = 0, behind = 0, unavailable, ...fixture }: WorktreeFixture): Worktree {
  const changes = changesByWorktree[fixture.id] ?? [];
  let kind: Worktree['status']['kind'] = 'clean';
  if (changes.length > 0) kind = 'dirty';
  if (changes.some(({ group }) => group === 'Conflicts')) kind = 'conflict';
  if (unavailable) kind = 'unknown';
  return { ...fixture, status: { kind, changes: changes.length, ahead, behind } };
}

type RepoKey = keyof typeof histories;

function repository(
  id: RepoKey,
  branch: string,
  options: Partial<Pick<WorktreeFixture, 'ahead' | 'behind' | 'unavailable'>> = {},
  linked: Worktree[] = [],
): Repository {
  const primaryWorktreeId = `${id}:primary`;
  const home = ['dotfiles', 'notes', 'empty-repo', 'archive-api'].includes(id) ? 'personal' : 'work';
  const history = histories[id].commits;
  const head = history.find(({ refs }) => refs.some(({ name }) => name === branch));
  return {
    id,
    name: id,
    primaryWorktreeId,
    worktrees: [
      worktree({ id: primaryWorktreeId, path: `~/${home}/${id}`, branch, head: head?.oid ?? null, ...options }),
      ...linked,
    ],
  };
}

const catalog: WorkspaceCatalog = {
  workspaces: [
    {
      id: 'work',
      name: 'Work',
      rootPath: '~/work',
      repositoryIds: ['frontend', 'backend', 'conversation-agent', 'simulation-agent', 'report-agent', 'common-utils'],
    },
    {
      id: 'personal',
      name: 'Personal',
      rootPath: '~/personal',
      repositoryIds: ['dotfiles', 'notes', 'empty-repo', 'archive-api'],
    },
  ],
  repositories: {
    frontend: repository('frontend', 'staging', { ahead: 2 }),
    backend: repository('backend', 'master'),
    'conversation-agent': repository('conversation-agent', 'task/router', {}, [
      worktree({
        id: 'conversation-agent:staging',
        path: '~/worktrees/conversation-staging',
        branch: 'staging',
        head: conversationHistory.commits[1].oid,
        external: true,
        behind: 1,
      }),
      worktree({
        id: 'conversation-agent:review',
        path: '~/worktrees/conversation-review',
        branch: null,
        head: conversationHistory.commits[8].oid,
        external: true,
        locked: true,
      }),
    ]),
    'simulation-agent': repository('simulation-agent', 'master', { behind: 5 }),
    'report-agent': repository('report-agent', 'staging'),
    'common-utils': repository('common-utils', 'master'),
    dotfiles: repository('dotfiles', 'main'),
    notes: repository('notes', 'main'),
    'empty-repo': repository('empty-repo', 'main'),
    'archive-api': repository('archive-api', 'main', { unavailable: true }),
  },
};

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createMockGitService({ viewDelay = 140, detailDelay = 25 } = {}): GitService {
  return {
    getCatalog: () => catalog,

    async getRepositoryView(repoId, worktreeId, scope, refName) {
      await pause(viewDelay);
      const repo = catalog.repositories[repoId];
      const selected = repo?.worktrees.find(({ id }) => id === worktreeId);

      if (!selected) throw new Error('The selected worktree is unavailable.');
      if (selected.status.kind === 'unknown') {
        throw new Error(`The sample worktree at ${selected.path} could not be read.`);
      }

      const history = histories[repoId as RepoKey];
      const refs = history.commits.flatMap(({ oid, refs }) => refs.flatMap(({ kind, name }): GitRef[] => kind === 'head' ? [] : [
        { kind, fullName: longRef(kind, name), targetOid: oid, symbolicTarget: null },
      ]));
      const roots = scope === 'current' ? (selected.head ? [selected.head] : []) : refs.filter((ref) => (
        scope === 'local' ? ref.kind === 'local' : ref.fullName === refName
      )).map((ref) => ref.targetOid);
      const scoped = scope === 'all' ? history.commits : commitsReachableFrom(history.commits, roots);
      const commits = scoped.map((commit): Commit => {
        if (commit.oid !== selected.head) return commit;
        return { ...commit, refs: [{ name: 'HEAD', kind: 'head' }, ...commit.refs] };
      });

      return {
        commits,
        ...(refs.length ? { refs } : {}),
        graphRows: materializePreviewRows(commits, history.placements),
        changes: changesByWorktree[worktreeId] ?? [],
      };
    },

    async getCommitDetail(repoId, oid, parentOid) {
      await pause(detailDelay);
      const commit = histories[repoId as RepoKey]?.commits.find((item) => item.oid === oid);
      if (!commit) throw new Error('The selected commit is unavailable.');
      if (parentOid === null ? commit.parents.length > 0 : !commit.parents.includes(parentOid)) {
        throw new Error('The selected comparison base is unavailable.');
      }

      const [master, staging, routing] = conversationHistory.commits;
      if (commit.oid === routing.oid) {
        return {
          message: `${commit.subject}\n\nUse the task-specific route when a request has no conversation context. Cover the fallback in the router tests.`,
          files: routingFiles,
        };
      }
      if (commit.oid === master.oid || commit.oid === staging.oid) {
        const firstParent = parentOid === commit.parents[0];
        return {
          message: `${commit.subject}\n\nBring the routing changes into the target branch while preserving its release configuration.`,
          files: firstParent ? routingFiles : stagingComparison,
        };
      }

      return {
        message: commit.subject,
        files: [summaryFile(commit.subject, parentOid === null)],
      };
    },
  };
}
