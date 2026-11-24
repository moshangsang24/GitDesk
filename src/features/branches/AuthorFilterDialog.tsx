import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { shortRef } from '../../core/graph/refs';
import type { AuthorFilter, CommitAuthor, GitRef } from '../../services/contracts';
import { displayError, useGitDesk } from '../../stores/gitdesk';

function defaultBase(refs: GitRef[], branches: GitRef[]) {
  const originHead = refs.find((entry) => entry.fullName === 'refs/remotes/origin/HEAD')?.symbolicTarget;
  const candidates = [originHead, 'refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master'];
  return candidates.find((candidate) => branches.some(({ fullName }) => fullName === candidate)) ?? '';
}

function authorKey(author: CommitAuthor) {
  return JSON.stringify([author.name, author.email]);
}

export function AuthorFilterDialog({ repoId, refs, saved, onApply, onClose }: {
  repoId: string;
  refs: GitRef[];
  saved: AuthorFilter | null;
  onApply(filter: AuthorFilter): void;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const listAuthors = useGitDesk((state) => state.service.history?.listAuthors);
  const branches = refs.filter((ref) => ref.kind !== 'tag' && !ref.symbolicTarget);
  const [baseRef, setBaseRef] = useState(() => saved ? saved.baseRef : defaultBase(refs, branches));
  const [authors, setAuthors] = useState<CommitAuthor[] | null>(null);
  const [chosen, setChosen] = useState<CommitAuthor | null>(saved?.author ?? null);
  const [query, setQuery] = useState('');
  const [manual, setManual] = useState(false);
  const [name, setName] = useState(saved?.author.name ?? '');
  const [email, setEmail] = useState(saved?.author.email ?? '');
  const [error, setError] = useState('');
  const [attempt, retry] = useState(0);

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  useEffect(() => {
    if (!listAuthors) return;
    const controller = new AbortController();
    void listAuthors(repoId, controller.signal).then(
      (result) => { if (!controller.signal.aborted) { setAuthors(result); setError(''); } },
      (failure: unknown) => { if (!controller.signal.aborted) setError(displayError(failure)); },
    );
    return () => controller.abort();
  }, [listAuthors, repoId, attempt]);

  const key = chosen ? authorKey(chosen) : '';
  const term = query.trim().toLowerCase();
  const matches = authors?.filter((author) => `${author.name} ${author.email}`.toLowerCase().includes(term)) ?? [];
  const options = matches.slice(0, 120);
  if (chosen && !options.some((author) => authorKey(author) === key)) options.unshift(chosen);
  const validBase = branches.some((branch) => branch.fullName === baseRef);
  const author = manual ? (name.trim() && email.trim() ? { name: name.trim(), email: email.trim() } : null) : chosen;

  return (
    <dialog ref={dialog} className="settings-dialog author-filter-dialog" aria-labelledby="author-filter-title" onCancel={onClose}>
      <header>
        <h2 id="author-filter-title">My branches</h2>
        <button type="button" className="icon-button" aria-label="Close author filter" onClick={onClose}><X size={16} /></button>
      </header>
      <form className="settings-content release-form" onSubmit={(event) => {
        event.preventDefault();
        if (author && validBase) onApply({ author, baseRef });
      }}>
        <p>Choose your Git author identity. History will show branches with your commits beyond the base branch.</p>
        {manual ? (
          <div className="release-task-fields">
            <label>Author name <input required maxLength={256} value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>Author email <input required maxLength={256} value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          </div>
        ) : (
          <>
            <label>Find a commit author <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name or email" /></label>
            <label>Commit author
              <select className="control" value={key} onChange={(event) => setChosen(options.find((option) => authorKey(option) === event.target.value) ?? null)}>
                <option value="">{authors ? 'Choose an author' : error || !listAuthors ? 'Authors unavailable' : 'Reading recent authors…'}</option>
                {options.map((option) => <option key={authorKey(option)} value={authorKey(option)}>{option.email ? `${option.name} <${option.email}>` : option.name}</option>)}
              </select>
            </label>
            {authors && !matches.length && <p role="status">{term ? 'No matching authors in recent commits.' : 'Recent branch history contains no authors.'}</p>}
            {matches.length > 120 && <p role="status">Showing 120 authors. Search by name or email to narrow the list.</p>}
            {error && <div role="alert">{error} <button type="button" className="control" onClick={() => { setError(''); retry(attempt + 1); }}>Retry</button></div>}
          </>
        )}
        <button type="button" className="control author-filter-manual" onClick={() => setManual(!manual)}>{manual ? 'Choose from recent authors' : 'Enter name and email'}</button>
        <label>Base branch
          <select className="control" value={validBase ? baseRef : ''} onChange={(event) => setBaseRef(event.target.value)}>
            <option value="">Choose a base branch</option>
            {branches.map((branch) => <option key={branch.fullName} value={branch.fullName}>{shortRef(branch.fullName)} · {branch.kind === 'local' ? 'Local' : 'Remote'}</option>)}
          </select>
        </label>
        <div className="release-buttons">
          <button className="control" type="submit" disabled={!author || !validBase}>Show my branches</button>
          <button className="control" type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </dialog>
  );
}
