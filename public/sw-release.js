/* Generated into /sw.js by build-shell-release.js; not a page script. */
'use strict';

function createShellReleaseCache({ manifest, storage, fetcher, worker, cryptoApi, origin, canReplaceDocument }) {
  const META = 'usernode-shell-releases-v1';
  const CONTENT = 'usernode-shell-content-v1';
  const PREFIX = '/__usernode-shell/';
  const currentKey = PREFIX + 'current';
  const manifests = new Map();
  const reads = new Map();
  const pending = new Map();
  let writeTail = Promise.resolve();
  let cleaning = null;
  function withStorageLock(action) {
    // Installing and active workers share CacheStorage. Serialize mutations
    // across them so cleanup cannot remove a download that just completed.
    if (worker.navigator?.locks) return worker.navigator.locks.request('usernode-shell-release', action);
    const run = writeTail.then(action);
    writeTail = run.catch(() => {});
    return run;
  }
  const buildKey = value => value.revision === 'dev' ? value.id : value.revision;
  const manifestKey = value => PREFIX + 'release/' + value;
  const assetKey = entry => PREFIX + 'content/' + entry.hash + entry.path;
  const scopedPath = (entry, release) => release.revision !== 'dev' && /\.(js|css)$/.test(entry.path)
    ? `/b/${release.revision}${entry.path}` : entry.path;
  const requestUrl = value => new URL(typeof value === 'string' ? value : value.url, origin);
  const sha256 = async bytes => Array.from(new Uint8Array(await cryptoApi.subtle.digest('SHA-256', bytes)))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');

  function validate(value) {
    if (!value || value.version !== 1 || !/^(?:[a-f0-9]{7,40}|dev)$/.test(value.revision)
        || !/^[a-f0-9]{64}$/.test(value.id) || !Array.isArray(value.assets)
        || !value.assets.length || value.assets.length > 1000) throw new Error('Invalid shell release');
    const seen = new Set();
    for (const entry of value.assets) {
      if (!entry || typeof entry.path !== 'string' || !/^\/[a-zA-Z0-9_./-]+$/.test(entry.path)
          || entry.path.includes('..') || entry.path.startsWith('//') || seen.has(entry.path)
          || !/^[a-f0-9]{64}$/.test(entry.hash) || typeof entry.precache !== 'boolean'
          || entry.path.startsWith('/api/')) throw new Error('Invalid shell asset');
      seen.add(entry.path);
    }
    if (!value.assets.some(entry => entry.path === '/index.html' && entry.precache)) {
      throw new Error('Shell release has no document');
    }
    return value;
  }

  async function readJson(key) {
    const response = await (await storage.open(META)).match(key);
    return response ? response.json() : null;
  }
  async function putJson(key, value) {
    await (await storage.open(META)).put(key, new Response(JSON.stringify(value), {
      headers: { 'Content-Type': 'application/json' },
    }));
  }
  async function getManifest(key) {
    if (!key) return null;
    if (manifests.has(key)) return manifests.get(key);
    if (!reads.has(key)) reads.set(key, (async () => {
      const value = await readJson(manifestKey(key));
      if (value) manifests.set(key, validate(value));
      return value;
    })().finally(() => reads.delete(key)));
    return reads.get(key);
  }
  async function current() {
    return getManifest((await readJson(currentKey))?.build);
  }
  async function fetchFresh(url) {
    return fetcher(url, { cache: 'reload', redirect: 'error', signal: AbortSignal.timeout(20000) });
  }
  async function fetchManifest(expected) {
    const response = await fetchFresh('/shell/release.json');
    if (!response.ok) throw new Error('Shell release unavailable');
    const value = validate(await response.json());
    if (expected && value.revision !== expected) throw new Error('Shell build mismatch');
    return value;
  }
  async function asset(entry, release) {
    const cache = await storage.open(CONTENT);
    const key = assetKey(entry);
    const hit = await cache.match(key);
    if (hit) return hit;
    const response = await fetchFresh(scopedPath(entry, release));
    if (!response.ok || response.redirected) throw new Error('Shell asset unavailable');
    // Only downloaded assets are hashed. A normal cached load does no
    // hashing and no revalidation; identical bytes survive backend updates.
    if (await sha256(await response.clone().arrayBuffer()) !== entry.hash) {
      throw new Error('Shell asset belongs to another release');
    }
    await cache.put(key, response.clone());
    return response;
  }
  async function documentFor(release) {
    if (!release) return null;
    return (await storage.open(CONTENT)).match(assetKey(release.assets.find(entry => entry.path === '/index.html')));
  }

  async function stage(value) {
    const release = validate(value);
    if (pending.has(release.id)) return pending.get(release.id);
    const run = withStorageLock(async () => {
      await putJson(PREFIX + 'pending/' + release.id, { ...release, expiresAt: Date.now() + 300000 });
      try {
        const entries = release.assets.filter(entry => entry.precache);
        // Bound download concurrency; lazy chunks remain on demand.
        let next = 0;
        const results = await Promise.allSettled(Array.from({ length: Math.min(6, entries.length) }, async () => {
          while (next < entries.length) await asset(entries[next++], release);
        }));
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
        // Publish metadata only after the COMPLETE required shell is durable.
        const saved = { ...release, installedAt: Date.now() };
        await putJson(manifestKey(buildKey(release)), saved);
        manifests.set(buildKey(release), saved);
        return saved;
      } finally {
        await (await storage.open(META)).delete(PREFIX + 'pending/' + release.id);
      }
    }).finally(() => pending.delete(release.id));
    pending.set(release.id, run);
    return run;
  }
  function promote(release, previous, ordered = false) {
    return withStorageLock(async () => {
      const active = await current();
      // An older in-flight navigation must not undo a completed update.
      if (previous !== undefined && (active?.id || null) !== previous && active?.id !== release.id) return false;
      // A sequential response from an old rollout replica is also stale,
      // even if no other request won the race. Explicit version-prefetch
      // messages may intentionally roll back to a previously built image.
      if (ordered && !canReplaceDocument(await documentFor(active), await documentFor(release))) return false;
      await putJson(currentKey, { build: buildKey(release) });
      return true;
    });
  }

  async function noteClient(id, revision) {
    if (id && typeof id === 'string' && /^[a-zA-Z0-9-]+$/.test(id)
        && /^(?:[a-f0-9]{7,64}|dev)$/.test(revision || '')) {
      await putJson(PREFIX + 'client/' + id, { build: revision });
    }
  }

  async function prune() {
    const cache = await storage.open(META);
    const keys = await cache.keys();
    const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const live = new Set(clients.map(client => client.id));
    const keep = new Set([(await readJson(currentKey))?.build]);
    const releases = [];
    const needed = new Set();
    const reportedClients = new Set();
    for (const key of keys) {
      const pathname = requestUrl(key).pathname;
      if (pathname.startsWith(PREFIX + 'client/')) {
        const id = pathname.slice((PREFIX + 'client/').length);
        if (live.has(id)) {
          const build = (await readJson(key))?.build;
          keep.add(build);
          if (await getManifest(build)) reportedClients.add(id);
        }
        else await cache.delete(key);
      } else if (pathname.startsWith(PREFIX + 'pending/')) {
        const release = await readJson(key);
        if (release?.expiresAt > Date.now()) {
          release.assets.forEach(entry => needed.add(requestUrl(assetKey(entry)).href));
        } else await cache.delete(key);
      } else if (pathname.startsWith(PREFIX + 'release/')) {
        const release = await readJson(key);
        if (release) releases.push(release);
      }
    }
    // Current + one previous release, and anything still used by an open
    // tab. Assets are stored once by hash, not duplicated per release.
    releases.sort((a, b) => b.installedAt - a.installedAt).slice(0, 2)
      .forEach(release => keep.add(buildKey(release)));
    for (const release of releases) {
      const key = buildKey(release);
      if (keep.has(key)) release.assets.forEach(entry => needed.add(requestUrl(assetKey(entry)).href));
      else { await cache.delete(manifestKey(key)); manifests.delete(key); }
    }
    const content = await storage.open(CONTENT);
    for (const key of await content.keys()) {
      if (!needed.has(key.url)) await content.delete(key);
    }
    // Keep pre-migration assets until every open tab is accounted for by a
    // generated release. Never prune the API/auth or immutable-image caches.
    if (reportedClients.size === live.size) {
      for (const name of await storage.keys()) {
        if (/^usernode-shell-v\d+$/.test(name)) await storage.delete(name);
      }
    }
  }
  function cleanup() {
    // Several tabs can report ownership at once after a worker activation.
    if (!cleaning) cleaning = withStorageLock(prune).finally(() => { cleaning = null; });
    return cleaning;
  }

  async function prefetch(expected) {
    const before = (await current())?.id || null;
    try {
      const release = await stage(await fetchManifest(expected));
      const ok = await promote(release, before);
      if (ok) await cleanup().catch(() => {});
      return { ok, mismatch: !ok };
    } catch (error) { return { ok: false, mismatch: /mismatch|another release/.test(error.message) }; }
  }

  async function navigate(event) {
    const before = await current();
    const cached = await documentFor(before);
    const fresh = (async () => {
      const response = await fetchFresh(event.request);
      if (!response.ok) throw new Error('Shell document unavailable');
      const revision = response.headers.get('x-platform-build');
      if (before && revision && revision === before.revision) return { response, release: before };
      if (cached && !canReplaceDocument(cached, response)) return { response: cached, release: before };
      const release = await stage(await fetchManifest(revision));
      const won = await promote(release, before?.id || null, true);
      const selected = won ? release : await current();
      return { response: await documentFor(selected), release: selected };
    })();
    event.waitUntil(fresh.then(() => cleanup()).catch(() => {}));
    let timer;
    const fallback = cached ? new Promise(resolve => {
      timer = setTimeout(() => resolve({ response: cached, release: before }), 200);
    }) : new Promise(() => {});
    let selected;
    try {
      selected = await Promise.race([fresh, fallback]);
    } catch (err) {
      if (!cached) throw err;
      selected = { response: cached, release: before };
    } finally { clearTimeout(timer); }
    event.waitUntil(noteClient(event.resultingClientId || event.clientId, buildKey(selected.release)).catch(() => {}));
    return selected.response;
  }

  async function respond(event) {
    const url = requestUrl(event.request);
    const scoped = /^\/b\/([a-f0-9]{7,40})(\/.*)$/.exec(url.pathname);
    const client = !scoped && event.clientId ? await readJson(PREFIX + 'client/' + event.clientId) : null;
    const release = scoped ? await getManifest(scoped[1]) : await getManifest(client?.build) || await current();
    const pathname = scoped ? scoped[2] : url.pathname;
    const entry = release?.assets.find(item => item.path === pathname);
    if (entry) {
      try {
        const response = await asset(entry, release);
        const headers = new Headers(response.headers);
        if (release.revision !== 'dev') headers.set('X-Platform-Build', release.revision);
        // A cached Response retains its original network URL. Reusing that
        // object under /b/NEW/... would resolve relative module imports and
        // CSS URLs against /b/OLD/.... A synthetic response keeps the NEW
        // request URL while reusing the already-verified body as a stream.
        return new Response(response.body, { status: response.status, headers });
      }
      catch { return new Response('This interface version is unavailable. Reload when online.', { status: 503 }); }
    }
    // Existing v36 clients may outlive the first automatic-cache release.
    // They keep their exact cached bytes until they navigate to a new shell.
    if (scoped) {
      for (const name of await storage.keys()) {
        if (!/^usernode-shell-v\d+$/.test(name)) continue;
        const hit = await (await storage.open(name)).match(event.request);
        if (hit) return hit;
      }
      const response = await fetchFresh(event.request);
      if (response.ok && response.headers.get('x-platform-build') === scoped[1]) return response;
      return new Response('This interface version is unavailable. Reload when online.', { status: 503 });
    }
    return null;
  }

  validate(manifest);
  return {
    install: async () => {
      const key = PREFIX + 'install/' + manifest.id;
      await putJson(key, { previous: (await current())?.id || null });
      try { return await stage(manifest); }
      catch (error) { await (await storage.open(META)).delete(key); throw error; }
    },
    activate: async () => {
      const release = await getManifest(buildKey(manifest));
      if (!release || !await documentFor(release)) throw new Error('Incomplete shell installation');
      const install = await readJson(PREFIX + 'install/' + manifest.id);
      await promote(release, install?.previous, true);
      await (await storage.open(META)).delete(PREFIX + 'install/' + manifest.id);
      await cleanup().catch(() => {});
    },
    navigate, respond, prefetch, noteClient, cleanup,
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createShellReleaseCache };
