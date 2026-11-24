import { Search, X } from 'lucide-react';
import type { KeyboardEvent, RefObject } from 'react';

interface Props {
  inputRef: RefObject<HTMLInputElement | null>;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onEscape: () => void;
  onEnter?: (reverse: boolean) => void;
}

export function SearchField({ inputRef, label, value, onChange, onEscape, onEnter }: Props) {
  function handleKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onEscape();
    } else if (event.key === 'Enter' && onEnter) {
      event.preventDefault();
      onEnter(event.shiftKey);
    }
  }

  return (
    <div className="search-field">
      <Search size={14} aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        aria-label={label}
        placeholder={`${label}…`}
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKey}
      />
      {value && (
        <button
          className="icon-button clear-search"
          aria-label={`Clear ${label.toLowerCase()}`}
          title="Clear search"
          onClick={() => { onChange(''); inputRef.current?.focus(); }}
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}
