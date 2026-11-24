import { graphGeometry, graphPalette } from '../../core/graph/types';
import type { GraphRow } from '../../core/graph/types';

const { inset, spacing, height } = graphGeometry;
const middle = height / 2;
const x = (lane: number) => inset + lane * spacing;
const color = (colorId: number) => graphPalette[colorId % graphPalette.length];
const lineWidth = 2;
/** Drawn in the row background so nodes separate from the lines passing through them. */
const separation = { stroke: 'var(--graph-row-bg)', strokeWidth: 2 } as const;

export function GraphCell({ row, width, selected = false }: { row: GraphRow; width: number; selected?: boolean }) {
  const center = x(row.lane);
  const tone = color(row.colorId);

  return (
    <svg className="graph-cell" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <g fill="none" strokeWidth={lineWidth} strokeLinecap="round">
        {row.through.map((segment) => (
          <path
            key={segment.lane}
            d={`M ${x(segment.lane)} 0 V ${height}`}
            stroke={color(segment.colorId)}
          />
        ))}
        {row.incoming && <path d={`M ${center} 0 V ${middle}`} stroke={tone} />}
        {row.parentEdges.map(({ parentOid, destination }) => {
          const end = x(destination.lane);
          const path = end === center
            ? `M ${center} ${middle} V ${height}`
            : `M ${center} ${middle} C ${center} ${middle + 7} ${end} ${height - 6} ${end} ${height}`;
          return <path key={parentOid} d={path} stroke={color(destination.colorId)} />;
        })}
      </g>
      {selected && <circle className="graph-selection" cx={center} cy={middle} r="8.5" />}
      {row.nodeKind === 'merge' ? (
        <>
          <circle cx={center} cy={middle} r="5.2" fill="var(--graph-row-bg)" stroke={tone} strokeWidth="2" />
          <circle cx={center} cy={middle} r="2" fill={tone} />
        </>
      ) : row.nodeKind === 'root' ? (
        <rect x={center - 3.6} y={middle - 3.6} width="7.2" height="7.2" rx="1.2" fill={tone} {...separation} />
      ) : row.nodeKind === 'boundary' ? (
        <path d={`M ${center - 4.5} ${middle - 3.5} H ${center + 4.5} L ${center} ${middle + 4.5} Z`} fill="var(--graph-row-bg)" stroke={tone} strokeWidth="2" strokeLinejoin="round" />
      ) : (
        <circle cx={center} cy={middle} r="4.3" fill={tone} {...separation} />
      )}
    </svg>
  );
}
