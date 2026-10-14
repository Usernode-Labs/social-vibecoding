'use strict';

// #4387: what a first version's App tab shows while it is built, so the
// 10 to 25 minutes are something to watch. Three things, each optional; a
// missing one leaves the screen as it was (the project's thumbnail):
//
//   FIRST LOOK    from "Building it". The build's spec turn draws up to two
//                 finished screens as HTML mocks (prompts.js
//                 FIRST_VERSION_SCREENS_BRIEF). The main one is rendered to
//                 a phone-sized PNG in the build's own worker
//                 (worker/usernode-first-look.js: scripts off, no network)
//                 and stored for the run. Nobody is ever sent the HTML.
//                 Until then (newcomer run six, 14 Oct 2026), the EARLY
//                 first look drawn the same way from the plan at Make it
//                 (first-version-early-look.js) stands in for it.
//   CAPTION       while it builds. The build agent runs
//                 `usernode-progress "Adding the tier rows"` as it starts
//                 each point of the plan (homeroom-bot-live.js
//                 FIRST_VERSION_PROGRESS_LINES); the phrase is read off the
//                 command in the turn's own stream (captionOf), cleaned, and
//                 kept on the run (homeroom_bot_runs.build_caption). The
//                 build line shows it as its note.
//   REAL SCREENS  from "Testing it". The review's last capture of the build
//                 (bot-review.js, in the same worker) keeps up to three
//                 phone screens; they are copied for the run. A first
//                 version built without a review has none, and keeps its
//                 first look.
//
// What the App tab is told (routes/apps.js GET /api/apps/:slug
// `first_version.caption` and `.screens`) and the images themselves (GET
// /api/apps/:slug/first-version/screens/:kind/:n) are for the project's
// MEMBERS only: the screens and the phrases come from the plan, which is a
// read for members (routes/apps.js hubFirstVersion).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const log = require('./logger');

const KINDS = Object.freeze(['first_look', 'real']);
const MAX_SCREENS = 3;
const CAPTION_MAX = 40;
const SCRIPT_FILE = path.join(__dirname, '..', '..', 'worker', 'usernode-first-look.js');
const SCRIPT_PATH = '/tmp/usernode-first-look.js';
const MARKER = '__USERNODE_FIRST_LOOK__';
const RENDER_TIMEOUT_MS = 90 * 1000;
const PHONE = Object.freeze({ width: 390, height: 844 });
const MAX_PNG_BYTES = 4 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const KIT_CSS_FILE = path.join(__dirname, '..', '..', 'public', 'usernode-native', 'v1', 'native.css');
// The real screens kept, in this order: the app with its data, the same
// screen after its main action, and its empty state.
const REAL_SHOTS = Object.freeze(['phone-light-populated', 'phone-light-result', 'phone-light-empty']);

// ── The caption ──────────────────────────────────────────────────────────

