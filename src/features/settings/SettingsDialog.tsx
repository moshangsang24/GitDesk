import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { GitRef, Repository } from '../../services/contracts';
import type { ReleaseActions, ReleaseOverview } from '../../services/release';
import { displayError, useGitDesk } from '../../stores/gitdesk';
import { TargetForm } from '../releases/ReleaseForms';
import { accents, useDisplayPreferences } from './preferences';
import { RepositoryNetworkSettings } from './RepositoryNetworkSettings';
import type { Appearance } from './useAppearance';

interface Props {
  open: boolean;
  onClose: () => void;
  showHash: boolean;
  setShowHash: (value: boolean) => void;
  appearance: Appearance;
  local: boolean;
  setAppearance: (value: Appearance) => void;
  repository?: Repository;
  refs?: GitRef[];
}

function ReleaseTargetsSettings({ repository, refs, release }: {
  repository: Repository; refs?: GitRef[]; release: ReleaseActions;
}) {
  const [overview, setOverview] = useState<ReleaseOverview | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const releaseTargetsSaved = useGitDesk((state) => state.releaseTargetsSaved);
  useEffect(() => {
    let active = true;
    void release.overview(repository.id).then(
      (result) => { if (active) { setOverview(result); setError(''); } },
      (failure: unknown) => { if (active) setError(displayError(failure)); },
    );
    return () => { active = false; };
  }, [release, repository.id, attempt]);

  return <section className="settings-release-targets" aria-labelledby="settings-targets-title">
    <h3 id="settings-targets-title">Release branches · {repository.name}</h3>
    {error ? <div role="alert">{error} <button className="control" onClick={() => { setError(''); setAttempt(attempt + 1); }}>Retry</button></div>
      : overview && refs ? <TargetForm key={overview.targetRevision} release={release} repoId={repository.id} refs={refs} overview={overview} onSave={(result) => {
        setOverview(result);
        setSaved(true);
        if (result.targetRevision !== overview.targetRevision) releaseTargetsSaved(repository.id, result.targetRevision);
      }} /> : <p role="status" className="text-muted">Reading release branches…</p>}
    {saved && <p role="status" className="text-muted">Targets saved for History and Releases.</p>}
  </section>;
}

export function SettingsDialog({ open, onClose, showHash, setShowHash, appearance, setAppearance, local, repository, refs }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const absoluteDates = useDisplayPreferences((state) => state.absoluteDates);
  const setAbsoluteDates = useDisplayPreferences((state) => state.setAbsoluteDates);
  const accent = useDisplayPreferences((state) => state.accent);
  const setAccent = useDisplayPreferences((state) => state.setAccent);
  const release = useGitDesk((state) => state.service.release);
  const operations = useGitDesk((state) => state.service.operations);

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
        <fieldset className="settings-row accent-picker">
          <legend>Accent color</legend>
          <div className="accent-options">
            {accents.map(({ id, label }) => (
              <label key={id} className="accent-option" data-swatch={id} title={label}>
                <input type="radio" name="accent" value={id} checked={accent === id} onChange={() => setAccent(id)} />
                <span className="accent-swatch" aria-hidden="true" />
                <span className="sr-only">{label}</span>
              </label>
            ))}
          </div>
        </fieldset>
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
        {open && operations && repository && <RepositoryNetworkSettings key={`network:${repository.id}`} repository={repository} operations={operations} />}
        {open && release && (repository
          ? <ReleaseTargetsSettings key={`release-targets:${repository.id}`} repository={repository} refs={refs} release={release} />
          : <p className="text-muted settings-release-targets">Select a repository to configure its release branches.</p>)}
        <div className="settings-shortcuts">
          <h3 className="section-caption">Keyboard shortcuts</h3>
          <dl>
            <div><dt>Find repository</dt><dd><kbd>⌘ K</kbd></dd></div>
            <div><dt>Search current view</dt><dd><kbd>⌘ F</kbd></dd></div>
            <div><dt>Refresh repository</dt><dd><kbd>⌘ R</kbd></dd></div>
            <div><dt>Copy selected commit hash</dt><dd><kbd>⌘ C</kbd></dd></div>
            <div><dt>Open context menu</dt><dd><kbd>⇧ F10</kbd></dd></div>
          </dl>
        </div>
      </div>
    </dialog>
  );
}
