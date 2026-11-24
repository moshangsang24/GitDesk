import { useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

interface Props {
  axis: 'x' | 'y';
  label: string;
  value: number;
  min: number;
  max: number;
  reverse?: boolean;
  onResize: (value: number) => void;
}

export function ResizeHandle({ axis, label, value, min, max, reverse = false, onResize }: Props) {
  const drag = useRef<{ coordinate: number; start: number } | null>(null);
  const clamp = (next: number) => onResize(Math.round(Math.max(min, Math.min(max, next))));
  const coordinate = (event: PointerEvent) => axis === 'x' ? event.clientX : event.clientY;

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { coordinate: coordinate(event), start: value };
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    const delta = coordinate(event) - drag.current.coordinate;
    clamp(drag.current.start + delta * (reverse ? -1 : 1));
  }

  function resizeWithKeys(event: KeyboardEvent<HTMLDivElement>) {
    const forward = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
    const backward = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
    if (event.key === 'Home') clamp(min);
    else if (event.key === 'End') clamp(max);
    else if (event.key === forward || event.key === backward) {
      const direction = (event.key === forward ? 1 : -1) * (reverse ? -1 : 1);
      clamp(value + (event.shiftKey ? 24 : 8) * direction);
    } else return;

    event.preventDefault();
  }

  return (
    <div
      className={`resize-handle resize-${axis}`}
      role="separator"
      aria-label={label}
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onKeyDown={resizeWithKeys}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onLostPointerCapture={() => { drag.current = null; }}
    />
  );
}
