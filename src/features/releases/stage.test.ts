import { fetchCoversRef } from '../../services/operations';
import { describe, expect, it } from 'vitest';
import type { Inclusion, StageSnapshot } from '../../services/release';
import { summarizeStage } from './stage';

function stage(...statuses: Inclusion[]): StageSnapshot {
  return {
    target: 'refs/remotes/origin/test', tip: 'b'.repeat(40), state: 'ready', observedAt: 0, reason: null,
    evidence: statuses.map((status, index) => ({ oid: String(index), status, reason: null })),
  };
}

describe('release stage summary', () => {
  it('shows partial evidence and counts unknown separately', () => {
    expect(summarizeStage(stage('included', 'unknown', 'notContained'), 3)).toMatchObject({ label: 'Partial', included: 1, unknown: 1 });
  });

  it('requires a complete negative result before reporting absent originals', () => {
    expect(summarizeStage(stage('unknown', 'notContained'), 2).label).toBe('Unknown');
    expect(summarizeStage(stage('notContained', 'notContained'), 2).label).toBe('Original commits absent');
  });

  it('distinguishes missing targets and pending reads from absence', () => {
    expect(summarizeStage({ ...stage(), state: 'missing' }, 1).label).toBe('Ref missing');
    expect(summarizeStage(undefined, 1).label).toBe('Calculating…');
  });
});

describe('Fetch mapping coverage', () => {
  it('maps exact and wildcard destinations and honors remote exclusions', () => {
    const record = {
      fetchedAt: 1000,
      failure: null,
      specs: [
        { source: 'refs/heads/*', destination: 'refs/remotes/origin/tracking/*' },
        { source: 'refs/heads/hidden/*', destination: null },
        { source: 'refs/heads/preview', destination: 'refs/remotes/origin/next' },
      ],
    };
    expect(fetchCoversRef(record, 'refs/remotes/origin/tracking/release/current')).toBe(true);
    expect(fetchCoversRef(record, 'refs/remotes/origin/tracking/hidden/draft')).toBe(false);
    expect(fetchCoversRef(record, 'refs/remotes/origin/next')).toBe(true);
    expect(fetchCoversRef(record, 'refs/remotes/origin/other')).toBe(false);
  });
});
