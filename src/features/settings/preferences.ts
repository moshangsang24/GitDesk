import { create } from 'zustand';

const absoluteDatesKey = 'gitdesk.absolute-dates';
const accentKey = 'gitdesk.accent';

export const accents = [
  { id: 'blue', label: 'Blue' },
  { id: 'violet', label: 'Violet' },
  { id: 'teal', label: 'Teal' },
  { id: 'rose', label: 'Rose' },
] as const;

export type Accent = typeof accents[number]['id'];

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The preference still applies for this session.
  }
}

export function parseAccent(value: string | null): Accent {
  return accents.some(({ id }) => id === value) ? value as Accent : 'blue';
}

function applyAccent(accent: Accent) {
  if (typeof document === 'undefined') return;
  // Blue is the token default, so it needs no attribute.
  if (accent === 'blue') delete document.documentElement.dataset.accent;
  else document.documentElement.dataset.accent = accent;
}

interface DisplayPreferences {
  /** Show short dates for every commit instead of relative times for the last week. */
  absoluteDates: boolean;
  setAbsoluteDates: (value: boolean) => void;
  accent: Accent;
  setAccent: (value: Accent) => void;
}

const initialAccent = typeof window === 'undefined' ? 'blue' : parseAccent(read(accentKey));
applyAccent(initialAccent);

export const useDisplayPreferences = create<DisplayPreferences>((set) => ({
  absoluteDates: typeof window === 'undefined' ? false : read(absoluteDatesKey) === 'true',
  setAbsoluteDates(value) {
    set({ absoluteDates: value });
    write(absoluteDatesKey, String(value));
  },
  accent: initialAccent,
  setAccent(value) {
    set({ accent: value });
    applyAccent(value);
    write(accentKey, value);
  },
}));
