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
 * Draw the spec's main screen in the build's worker and keep it as the
 * run's first look. Resolves true when it was kept; never throws (a first
 * look that could not be drawn is simply not there).
 */
async function renderFirstLook({ pool, worker, containerName, runId, specHtml, timeoutMs = RENDER_TIMEOUT_MS }) {
  try {
    const screen = mainScreenOf(specHtml);
    if (!screen || !containerName || !worker || typeof worker.runBenchCapture !== 'function') return false;
    const input = { html: firstLookDocument(screen), width: screen.width, height: screen.height };
    const source = `'use strict';\nconst FIRST_LOOK = ${JSON.stringify(input)};\n${script()}`;
    const stdout = await worker.runBenchCapture(containerName, { source, env: {}, timeoutMs, scriptPath: SCRIPT_PATH, maxBuffer: 16 * 1024 * 1024 });
    const png = readRendered(stdout);
    if (!png) {
      log.info('first-version-screens', 'No first look from the spec\'s screen', { runId });
      return false;
    }
    await storeScreens(pool, runId, 'first_look', [png]);
    return true;
  } catch (err) {
    log.warn('first-version-screens', 'Could not draw the first look', { runId, err: err.message });
    return false;
  }
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

// The newest run of the project's first version: the one being built.
const RUN_SQL = `SELECT r.id, r.build_caption
                   FROM homeroom_bot_first_versions f
                   JOIN homeroom_bot_runs r ON r.app_id = f.app_id AND r.issue_number = f.issue_number
                  WHERE f.app_id = $1 AND f.bot_builds = TRUE
                  ORDER BY r.id DESC
                  LIMIT 1`;

/**
 * What a first version's run has to show: its caption and, per kind, how
 * many screens and when they were taken. Null when there is no run.
 */
async function showcaseOf(pool, appId) {
  const { rows: [run] } = await pool.query(RUN_SQL, [Number(appId)]);
  if (!run) return null;
  const { rows } = await pool.query(
    `SELECT kind, COUNT(*)::int AS count, MAX(created_at) AS at
       FROM first_version_screens WHERE bot_run_id = $1 GROUP BY kind`,
    [Number(run.id)],
  );
  const screens = {};
  for (const r of rows) screens[r.kind] = { count: Math.min(Number(r.count) || 0, MAX_SCREENS), at: r.at ? new Date(r.at).toISOString() : null };
  return { runId: Number(run.id), caption: captionOf(`$ usernode-progress ${run.build_caption || ''}`), screens };
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

/** One screen's image for the project's first version: { content_type, data }, or null. */
async function readScreen(pool, appId, kind, position) {
  if (!KINDS.includes(kind) || !Number.isInteger(position) || position < 0 || position >= MAX_SCREENS) return null;
  const { rows: [run] } = await pool.query(RUN_SQL, [Number(appId)]);
  if (!run) return null;
  const { rows: [row] } = await pool.query(
    `SELECT content_type, data FROM first_version_screens
      WHERE bot_run_id = $1 AND kind = $2 AND position = $3`,
    [Number(run.id), kind, position],
  );
  return row || null;
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
  renderFirstLook,
  realShotsOf,
  keepRealScreens,
  storeScreens,
  showcaseOf,
  firstVersionShowcase,
  readScreen,
};
