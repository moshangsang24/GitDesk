import type { GitRef } from '../../services/contracts';

export function taskFieldsFromSource(source: string) {
  const match = /^task\/(\d{1,80})-([^/\s]+)$/.exec(source.trim());
  if (!match) return null;
  const title = `task: ${match[2]}`;
  return title.length <= 120 && new TextEncoder().encode(title).length <= 240 ? { issue: match[1], title } : null;
}

export function defaultTaskBase(refs: GitRef[]) {
  const names = ['refs/remotes/origin/master', 'refs/heads/master', 'refs/remotes/origin/main', 'refs/heads/main'];
  for (const name of names) {
    const ref = refs.find(({ fullName, symbolicTarget }) => fullName === name && !symbolicTarget);
    if (ref) return ref;
  }
}
