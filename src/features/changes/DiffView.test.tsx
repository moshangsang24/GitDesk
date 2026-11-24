// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DiffView } from './DiffView';

afterEach(cleanup);

describe('DiffView', () => {
  it('renders patch text verbatim and preserves the change sign', () => {
    const source = '<img src=x onerror=alert(1)>';
    const { container } = render(<DiffView file={{
      id: 'markup',
      path: 'example.html',
      status: 'A',
      diff: {
        kind: 'text',
        hunks: [{ header: '@@ -0,0 +1,1 @@', lines: [{ kind: 'add', newLine: 1, text: source }] }],
      },
    }} />);

    expect(screen.getByText(source).tagName).toBe('CODE');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('+').textContent).toBe('+');
  });

  it('explains why a binary patch cannot be displayed', () => {
    render(<DiffView file={{ id: 'preview', path: 'preview.png', status: 'M', diff: { kind: 'binary' } }} />);
    expect(screen.getByRole('status').textContent).toContain('Binary file');
  });
});
