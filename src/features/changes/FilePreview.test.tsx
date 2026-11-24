// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangedFile, FileDiff } from '../../services/contracts';
import { useGitDesk } from '../../stores/gitdesk';
import { FilePreview } from './FilePreview';

const file: ChangedFile = { id: 'file', path: 'sample.txt', status: 'M', diff: { kind: 'deferred' } };
const source = { kind: 'changes', group: 'Unstaged' } as const;

function patch(text: string): FileDiff {
  return { kind: 'text', hunks: [{ header: '@@ -1 +1 @@', lines: [{ kind: 'add', newLine: 1, text }] }] };
}

describe('worktree preview refresh', () => {
  const originalService = useGitDesk.getState().service;
  afterEach(() => {
    cleanup();
    useGitDesk.setState({ service: originalService });
  });

  it('keeps the scroll element on refresh and skips a read when the file revision is unchanged', async () => {
    let finish!: (value: FileDiff) => void;
    const pending = new Promise<FileDiff>((resolve) => { finish = resolve; });
    const preview = vi.fn().mockResolvedValueOnce(patch('first edit')).mockReturnValueOnce(pending);
    useGitDesk.setState({ service: { ...originalService, review: {
      preview, listChanges: async () => [], open: async () => undefined,
    } } });
    const { rerender } = render(<FilePreview file={file} source={source} revision="file-stamp-a" />);
    await screen.findByText('first edit');
    const scroll = screen.getByLabelText('File patch');
    scroll.scrollTop = 140;
    rerender(<FilePreview file={{ ...file }} source={source} revision="file-stamp-a" />);
    expect(preview).toHaveBeenCalledTimes(1);
    rerender(<FilePreview file={{ ...file }} source={source} revision="file-stamp-b" />);
    expect(preview).toHaveBeenCalledTimes(2);
    expect(screen.getByText('first edit')).toBeTruthy();
    await act(async () => finish(patch('second edit')));
    expect(screen.getByText('second edit')).toBeTruthy();
    expect(screen.getByLabelText('File patch')).toBe(scroll);
    expect(scroll.scrollTop).toBe(140);
  });
});
