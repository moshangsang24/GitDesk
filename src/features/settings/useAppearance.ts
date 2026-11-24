import { useLayoutEffect, useState } from 'react';

export type Appearance = 'light' | 'dark';

const storageKey = 'gitdesk.appearance';

export function useAppearance() {
  const [appearance, setAppearance] = useState<Appearance>(() => {
    try {
      return window.localStorage.getItem(storageKey) === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  });

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = appearance;
    const chromeColor = getComputedStyle(root).getPropertyValue('--bg-elevated').trim();
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', chromeColor);

    try {
      window.localStorage.setItem(storageKey, appearance);
    } catch {
      // The theme still applies when storage is unavailable.
    }
  }, [appearance]);

  return [appearance, setAppearance] as const;
}
