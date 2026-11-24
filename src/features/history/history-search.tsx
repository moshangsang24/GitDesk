import type { Commit } from '../../services/contracts';

export function matchesCommit({ subject, authorName, oid }: Commit, search: string): boolean {
  return [subject, authorName, oid].some((field) => field.toLowerCase().includes(search));
}

export function searchCommits(commits: Commit[], query: string): Commit[] {
  const search = query.trim().toLowerCase();
  if (!search) return [];
  return commits.filter((commit) => matchesCommit(commit, search));
}

export function Highlight({ value, query }: { value: string; query: string }) {
  const search = query.trim().toLowerCase();
  if (!search) return value;
  const start = value.toLowerCase().indexOf(search);
  if (start === -1) return value;

  return <>{value.slice(0, start)}<mark>{value.slice(start, start + search.length)}</mark>{value.slice(start + search.length)}</>;
}