// `usernode-progress` and what follows it on the command line, in either
// harness's line ("$ usernode-progress \"Adding …\"", or Codex's
// `$ /bin/bash -lc 'usernode-progress "Adding …"'`).
const COMMAND_RE = /(?:^|[\s;&|('"])usernode-progress\s+(.+)$/;

/**
 * The phrase a progress line shows the build agent noting, cleaned for the
 * App tab, or null: plain text, one line, starting with "Adding", at most
 * CAPTION_MAX characters. It comes from a model, so anything else is no
 * phrase at all. Pure.
 */
function captionOf(line) {
  const text = String(line || '');
  if (!text.startsWith('$ ')) return null;
  const m = COMMAND_RE.exec(text.slice(2));
  if (!m) return null;
  // The phrase's own words: what its quotes hold, else up to the next shell
  // separator; then only letters, digits, spaces and light punctuation.
  const rest = m[1].replace(/\\(.)/g, '$1').trim();
  const q = rest[0];
  let phrase = q === '"' || q === '\''
    ? rest.slice(1, rest.indexOf(q, 1) > 0 ? rest.indexOf(q, 1) : undefined)
    : rest.split(/\s*(?:&&|\|\||[;|>]|\$\()/)[0];
  phrase = phrase.replace(/["`]/g, ' ').normalize('NFKC').replace(/[^\p{L}\p{N} ,.'’&+\-/()]/gu, ' ').replace(/\s+/g, ' ').trim();
  phrase = phrase.replace(/[\s,.(/&+-]+$/u, '');
  if (!/^Adding\s+\S/.test(phrase)) return null;
  if (phrase.length > CAPTION_MAX) {
    const cut = phrase.slice(0, CAPTION_MAX);
    const space = cut.lastIndexOf(' ');
    phrase = (space > 'Adding'.length ? cut.slice(0, space) : cut).replace(/[\s,.(/&+-]+$/u, '');
  }
  return phrase;
}

/**
 * A turn's progress watcher that keeps the newest phrase on the run, once
 * per change. A write that fails is logged; it never stops the turn.
 */
function captionWatcher(pool, runId) {
  let last = null;
  let chain = Promise.resolve();
  return (line) => {
    const phrase = captionOf(line);
    if (!phrase || phrase === last) return;
    last = phrase;
    chain = chain.then(() => pool.query(
      'UPDATE homeroom_bot_runs SET build_caption = $2, build_caption_at = NOW() WHERE id = $1',
      [Number(runId), phrase],
    )).catch((err) => log.warn('first-version-screens', 'Could not keep the build\'s caption', { runId, err: err.message }));
  };
}

// ── The first look ───────────────────────────────────────────────────────

/**
 * The main screen a spec drew, from its HTML: its first phone screen
 * (FIRST_VERSION_SCREENS_BRIEF draws the main one first), else its first
 * screen. `{ markup, width, height }`, or null for a spec with none. Pure.
 */
function mainScreenOf(specHtml) {
  const specHtmlLib = require('./spec-html');
  const html = typeof specHtml === 'string' ? specHtmlLib.extractHtmlSpec(specHtml) : null;
  if (!html) return null;
  const screens = specHtmlLib.tokenize(html)
    .filter((tok) => tok.type === 'raw' && tok.name === 'template' && 'data-screen' in tok.attrs)
    .map((tok) => ({ markup: String(tok.raw || ''), g: specHtmlLib.screenGeometry(tok.attrs) }))
    .filter((s) => s.markup.trim());
  const main = screens.find((s) => s.g.kind === 'phone') || screens[0];
  return main ? { markup: main.markup, width: PHONE.width, height: PHONE.height } : null;
}

let kitCss = null;
function readKitCss() {
  if (kitCss == null) {
    try { kitCss = fs.readFileSync(KIT_CSS_FILE, 'utf8'); } catch { kitCss = ''; }
  }
  return kitCss;
}

/**
 * The document the worker draws: the screen's markup with the native kit's
 * stylesheet inline, its after side (a first version's screens mark
 * everything "after"), the light look, and a CSP that lets nothing load
 * but inline styles and data. No `</style>` from the kit can close early:
 * it is the platform's own file. Pure but for the kit's read.
 */
function firstLookDocument(screen, css = readKitCss()) {
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";
  return '<!doctype html><html data-side="after"><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${csp}">`
    + `<meta name="viewport" content="width=${screen.width}">`
    + `<style>${String(css).replace(/<\/style/gi, '<\\/style')}</style>`
    + '<style>html,body{margin:0}[data-side="before"]{display:none!important}</style>'
    + `</head><body>${screen.markup}</body></html>`;
}

let scriptSource = null;
function script() {
  if (scriptSource == null) scriptSource = fs.readFileSync(SCRIPT_FILE, 'utf8');
  return scriptSource;
}

function pngSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** The PNG on the script's marker line, checked, or null. Pure. */
function readRendered(stdout) {
  const lines = String(stdout || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith(`${MARKER} `)) continue;
    let out;
    try { out = JSON.parse(lines[i].slice(MARKER.length + 1)); } catch { return null; }
    if (!out || out.ok !== true || typeof out.png !== 'string') return null;
    const data = Buffer.from(out.png, 'base64');
    const size = pngSize(data);
    if (!size || data.length > MAX_PNG_BYTES || size.width > 2000 || size.height > 4000) return null;
    return { data, ...size };
  }
  return null;
}

/**
 * The main screen of a spec (or of a saved screen as one, screenDocument)
 * drawn to a phone-sized PNG in a worker: { data, width, height }, or null
 * when there is no screen, no worker or no picture. Stores nothing. The one
 * way a first look is drawn: the spec's (renderFirstLook) and the early one
 * from the plan at Make it (first-version-early-look.js). Throws only what
 * the worker throws.
 */
async function drawScreenPng({ worker, containerName, specHtml, timeoutMs = RENDER_TIMEOUT_MS }) {
  const screen = mainScreenOf(specHtml);
  if (!screen || !containerName || !worker || typeof worker.runBenchCapture !== 'function') return null;
  const input = { html: firstLookDocument(screen), width: screen.width, height: screen.height };
  const source = `'use strict';\nconst FIRST_LOOK = ${JSON.stringify(input)};\n${script()}`;
  const stdout = await worker.runBenchCapture(containerName, { source, env: {}, timeoutMs, scriptPath: SCRIPT_PATH, maxBuffer: 16 * 1024 * 1024 });
  return readRendered(stdout);
}

/**
 * Draw the spec's main screen in the build's worker and keep it as the
 * run's first look. Resolves true when it was kept; never throws (a first
 * look that could not be drawn is simply not there).
 */
async function renderFirstLook({ pool, worker, containerName, runId, specHtml, timeoutMs = RENDER_TIMEOUT_MS }) {
  try {
    if (!mainScreenOf(specHtml) || !containerName || !worker || typeof worker.runBenchCapture !== 'function') return false;
    const png = await drawScreenPng({ worker, containerName, specHtml, timeoutMs });
    if (!png) {
      // Warned (newcomer run five): a first look that quietly is not there
      // was hard to tell from one that was never asked for.
      log.warn('first-version-screens', 'No first look from the spec\'s screen', { runId });
      return false;
    }
    await storeScreens(pool, runId, 'first_look', [png]);
    return true;
  } catch (err) {
    log.warn('first-version-screens', 'Could not draw the first look', { runId, err: err.message });
    return false;
  }
}

// ── The first look, drawn first (newcomer run four, 13 Oct 2026) ─────────
//
// The spec turn used to draw its two screens inside a spec of 40,000
// characters, five and a half minutes long, and the first look was drawn
// only once the whole spec was in. Now the spec draws its main screen
// FIRST (homeroom-bot-live.js FIRST_VERSION_SCREENS_FIRST) and saves it
// with `usernode-screen 1` (worker/usernode-screen: the screen on stdin,
// written whole to SAVED_DIR, nothing else), then writes the rest. The
// platform sees the command in the turn's own stream (savedScreenOf, as
// the build's "Adding" phrases are seen), reads the saved screen off the
// worker (readSavedScreen) and draws the first look from it at once, while
// the spec goes on: about a minute into the spec rather than at its end.
//
// The screens are written once. In the spec's screens figure a saved
// screen is an empty placeholder, <template data-screen data-from="1">
// </template>, and the platform puts the saved screen in its place once
// the spec is in (spliceSavedScreens), so the spec, its markdown copy and
// the build read it whole, as before. A screen that was not saved (an older
// worker without the command, or a spec that did not use it) is drawn in
// the figure in full, as before, and its first look is drawn from the spec
// when it is in.

const SAVED_DIR = '/tmp/usernode-screens';
const SAVED_MAX_CHARS = 200 * 1000;
// The command as the stream labels it ("$ usernode-screen 1 <<'SCREEN'"),
// in either harness's line, and the command's own answer under it.
const SAVE_COMMAND_RE = /(?:^|[\s;&|('"])usernode-screen\s+([12])(?![\w.-])/;
const SAVED_RE = /\bSaved screen ([12])\b/;
// A placeholder for a saved screen in the spec's figure.
const PLACEHOLDER_RE = /<template\b[^>]*?\bdata-from\s*=\s*["']?([12])["']?[^>]*>\s*<\/template\s*>/gi;

/**
 * Which screen a progress line shows the spec saving, 1 or 2, or null: the
 * command itself ("$ usernode-screen 1 …") or its answer ("⎿ Bash: Saved
 * screen 1 …"). Pure.
 */
function savedScreenOf(line) {
  const text = String(line || '');
  if (text.startsWith('$ ')) {
    const m = SAVE_COMMAND_RE.exec(text.slice(2));
    return m ? Number(m[1]) : null;
  }
  if (/^\s*⎿/.test(text)) {
    const m = SAVED_RE.exec(text);
    return m ? Number(m[1]) : null;
  }
  return null;
}

/**
 * The first <template data-screen> element in `text`, whole (its tags
 * included), or null when it holds none. What a saved file must be. Pure.
 */
function savedTemplateOf(text) {
  const src = String(text || '').slice(0, SAVED_MAX_CHARS);
  const re = /<template\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(src))) {
    if (!/\bdata-screen\b/i.test(m[1]) || /\bdata-from\b/i.test(m[1])) continue;
    const end = src.toLowerCase().indexOf('</template', m.index + m[0].length);
    if (end === -1) return null;
    const close = src.indexOf('>', end);
    if (close === -1) return null;
    const whole = src.slice(m.index, close + 1);
    return whole.slice(m[0].length, end - m.index).trim() ? whole : null;
  }
  return null;
}

/**
 * One saved screen, read off the spec's worker: its <template> element, or
 * null when it is not there (or not one). Never throws.
 */
async function readSavedScreen(worker, containerName, n) {
  try {
    if (!worker || typeof worker.runLiveScript !== 'function' || !containerName || ![1, 2].includes(Number(n))) return null;
    const out = await worker.runLiveScript(containerName, 'cat "$1" 2>/dev/null || true', {
      args: [`${SAVED_DIR}/${Number(n)}.html`], timeoutMs: 15000, maxBuffer: 2 * SAVED_MAX_CHARS,
    });
    return savedTemplateOf(out);
  } catch (err) {
    log.warn('first-version-screens', 'Could not read a saved screen', { n, err: err.message });
    return null;
  }
}

/**
 * The spec with each placeholder for a saved screen replaced by that
 * screen, whole. A placeholder whose screen is not in `saved` is left. Pure.
 */
function spliceSavedScreens(text, saved) {
  if (typeof text !== 'string' || !saved || !saved.size) return text;
  return text.replace(PLACEHOLDER_RE, (whole, n) => saved.get(Number(n)) || whole);
}

/**
 * Watches a spec turn's progress for the screens it saves: each one is read
 * off the worker (`read(n)`, tried again a few times a moment apart, since
 * the command may still be running when its line is seen) and handed to
 * `onScreen({ n, markup })`, once per change. `idle()` resolves once no
 * read is in flight; `firstSavedAt()` is when the first screen was read
 * (`now()`), or null. A watcher never stops a turn.
 */
function screenWatcher({ read, onScreen = null, delayMs = 1500, tries = 4, now = Date.now } = {}) {
  const last = new Map();
  let firstAt = null;
  const reading = new Set();
  const inFlight = new Set();
  const look = (n, attempt = 0) => {
    const job = new Promise((resolve) => setTimeout(resolve, delayMs))
      .then(() => read(n))
      .then((markup) => {
        if (!markup) {
          if (attempt + 1 < tries) look(n, attempt + 1);
          return;
        }
        if (last.get(n) === markup) return;
        last.set(n, markup);
        if (firstAt == null) firstAt = now();
        if (onScreen) {
          try { onScreen({ n, markup }); } catch { /* a watcher never stops a turn */ }
        }
      })
      .catch(() => {})
      .finally(() => { inFlight.delete(job); reading.delete(n); });
    reading.add(n);
    inFlight.add(job);
  };
  const watch = (line) => {
    const n = savedScreenOf(line);
    if (n && !reading.has(n)) look(n);
  };
  watch.idle = async () => {
    while (inFlight.size) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.all([...inFlight]);
    }
  };
  watch.saved = () => new Map(last);
  watch.firstSavedAt = () => firstAt;
  return watch;
}

/** A saved screen as a spec document (one figure), for mainScreenOf. Pure. */
function screenDocument(markup) {
  return `<article data-spec><h1>First look</h1><figure data-screens>${String(markup || '')}</figure></article>`;
}

/**
 * Draw a saved main screen as the run's first look, in the spec's own
 * worker, while the spec goes on (renderFirstLook). Never throws.
 */
async function renderSavedFirstLook({ pool, worker, containerName, runId, markup, timeoutMs = RENDER_TIMEOUT_MS }) {
  if (!savedTemplateOf(markup)) return false;
  return renderFirstLook({ pool, worker, containerName, runId, specHtml: screenDocument(markup), timeoutMs });
}

// ── The real screens ─────────────────────────────────────────────────────

/** The stored artifact ids of the real screens worth keeping from a capture, at most three, none twice. Pure. */
function realShotsOf(capture) {
  if (!capture || capture.booted !== true) return [];
  const shots = new Map((Array.isArray(capture.shots) ? capture.shots : []).filter((s) => s && s.artifactId).map((s) => [s.id, s]));
  const seen = new Set();
  const out = [];
  for (const id of REAL_SHOTS) {
    const s = shots.get(id);
    if (!s || (s.sha256 && seen.has(s.sha256))) continue;
    if (s.sha256) seen.add(s.sha256);
    out.push(s.artifactId);
    if (out.length >= MAX_SCREENS) break;
  }
  return out;
}

/**
 * Keep a run's real screens from its review's final capture (the run's
 * bot_capture_artifacts). Resolves how many were kept; never throws.
 */
async function keepRealScreens(pool, runId, capture) {
  const ids = realShotsOf(capture);
  if (!ids.length) return 0;
  try {
    const { rows } = await pool.query(
      `SELECT id, data, width, height FROM bot_capture_artifacts
        WHERE bot_run_id = $1 AND id = ANY($2::text[]) AND content_type = 'image/png'`,
      [Number(runId), ids],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const images = ids.map((id) => byId.get(id)).filter(Boolean)
      .map((r) => ({ data: r.data, width: r.width, height: r.height }));
    if (!images.length) return 0;
    await storeScreens(pool, runId, 'real', images);
    return images.length;
  } catch (err) {
    log.warn('first-version-screens', 'Could not keep the real screens', { runId, err: err.message });
    return 0;
  }
}

/** Replace a run's screens of one kind with `images` ({ data, width, height }), at most three. */
async function storeScreens(pool, runId, kind, images) {
  if (!KINDS.includes(kind)) throw new Error(`storeScreens: unknown kind ${kind}`);
  await pool.query('DELETE FROM first_version_screens WHERE bot_run_id = $1 AND kind = $2', [Number(runId), kind]);
  const kept = (images || []).slice(0, MAX_SCREENS);
  for (let i = 0; i < kept.length; i += 1) {
    const img = kept[i];
    const data = Buffer.isBuffer(img.data) ? img.data : Buffer.from(img.data || '');
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      `INSERT INTO first_version_screens (id, bot_run_id, kind, position, content_type, data, width, height, bytes)
       VALUES ($1, $2, $3, $4, 'image/png', $5, $6, $7, $8)`,
      [crypto.randomBytes(16).toString('hex'), Number(runId), kind, i, data,
        Number(img.width) || null, Number(img.height) || null, data.length],
    );
  }
  return kept.length;
}

// ── What the App tab reads ───────────────────────────────────────────────

// The newest build of the project's first version: its newest live run
// that went ahead to be built, the one being built. N7: never a follow-up
// on its proposal (a fix of its failing checks is a run of its own,
// verdict 'revise', with no screens), so the card keeps the build's screens
// through it.
const RUN_SQL = `SELECT r.id, r.build_caption, r.build_note
                   FROM homeroom_bot_first_versions f
                   JOIN homeroom_bot_runs r ON r.app_id = f.app_id AND r.issue_number = f.issue_number
                  WHERE f.app_id = $1 AND f.bot_builds = TRUE
                    AND r.mode = 'live' AND r.verdict = 'ready'
                  ORDER BY r.id DESC
                  LIMIT 1`;

function earlyLooks() {
  return require('./first-version-early-look');
}

/**
 * What a first version's run has to show: its caption and, per kind, how
 * many screens and when they were taken. Newcomer run six (14 Oct 2026):
 * until its run has a first look of its own, the EARLY one drawn from its
 * plan at Make it (first-version-early-look.js), before there is a run at
 * all, or while its run is the one built from that plan; the spec's own
 * replaces it the moment it is saved. Null when there is neither a run nor
 * an early look.
 */
async function showcaseOf(pool, appId) {
  const { rows: [run] } = await pool.query(RUN_SQL, [Number(appId)]);
  const screens = {};
  if (run) {
    const { rows } = await pool.query(
      `SELECT kind, COUNT(*)::int AS count, MAX(created_at) AS at
         FROM first_version_screens WHERE bot_run_id = $1 GROUP BY kind`,
      [Number(run.id)],
    );
    for (const r of rows) screens[r.kind] = { count: Math.min(Number(r.count) || 0, MAX_SCREENS), at: r.at ? new Date(r.at).toISOString() : null };
  }
  if (!screens.first_look?.count) {
    const early = await earlyLooks().shownFor(pool, appId, run || null).catch(() => null);
    if (early) screens.first_look = { count: 1, at: early.at ? new Date(early.at).toISOString() : null };
  }
  if (!run && !screens.first_look) return null;
  return {
    runId: run ? Number(run.id) : null,
    caption: run ? captionOf(`$ usernode-progress ${run.build_caption || ''}`) : null,
    screens,
  };
}

/**
 * What the App tab is told, for a member, at its build line (`line`):
 * the caption while it is built, and which screens to draw. The real
 * screens from "Testing it" on, the first look while it is built and tested
 * without them. Pure.
 */
function firstVersionShowcase(showcase, line) {
  if (!showcase) return {};
  const out = {};
  if (line === 'building' && showcase.caption) out.caption = showcase.caption;
  const real = showcase.screens?.real;
  const look = showcase.screens?.first_look;
  const pick = real?.count && (line === 'testing' || line === 'ready') ? ['real', real]
    : look?.count && (line === 'building' || line === 'testing') ? ['first_look', look]
      : null;
  if (pick) {
    const at = pick[1].at || null;
    out.screens = { kind: pick[0], count: pick[1].count, at, v: at ? String(new Date(at).getTime()) : '0' };
  }
  return out;
}

/**
 * One screen's image for the project's first version: { content_type, data },
 * or null. The first look is the run's own, else the early one showcaseOf
 * offers in its place.
 */
async function readScreen(pool, appId, kind, position) {
  if (!KINDS.includes(kind) || !Number.isInteger(position) || position < 0 || position >= MAX_SCREENS) return null;
  const { rows: [run] } = await pool.query(RUN_SQL, [Number(appId)]);
  if (run) {
    const { rows: [row] } = await pool.query(
      `SELECT content_type, data FROM first_version_screens
        WHERE bot_run_id = $1 AND kind = $2 AND position = $3`,
      [Number(run.id), kind, position],
    );
    if (row) return row;
  }
  if (kind !== 'first_look' || position !== 0) return null;
  return earlyLooks().pictureFor(pool, appId, run || null).catch(() => null);
}

module.exports = {
  KINDS,
  MAX_SCREENS,
  CAPTION_MAX,
  SCRIPT_FILE,
  SCRIPT_PATH,
  MARKER,
  REAL_SHOTS,
  captionOf,
  captionWatcher,
  mainScreenOf,
  firstLookDocument,
  readRendered,
  drawScreenPng,
  renderFirstLook,
  // 13 Oct 2026: the first look, drawn first.
  SAVED_DIR,
  savedScreenOf,
  savedTemplateOf,
  readSavedScreen,
  spliceSavedScreens,
  screenWatcher,
  screenDocument,
  renderSavedFirstLook,
  realShotsOf,
  keepRealScreens,
  storeScreens,
  showcaseOf,
  firstVersionShowcase,
  readScreen,
};
