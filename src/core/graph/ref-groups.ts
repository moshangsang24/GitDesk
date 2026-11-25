/**
 * Groups branch names into folders by the segment before the first "/".
 * A prefix becomes a folder only when at least two names share it, so a lone
 * `hotfix/x` stays a plain row instead of a one-item folder.
 */
export interface RefFolder<T> {
  prefix: string;
  items: Array<{ ref: T; leaf: string }>;
}

export interface GroupedRefs<T> {
  folders: Array<RefFolder<T>>;
  loose: Array<{ ref: T; leaf: string }>;
}

const compare = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare;

export function groupByPrefix<T>(refs: readonly T[], nameOf: (ref: T) => string): GroupedRefs<T> {
  const byPrefix = new Map<string, Array<{ ref: T; leaf: string }>>();
  const loose: Array<{ ref: T; leaf: string }> = [];
  for (const ref of refs) {
    const name = nameOf(ref);
    const slash = name.indexOf('/');
    if (slash <= 0 || slash === name.length - 1) {
      loose.push({ ref, leaf: name });
      continue;
    }
    const prefix = name.slice(0, slash);
    const entry = { ref, leaf: name.slice(slash + 1) };
    const items = byPrefix.get(prefix);
    if (items) items.push(entry);
    else byPrefix.set(prefix, [entry]);
  }

  const folders: Array<RefFolder<T>> = [];
  for (const [prefix, items] of byPrefix) {
    if (items.length < 2) {
      loose.push({ ref: items[0].ref, leaf: `${prefix}/${items[0].leaf}` });
      continue;
    }
    items.sort((a, b) => compare(a.leaf, b.leaf));
    folders.push({ prefix, items });
  }
  folders.sort((a, b) => compare(a.prefix, b.prefix));
  loose.sort((a, b) => compare(a.leaf, b.leaf));
  return { folders, loose };
}
