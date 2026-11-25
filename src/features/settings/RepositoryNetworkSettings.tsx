import { useEffect, useState } from 'react';
import type { Repository } from '../../services/contracts';
import { proxyLabels, type OperationActions, type RepositoryProxy } from '../../services/operations';
import { displayError } from '../../stores/gitdesk';

export function RepositoryNetworkSettings({ repository, operations }: {
  repository: Repository; operations: OperationActions;
}) {
  const [mode, setMode] = useState<RepositoryProxy['mode'] | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const repoId = repository.id;

  useEffect(() => {
    let active = true;
    void operations.getProxy(repoId).then(
      (proxy) => {
        if (!active) return;
        setMode(proxy.mode);
        if (proxy.mode === 'custom') setUrl(proxy.url);
        setError('');
      },
      (failure: unknown) => { if (active) setError(displayError(failure)); },
    );
    return () => { active = false; };
  }, [operations, repoId, attempt]);

  async function save() {
    if (!mode || busy) return;
    setBusy(true);
    setSaved(false);
    setError('');
    try {
      const proxy = await operations.saveProxy(repoId, mode === 'custom' ? { mode, url } : { mode });
      if (proxy.mode === 'custom') setUrl(proxy.url);
      setSaved(true);
    } catch (failure) { setError(displayError(failure)); }
    finally { setBusy(false); }
  }

  return <section className="settings-release-targets settings-network" aria-labelledby="repository-network-title">
    <h3 id="repository-network-title">Network · {repository.name}</h3>
    {!mode && !error && <p role="status" className="text-muted">Reading proxy settings…</p>}
    {mode && <form className="release-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label className="settings-network-mode">
        <span>HTTP proxy</span>
        <select className="control" value={mode} disabled={busy} onChange={(event) => {
          setMode(event.target.value as RepositoryProxy['mode']);
          setError('');
          setSaved(false);
        }}>
          {Object.entries(proxyLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      {mode === 'custom' && <label>Proxy URL
        <input value={url} onChange={(event) => { setUrl(event.target.value); setSaved(false); setError(''); }}
          placeholder="http://127.0.0.1:7890" required maxLength={512} disabled={busy} spellCheck={false} />
      </label>}
      <p className="text-muted">Applies to HTTP(S) Fetch, Pull and Push for this repository. SSH uses your SSH configuration.</p>
      <div className="release-buttons">
        <button className="control" disabled={busy || (mode === 'custom' && !url.trim())} type="submit">Save proxy</button>
        {saved && <span role="status" className="text-muted">Proxy saved.</span>}
      </div>
    </form>}
    {error && <p role="alert">{error} {!mode && <button className="control" onClick={() => { setError(''); setAttempt(attempt + 1); }}>Retry</button>}</p>}
  </section>;
}
