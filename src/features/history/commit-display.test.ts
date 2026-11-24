import { describe, expect, it } from 'vitest';
import { graphPalette } from '../../core/graph/types';
import { authorColor, authorInitials, formatCommitAge, formatFullDate, formatShortDate } from './commit-display';

const now = new Date(2026, 10, 24, 15, 0, 0).getTime();
const at = (...parts: [number, number, number, number?, number?]) => new Date(...(parts as [number, number, number, number, number])).getTime() / 1000;

describe('formatCommitAge', () => {
  it('uses minutes and hours within the last day', () => {
    expect(formatCommitAge(now / 1000 - 20, now)).toBe('Just now');
    expect(formatCommitAge(now / 1000 - 5 * 60, now)).toBe('5m ago');
    expect(formatCommitAge(now / 1000 - 5 * 3600, now)).toBe('5h ago');
    expect(formatCommitAge(at(2026, 10, 23, 18), now)).toBe('21h ago');
  });

  it('uses calendar days for the rest of the week', () => {
    expect(formatCommitAge(at(2026, 10, 23, 9), now)).toBe('Yesterday');
    expect(formatCommitAge(at(2026, 10, 20, 12), now)).toBe('4d ago');
    expect(formatCommitAge(at(2026, 10, 18, 16), now)).toBe('6d ago');
  });

  it('falls back to a short date after a week and for future timestamps', () => {
    expect(formatCommitAge(at(2026, 10, 17, 12), now)).toBe('Nov 17');
    expect(formatCommitAge(now / 1000 + 3600, now)).toBe('Nov 24');
  });

  it('formats tooltips with date, time and time zone', () => {
    const text = formatFullDate(at(2026, 10, 23, 9, 5));
    expect(text).toMatch(/^Nov 23, 2026, 9:05\sAM\s\S+/u);
  });

  it('adds the year for dates outside the current year', () => {
    expect(formatShortDate(at(2025, 0, 3), now)).toBe('Jan 3, 2025');
    expect(formatCommitAge(at(2025, 11, 30), now)).toBe('Dec 30, 2025');
  });
});

describe('author avatar', () => {
  it('derives initials from names and handles', () => {
    expect(authorInitials('James')).toBe('J');
    expect(authorInitials('Ada Lovelace')).toBe('AL');
    expect(authorInitials('grace.hopper')).toBe('GH');
    expect(authorInitials('  ')).toBe('?');
    expect(authorInitials('李 雷')).toBe('李雷');
  });

  it('maps an author to a stable palette colour', () => {
    expect(graphPalette).toContain(authorColor('James'));
    expect(authorColor('James')).toBe(authorColor(' james '));
  });
});
