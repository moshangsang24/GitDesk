import { ArrowDown, ArrowUp, CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import type { WorktreeStatus } from '../../services/contracts';

interface ChipProps {
  tone: 'sync' | 'dirty' | 'conflict' | 'unknown';
  symbol: ReactNode;
  label: string;
  count?: number;
}

function StatusChip({ tone, symbol, label, count }: ChipProps) {
  return (
    <span className={`status-chip status-chip-${tone}`} title={label} role="img" aria-label={label}>
      <span className="status-chip-symbol" aria-hidden="true">{symbol}</span>
      {count !== undefined && <span aria-hidden="true">{count}</span>}
    </span>
  );
}

export function RepoStatus({ status, compact = false }: { status: WorktreeStatus; compact?: boolean }) {
  const ahead = status.ahead ?? 0;
  const behind = status.behind ?? 0;

  if (compact) {
    if (status.kind === 'unknown') return <StatusChip tone="unknown" label={status.detail || "Repository status unknown"} symbol="–" />;
    if (status.kind === 'conflict') {
      return <StatusChip tone="conflict" label={`${status.changes} changed files, including conflicts`} symbol="!" count={status.changes} />;
    }
    if (status.filterLimited) return <StatusChip tone="unknown" label={status.detail || 'Git clean filters limit change detection'} symbol="~" count={status.changes} />;
    if (status.kind === 'dirty') {
      return <StatusChip tone="dirty" label={`${status.changes} changed files`} symbol="•" count={status.changes} />;
    }
    if (!ahead && !behind) return null;

    return (
      <span className="repo-status-chips">
        {ahead > 0 && <StatusChip tone="sync" label={`${ahead} commits ahead`} symbol={<ArrowUp size={11} />} count={ahead} />}
        {behind > 0 && <StatusChip tone="sync" label={`${behind} commits behind`} symbol={<ArrowDown size={11} />} count={behind} />}
      </span>
    );
  }

  if (status.kind === 'unknown') return <span className="repo-status text-muted" title={status.detail ?? undefined}>Unknown</span>;

  const changed = status.kind === 'dirty' || status.kind === 'conflict';
  const synced = ahead === 0 && behind === 0;

  return (
    <span className="repo-status">
      {status.kind === 'conflict' && (
        <span className="conflict-status" title={`${status.changes} changed files, including conflicts`}>
          <CircleAlert size={12} aria-hidden="true" />
          Conflicts
        </span>
      )}
      {status.kind === 'dirty' && (
        <span className="dirty-status" title={status.detail ?? `${status.changes} changed files`}>
          {status.filterLimited ? `~${status.changes} changed` : `${status.changes} changed`}
        </span>
      )}
      {!changed && synced && <span className="clean-status">Clean</span>}
      {ahead > 0 && <span className="sync-status"><ArrowUp size={10} aria-hidden="true" />ahead {ahead}</span>}
      {behind > 0 && <span className="sync-status"><ArrowDown size={10} aria-hidden="true" />behind {behind}</span>}
    </span>
  );
}
