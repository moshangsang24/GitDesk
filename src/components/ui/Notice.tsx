import type { ReactNode } from 'react';

interface Props {
  title: string;
  children?: ReactNode;
  kind?: 'empty' | 'error' | 'loading';
  onRetry?: () => void;
}

export function Notice({ title, children, kind = 'empty', onRetry }: Props) {
  return (
    <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {onRetry && <button className="control" onClick={onRetry}>Retry</button>}
    </div>
  );
}
