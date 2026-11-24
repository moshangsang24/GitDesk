import { create } from 'zustand';

const absoluteDatesKey = 'gitdesk.absolute-dates';

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

interface DisplayPreferences {
  /** Show short dates for every commit instead of relative times for the last week. */
  absoluteDates: boolean;
  setAbsoluteDates: (value: boolean) => void;
}

export const useDisplayPreferences = create<DisplayPreferences>((set) => ({
  absoluteDates: typeof window === 'undefined' ? false : readFlag(absoluteDatesKey),
  setAbsoluteDates(value) {
    set({ absoluteDates: value });
    try {
      window.localStorage.setItem(absoluteDatesKey, String(value));
    } catch {
      // The preference still applies for this session.
    }
  },
}));
