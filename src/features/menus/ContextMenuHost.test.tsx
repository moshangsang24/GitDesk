// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { separator, showContextMenu, useMenuState } from '../../services/context-menu';
import { ContextMenuHost } from './ContextMenuHost';

afterEach(() => {
  cleanup();
  useMenuState.setState({ menu: null, toast: null, confirmation: null });
});

describe('ContextMenuHost', () => {
  it('shows the HTML menu outside the desktop app and runs the chosen item', async () => {
    const run = vi.fn();
    render(<ContextMenuHost />);
    await act(() => showContextMenu([
      separator,
      { kind: 'action', id: 'copy', label: 'Copy Hash', shortcut: 'copy', run },
      { kind: 'action', id: 'off', label: 'Reveal in Finder (Desktop App Only)', disabled: true, run: vi.fn() },
    ], { x: 20, y: 20 }));

    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Copy Hash⌘C', 'Reveal in Finder (Desktop App Only)']);
    expect((items[1] as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(items[0]);

    fireEvent.click(items[0]);
    expect(run).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on Escape and returns focus to where the menu was opened', async () => {
    render(<><button>origin</button><ContextMenuHost /></>);
    const origin = screen.getByText('origin');
    origin.focus();
    await act(() => showContextMenu([{ kind: 'action', id: 'a', label: 'A', run: vi.fn() }], { x: 0, y: 0 }));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(origin);
  });

  it('does not open an empty menu', async () => {
    render(<ContextMenuHost />);
    await act(() => showContextMenu([separator], { x: 0, y: 0 }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('suppresses the WebView menu outside text areas only', () => {
    render(<><div data-testid="row">row</div><textarea aria-label="notes" /><ContextMenuHost /></>);
    const onRow = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    screen.getByTestId('row').dispatchEvent(onRow);
    expect(onRow.defaultPrevented).toBe(true);
    const inText = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    screen.getByLabelText('notes').dispatchEvent(inText);
    expect(inText.defaultPrevented).toBe(false);
  });

  it('opens the focused element’s menu with Shift+F10', () => {
    const onMenu = vi.fn();
    render(<><button onContextMenu={onMenu}>row</button><ContextMenuHost /></>);
    screen.getByText('row').focus();
    fireEvent.keyDown(window, { key: 'F10', shiftKey: true });
    expect(onMenu).toHaveBeenCalledOnce();
  });
});
