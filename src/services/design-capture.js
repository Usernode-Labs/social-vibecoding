'use strict';

// #6354: a design of one of Homeroom's own pages starts from that page, not
// from a guess at it. Asked to "show me the Homeroom bot page with a search
// box", the design bot used to rebuild the page from the code: eleven reads
// of the source, then a drawing that was first blank and then wider than the
// real page (private thread 16876).
//
// This module is the door the design bot's `capture_page` tool goes through:
//
//   1. PAGES maps a page's name (or route) to its DEMO route. Demo routes
//      answer with made-up rows only on a staging copy (USERNODE_ENV is
//      'staging'), never on production, so a capture can only ever hold
//      fixture data. A route outside this table is refused, so the job never
//      opens an arbitrary address.
//   2. ensureCopy keeps ONE staging copy of Homeroom running at the image the
//      platform is serving, so the first capture after a quiet spell waits
//      for it to start and later ones take seconds. It is stopped after
//      IDLE_MS.
//   3. The capture job (capture/capture.js, PAGE_CAPTURE mode) opens the demo
//      route at the asked size, signed in as the seeded `usernode-capture`
//      fixture, and runs the design serializer in the page
//      (frontend/src/features/design/capture.ts, published as
//      window.UsernodeReact.designCapture). It answers with the HTML, which
//      design-threads.js stores as version 1, "As it is now".
//
// The person's own session, rows and identity never reach the job: only the
// fixture token and a route from this table are sent.

const crypto = require('node:crypto');
const log = require('./logger');
const applicationRuntime = require('./application-runtime');
const dbManager = require('./db-manager');
const docker = require('./docker');
const kubernetes = require('./kubernetes');
const stagingEnv = require('./staging-env');

const CAPTURE_IMAGE = 'usernode-capture:latest';
// The design bot's own cap on the version it reads (design-bot.js
// MAX_DESIGN_CHARS). Kept here too so this module never requires the bot.
const MAX_DESIGN_CHARS = 120_000;
// A page copy is always taken at one of the design bot's two sizes.
const VIEWPORTS = Object.freeze({
  phone: Object.freeze({ width: 390, height: 844 }),
  desktop: Object.freeze({ width: 1280, height: 800 }),
});
// This copy of Homeroom answers within this long, or the capture falls back
// to drawing the page from the code.
const COPY_READY_MS = 180_000;
const JOB_TIMEOUT_MS = 60_000;
// How long the one demo copy stays up after its last capture.
const IDLE_MS = 30 * 60 * 1000;
const COPY_NAME = 'usernode-design-capture';
const CAPTURE_USERNAME = 'usernode-capture';
// The pg advisory lock that keeps two processes from starting two copies.
const COPY_LOCK = 0x6c61796f; // 'layo'

/**
 * The pages Homeroom can copy for a design, by the name people use. Each
 * route carries `?demo=1` and is answered with mock rows only on a staging
 * copy; `<self>` is the platform's own app slug (the one its dapp.json
 * checks use).
 */
const PAGES = Object.freeze([
  Object.freeze({ key: 'homeroom-bot', name: 'Homeroom bot page', route: () => '/?demo=1#homeroom-bot' }),
  Object.freeze({ key: 'main-chat', name: 'Main Chat', route: () => '/?demo=1#homeroom-bot/main' }),
  Object.freeze({ key: 'messages', name: 'Messages', route: () => '/?demo=1#messages' }),
  Object.freeze({ key: 'communities', name: 'Communities', route: () => '/?demo=1#communities' }),
  Object.freeze({ key: 'project', name: 'project page', route: (self) => `/?demo=1#app/${self}/dev` }),
  Object.freeze({ key: 'workshop', name: 'Workshop', route: (self) => `/app/${self}/workshop?demo=1` }),
  Object.freeze({ key: 'request', name: 'request page', route: (self) => `/?demo=1#app/${self}/dev/issues/900003` }),
]);

/** Pure: a route with the platform's own slug taken out, so any slug matches. */
function genericRoute(route) {
  return String(route).replace(/(app\/)[^/]+(\/)/i, '$1*$2').toLowerCase();
}

/**
 * Pure: the page named, keyed or routed by `text`, case-insensitively, or
 * null. A route matches with any app slug in it, so the same table answers
 * for every deployment's own slug.
 */
