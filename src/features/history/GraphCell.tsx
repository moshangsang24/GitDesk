import { graphGeometry, graphPalette } from '../../core/graph/types';
import type { GraphRow } from '../../core/graph/types';

const { inset, spacing, height } = graphGeometry;
const middle = height / 2;
const x = (lane: number) => inset + lane * spacing;
const color = (colorId: number) => graphPalette[colorId % graphPalette.length];

export function GraphCell({ row, width }: { row: GraphRow; width: number }) {
  const center = x(row.lane);
  const tone = color(row.colorId);

  return (
    <svg className="graph-cell" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <g fill="none" strokeWidth="1.8">
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
      {row.nodeKind === 'merge' ? (
        <>
          <circle cx={center} cy={middle} r="4.8" fill="var(--graph-row-bg)" stroke={tone} strokeWidth="1.65" />
          <circle cx={center} cy={middle} r="1.7" fill={tone} />
        </>
      ) : row.nodeKind === 'root' ? (
        <rect x={center - 3.1} y={middle - 3.1} width="6.2" height="6.2" rx="1" fill={tone} />
      ) : row.nodeKind === 'boundary' ? (
        <path d={`M ${center - 4} ${middle - 3} H ${center + 4} L ${center} ${middle + 4} Z`} fill="var(--graph-row-bg)" stroke={tone} strokeWidth="1.65" />
      ) : (
        <circle cx={center} cy={middle} r="3.8" fill={tone} />
      )}
    </svg>
  );
}
