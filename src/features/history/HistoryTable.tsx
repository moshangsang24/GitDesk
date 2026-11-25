import { useVirtualizer } from '@tanstack/react-virtual';
import { Maximize2, Minimize2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, KeyboardEvent, MouseEvent, RefObject } from 'react';
import { ResizeHandle } from '../../components/ui/ResizeHandle';
import { longRef } from '../../core/graph/refs';
import { showContextMenu } from '../../services/context-menu';
import { copy } from '../menus/actions';
import { commitMenu, refMenu } from '../menus/menus';
import { graphGeometry, graphPalette } from '../../core/graph/types';
import { useDisplayPreferences } from '../settings/preferences';
import { authorColor, authorInitials, formatCommitAge, formatFullDate, formatShortDate } from './commit-display';
import type { Commit, RefLabel, RepositoryView } from '../../services/contracts';
import { stageNames } from '../../services/release';
import { useGitDesk } from '../../stores/gitdesk';
import { GraphCell } from './GraphCell';
import { useHistoryEvidence } from '../releases/history-evidence';
import { evidenceLabels, formatObservation } from '../releases/stage';
import { Highlight } from './history-search';

const headerHeight = 26;
const minimumSubjectWidth = 190;
export function formatCommitDate(timestamp: number, detailed = false) {
  return detailed ? formatFullDate(timestamp) : formatShortDate(timestamp);
}

const refKinds: Record<RefLabel['kind'], string> = {
  head: 'HEAD', local: 'Local branch', remote: 'Remote-tracking branch', tag: 'Tag',
};

type RefMenuHandler = (label: RefLabel, event: MouseEvent) => void;

function RefBadge({ label, color, onMenu }: { label: RefLabel; color: string; onMenu?: RefMenuHandler }) {
  if (label.kind === 'head') {
    return <span className="ref-badge ref-head" title="HEAD" role="img" aria-label="HEAD" />;
  }
  return (
    <span
      className={`ref-badge ref-${label.kind}`}
      style={{ '--ref-color': color } as CSSProperties}
      title={`${refKinds[label.kind]}: ${label.name}`}
      onContextMenu={onMenu && ((event) => { event.stopPropagation(); onMenu(label, event); })}
    >
      <span className="ref-mark" aria-hidden="true" />
      <span className="truncate">{label.name}</span>
    </span>
  );
}

function RefBadges({ refs, limit, color, onMenu }: { refs: RefLabel[]; limit: number; color: string; onMenu?: RefMenuHandler }) {
  // The HEAD marker is a compact ring, so it does not use up one of the visible label slots.
  const head = refs.filter(({ kind }) => kind === 'head');
  const named = refs.filter(({ kind }) => kind !== 'head');
  // Two long names would both truncate to a few letters; show one and fold the rest into +N.
  const fits = limit > 1 && named.slice(0, 2).reduce((total, { name }) => total + name.length, 0) > 20 ? 1 : limit;
  const visible = named.slice(0, fits);
  const overflow = named.slice(fits);
  return (
    <div className="ref-labels">
      {head.map((label) => <RefBadge key="head" label={label} color={color} />)}
      {visible.map((label) => <RefBadge key={`${label.kind}-${label.name}`} label={label} color={color} onMenu={onMenu} />)}
      {overflow.length > 0 && (
        <details className="ref-overflow" onClick={(event) => event.stopPropagation()}>
          <summary className="ref-badge ref-more" aria-label={`Show ${overflow.length} more references`}>+{overflow.length}</summary>
          <span className="ref-overflow-list">
            {overflow.map((label) => <RefBadge key={`${label.kind}-${label.name}`} label={label} color={color} onMenu={onMenu} />)}
          </span>
        </details>
      )}
    </div>
  );
}

interface Props {
  data: Pick<RepositoryView, 'commits' | 'graphRows'>;
  gridRef: RefObject<HTMLDivElement | null>;
  query: string;
  matches: ReadonlySet<string>;
  showHash: boolean;
  viewportWidth: number;
  hasMore?: boolean;
  paging?: boolean;
  releaseStatus?: boolean;
  tracking?: { ids: string[]; onToggle(oid: string): void };
}

const columnLimits = {
  Author: { min: 80, max: 260 },
  Date: { min: 60, max: 135 },
  Hash: { min: 55, max: 140 },
};

