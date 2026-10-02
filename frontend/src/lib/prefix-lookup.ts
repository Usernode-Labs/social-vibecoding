/**
 * A typeahead that asks the server per prefix (#3361): `@a`, then `@al`,
 * then `@alex`, each its own request. Two things go wrong without care, and
 * this is where they are handled once for every caller:
 *
 *   - ANSWERS ARRIVE OUT OF ORDER. A slow `@a` landing after `@alex` must
 *     not replace or close the list for `@alex`. `ask` resolves null for any
 *     prefix that is no longer the latest one asked, so a stale answer is
 *     dropped by construction rather than by each caller remembering to.
 *   - THE SAME PREFIX IS ASKED TWICE. A caret move re-syncs the list without
 *     the text changing; an in-flight request is shared, and a finished one
 *     is remembered, so neither costs a second request.
 *
 * A failed request is not remembered (the next keystroke retries) and
 * resolves as an empty list for the latest prefix, so the list closes.
 */
export interface PrefixLookup<T> {
  /** The remembered answer for `query`, or null when there is none yet. */
  cached: (query: string) => T[] | null;
  /**
   * Ask for `query` and make it the latest prefix. Resolves with its answer,
   * or null when a later `ask` has superseded it by the time it lands.
   */
  ask: (query: string) => Promise<T[] | null>;
}

export function prefixLookup<T>(fetcher: (query: string) => Promise<T[]>): PrefixLookup<T> {
  const done = new Map<string, T[]>();
  const inflight = new Map<string, Promise<T[]>>();
  let latest: string | null = null;
  const keyOf = (query: string) => query.toLowerCase();
  return {
    cached(query) {
      return done.get(keyOf(query)) ?? null;
    },
    async ask(query) {
      const key = keyOf(query);
      latest = key;
      let pending = inflight.get(key);
      const hit = done.get(key);
      if (!hit && !pending) {
        pending = fetcher(query).then((found) => { done.set(key, found); return found; });
        inflight.set(key, pending);
        const settle = () => { if (inflight.get(key) === pending) inflight.delete(key); };
        pending.then(settle, settle);
      }
      let found: T[];
      try {
        found = hit ?? await (pending as Promise<T[]>);
      } catch {
        found = [];
      }
      return latest === key ? found : null;
    },
  };
}
