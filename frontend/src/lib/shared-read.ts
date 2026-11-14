/**
 * One request for readers that ask for the same thing at the same moment
 * (#6591).
 *
 * Two stores fill from the same two answers on every page load: Home's pins
 * (features/home/home-pins-store.ts) and the community scope
 * (features/workshop/community-scope.ts) both read the joined communities
 * and the votes waiting, a few milliseconds apart, so each was asked for
 * twice. `sharedJson` gives the second reader the first one's request.
 *
 * It is NOT a cache. An answer is shared only while its request is in
 * flight; once it lands the next reader asks the server again, so nothing
 * read here can be older than the request that fetched it, and a read made
 * after a vote, a join or a pin never sees the answer from before it unless
 * it started before that answer arrived, which the callers' own re-reads
 * already allow for.
 *
 * `fresh` asks for the current answer rather than a copy the service worker
 * kept (`cache: 'no-cache'`, request 6500). A reader that needs that never
 * joins a request made without it; a reader that does not need it may join
 * one made with it.
 */

interface InFlight {
  fresh: boolean;
  read: Promise<unknown>;
}

const inFlight = new Map<string, InFlight>();

/**
 * GET `url` as JSON, sharing a request already on its way for the same URL.
 * Rejects on a network failure or a status that is not ok, for every reader
 * sharing it. The parsed body is shared: treat it as read-only.
 */
export function sharedJson<T = unknown>(url: string, { fresh = false }: { fresh?: boolean } = {}): Promise<T> {
  const running = inFlight.get(url);
  if (running && (running.fresh || !fresh)) return running.read as Promise<T>;
  const entry: InFlight = {
    fresh,
    read: fetch(url, { credentials: 'same-origin', ...(fresh ? { cache: 'no-cache' as const } : {}) })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      }),
  };
  const done = () => { if (inFlight.get(url) === entry) inFlight.delete(url); };
  entry.read.then(done, done);
  inFlight.set(url, entry);
  return entry.read as Promise<T>;
}
