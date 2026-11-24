import { useLayoutEffect, useState } from 'react';

export type Appearance = 'system' | 'light' | 'dark';

const storageKey = 'gitdesk.appearance.v2';
const legacyKey = 'gitdesk.appearance';
const darkQuery = '(prefers-color-scheme: dark)';

export function parseAppearance(saved: string | null, legacy: string | null): Appearance {
  if (saved === 'system' || saved === 'light' || saved === 'dark') return saved;
  // v1 always stored a value and defaulted to light, so only an explicit dark choice is kept.
  return legacy === 'dark' ? 'dark' : 'system';
}

export function resolveAppearance(appearance: Appearance, prefersDark: boolean): 'light' | 'dark' {
  return appearance === 'system' ? (prefersDark ? 'dark' : 'light') : appearance;
}

function readAppearance(): Appearance {
  try {
    return parseAppearance(window.localStorage.getItem(storageKey), window.localStorage.getItem(legacyKey));
  } catch {
    return 'system';
  }
}

export function useAppearance() {
  const [appearance, setAppearance] = useState<Appearance>(readAppearance);

  useLayoutEffect(() => {
    const media = typeof window.matchMedia === 'function' ? window.matchMedia(darkQuery) : null;
    const apply = () => {
      const root = document.documentElement;
      root.dataset.theme = resolveAppearance(appearance, media?.matches ?? false);
      const chromeColor = getComputedStyle(root).getPropertyValue('--bg-chrome').trim();
      document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', chromeColor);
    };
    apply();
    if (appearance === 'system') media?.addEventListener('change', apply);

    try {
      window.localStorage.setItem(storageKey, appearance);
    } catch {
      // The theme still applies when storage is unavailable.
    }
    return () => media?.removeEventListener('change', apply);
  }, [appearance]);

  return [appearance, setAppearance] as const;
}