function findPage(text) {
  const want = String(text ?? '').trim().toLowerCase().replace(/\/+$/, '');
  if (!want) return null;
  const bare = want.replace(/^#/, '');
  for (const page of PAGES) {
    if (want === page.key.toLowerCase() || want === page.name.toLowerCase()) return page;
    const route = page.route('*');
    if (want === genericRoute(route) || genericRoute(want) === genericRoute(route)) return page;
    // "#homeroom-bot", "homeroom-bot/main" and the like: the route's hash.
    const hash = String(route).split('#')[1];
    if (hash && (bare === hash.toLowerCase() || want === hash.toLowerCase())) return page;
  }
  return null;
}

/** Pure: a page's demo route with the platform's own slug filled in. */
function routeOf(page, selfSlug) {
  return page.route(String(selfSlug || ''));
}

/** Pure: the capture job's payload for a page and size. */
function jobSpec(page, selfSlug, size, url) {
  return {
    url,
    viewport: VIEWPORTS[size === 'phone' ? 'phone' : 'desktop'],
    page: page.key,
    route: routeOf(page, selfSlug),
  };
}

/** Every stylesheet the copy names by its own origin, rewritten to this site's path. */
function rewriteSheets(html) {
  return String(html).replace(/href="(https?:\/\/[^"]+)"/g, (whole, href) => {
    let path;
    try { path = new URL(href).pathname; } catch { return whole; }
    if (path === '/usernode-native/v1/native.css' || path === '/css/app.css' || path === '/css/tailwind.css') {
      return `href="${path}"`;
    }
    return whole;
  });
}

/** Pure: the HTML in a capture job's stdout, or null. */
function readPageFrame(stdout) {
  const text = String(stdout || '');
  const head = text.match(/__USERNODE_PAGE__ bytes=(\d+)\r?\n/);
  if (!head) return null;
  const from = head.index + head[0].length;
  const end = text.indexOf('__USERNODE_PAGE_END__', from);
  if (end < 0) return null;
  const encoded = text.slice(from, end).replace(/\s+/g, '');
  if (!encoded) return null;
  try {
    const html = Buffer.from(encoded, 'base64').toString('utf8');
    return html.trim() ? html : null;
  } catch {
    return null;
  }
}

/** Pure: why a capture job gave up, or null when it did not say. */
function readPageFailure(stdout) {
  const found = String(stdout || '').match(/__USERNODE_PAGE_FAIL__ reason=([^\s]+)/);
  if (!found) return null;
  try { return decodeURIComponent(found[1]); } catch { return found[1]; }
}

// ── The one demo copy ────────────────────────────────────────────────────

// { promise, copy } while a copy is starting; `copy` once it answered.
let starting = null;
// { url, runtimeName, runtimeKind, dbName, sessionId, expiresAt, timer }
let current = null;

/** Pure: the copy's own names, from a random token. */
function copyNames(kind, slug = 'app') {
  const token = crypto.randomBytes(8).toString('hex');
  return {
    sessionId: Number(String(Date.now()).slice(-9)),
    runtimeName: kind === 'kubernetes' ? `sv-design-cap-${token.slice(0, 12)}` : `${COPY_NAME}-${token.slice(0, 12)}`,
    // A shots clone's shape: disposable, so its sessions may be cut and it
    // may be dropped when the copy goes.
    dbName: dbManager.shotsDbName(slug, token, 'base'),
  };
}

/** The image the platform is serving right now, immutable. */
async function servingImage(config) {
  if (applicationRuntime.mode(config) === 'docker') {
    return docker.imageDigest(process.env.USERNODE_PLATFORM_IMAGE || 'usernode-platform:latest');
  }
  const cfg = config.kubernetes || {};
  const { apps } = kubernetes._getClients();
  const deployment = await apps.readNamespacedDeployment({
    name: cfg.platformDeployment || 'social-vibecoding',
    namespace: cfg.platformNamespace || 'social-platform',
  });
  const containers = deployment?.spec?.template?.spec?.containers || [];
  const image = (containers.find((container) => container.name === 'app') || containers[0] || {}).image;
  if (!image || !image.includes('@sha256:')) throw new Error('The platform image is not an immutable digest');
  return image;
}

/** Pure: the staging env a copy runs with: staging, a fresh database, no model key. */
function copyEnv(config, app, databaseUrl) {
  return {
    ...stagingEnv.platformStagingEnv(app, config),
    DATABASE_URL: databaseUrl,
  };
}

/** Resolves once the copy answers /health, or throws after COPY_READY_MS. */
async function waitForCopy(url) {
  const until = Date.now() + COPY_READY_MS;
  let last = null;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return;
      last = `status ${res.status}`;
    } catch (err) {
      last = err?.message || 'unreachable';
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`The demo copy did not answer: ${last || 'timed out'}`);
}

