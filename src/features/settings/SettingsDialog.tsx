import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useDisplayPreferences } from './preferences';
import type { Appearance } from './useAppearance';

interface Props {
  open: boolean;
  onClose: () => void;
  showHash: boolean;
  setShowHash: (value: boolean) => void;
  appearance: Appearance;
  local: boolean;
  setAppearance: (value: Appearance) => void;
}

export function SettingsDialog({ open, onClose, showHash, setShowHash, appearance, setAppearance, local }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const absoluteDates = useDisplayPreferences((state) => state.absoluteDates);
  const setAbsoluteDates = useDisplayPreferences((state) => state.setAbsoluteDates);

  useEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open) element.showModal();
    if (!open && element?.open) element.close();
  }, [open]);

  return (
    <dialog ref={dialog} className="settings-dialog" aria-labelledby="settings-title" onCancel={onClose} onClose={onClose}>
      <header>
        <h2 id="settings-title">Settings</h2>
        <button className="icon-button" aria-label="Close settings" title="Close settings" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className="settings-content">
        <label className="settings-row">
          <span>Appearance</span>
          <select className="control" value={appearance} onChange={(event) => {
            const value = event.target.value;
            setAppearance(value === 'dark' || value === 'light' ? value : 'system');
          }}>
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <label className="settings-row">
          <span>Always show commit dates</span>
          <input type="checkbox" checked={absoluteDates} onChange={(event) => setAbsoluteDates(event.target.checked)} />
        </label>
        {!local && <label className="settings-row">
          <span>Show commit hashes</span>
          <input type="checkbox" checked={showHash} onChange={(event) => setShowHash(event.target.checked)} />
        </label>}
        <div className="settings-row">
          <span>Data source</span><span className="settings-value">{local ? 'Local Git' : 'Mock repositories'}</span>
        </div>
        <div className="settings-shortcuts">
          <h3 className="section-caption">Keyboard shortcuts</h3>
          <dl>
            <div><dt>Find repository</dt><dd><kbd>⌘ K</kbd></dd></div>
            <div><dt>Search current view</dt><dd><kbd>⌘ F</kbd></dd></div>
            <div><dt>Refresh repository</dt><dd><kbd>⌘ R</kbd></dd></div>
          </dl>
        </div>
      </div>
    </dialog>
  );
}
