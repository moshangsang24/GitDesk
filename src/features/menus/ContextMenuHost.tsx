import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { closeContextMenu, shortcutLabels, useMenuState } from '../../services/context-menu';

/** Text areas keep the system menu (Copy, Select All); everything else uses the app's menus. */
const nativeTextMenu = 'input, textarea, select, [contenteditable="true"], .diff-scroll, .commit-message-expanded';

function useGlobalMenuBehaviour() {
  useEffect(() => {
    function suppressDefault(event: MouseEvent) {
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(nativeTextMenu)) return;
      event.preventDefault();
    }

    function openFromKeyboard(event: globalThis.KeyboardEvent) {
      if (!(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return;
      const target = document.activeElement;
      if (!(target instanceof HTMLElement) || target === document.body || target.closest(nativeTextMenu)) return;
      event.preventDefault();
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: rect.left + Math.min(24, rect.width / 2), clientY: rect.top + Math.min(rect.height, 28),
      }));
    }

    window.addEventListener('contextmenu', suppressDefault);
    window.addEventListener('keydown', openFromKeyboard);
    return () => {
      window.removeEventListener('contextmenu', suppressDefault);
      window.removeEventListener('keydown', openFromKeyboard);
    };
  }, []);
}

function HtmlMenu() {
  const menu = useMenuState((state) => state.menu);
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!menu || !element) { setPosition(null); return; }
    const { width, height } = element.getBoundingClientRect();
    setPosition({
      left: Math.max(4, Math.min(menu.x, window.innerWidth - width - 4)),
      top: Math.max(4, menu.y + height > window.innerHeight - 4 ? menu.y - height : menu.y),
    });
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return;
      closeContextMenu();
    };
    const dismiss = () => closeContextMenu();
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('wheel', dismiss, { capture: true, passive: true });
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('wheel', dismiss, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, [menu]);

  if (!menu) return null;

  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (event.key === 'ArrowDown') next = buttons[(index + 1) % buttons.length];
    else if (event.key === 'ArrowUp') next = buttons[(index - 1 + buttons.length) % buttons.length];
    else if (event.key === 'Home') next = buttons[0];
    else if (event.key === 'End') next = buttons.at(-1);
    else if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); closeContextMenu(); return; }
    else return;
    event.preventDefault();
    next?.focus();
  }

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-orientation="vertical"
      style={position ? { left: position.left, top: position.top } : { left: menu.x, top: menu.y, visibility: 'hidden' }}
      onKeyDown={handleKey}
      onContextMenu={(event) => event.preventDefault()}
    >
      {menu.entries.map((entry, index) => entry.kind === 'separator'
        ? <div key={`separator-${index}`} className="context-menu-separator" role="separator" />
        : (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            onClick={() => { closeContextMenu(); entry.run(); }}
          >
            <span>{entry.label}</span>
            {entry.shortcut && <kbd>{shortcutLabels[entry.shortcut]}</kbd>}
          </button>
        ))}
    </div>
  );
}

function Toast() {
  const toast = useMenuState((state) => state.toast);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => {
      if (useMenuState.getState().toast?.id === toast.id) useMenuState.setState({ toast: null });
    }, toast.error ? 5000 : 1800);
    return () => window.clearTimeout(timer);
  }, [toast]);
  return (
    <div className="app-toast-region" role="status" aria-live="polite">
      {toast && <div className={`app-toast${toast.error ? ' app-toast-error' : ''}`}>{toast.text}</div>}
    </div>
  );
}

function ConfirmDialog() {
  const confirmation = useMenuState((state) => state.confirmation);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (confirmation && element && !element.open) element.showModal();
    if (!confirmation && element?.open) element.close();
  }, [confirmation]);

  function settle(confirmed: boolean) {
    confirmation?.resolve(confirmed);
    useMenuState.setState({ confirmation: null });
  }

  return (
    <dialog ref={dialog} className="settings-dialog confirm-dialog" aria-labelledby="confirm-title" onCancel={() => settle(false)}>
      {confirmation && (
        <form method="dialog" onSubmit={(event) => { event.preventDefault(); settle(true); }}>
          <h2 id="confirm-title">{confirmation.title}</h2>
          <p>{confirmation.message}</p>
          <div className="confirm-actions">
            <button type="button" className="control" onClick={() => settle(false)} autoFocus>Cancel</button>
            <button type="submit" className="control control-danger">{confirmation.confirmLabel}</button>
          </div>
        </form>
      )}
    </dialog>
  );
}

/** Mounted once beside the app: HTML menu fallback, notices, confirmations and global menu keys. */
export function ContextMenuHost() {
  useGlobalMenuBehaviour();
  return (
    <>
      <HtmlMenu />
      <Toast />
      <ConfirmDialog />
    </>
  );
}