/** Start the one demo copy and leave it up for IDLE_MS after its last use. */
async function startCopy(config, pool, { deps = {} } = {}) {
  const app = await selfApp(pool, config);
  if (!app) throw new Error('Homeroom has no app row');
  const kind = applicationRuntime.mode(config);
  const names = copyNames(kind, app.slug);
  const imageRef = deps.servingImage ? await deps.servingImage(config) : await servingImage(config);
  const created = deps.createDatabase
    ? await deps.createDatabase(names.dbName)
    : await dbManager.createEmptyPlatformDatabase(names.dbName);
  const databaseUrl = deps.connectionUrl
    ? deps.connectionUrl(names.dbName, created.password)
    : dbManager.connectionUrl(names.dbName, created.password);
  const deploy = deps.deploy || applicationRuntime.deploy;
  // The platform's own staging env, with its dapp.json secrets resolved the
  // way a shots copy's are. When they cannot be resolved the copy still gets
  // the platform-owned half and may start degraded; a capture that cannot
  // open falls back to drawing, never breaks the turn.
  let env = copyEnv(config, app, databaseUrl);
  if (!deps.deploy) {
    try {
      const shots = require('./shots-environment');
      env = {
        ...(await shots.resolvedStagingEnv(config, pool, { id: names.sessionId }, app, process.cwd())),
        DATABASE_URL: databaseUrl,
      };
    } catch (err) {
      log.warn('design-capture', 'The demo copy starts without resolved staging secrets', { err: err?.message });
    }
  }
  // A platform preview is refused unless it carries the data-policy label its
  // empty database was made with.
  const policy = require('./platform-preview-data-policy');
  const labels = { [policy.APP_ID_LABEL]: String(app.id) };
  if (created.platformPreviewPolicy) Object.assign(labels, policy.runtimeLabels(created));
  const deployed = await deploy(config, {
    app,
    environment: 'staging',
    sessionId: names.sessionId,
    imageRef,
    dockerName: names.runtimeName,
    runtimeName: names.runtimeName,
    internalOnly: true,
    env,
    port: 3000,
    memory: docker.STAGING_MEMORY,
    cpus: docker.STAGING_CPUS,
    labels,
  });
  const url = deployed?.url || `http://${names.runtimeName}:3000`;
  await waitForCopy(url);
  const copy = {
    url, runtimeName: names.runtimeName, runtimeKind: kind, dbName: names.dbName,
    sessionId: names.sessionId, appId: app.id, expiresAt: Date.now() + IDLE_MS, timer: null,
  };
  log.info('design-capture', 'A design demo copy is up', { runtimeName: copy.runtimeName, dbName: copy.dbName });
  return copy;
}

/** The platform's own app row, or null. */
async function selfApp(pool, config) {
  if (!config?.selfAppSlug) return null;
  const { rows: [row] } = await pool.query(
    'SELECT id, slug, name FROM apps WHERE slug = $1', [String(config.selfAppSlug)],
  );
  return row || null;
}

/** Stop the copy and drop its database. Never throws. */
async function stopCopy(config, copy = current, { deps = {} } = {}) {
  if (!copy) return;
  if (copy.timer) clearTimeout(copy.timer);
  if (current === copy) current = null;
  try {
    const remove = deps.remove || applicationRuntime.remove;
    await remove(config, { runtimeName: copy.runtimeName, runtimeKind: copy.runtimeKind, appId: copy.appId });
  } catch (err) {
    log.warn('design-capture', 'Could not stop the design demo copy', { err: err?.message });
  }
  try {
    await (deps.dropDatabase || dbManager.dropDisposableDatabase)(copy.dbName);
  } catch (err) {
    log.warn('design-capture', 'Could not drop the design demo copy database', { err: err?.message });
  }
  log.info('design-capture', 'The design demo copy is gone', { runtimeName: copy.runtimeName });
}

function touch(copy) {
  copy.expiresAt = Date.now() + IDLE_MS;
  if (copy.timer) clearTimeout(copy.timer);
  copy.timer = setTimeout(() => { stopCopy(copy).catch(() => {}); }, IDLE_MS);
  // Never hold the process open for a copy nobody is using.
  if (typeof copy.timer.unref === 'function') copy.timer.unref();
}

/**
 * The one demo copy, started when there is none. Two callers share one
 * start: in this process through `starting`, and across processes through a
 * pg advisory lock. Resolves the copy; throws when it cannot start.
 */
