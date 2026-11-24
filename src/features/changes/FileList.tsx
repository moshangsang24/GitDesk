import { showContextMenu } from '../../services/context-menu';
import type { ChangedFile } from '../../services/contracts';
import { copy, worktreeFilePath } from '../menus/actions';
import { fileMenu } from '../menus/menus';

const statusLabels: Record<ChangedFile['status'], string> = {
  A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', U: 'Conflict',
};

interface Props {
  files: ChangedFile[];
  selected: string | null;
  onSelect: (id: string) => void;
}

function DiffStats({ file }: { file: ChangedFile }) {
  if (!file.stats && file.diff.kind !== 'text') return null;
  let { added, deleted } = file.stats ?? { added: 0, deleted: 0 };
  for (const { lines } of !file.stats && file.diff.kind === 'text' ? file.diff.hunks : []) {
    for (const { kind } of lines) {
      if (kind === 'add') ++added;
      else if (kind === 'delete') ++deleted;
    }
  }

  return (
    <span className="diff-stats">
      {added > 0 && <span className="add-count">+{added}</span>}
      {deleted > 0 && <span className="delete-count">−{deleted}</span>}
    </span>
  );
}

export function FileList({ files, selected, onSelect }: Props) {
  return (
    <ul className="file-list">
      {files.map((file) => (
        <li key={file.id}>
          <button
            className="file-button"
            aria-current={selected === file.id ? 'true' : undefined}
            aria-label={`${statusLabels[file.status]} ${file.path}`}
            title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
            onClick={(event) => {
              event.currentTarget.focus({ preventScroll: true });
              onSelect(file.id);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.currentTarget.focus({ preventScroll: true });
              onSelect(file.id);
              void showContextMenu(fileMenu(
                { path: file.path, fullPath: worktreeFilePath(file.path) },
                { copy, show: () => onSelect(file.id) },
              ), { x: event.clientX, y: event.clientY });
            }}
          >
            <span className={`file-status file-status-${file.status}`} title={statusLabels[file.status]}>{file.status}</span>
            <span className="truncate file-path">{file.path}</span>
            <DiffStats file={file} />
          </button>
        </li>
      ))}
    </ul>
  );
}
