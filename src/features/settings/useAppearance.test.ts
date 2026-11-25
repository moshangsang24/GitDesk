import { describe, expect, it } from 'vitest';
import { parseAccent } from './preferences';
import { parseAppearance, resolveAppearance } from './useAppearance';

describe('appearance preference', () => {
  it('defaults to following the system', () => {
    expect(parseAppearance(null, null)).toBe('system');
  });

  it('keeps an explicit v1 dark choice and drops the old forced light default', () => {
    expect(parseAppearance(null, 'dark')).toBe('dark');
    expect(parseAppearance(null, 'light')).toBe('system');
  });

  it('prefers the current setting over the legacy one', () => {
    expect(parseAppearance('light', 'dark')).toBe('light');
    expect(parseAppearance('bogus', null)).toBe('system');
  });

  it('resolves System from the OS preference', () => {
    expect(resolveAppearance('system', true)).toBe('dark');
    expect(resolveAppearance('system', false)).toBe('light');
    expect(resolveAppearance('light', true)).toBe('light');
  });
});

describe('accent preference', () => {
  it('falls back to blue for unknown values', () => {
    expect(parseAccent(null)).toBe('blue');
    expect(parseAccent('violet')).toBe('violet');
    expect(parseAccent('neon')).toBe('blue');
  });
});
