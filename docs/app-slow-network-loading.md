# Making an app load fast on a poor connection

Hand this to an app's dev chat when the app is quick offline, quick on wifi,
and painful on a weak mobile signal.

**Read the "Offline — apps that open with no connection" section of the
platform conventions first.** It is the binding contract; this document is
how to hit the performance goal without breaking it. Where the two ever
disagree, the conventions win.

## The problem, precisely

There are three network states, not two:

| state | what `fetch` does | what the user sees |
|---|---|---|
| online | resolves fast | fast load |
| offline | rejects immediately | offline mode, immediately |
| **poor** | **opens, stalls, eventually resolves** | **a long blank wait** |

Offline is fast *because failure is fast*. A weak signal never fails — the
socket opens and then crawls — so every request holds its slot for as long
as the connection wants. Nothing is broken, so nothing falls back.

The second half of the problem is that these waits **stack serially**.
Nothing requests `/app.js` until `index.html` has parsed, and nothing
renders data until `/app.js` has run. Three tiers with a 3-second patience
each is a nine-second blank screen, and none of the three looks
unreasonable on its own.

## The split that matters

**The service worker caches your shell. It does not touch your data.**

That division is not a style preference — it falls out of how apps are
authenticated. The app gets a per-user JWT injected as `?token=`, and **an
offline load carries no token at all**. A worker that replayed cached
`GET /api/*` would therefore hand the previous user's authenticated data to
whoever opens the app next, with nothing in the loop to authenticate it.
The platform's own worker does cache its API, but it sits on the
session-cookie origin, clears that cache on logout and reconciles the
session endpoint — an app has none of those.

So:

- **Shell** (`index.html`, JS, CSS, fonts, icons) → the worker, **cache-first**.
  The cost of a stale shell is being one deploy behind for one load, and the
  next load fixes it. Do not race the network for these.
- **Data** (`/api/*`) → **never the worker**. Keep the app's own read cache
  in the page, keyed to the user you remember, painted immediately and
  reconciled when the network answers. Same instant-paint result, at a layer
  that knows whose data it is holding.
- **Content-addressed assets** (hashed filenames, upload ids) → the worker,
  cache-first forever. A stale hit is impossible by construction.

## Recipe

### 1. Keep the bridge tag

```html
<script src="https://social-vibecoding.usernodelabs.org/usernode-bridge/v1/bridge.js"></script>
```

Required whether or not the app calls a single `usernode.*` API: it is how
the app answers the shell, and an app that omits it can never be opened
offline no matter what else it does. Never vendor it.

### 2. Add `public/sw.js` — shell only

```js
// Shell cache only. /api/* is deliberately absent from this file; see the
// platform conventions on offline apps for why a worker must never serve it.
const SW_VERSION = 'v1';
const SHELL_CACHE = `myapp-shell-${SW_VERSION}`;

// Every local file the app needs to render. Keep this list honest — a
// missing entry is a blank screen on the first offline load.
const SHELL_ASSETS = ['/', '/index.html', '/app.js', '/tailwind.css'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Per-asset and best-effort: one 404 must not brick the whole install.
    await Promise.allSettled(SHELL_ASSETS.map((p) => cache.add(p)));
    // Take control on the FIRST visit. The shell decides whether this app
    // can open offline by asking whether a worker served this document, so
    // waiting for a second visit costs the capability on this one.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.startsWith('myapp-') && n !== SHELL_CACHE)
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// Cache-first: the whole point. No race, no deadline — if we have it, it
// ships now, and the network copy refreshes the cache for the next load.
async function shell(event, key) {
  const cache = await caches.open(SHELL_CACHE);
  const req = key || event.request;
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) {
    event.waitUntil(fetch(event.request)
      .then((res) => (res && res.ok ? cache.put(req, res.clone()) : null))
      .catch(() => {}));
    return hit;
  }
  // Nothing cached — a first-ever load. Wait it out; there is no fallback,
  // and failing early would turn a slow load into a broken one.
  const res = await fetch(event.request);
  if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                 // never intercept writes
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // never intercept third parties
  if (url.pathname.startsWith('/api/')) return;     // NEVER the worker's business

  if (req.mode === 'navigate') {
    event.respondWith(shell(event, '/index.html'));
  } else if (/\.(?:js|css|woff2?|png|svg|webmanifest)$/i.test(url.pathname)) {
    event.respondWith(shell(event));
  }
  // everything else: browser default
});
```

Register it:

```js
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
```

Registration can be refused outright in a cross-origin iframe — some
WebViews deny storage to one. That is a normal degradation, not something
to work around: no worker means the shell shows its reconnect placeholder,
which is the correct outcome rather than a platform bug.

### 3. Put the read cache in the page, keyed to the user

This is the half that used to live in the worker. It belongs here because
this is the only layer that knows who the data belongs to.

