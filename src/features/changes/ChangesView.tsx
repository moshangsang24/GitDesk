import { useState } from 'react';
import { Notice } from '../../components/ui/Notice';
import { ResizeHandle } from '../../components/ui/ResizeHandle';
import type { ChangeGroup, WorktreeChange } from '../../services/contracts';
import { FilePreview } from './FilePreview';
import { FileList } from './FileList';

const groups: ChangeGroup[] = ['Staged', 'Unstaged', 'Untracked', 'Conflicts'];

interface Props {
  changes: WorktreeChange[];
  query: string;
  fileWidth: number;
  onResizeFiles: (width: number) => void;
  revision?: number;
  baseOid?: string | null;
}

export function ChangesView({ changes, query, fileWidth, onResizeFiles, revision, baseOid }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  if (!changes.length) return <Notice title="Working tree clean" />;

  const search = query.trim().toLowerCase();
  const visible = changes.filter(({ path, oldPath }) => path.toLowerCase().includes(search) || oldPath?.toLowerCase().includes(search));
  if (!visible.length) return <Notice title="No matching changes">Try a different file name or path.</Notice>;
  const file = visible.find(({ id }) => id === selected) ?? visible[0];
  const previewRevision = file.revision
    ? JSON.stringify([baseOid, file.revision, file.status, file.oldPath, file.stats])
    : String(revision ?? '');

  return (
    <div className="changes-layout diff-layout">
      <div className="changes-groups file-panel" style={{ width: fileWidth }} aria-label="Uncommitted changes">
        {groups.map((group) => {
          const files = visible.filter((entry) => entry.group === group);
          if (!files.length) return null;

          return (
            <section key={group} className={`change-group change-${group.toLowerCase()}`}>
              <h2 className="section-caption change-group-heading">
                <span className="change-dot" aria-hidden="true" />
                {group}
                <span className="change-group-count">{files.length}</span>
              </h2>
              <FileList files={files} selected={file.id} onSelect={setSelected} />
            </section>
          );
        })}
      </div>
      <ResizeHandle axis="x" label="Resize worktree changes" value={fileWidth} min={160} max={340} onResize={onResizeFiles} />
      <FilePreview file={file} source={{ kind: 'changes', group: file.group }} revision={previewRevision} />
    </div>
  );
}
