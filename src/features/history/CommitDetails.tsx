import { Check, ChevronDown, ChevronRight, Copy, X } from 'lucide-react';
import { useState } from 'react';
import { Notice } from '../../components/ui/Notice';
import { ResizeHandle } from '../../components/ui/ResizeHandle';
import { useGitDesk } from '../../stores/gitdesk';
import { FilePreview } from '../changes/FilePreview';
import { FileList } from '../changes/FileList';
import { formatCommitDate } from './HistoryTable';

interface Props {
  height: number;
  fileWidth: number;
  onResizeFiles: (width: number) => void;
  onClose: () => void;
}

export function CommitDetails({ height, fileWidth, onResizeFiles, onClose }: Props) {
  const detail = useGitDesk((state) => state.detail);
  const openCommit = useGitDesk((state) => state.openCommit);
  const [fileId, setFileId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  if (!detail) return null;
  const { commit, parentOid, result } = detail;
  const files = result.phase === 'ready' ? result.data.files : [];
  const file = files.find(({ id }) => id === fileId) ?? files[0];

  async function copyHash() {
    try {
      await navigator.clipboard.writeText(commit.oid);
      setCopyState('copied');
    } catch {
      setCopyState('error');
      setExpanded(true);
    }
  }

  return (
    <section className="commit-details" aria-label="Commit details" style={{ height }}>
      <header className="commit-details-header">
        <button className="detail-subject" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="truncate" title={commit.subject}>{commit.subject}</span>
        </button>
        <div className="detail-meta">
          <button className="hash-button" onClick={() => { void copyHash(); }} aria-label="Copy commit hash" title={commit.oid}>
            <code>{commit.oid.slice(0, 7)}</code>
            {copyState === 'copied' ? <Check size={12} /> : <Copy size={12} />}
          </button>
          <span className="detail-author truncate" title={commit.authorName}>{commit.authorName}</span>
          <time title={formatCommitDate(commit.authorTime, true)}>{formatCommitDate(commit.authorTime)}</time>
          {result.phase === 'ready' && (
            <span className="detail-file-count">{files.length} changed {files.length === 1 ? 'file' : 'files'}</span>
          )}
          {copyState === 'copied' && <span className="sr-only" role="status">Commit hash copied.</span>}
        </div>
        {commit.parents.length > 1 && (
          <label className="parent-picker">
            <span>Compare parent</span>
            <select
              className="control"
              value={parentOid ?? ''}
              onChange={(event) => { void openCommit(commit.oid, event.target.value); }}
            >
              {commit.parents.map((parent, index) => <option key={parent} value={parent}>{index + 1} · {parent.slice(0, 7)}</option>)}
            </select>
          </label>
        )}
        <button className="icon-button close-detail" onClick={onClose} aria-label="Close commit details" title="Close details (Esc)">
          <X size={16} />
        </button>
      </header>

      {expanded && (
        <div className="commit-message-expanded">
          <code tabIndex={0}>{commit.oid}</code>
          {copyState === 'error' && <span role="status"> Select the full hash to copy it.</span>}
          <p>{result.phase === 'ready' ? result.data.message : commit.subject}</p>
          {!!commit.parents.length && <p>Parents: {commit.parents.map((oid) => <code key={oid} title={oid}>{oid.slice(0, 7)} </code>)}</p>}
          {result.phase === 'ready' && result.data.committerName && <p>Committed by {result.data.committerName}{result.data.committerTime !== undefined && ` · ${formatCommitDate(result.data.committerTime, true)}`}</p>}
        </div>
      )}

      {result.phase === 'error' && (
        <Notice title="Could not load commit details" kind="error" onRetry={() => { void openCommit(commit.oid, parentOid); }}>
          {result.message}
        </Notice>
      )}
      {result.phase === 'loading' && <Notice title="Loading commit details…" kind="loading" />}
      {result.phase === 'ready' && (
        <div className="diff-layout">
          <div className="file-panel" style={{ width: fileWidth }}>
            <h2 className="section-caption">Changed files</h2>
            <FileList files={files} selected={file?.id ?? null} onSelect={setFileId} />
          </div>
          <ResizeHandle axis="x" label="Resize changed files" value={fileWidth} min={160} max={340} onResize={onResizeFiles} />
          {file ? <FilePreview file={file} source={{ kind: 'commit', oid: commit.oid, parentOid }} /> : <Notice title={result.data.boundary ? 'Shallow history boundary' : 'No changed files'} />}
        </div>
      )}
    </section>
  );
}
