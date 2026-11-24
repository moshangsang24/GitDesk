import { graphPalette } from '../../core/graph/types';

const dayMs = 86_400_000;
const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const shortDateWithYear = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
// dateStyle/timeStyle cannot be combined with timeZoneName, so the fields are listed explicitly.
const fullDate = new Intl.DateTimeFormat('en-US', {
  year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});

/** Full local date and time with the time zone, for tooltips. */
export function formatFullDate(timestamp: number) {
  return fullDate.format(timestamp * 1000);
}

function startOfDay(time: number) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Short calendar date; adds the year when it differs from `now`. */
export function formatShortDate(timestamp: number, now = Date.now()) {
  const time = timestamp * 1000;
  const sameYear = new Date(time).getFullYear() === new Date(now).getFullYear();
  return (sameYear ? shortDate : shortDateWithYear).format(time);
}

/**
 * Relative time for commits from the last seven days, otherwise a short date.
 * Future timestamps (clock skew, rewritten history) always use the date.
 */
export function formatCommitAge(timestamp: number, now = Date.now()) {
  const time = timestamp * 1000;
  const elapsed = now - time;
  if (elapsed < 0) return formatShortDate(timestamp, now);
  if (elapsed < 60_000) return 'Just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < dayMs) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  const days = Math.round((startOfDay(now) - startOfDay(time)) / dayMs);
  if (days <= 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return formatShortDate(timestamp, now);
}

/** One or two initials for an author avatar. */
export function authorInitials(name: string) {
  const words = name.trim().split(/[\s._-]+/u).filter(Boolean);
  if (words.length === 0) return '?';
  const first = Array.from(words[0])[0] ?? '?';
  const second = words.length > 1 ? Array.from(words[words.length - 1])[0] ?? '' : '';
  return (first + second).toUpperCase();
}

/** Stable lane colour for an author, derived locally from the name. */
export function authorColor(name: string) {
  let hash = 5381;
  for (const char of name.trim().toLowerCase()) hash = ((hash * 33) ^ char.codePointAt(0)!) >>> 0;
  return graphPalette[hash % graphPalette.length];
}
