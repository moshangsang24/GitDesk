import type { ReactNode } from 'react';
import type { ChangedFile, DiffLine } from '../../services/contracts';
import { Notice } from '../../components/ui/Notice';

function DiffRow({ line }: { line: DiffLine }) {
  const sign = line.kind === 'add' ? '+' : line.kind === 'delete' ? '−' : ' ';
  return (
    <div className={`diff-row diff-${line.kind}`}>
      <span className="line-number" aria-hidden="true">{'oldLine' in line ? line.oldLine : ''}</span>
      <span className="line-number" aria-hidden="true">{'newLine' in line ? line.newLine : ''}</span>
      <span className="line-sign">{sign}</span>
      <code>{line.text || '\u00a0'}</code>
    </div>
  );
}

export function DiffView({ file, busy, notice }: { file: ChangedFile; busy?: boolean; notice?: ReactNode }) {
  const { diff } = file;
  const path = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;

  return (
    <section className="diff-view" aria-label="Unified diff" aria-busy={busy || undefined}>
      <header className="diff-title truncate" title={path}>{path}</header>
      {notice}
      <div className="diff-scroll" tabIndex={0} aria-label="File patch">
        {diff.kind === 'text' && (
          <div className="diff-code">
            {diff.hunks.map((hunk) => (
              <div key={hunk.header} className="diff-hunk">
                <div className="hunk-header">{hunk.header}</div>
                {hunk.lines.map((line, index) => <DiffRow key={index} line={line} />)}
              </div>
            ))}
            {diff.truncated && <p className="diff-message">Patch truncated. Additional lines are omitted.</p>}
          </div>
        )}
        {diff.kind === 'binary' && <Notice title="Binary file">A text patch is unavailable.</Notice>}
        {diff.kind === 'empty' && <Notice title="No text changes" />}
        {diff.kind === 'large' && <Notice title="File too large to preview">The patch exceeds the preview limit.</Notice>}
        {diff.kind === 'unavailable' && <Notice title="Preview unavailable">{diff.reason}</Notice>}
      </div>
    </section>
  );
}
