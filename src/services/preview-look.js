'use strict';

// 20 Nov 2026 (live-draft review, A): the draft bot looks at its preview.
//
// Thread 58972 made ten edits to one delete button between 15:31 and 15:47,
// and every reply said it was fixed; each time the person answered "nope"
// with a screenshot. Nothing rendered the page, so every visual claim was a
// guess. The draft's look_at_preview tool (live-draft-bot.js) comes here.
//
// It reuses the capture job the design bot's capture_page and its look at a
// version already run (design-capture.js runCaptureJob: a Kubernetes Job of
// the capture image, or a one-shot container of it on Docker), in a mode of
// its own (capture/capture.js PREVIEW_LOOK), and it reaches the preview the
// way a proposal's shots reach an app's preview (visuals.js):
//
//   - the ADDRESS is built from the draft's own row and nothing else: the
//     preview's ingress host (`<slug>--s<session>.<previews domain>`,
//     visuals.kubernetesCaptureOrigin) under the Kubernetes capture runtime,
//     else its container on the shared Docker network. The model supplies
//     only a path inside the app, which previewPath checks: relative, from
//     "/", with no scheme, host, "..", backslash or token of its own. The job
//     refuses a top-level navigation to any other origin as well;
//   - it is SIGNED IN as the seeded `usernode-capture` fixture, with the same
//     capture token the shots' "after" side carries (visuals.mintCaptureToken
//     and withToken). The person's own session never reaches the job.
//
// It answers each matched element's box, text and layout styles, the page's
// console errors and, when the turn's model can read one, a screenshot.

const log = require('./logger');

const VIEWPORTS = Object.freeze({
  phone: Object.freeze({ width: 390, height: 844 }),
  desktop: Object.freeze({ width: 1280, height: 800 }),
});
// A look waits for the job this long (a Kubernetes Job may take a while to start).
const LOOK_TIMEOUT_MS = 60_000;
const MAX_PATH_CHARS = 300;
const MAX_SELECTOR_CHARS = 300;
// The address a look may never carry: a scheme, a host, a way up, or a backslash.
const UNSAFE_PATH_RE = /[\\\u0000-\u001f\u007f]|%(?:2e|2f|5c|00)/i;

/**
 * Pure: `value` as a path inside the app (the model's words), or null. It is
 * relative to the preview's own origin and nothing else: it starts with one
 * "/", has no scheme, host, ".." segment (written or encoded), backslash,
 * control character, or `token` of its own.
 */