export function HistoryTable({ data, gridRef, query, matches, showHash, viewportWidth, hasMore, paging, releaseStatus, tracking }: Props) {
  const selectedOid = useGitDesk((state) => state.selectedCommitOid);
  const openCommit = useGitDesk((state) => state.openCommit);
  const hasDetail = useGitDesk((state) => state.detail !== null);
  const scrollSelection = useGitDesk((state) => state.scrollSelection);
  const visibility = useGitDesk((state) => state.refVisibility);
  const repoId = useGitDesk((state) => state.repoId);
  const loadMore = useGitDesk((state) => state.loadMoreHistory);
  const setScope = useGitDesk((state) => state.setScope);
  const locateCommit = useGitDesk((state) => state.locateCommit);
  const absoluteDates = useDisplayPreferences((state) => state.absoluteDates);
  const { commits, graphRows } = data;
  const [widths, setWidths] = useState<Partial<Record<keyof typeof columnLimits, number>>>({});
  const [graphExpanded, setGraphExpanded] = useState(false);
  const columns = {
    Author: widths.Author ?? Math.round(Math.max(104, Math.min(140, viewportWidth * 0.1))),
    Date: widths.Date ?? (viewportWidth <= 780 ? 74 : 80),
    Hash: showHash ? widths.Hash ?? (viewportWidth <= 780 ? 66 : 73) : 0,
  };

  const fullGraphWidth = useMemo(() => {
    let widest = 0;
    for (const row of graphRows) {
      widest = Math.max(widest, row.lane);
      for (const lane of row.through) widest = Math.max(widest, lane.lane);
      for (const edge of row.parentEdges) widest = Math.max(widest, edge.destination.lane);
    }
    return Math.max(graphGeometry.minWidth, 2 * graphGeometry.inset + graphGeometry.spacing * widest);
  }, [graphRows]);
  const compactGraphWidth = Math.min(fullGraphWidth, viewportWidth < 850 ? 118 : 136);
  const graphWidth = graphExpanded ? fullGraphWidth : compactGraphWidth;

  // TanStack Virtual's imperative instance is used directly for keyboard navigation.
  const virtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => gridRef.current,
    getItemKey: (index) => commits[index].oid,
    estimateSize: () => graphGeometry.height,
    scrollMargin: headerHeight,
    scrollPaddingStart: headerHeight,
    overscan: 12,
  });
  const items = virtualizer.getVirtualItems();
  const selectedIndex = commits.findIndex(({ oid }) => oid === selectedOid);
  const lastVisible = items.at(-1)?.index ?? -1;
  const firstBucket = Math.floor((items[0]?.index ?? 0) / 32) * 32;
  const bucketEnd = lastVisible < 0 ? 0 : Math.min(firstBucket + 200, Math.ceil((lastVisible + 1) / 32) * 32);
  const releaseResult = useHistoryEvidence(!!releaseStatus, releaseStatus ? commits.slice(firstBucket, bucketEnd).map(({ oid }) => oid) : [], repoId);
  const compactRefs = viewportWidth < 850;
  const refWidth = compactRefs ? 104 : 138;

  useEffect(() => {
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: 'auto' });
  }, [selectedIndex, scrollSelection, virtualizer]);

  useEffect(() => {
    if (hasMore && !paging && lastVisible >= 0 && lastVisible >= commits.length - 16) void loadMore();
  }, [commits.length, hasMore, lastVisible, loadMore, paging]);

  function choose(commit: Commit) {
    if (tracking) { tracking.onToggle(commit.oid); return; }
    void openCommit(commit.oid);
  }

  const focusBranch = (fullName: string) => { void setScope('ref', fullName); };

  function showCommitMenu(commit: Commit, point: { x: number; y: number }) {
    gridRef.current?.focus({ preventScroll: true });
    // Right-click selects the row first so the menu always acts on the selection.
    if (!tracking && selectedOid !== commit.oid) void openCommit(commit.oid);
    void showContextMenu(commitMenu(commit, { copy, focusBranch }), point);
  }

  function showRefMenu(commit: Commit, label: RefLabel, event: MouseEvent) {
    event.preventDefault();
    if (label.kind === 'head') return;
    const fullName = longRef(label.kind, label.name);
    void showContextMenu(refMenu(
      { kind: label.kind, fullName, name: label.name, targetOid: commit.oid },
      { copy, focusBranch, locate: (oid) => { void locateCommit(oid); } },
    ), { x: event.clientX, y: event.clientY });
  }

  function handleGridMenu(event: MouseEvent<HTMLDivElement>) {
    // Keyboard-opened menus (⇧F10) target the grid itself; use the selected row.
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    const commit = commits[selectedIndex];
    if (!commit) return;
    const rect = document.getElementById(`commit-${commit.oid}`)?.getBoundingClientRect();
    showCommitMenu(commit, rect ? { x: rect.left + 160, y: rect.bottom - 4 } : { x: event.clientX, y: event.clientY });
  }

  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'c') {
      const commit = commits[selectedIndex];
      if (commit && window.getSelection()?.isCollapsed !== false) {
        event.preventDefault();
        copy(commit.oid, 'commit hash');
      }
      return;
    }
    if (event.target !== event.currentTarget) return;
    let index: number;
    if (event.key === 'ArrowDown') index = Math.min(commits.length - 1, selectedIndex + 1);
    else if (event.key === 'ArrowUp') index = Math.max(0, selectedIndex - 1);
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = commits.length - 1;
    else if (event.key === 'Enter' || (tracking && event.key === ' ')) index = Math.max(0, selectedIndex);
    else return;

    event.preventDefault();
    if (commits[index] && (!tracking || event.key === 'Enter' || event.key === ' ')) {
      if (index !== selectedIndex || !hasDetail || event.key === 'Enter' || event.key === ' ') choose(commits[index]);
    } else if (tracking && commits[index]) {
      const row = document.getElementById(`commit-${commits[index].oid}`);
      row?.querySelector('input')?.focus();
    }
  }

  const activeDescendant = selectedIndex >= 0 && items.some(({ index }) => index === selectedIndex)
    ? `commit-${commits[selectedIndex].oid}` : undefined;

  return (
    <div
      ref={gridRef}
      className="history-grid"
      style={{
        '--history-columns': `${tracking ? '28px ' : ''}${refWidth}px ${graphWidth}px minmax(${minimumSubjectWidth}px, 1fr) ${columns.Author}px ${columns.Date}px ${showHash ? `${columns.Hash}px ` : ''}${releaseStatus ? 'repeat(3, 74px) ' : ''}max(0px, calc(100% - var(--history-data-width)))`,
        '--history-min-width': `${refWidth + graphWidth + minimumSubjectWidth + columns.Author + columns.Date + columns.Hash + (releaseStatus ? 222 : 0) + (tracking ? 28 : 0)}px`,
      } as CSSProperties}
      role="grid"
      tabIndex={0}
      aria-label="Commit history"
      aria-rowcount={hasMore ? -1 : commits.length + 1}
      aria-colcount={(showHash ? 6 : 5) + (releaseStatus ? 3 : 0) + (tracking ? 1 : 0)}
      aria-activedescendant={activeDescendant}
      onKeyDown={handleKey}
      onContextMenu={handleGridMenu}
    >
      <div className="history-header history-columns" role="row" aria-rowindex={1}>
        {tracking && <span role="columnheader" aria-label="Track commit" />}
        <span role="columnheader">Branch / Tag</span>
        <div role="columnheader" className="graph-heading">
          Graph
          {fullGraphWidth > compactGraphWidth && <button type="button" className="icon-button graph-expand"
            aria-label={graphExpanded ? 'Show compact graph' : 'Show full graph'} aria-expanded={graphExpanded}
            title={graphExpanded ? 'Show compact graph' : 'Show all graph lanes'} onClick={() => setGraphExpanded(!graphExpanded)}>
            {graphExpanded ? <Minimize2 size={12} aria-hidden="true" /> : <Maximize2 size={12} aria-hidden="true" />}
          </button>}
        </div>
        <span role="columnheader">Commit message</span>
        {(Object.keys(columns) as Array<keyof typeof columns>).map((column) => columns[column] > 0 && (
          <div key={column} role="columnheader" aria-label={column} className="resizable-column">
            {column}
            <ResizeHandle
              axis="x"
              label={`Resize ${column.toLowerCase()} column`}
              value={columns[column]}
              {...columnLimits[column]}
              reverse
              onResize={(width) => setWidths((previous) => ({ ...previous, [column]: width }))}
            />
          </div>
        ))}
        {releaseStatus && stageNames.map((stage) => <span role="columnheader" key={stage}>{stage}</span>)}
      </div>
      <div className="history-rows" role="rowgroup" style={{ height: virtualizer.getTotalSize() }}>
        {items.map(({ index, start, key }) => {
          const commit = commits[index];
          const graph = graphRows[index];
          const refs = commit.refs.filter(({ kind }) => kind !== 'local' && kind !== 'remote' || visibility[kind]);
          const isMatch = matches.has(commit.oid);
          const date = formatCommitDate(commit.authorTime, true);
          return (
            <div
              key={key}
              id={`commit-${commit.oid}`}
              className="history-row history-columns"
              style={{ transform: `translateY(${start - headerHeight}px)` }}
              role="row"
              aria-rowindex={index + 2}
              aria-selected={selectedOid === commit.oid}
              data-match={isMatch || undefined}
              data-even={index % 2 === 0 || undefined}
              onClick={() => { gridRef.current?.focus({ preventScroll: true }); choose(commit); }}
              onContextMenu={(event) => { event.preventDefault(); showCommitMenu(commit, { x: event.clientX, y: event.clientY }); }}
            >
              {tracking && <span className="history-track-cell" role="gridcell"><input type="checkbox" checked={tracking.ids.includes(commit.oid)} aria-label={`Track ${commit.subject}`} onClick={(event) => event.stopPropagation()} onChange={() => tracking.onToggle(commit.oid)} /></span>}
              <div role="gridcell" className="history-ref-cell"><RefBadges refs={refs} limit={compactRefs ? 1 : 2} color={graphPalette[graph.colorId % graphPalette.length]} onMenu={(label, event) => showRefMenu(commit, label, event)} /></div>
              <span role="gridcell" className="graph-column" title={graph.nodeKind === 'boundary' ? 'Shallow history boundary' : graph.nodeKind === 'normal' ? undefined : `${graph.nodeKind} commit`}>
                <GraphCell row={graph} width={fullGraphWidth} selected={selectedOid === commit.oid} />
                {graph.nodeKind !== 'normal' && (
                  <span className="sr-only">{graph.nodeKind === 'merge' ? `Merge, ${commit.parents.length} parents` : graph.nodeKind === 'boundary' ? 'Shallow history boundary' : 'Root commit'}</span>
                )}
              </span>
              <span role="gridcell" className="commit-message" title={commit.subject}>
                <span className="commit-subject truncate"><Highlight value={commit.subject} query={query} /></span>
              </span>
              <span role="gridcell" className="history-meta history-author" title={commit.authorName}>
                <span className="author-avatar" style={{ '--avatar-color': authorColor(commit.authorName) } as CSSProperties} aria-hidden="true">{authorInitials(commit.authorName)}</span>
                <span className="truncate"><Highlight value={commit.authorName} query={query} /></span>
              </span>
              <span role="gridcell" className="history-meta history-date truncate" title={date}>
                {absoluteDates ? formatShortDate(commit.authorTime) : formatCommitAge(commit.authorTime)}
              </span>
              {showHash && (
                <span role="gridcell" className="history-hash truncate" title={commit.oid}>
                  <Highlight value={commit.oid.slice(0, 7)} query={query} />
                </span>
              )}
              {releaseStatus && stageNames.map((stage, index) => {
                const snapshot = releaseResult?.value?.stages[index];
                const evidence = snapshot?.evidence.find(({ oid }) => oid === commit.oid);
                const pending = releaseResult?.error ?? (snapshot?.state === 'unconfigured' ? 'Unconfigured' : snapshot?.state === 'missing' ? 'Reference missing' : snapshot?.reason ?? 'Calculating');
                const label = evidence ? evidenceLabels[evidence.status] : pending;
                const glyph = evidence ? ({ included: '✓', notContained: '○', unknown: '?' })[evidence.status]
                  : releaseResult?.error || snapshot?.state === 'unknown' ? '?'
                    : snapshot?.state === 'missing' ? '!' : snapshot?.state === 'unconfigured' ? '—' : '…';
                const tooltip = [label, snapshot?.target, snapshot?.tip, snapshot && formatObservation(snapshot.observedAt), evidence?.reason].filter(Boolean).join(' · ');
                return <span key={stage} role="gridcell" className="history-release-cell" data-inclusion={evidence?.status} aria-label={`${stage}: ${label}`} title={tooltip}>{glyph}</span>;
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