async function ensureCopy(config, pool, { deps = {} } = {}) {
  if (current && Date.now() < current.expiresAt) {
    touch(current);
    return current;
  }
  if (starting) return starting;
  starting = (async () => {
    const client = typeof pool?.connect === 'function' ? await pool.connect() : null;
    try {
      if (client) await client.query('SELECT pg_advisory_lock($1)', [COPY_LOCK]);
      if (current && Date.now() < current.expiresAt) {
        touch(current);
        return current;
      }
      const copy = await startCopy(config, pool, { deps });
      current = copy;
      touch(copy);
      return copy;
    } finally {
      if (client) {
        await client.query('SELECT pg_advisory_unlock($1)', [COPY_LOCK]).catch(() => {});
        client.release();
      }
      starting = null;
    }
  })();
  return starting;
}

// ── The capture ──────────────────────────────────────────────────────────

/** Sign in as the seeded capture fixture, never the person who asked. */
async function fixtureToken(pool, config, { deps = {} } = {}) {
  const mint = deps.mintCaptureToken
    || ((user, appId, options) => require('./visuals').mintCaptureToken(user, appId, options));
  const app = await selfApp(pool, config);
  if (!app) throw new Error('Homeroom has no app row');
  const { rows: [user] } = await pool.query(
    'SELECT id, username, usernode_pubkey FROM users WHERE username = $1', [CAPTURE_USERNAME],
  );
  if (!user) throw new Error('The capture fixture is missing');
  return mint(user, app.id, { previewOnly: true });
}

/** Run the capture job and resolve its stdout. */
async function runCaptureJob(config, spec, { deps = {} } = {}) {
  const env = { PAGE_CAPTURE: JSON.stringify(spec) };
  const payload = { env, memory: '2g', cpus: '2', timeoutMs: JOB_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 };
  if (deps.runJob) return deps.runJob(payload);
  if (config.captureRuntime === 'kubernetes') {
    return kubernetes.runCaptureJob(config, { ...payload, sessionId: spec.sessionId || 1 });
  }
  // The same capture image the shots run in, built on first use.
  await require('./visuals').ensureCaptureImage();
  return docker.runOneShot(`${COPY_NAME}-job-${crypto.randomBytes(4).toString('hex')}`, {
    ...payload, image: CAPTURE_IMAGE, salvagePartial: true,
  });
}

/**
 * A design's version 1: one of Homeroom's pages, copied by Homeroom itself at
 * `size` from its demo route, signed in as the fixture. Resolves
 * { ok: true, html, title, route, width, height } or { ok: false, reason }.
 * Never throws.
 */
async function capturePage(config, pool, { page, size = 'desktop', deps = {} } = {}) {
  const found = typeof page === 'string' ? findPage(page) : page;
  if (!found) return { ok: false, reason: 'unknown_page' };
  const chosen = size === 'phone' ? 'phone' : 'desktop';
  const viewport = VIEWPORTS[chosen];
  try {
    const copy = deps.copy || await ensureCopy(config, pool, { deps });
    const token = deps.token != null ? deps.token : await fixtureToken(pool, config, { deps });
    const withToken = deps.withToken || require('./visuals').withToken;
    const route = routeOf(found, config.selfAppSlug);
    const url = withToken(`${copy.url}${route}`, token);
    const spec = { ...jobSpec(found, config.selfAppSlug, chosen, url), sessionId: copy.sessionId };
    const out = await runCaptureJob(config, spec, { deps });
    const stdout = typeof out === 'string' ? out : out?.stdout;
    const failure = readPageFailure(stdout);
    if (failure) return { ok: false, reason: failure };
    const html = readPageFrame(stdout);
    if (!html) return { ok: false, reason: 'no_page' };
    const rewritten = rewriteSheets(html);
    if (rewritten.length > MAX_DESIGN_CHARS) return { ok: false, reason: 'too_big' };
    return {
      ok: true, html: rewritten, title: found.name, route, width: viewport.width, height: viewport.height,
    };
  } catch (err) {
    log.warn('design-capture', 'A design capture did not happen', { page: found.key, err: err?.message });
    return { ok: false, reason: 'capture_failed' };
  }
}

/** Test seam: drop the shared copy and any start in flight. */
function _reset() {
  if (current?.timer) clearTimeout(current.timer);
  current = null;
  starting = null;
}

module.exports = {
  PAGES, VIEWPORTS, MAX_DESIGN_CHARS, IDLE_MS,
  findPage, routeOf, jobSpec, rewriteSheets, readPageFrame, readPageFailure,
  ensureCopy, stopCopy, capturePage, selfApp, _reset,
};
