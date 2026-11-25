import { useState } from 'react';
import { shortRef } from '../../core/graph/refs';
import type { ReleaseActions, ReleaseOverview, ReleaseTask, StageSnapshot } from '../../services/release';
import { displayError } from '../../stores/gitdesk';

export function CommitLinksForm({ release, repoId, task, stage, targetRevision, snapshot, onSave }: {
  release: ReleaseActions;
  repoId: string;
  task: ReleaseTask;
  stage: number;
  targetRevision: number;
  snapshot?: StageSnapshot;
  onSave: (overview: ReleaseOverview) => void;
}) {
  const [sourceOids, setSourceOids] = useState<string[]>([]);
  const [targetInput, setTargetInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const choices = snapshot?.state === 'ready' ? snapshot.evidence.filter(({ status }) => status !== 'included') : [];
  const links = task.fields.links ?? [];
  const targetOid = targetInput.trim();
  const ready = !!sourceOids.length && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(targetOid);

  async function save(sources: string[], replacement: string, remove: boolean) {
    setError('');
    setBusy(true);
    try {
      onSave(await release.editLinks(repoId, {
        taskId: task.id, revision: task.revision, targetRevision, stage, sourceOids: sources,
        targetOid: replacement, expectedTip: snapshot?.tip ?? null, remove,
      }));
      setSourceOids([]);
      setTargetInput('');
    } catch (failure) { setError(displayError(failure)); }
    finally { setBusy(false); }
  }

  if (!choices.length && !links.length) return null;
  return <details className="release-links-editor">
    <summary>{choices.length ? 'Associate a target commit' : 'Manage associated commits'}</summary>
    {choices.length > 0 && <form className="release-form" onSubmit={(event) => {
      event.preventDefault();
      if (ready && !busy) void save(sourceOids, targetOid, false);
    }}>
      <p>Pick the original commits represented by a commit on {shortRef(snapshot?.target ?? '')}.</p>
      <fieldset className="release-link-choices">
        <legend>Original task commits</legend>
        {choices.map(({ oid }) => <label key={oid} title={oid}>
          <input type="checkbox" checked={sourceOids.includes(oid)} disabled={busy} onChange={(event) => {
            setSourceOids(event.target.checked ? [...sourceOids, oid] : sourceOids.filter((value) => value !== oid));
          }} />
          <code>{oid.slice(0, 12)}</code>
        </label>)}
      </fieldset>
      <label>Target commit ID <input value={targetInput} onChange={(event) => setTargetInput(event.target.value)} spellCheck={false} placeholder="Full commit ID" disabled={busy} /></label>
      <div><button className="control" disabled={!ready || busy} type="submit">{busy ? 'Verifying…' : 'Verify and associate'}</button></div>
    </form>}
    {!!links.length && <ul className="release-evidence-list release-existing-links">
      {links.map(({ sourceOid, targetOid }) => <li key={`${sourceOid}:${targetOid}`}>
        <span title={`${sourceOid} → ${targetOid}`}><code>{sourceOid.slice(0, 12)}</code> → <code>{targetOid.slice(0, 12)}</code></span>
        <button className="control" disabled={busy} onClick={() => { void save([sourceOid], targetOid, true); }}>Remove association</button>
      </li>)}
    </ul>}
    {error && <p role="alert">{error}</p>}
  </details>;
}