```js
// Whose data is this? On an ONLINE load the injected token names them; on an
// offline load there is no token, so fall back to the last user we saw.
// Returns null when we have never seen one — and null must render empty,
// never somebody else's cache.
//
// This reads the token WITHOUT verifying it, which is fine for exactly one
// purpose: choosing a cache key. It is never an authorization decision. The
// server verifies the same token properly (RS256, issuer `usernode`,
// audience `usernode:app:<USERNODE_APP_ID>`) and gates every /api/* answer
// there, so a forged token buys a wrong local cache namespace and nothing
// else.
function currentUserId() {
  const token = new URLSearchParams(location.search).get('token');
  if (token) {
    try {
      // JWT payloads are base64URL: restore the two swapped characters
      // before atob, which only accepts standard base64.
      const raw = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const id = JSON.parse(atob(raw)).id;      // the platform's user claim
      if (id != null) {
        localStorage.setItem('myapp.lastUser', String(id));
        return String(id);
      }
    } catch { /* malformed token — fall through to the remembered user */ }
  }
  return localStorage.getItem('myapp.lastUser');  // may be null
}

const key = (user, url) => `myapp.cache.${user}.${url}`;

// Paint from cache immediately, then reconcile when the network answers.
// The callback may fire twice: once with the remembered copy, once with the
// truth. Make render() idempotent.
export async function loadCached(url, render) {
  const user = currentUserId();
  if (!user) return render(null);                    // unknown: show empty

  try {
    const saved = localStorage.getItem(key(user, url));
    if (saved) render(JSON.parse(saved));            // instant paint
  } catch { /* unreadable cache is just a cold start */ }

  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) return;                             // never cache a 401/500
    const data = await res.json();
    try {
      localStorage.setItem(key(user, url), JSON.stringify(data));
    } catch { /* quota — the screen is still correct, just not saved */ }
    render(data);                                    // the correction
  } catch {
    /* offline: the cached paint above stands */
  }
}
```

`localStorage` is shown because it is short enough to read. Anything beyond
a few hundred KB wants IndexedDB — the shape is identical.

Two rules this code exists to honour:

- **Never destroy per-user data because the token is absent.** An offline
  boot has no token. An app that treats that as "anonymous" and clears its
  namespace deletes the real user's saved work on their first offline load.
  Note that nothing above ever clears anything.
- **Never paint a cache you cannot attribute.** `currentUserId()` returning
  null renders empty, not the last user's rows.

### 4. Make revalidation cheap

Serve the app's own HTML/JS/CSS with `Cache-Control: no-cache,
must-revalidate`. That is not "don't cache" — it means "revalidate before
reuse", so the background refresh is a conditional GET that comes back
`304 Not Modified` when nothing changed. Without it the browser's heuristic
caching fights your worker; with it the background pass costs a round trip
instead of a full download.

```js
app.use(express.static('public', {
  setHeaders: (res, p) => {
    if (/\.(?:html|js|css|webmanifest)$/i.test(p)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));
```

### 5. Survive the reconnect reload

When the connection returns, the shell mints a token and re-points the
frame — the app reloads. Anything held only in memory is gone, so queue
mutations durably (same storage as above) and replay them on boot. And be
honest in the UI: a device that refuses durable storage cannot promise
"3 changes will sync", and saying so beats a queue that silently vanishes.

## Rules that are not optional

- **Never serve `/api/*` from the worker.** See the split above.
- **Never cache non-GETs.** Return early from the fetch handler.
- **Never intercept SSE / streaming responses.** A cached stream buffers
  forever and the connection appears to hang.
- **Never cache non-200s.** A cached 401 or 500 masks the real answer for
  as long as it lives.
- **Never vendor the bridge, the native kit, or the hosted Tailwind.** The
  copy freezes the day you make it and fleet-wide fixes stop reaching you.

## What this also buys you

Doing the above earns the app an **offline launch**: the shell opens an app
with no connection precisely when that app's own worker was serving its
document on a previous online visit, which it detects through the bridge
rather than any self-declaration. An app with no worker gets the reconnect
placeholder — correct behaviour, not a bug. So the shell work in step 2 is
not only a speed fix; it is the difference between opening offline and not.

Note also that storage is **partitioned by top-level site**: the cache the
app warms inside the platform shell is a different partition from the one it
warms when opened standalone. Both work; they do not share, so expect the
first load in each context to be cold.

## Prompt to paste into the app's dev chat

> Our app loads fast on wifi and fast when fully offline, but very slowly on
> a weak connection. Please fix it following
> `docs/app-slow-network-loading.md`, and read the "Offline — apps that open
> with no connection" section of the platform conventions first — it is
> binding and this must not violate it.
>
> Add a service worker that precaches the app shell (`index.html`, JS, CSS)
> and serves it **cache-first** with a background refresh, calling
> `skipWaiting()` and `clients.claim()` so the first visit counts. Keep the
> bridge `<script>` tag. The worker must **never** intercept `/api/*`,
> non-GET requests, or SSE streams, and must never cache a non-200.
>
> Move read caching into the page instead: keep the last response per
> `(user, url)` in the app's own storage, paint it immediately, then
> reconcile when the network answers. Derive the user from the injected
> `?token=` and remember it — an offline load arrives with **no token**, so
> fall back to the remembered user, render empty when there is none, and
> never clear per-user data just because the token is missing.
>
> Also set `Cache-Control: no-cache, must-revalidate` on the app's own
> HTML/JS/CSS so the background refresh is a cheap 304, and persist unsent
> mutations so they survive the reload that happens when the connection
> returns.
>
> Please include a test covering the `/api/*` bypass and the no-token path.
