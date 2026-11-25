import { describe, expect, it } from 'vitest';
import { groupByPrefix } from './ref-groups';

const names = (values: string[]) => groupByPrefix(values, (value) => value);

describe('groupByPrefix', () => {
  it('folders names that share a prefix and keeps the rest loose', () => {
    const grouped = names(['feat/4053', 'backup/2750-cutoff', 'main', 'feat/3698-what-if', 'backup/autoabs', 'decitron-core']);
    expect(grouped.folders.map(({ prefix, items }) => [prefix, items.map(({ leaf }) => leaf)])).toEqual([
      ['backup', ['2750-cutoff', 'autoabs']],
      ['feat', ['3698-what-if', '4053']],
    ]);
    expect(grouped.loose.map(({ leaf }) => leaf)).toEqual(['decitron-core', 'main']);
  });

  it('does not create a folder for a single prefixed name', () => {
    const grouped = names(['hotfix/login', 'main']);
    expect(grouped.folders).toEqual([]);
    expect(grouped.loose.map(({ leaf }) => leaf)).toEqual(['hotfix/login', 'main']);
  });

  it('only splits on the first slash and sorts numbers naturally', () => {
    const grouped = names(['feat/a/b', 'feat/10-x', 'feat/9-y']);
    expect(grouped.folders[0].items.map(({ leaf }) => leaf)).toEqual(['9-y', '10-x', 'a/b']);
  });

  it('treats leading or trailing slashes as plain names', () => {
    expect(names(['/odd', 'odd/']).folders).toEqual([]);
  });

  it('keeps the original objects', () => {
    const refs = [{ id: 1, name: 'feat/a' }, { id: 2, name: 'feat/b' }];
    expect(groupByPrefix(refs, ({ name }) => name).folders[0].items.map(({ ref }) => ref.id)).toEqual([1, 2]);
  });
});
