import type { ChangedFile, DiffHunk, DiffLine, FileDiff } from './contracts';

type HunkEntry = readonly ['context' | 'add' | 'delete', string];

function hunk(oldStart: number, newStart: number, entries: HunkEntry[], context = ''): DiffHunk {
  let oldLine = oldStart;
  let newLine = newStart;

  const lines = entries.map(([kind, text]): DiffLine => {
    if (kind === 'add') return { kind, text, newLine: newLine++ };
    if (kind === 'delete') return { kind, text, oldLine: oldLine++ };
    return { kind, text, oldLine: oldLine++, newLine: newLine++ };
  });

  const oldLength = oldLine - oldStart;
  const newLength = newLine - newStart;
  return { header: `@@ -${oldStart},${oldLength} +${newStart},${newLength} @@${context}`, lines };
}

export function textDiff(entries: HunkEntry[], oldStart = 1, newStart = 1, context = ''): FileDiff {
  return { kind: 'text', hunks: [hunk(oldStart, newStart, entries, context)] };
}

export const routingFiles: ChangedFile[] = [
  {
    id: 'router',
    path: 'agent/router.py',
    status: 'M',
    diff: {
      kind: 'text',
      hunks: [
        hunk(40, 40, [
          ['context', '    context = state.context'],
          ['context', '    if context is None:'],
          ['delete', '        return default_route(state)'],
          ['add', '        if state.task_route:'],
          ['add', '            return task_route(state)'],
          ['add', '        return default_route(state)'],
          ['context', '    return resolve_route(state, context)'],
        ], ' def route(state):'),
      ],
    },
  },
  {
    id: 'state',
    path: 'agent/state.py',
    status: 'M',
    diff: textDiff([
      ['context', 'class RoutingState:'],
      ['delete', '    context: Context'],
      ['add', '    context: Context | None'],
      ['add', '    task_route: bool = False'],
    ], 14, 14),
  },
  {
    id: 'tests',
    path: 'tests/test_router.py',
    status: 'A',
    diff: textDiff([
      ['add', 'def test_task_route_without_context():'],
      ['add', '    state = RoutingState(context=None, task_route=True)'],
      ['add', '    assert route(state) == Route.TASK'],
    ], 0),
  },
];

export const stagingComparison: ChangedFile[] = [
  {
    id: 'routing-config',
    path: 'config/routing.toml',
    status: 'M',
    diff: textDiff([
      ['context', '[routing]'],
      ['delete', 'fallback = "default"'],
      ['add', 'fallback = "task"'],
      ['context', 'max_attempts = 3'],
    ]),
  },
  {
    id: 'routing-guide',
    oldPath: 'docs/router.md',
    path: 'docs/routing.md',
    status: 'R',
    diff: { kind: 'empty' },
  },
  {
    id: 'routing-diagram',
    path: 'docs/routing-preview.png',
    status: 'A',
    diff: { kind: 'binary' },
  },
];

export function summaryFile(subject: string, root: boolean): ChangedFile {
  return {
    id: 'notes',
    path: 'docs/development.md',
    status: root ? 'A' : 'M',
    diff: root
      ? textDiff([['add', '# Development'], ['add', subject]], 0)
      : textDiff([['context', '# Development'], ['add', `- ${subject}`]]),
  };
}