function previewPath(value) {
  const raw = value == null || value === '' ? '/' : value;
  if (typeof raw !== 'string') return null;
  const path = raw.trim();
  if (!path || path.length > MAX_PATH_CHARS) return null;
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  if (UNSAFE_PATH_RE.test(path)) return null;
  const [beforeHash] = path.split('#');
  const [pathname, query = ''] = beforeHash.split('?');
  if (pathname.split('/').some((segment) => segment === '..' || segment === '.')) return null;
  if (/(^|&)token=/i.test(query)) return null;
  // Whatever it says, it must stay on the origin it is put on.
  try {
    const base = 'http://preview.invalid';
    const url = new URL(path, base);
    if (url.origin !== base) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

/** Pure: the size asked for, phone unless it says desktop. */
function sizeOf(value) {
  return String(value || '').toLowerCase() === 'desktop' ? 'desktop' : 'phone';
}

/** Pure: a selector as the job takes it, or '' for the page's main content. */
function selectorOf(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_SELECTOR_CHARS) : '';
}

/**
 * The draft's preview origin as the capture job reaches it, from the draft's
 * row alone (visuals.js uses the same two for a proposal's "after" side), or
 * null when its preview is not deployed.
 */
async function previewOrigin(config, draft, deps = {}) {
  const sessionId = Number(draft?.session_id);
  if (!draft?.staging_runtime_name || !draft.app_slug || !Number.isSafeInteger(sessionId) || sessionId <= 0) return null;
  const visuals = deps.visuals || require('./visuals');
  if (config?.captureRuntime === 'kubernetes') {
    return visuals.kubernetesCaptureOrigin(config, { slug: draft.app_slug }, sessionId);
  }
  // Docker: the preview's container on the shared network, by the short
  // alias when its name is too long for a DNS label (visuals.js #1381).
  const runtime = deps.applicationRuntime || require('./application-runtime');
  const docker = deps.docker || require('./docker');
  const name = String(draft.staging_runtime_name);
  const alias = runtime.dnsAlias({ environment: 'staging', sessionId });
  const confirmed = alias ? await docker.ensureNetworkAlias(name, alias).catch(() => false) : false;
  return `http://${visuals.dnsHostname(name, alias, { aliasConfirmed: confirmed })}:3000`;
}

/** The capture fixture's token for the draft's app: never the person who asked. */
async function fixtureToken(pool, draft, deps = {}) {
  const visuals = deps.visuals || require('./visuals');
  const mint = deps.mintCaptureToken || visuals.mintCaptureToken;
  const { rows: [user] } = await pool.query(
    'SELECT id, username, usernode_pubkey FROM users WHERE username = $1', [visuals.CAPTURE_USERNAME || 'usernode-capture'],
  );
  if (!user) return '';
  return mint(user, Number(draft.app_id), { previewOnly: false });
}

/** Pure: the frame `name` of a look job's stdout, decoded, or null. */
function frameOf(stdout, name) {
  const text = String(stdout || '');
  const head = new RegExp(`__USERNODE_${name}__ bytes=\\d+\\r?\\n`).exec(text);
  if (!head) return null;
  const from = head.index + head[0].length;
  const end = text.indexOf(`__USERNODE_${name}_END__`, from);
  if (end < 0) return null;
  const encoded = text.slice(from, end).replace(/\s+/g, '');
  if (!encoded) return null;
  try {
    const buf = Buffer.from(encoded, 'base64');
    return buf.length ? buf : null;
  } catch {
    return null;
  }
}

/** Pure: what a look job saw ({ facts, png }), or why it gave up ({ reason }). */
function readLook(stdout) {
  const failed = /__USERNODE_LOOK_FAIL__ reason=([^\s]+)/.exec(String(stdout || ''));
  const json = frameOf(stdout, 'LOOK');
  let facts = null;
  if (json) {
    try { facts = JSON.parse(json.toString('utf8')); } catch { facts = null; }
  }
  if (!facts || typeof facts !== 'object') {
    let reason = 'no_look';
    if (failed) {
      try { reason = decodeURIComponent(failed[1]); } catch { reason = failed[1]; }
    }
    return { reason };
  }
  return { facts, png: frameOf(stdout, 'LOOK_SHOT') };
}

/** Pure: no `token` value in anything a look reports to the model. */
function scrub(value) {
  return String(value ?? '').replace(/([?&]token=)[^&#\s"']+/gi, '$1…');
}

/**
 * Look at one page of `draft`'s running preview. `path` must already be a
 * previewPath; the origin is the draft's own. Resolves
 * { ok: true, facts, png? } or { ok: false, reason }. Never throws.
 */
async function lookAtPreview(config, pool, { draft, path, size = 'phone', selector = '', screenshot = false, deps = {} } = {}) {
  const safe = previewPath(path);
  if (!safe) return { ok: false, reason: 'bad_path' };
  try {
    const origin = await previewOrigin(config, draft, deps);
    if (!origin) return { ok: false, reason: 'not_up' };
    const token = deps.token != null ? deps.token : await fixtureToken(pool, draft, deps);
    const withToken = deps.withToken || require('./visuals').withToken;
    const url = withToken(`${origin}${safe}`, token);
    const spec = {
      url, viewport: VIEWPORTS[sizeOf(size)], selector: selectorOf(selector), screenshot: !!screenshot,
      sessionId: Number(draft.session_id),
    };
    const run = deps.runCaptureJob || require('./design-capture').runCaptureJob;
    const out = await run(config, spec, { deps, kind: 'PREVIEW_LOOK', timeoutMs: LOOK_TIMEOUT_MS });
    const seen = readLook(typeof out === 'string' ? out : out?.stdout);
    if (!seen.facts) return { ok: false, reason: scrub(seen.reason) };
    const facts = seen.facts;
    return {
      ok: true,
      facts: {
        ...facts,
        path: scrub(facts.path || safe),
        consoleErrors: (Array.isArray(facts.consoleErrors) ? facts.consoleErrors : [])
          .map((e) => ({ kind: String(e?.kind || 'console'), message: scrub(e?.message) })),
      },
      ...(screenshot && seen.png ? { png: seen.png } : {}),
    };
  } catch (err) {
    log.warn('preview-look', 'A look at a draft\'s preview did not happen', { draftId: draft?.id, err: scrub(err?.message) });
    return { ok: false, reason: 'look_failed' };
  }
}

module.exports = {
  VIEWPORTS, LOOK_TIMEOUT_MS, MAX_PATH_CHARS,
  previewPath, sizeOf, selectorOf, previewOrigin, readLook, scrub, lookAtPreview,
};
