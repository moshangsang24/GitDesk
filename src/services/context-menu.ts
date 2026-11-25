import { invoke, isTauri } from '@tauri-apps/api/core';
import { LogicalPosition } from '@tauri-apps/api/dpi';
import { Menu } from '@tauri-apps/api/menu';
import { create } from 'zustand';

/** Shortcuts shown in menus. Only list shortcuts that work outside the menu too. */
export type MenuShortcut = 'copy' | 'refresh';

export const shortcutLabels: Record<MenuShortcut, string> = { copy: '⌘C', refresh: '⌘R' };
const accelerators: Record<MenuShortcut, string> = { copy: 'CmdOrCtrl+C', refresh: 'CmdOrCtrl+R' };

export interface MenuAction {
  kind: 'action';
  id: string;
  label: string;
  shortcut?: MenuShortcut;
  disabled?: boolean;
  run: () => void;
}

export type MenuEntry = MenuAction | { kind: 'separator' };

export const separator: MenuEntry = { kind: 'separator' };

/** Drops leading, trailing and repeated separators left behind by hidden items. */
export function normalizeMenu(entries: MenuEntry[]): MenuEntry[] {
  const result: MenuEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === 'separator' && (result.length === 0 || result.at(-1)?.kind === 'separator')) continue;
    result.push(entry);
  }
  while (result.at(-1)?.kind === 'separator') result.pop();
  return result;
}

export interface MenuRequest {
  entries: MenuEntry[];
  x: number;
  y: number;
  returnFocus: HTMLElement | null;
}

interface Toast { id: number; text: string; error: boolean }

interface Confirmation {
  title: string;
  message: string;
  confirmLabel: string;
  resolve: (confirmed: boolean) => void;
}

interface MenuState {
  menu: MenuRequest | null;
  toast: Toast | null;
  confirmation: Confirmation | null;
}

/** UI state for the HTML menu fallback, transient notices and confirmations. */
export const useMenuState = create<MenuState>(() => ({ menu: null, toast: null, confirmation: null }));

let toastId = 0;
export function notify(text: string, error = false) {
  useMenuState.setState({ toast: { id: ++toastId, text, error } });
}

export function requestConfirmation(options: Omit<Confirmation, 'resolve'>): Promise<boolean> {
  useMenuState.getState().confirmation?.resolve(false);
  return new Promise((resolve) => useMenuState.setState({ confirmation: { ...options, resolve } }));
}

export async function copyText(text: string) {
  if (isTauri()) {
    await invoke('write_clipboard_text', { text });
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Browser previews may lack clipboard permissions or the async Clipboard API.
  }
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.append(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  previous?.focus({ preventScroll: true });
  if (!copied) throw new Error('The clipboard is unavailable.');
}

/** Copies text and reports the result, since native menus give no feedback of their own. */
export async function copyWithNotice(text: string, what: string) {
  try {
    await copyText(text);
    notify(`Copied ${what}`);
  } catch {
    notify(`Could not copy ${what}. Select the text and press ⌘C instead.`, true);
  }
}

let nativeMenu: Menu | null = null;

async function popupNative(entries: MenuEntry[], x: number, y: number) {
  const menu = await Menu.new({
    items: entries.map((entry) => entry.kind === 'separator'
      ? { item: 'Separator' as const }
      : {
        // Let Tauri assign each popup its own item IDs. Closing an old popup removes its handlers by ID.
        text: entry.label,
        enabled: !entry.disabled,
        accelerator: entry.shortcut ? accelerators[entry.shortcut] : undefined,
        action: () => entry.run(),
      }),
  });
  // The previous menu has closed by the time another opens; release its native resources.
  const previous = nativeMenu;
  nativeMenu = menu;
  void previous?.close().catch(() => undefined);
  await menu.popup(new LogicalPosition(x, y));
}

/**
 * Shows a context menu: the native macOS menu in the desktop app, otherwise
 * (browser preview, or if the native menu fails) the HTML menu.
 */
export async function showContextMenu(items: MenuEntry[], point: { x: number; y: number }) {
  const entries = normalizeMenu(items);
  if (!entries.some((entry) => entry.kind === 'action')) return;
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (isTauri()) {
    try {
      await popupNative(entries, point.x, point.y);
      return;
    } catch {
      // Fall through to the HTML menu so the actions stay reachable.
    }
  }
  useMenuState.setState({ menu: { entries, x: point.x, y: point.y, returnFocus } });
}

export function closeContextMenu() {
  const menu = useMenuState.getState().menu;
  if (!menu) return;
  useMenuState.setState({ menu: null });
  menu.returnFocus?.focus({ preventScroll: true });
}
