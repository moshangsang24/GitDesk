import type { LanePlacement } from '../core/graph/types';
import type { Commit, RefLabel } from './contracts';

interface HistoryFixture {
  commits: Commit[];
  placements: ReadonlyMap<string, LanePlacement>;
}

interface Entry {
  subject: string;
  author?: string;
  shortOid?: string;
  parents: number[];
  lane: number;
  color: number;
  refs?: RefLabel[];
}

const entries: Entry[] = [
  { subject: 'Merge staging into master', author: 'James', shortOid: 'ab37f92', parents: [8, 1], lane: 0, color: 0, refs: [{ name: 'master', kind: 'local', tone: 'purple' }] },
  { subject: 'Merge task/router into staging', author: 'James', shortOid: 'c72ad10', parents: [5, 2], lane: 1, color: 1, refs: [{ name: 'staging', kind: 'local', tone: 'amber' }] },
  { subject: 'Improve agent routing logic', shortOid: '93bc2ea', parents: [3], lane: 2, color: 2, refs: [{ name: 'task/router', kind: 'local', tone: 'cyan' }] },
  { subject: 'Fix fallback for tool invocation', shortOid: 'a1df88e', parents: [4], lane: 2, color: 2 },
  { subject: 'Update multi-turn tests', shortOid: 'b71aa24', parents: [6], lane: 2, color: 2 },
  { subject: 'Prepare staging routing checks', author: 'Alex', shortOid: 'f1ed3c9', parents: [6], lane: 1, color: 1, refs: [{ name: 'origin/staging', kind: 'remote' }] },
  { subject: 'Update API response model', author: 'Alex', shortOid: 'de97a12', parents: [7], lane: 2, color: 2 },
  { subject: 'Improve request validation', author: 'Alex', shortOid: '8c4318e', parents: [8], lane: 2, color: 2 },
  { subject: 'Merge previous release', author: 'James', shortOid: '6bd2904', parents: [10, 9], lane: 0, color: 0 },
  { subject: 'Fix integration regression', author: 'Alex', shortOid: '2ae074c', parents: [10], lane: 1, color: 3 },
  { subject: 'Prepare alpha release', author: 'James', shortOid: '1bb29af', parents: [11], lane: 0, color: 0, refs: [{ name: 'v0.1.0-alpha', kind: 'tag' }] },
  { subject: 'Initialize agent service', author: 'James', shortOid: 'f3a070d', parents: [12], lane: 0, color: 0 },
  { subject: 'Add request tracing', author: 'Alex', parents: [13], lane: 0, color: 0, refs: [{ name: 'feat/4053-agent-writer', kind: 'local' }, { name: 'origin/feat/4053-agent-writer', kind: 'remote' }] },
  { subject: 'Document local setup', author: 'James', parents: [14], lane: 0, color: 0, refs: [{ name: 'feat/4053', kind: 'local' }, { name: 'backup/2750-cutoff-master', kind: 'local' }] },
  { subject: 'Extract response formatting', parents: [15], lane: 0, color: 0, refs: [{ name: 'feat/4013-fast-path', kind: 'local' }, { name: 'origin/feat/4013-fast-path', kind: 'remote' }] },
  { subject: 'Cover retry behavior', parents: [16], lane: 0, color: 0, refs: [{ name: 'backup/autoabs-before-rebase', kind: 'local' }] },
  { subject: 'Normalize incoming messages', author: 'Alex', parents: [17], lane: 0, color: 0, refs: [{ name: 'origin/master', kind: 'remote' }, { name: 'feature/autoabs-dev', kind: 'local' }] },
  { subject: 'Add health check', author: 'Alex', parents: [18], lane: 0, color: 0 },
  { subject: 'Set default conversation limits', author: 'James', parents: [19], lane: 0, color: 0 },
  { subject: 'Add request fixtures', parents: [20], lane: 0, color: 0 },
  { subject: 'Set up service configuration', author: 'James', parents: [21], lane: 0, color: 0 },
  { subject: 'Add initial package layout', author: 'Alex', parents: [22], lane: 0, color: 0 },
  { subject: 'Document project conventions', author: 'James', parents: [23], lane: 0, color: 0 },
  { subject: 'Initial commit', author: 'James', parents: [], lane: 0, color: 0 },
];

const day = 24 * 60 * 60;
const latestDate = Date.UTC(2026, 10, 23, 17, 30) / 1000;

function createFixture(authored: Entry[], seed: number): HistoryFixture {
  const ids = authored.map(({ shortOid }, index) => {
    const generatedPrefix = (0x45d0100 + seed * 503 + index * 173).toString(16);
    const suffix = (seed * 100 + index).toString(16).padStart(33, '0');
    return (shortOid ?? generatedPrefix) + suffix;
  });

  const commits = authored.map((entry, index) => ({
    oid: ids[index],
    parents: entry.parents.map((parent) => ids[parent]),
    subject: entry.subject,
    authorName: entry.author ?? 'Developer',
    authorTime: latestDate - day * Math.floor(index / 4) - (index % 4) * 1800,
    refs: entry.refs ?? [],
  }));

  const placements = new Map(commits.map(({ oid }, index) => [
    oid,
    { lane: authored[index].lane, colorId: authored[index].color },
  ]));

  return { commits, placements };
}

export const conversationHistory = createFixture(entries, 1);

export function linearHistory(seed: number, branch: string, subjects: string[]): HistoryFixture {
  return createFixture(subjects.map((subject, index) => ({
    subject,
    author: index % 2 === 0 ? 'Alex' : 'James',
    parents: index + 1 < subjects.length ? [index + 1] : [],
    lane: 0,
    color: seed % 8,
    refs: index === 0 ? [{ name: branch, kind: 'local' }] : [],
  })), seed);
}
