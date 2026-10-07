'use strict';

// #3737: the benchmark's SCREENSHOT STEP, the platform's half. Shared by the
// two taste task kinds (services/bench/taste.js): a `first_version` trial
// reaches it after its build, a `capture` trial instead of one.
//
// The step itself runs in the trial's sealed worker (worker/
// usernode-bench-capture.js has what it does and how): the app booted as a
// build turn's in-loop browser boots it, sixteen screenshots (two viewports,
// two looks, four states) and up to three of the populated screen after its
// primary action was tapped once (the `result` state), the automatic checks
// as numbers and the tells lint. This module sends that script, reads its
// one line of output back, keeps only well-formed PNGs of the planned
// screenshots, and stores them the way the before and after shots are
// stored: rows of their own (bench_trial_artifacts), never bytes in the
// trial's row. What the trial keeps (bench_trials.capture) is everything
// else: whether the app booted and why not, each screenshot's place in the
// plan, which control the result state tapped and why or why it tapped none
// (`primaryAction`), the checks and the tells.
//
// An app that would not install, build or boot is a RESULT, recorded as
// `booted: false` with its reason. Only the platform failing to run the
// step at all (no worker, an exec that died) is a fault, which the stage
// records as infra_fail.
//
// Grading reads the screenshots back through pickShots: the most telling
// eight, each with a caption that names its viewport, look and state and
// nothing about the trial, and a screenshot identical to one already
// chosen is skipped and said so (a state that looks exactly like the
// populated screen is itself worth knowing).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const log = require('../logger');
const { INLOOP_DATABASE_URL } = require('../in-loop-browser');

const SCRIPT_FILE = path.join(__dirname, '..', '..', '..', 'worker', 'usernode-bench-capture.js');
const MARKER = '__USERNODE_BENCH_CAPTURE__';
// Install, build, boot, up to nineteen screenshots (the result state's
// three bounded to 30 s in all) and two overflow passes. A slow npm install
// is most of it.
const CAPTURE_TIMEOUT_MS = 12 * 60 * 1000;
// What a model provider accepts as one image (services/mcp-tools.js keeps
// request screenshots under the same two limits).
const MAX_SHOT_BYTES = 4 * 1024 * 1024;
const MAX_SHOT_EDGE_PX = 8000;
const MAX_GRADING_SHOTS = 8;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const VIEWPORTS = Object.freeze({ phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } });
const LOOKS = Object.freeze(['light', 'dark']);
const STATES = Object.freeze(['populated', 'error', 'loading', 'result', 'empty']);
// The screens the result state is taken on (the step's RESULT_SCREENS).
const RESULT_SCREENS = Object.freeze(['phone-light', 'phone-dark', 'desktop-light']);
// How the step chose the control it tapped (the step's chooseAction).
const ACTION_RULES = Object.freeze(['marked', 'kit-primary', 'form-submit', 'accent']);
// The port the step launches the app on: not the build turn's in-loop port
// (services/in-loop-browser.js INLOOP_PORT), which a launch the build's
// agent left running may still hold. The database is the in-loop one, made
// fresh by the step.
const CAPTURE_PORT = 3190;

// The order grading shows them in, and so which eight it shows (pickShots
// skips a screenshot identical to one already chosen, then stops at
// eight). With every screen different, the eight are:
//   1-2  the populated screen on a phone, in both looks: what the app is;
//   3    the phone's result, the populated screen after its primary action
//        was tapped: for an app whose main content appears only after the
//        person acts (a calculator's answer) it is the screen that matters,
//        so it comes before every other size, look and state;
//   4    the populated screen on a desktop, light: whether it holds wide;
//   5-8  the empty state in both looks, then error and loading, on a phone:
//        the rubric's states criterion needs each of them seen.
// Then the dark look of the desktop's populated screen, which a result
// pushes out of the eight because it is the same screen in a look already
// seen on the phone, then the result's other look and size, then the rest.
// A capture with no result screen (one taken before the state existed, or
// an app with no primary action) shows the same eight as it always did:
// only the desktop's dark look moves, to the end of them. A result
// identical to its populated screen, a tap that changed nothing visible,
// is skipped as identical like any other.
const SHOT_PRIORITY = Object.freeze([
  'phone-light-populated', 'phone-dark-populated', 'phone-light-result', 'desktop-light-populated',
  'phone-light-empty', 'phone-dark-empty', 'phone-light-error', 'phone-light-loading',
  'desktop-dark-populated', 'phone-dark-result', 'desktop-light-result',
  'phone-dark-error', 'phone-dark-loading', 'desktop-light-empty', 'desktop-dark-empty',
  'desktop-light-error', 'desktop-dark-error', 'desktop-light-loading', 'desktop-dark-loading',
]);

const STATE_WORDS = Object.freeze({
  populated: 'populated (the app\'s own staging data)',
  empty: 'empty (no data yet)',
  error: 'error (the app\'s API answering 500)',
  loading: 'loading (the app\'s API held, taken at about 300 ms)',
});

/** Every screenshot the step plans, by id. Pure. */
function plannedShots() {
  const out = [];
  for (const state of STATES) {
    for (const [viewport, size] of Object.entries(VIEWPORTS)) {
      for (const look of LOOKS) {
        if (state === 'result' && !RESULT_SCREENS.includes(`${viewport}-${look}`)) continue;
        out.push({ id: `${viewport}-${look}-${state}`, viewport, look, state, ...size });
      }
    }
  }
  return out;
}

/** A tapped control's label as a caption quotes it: one line, no double quotes, at most 40 characters. Pure. */
function actionLabel(text) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').replace(/"/g, '\'').trim();
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
}

/**
 * "Phone 390×844, dark look, empty (no data yet)", or for the result state
 * "Phone 390×844, light look, after tapping "Calculate" (the screen's
 * primary action)". Pure.
 */
function caption(shot) {
  if (shot.state === 'result') {
    const verb = shot.viewport === 'phone' ? 'tapping' : 'clicking';
    const label = actionLabel(shot.action && shot.action.label);
    return `${screenWords(shot)}, after ${verb} ${label ? `"${label}" (the screen's primary action)` : 'the screen\'s primary action'}`;
  }
  return `${screenWords(shot)}, ${STATE_WORDS[shot.state] || shot.state}`;
}

/** "Phone 390×844, dark look". Pure. */
function screenWords(shot) {
  const size = VIEWPORTS[shot.viewport];
  const where = `${shot.viewport === 'phone' ? 'Phone' : 'Desktop'} ${size ? `${size.width}×${size.height}` : ''}`.trim();
  return `${where}, ${shot.look} look`;
}

/** The step's JSON from the script's stdout, or null when it wrote none. Pure. */
function parseOutput(stdout) {
  const lines = String(stdout || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith(`${MARKER} `)) continue;
    try { return JSON.parse(lines[i].slice(MARKER.length + 1)); } catch { return null; }
  }
  return null;
}

function pngSize(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * The screenshots worth keeping from the step's output: a planned id, a
 * real PNG, within the size limits. Each kept one carries its bytes and
 * hash (a result screen, the control it tapped too); a dropped one, why. A
 * result screen the step chose not to take (no clear primary action) is
 * neither: the capture's primaryAction says why. Pure.
 */
function acceptShots(shots) {
  const plan = new Map(plannedShots().map((s) => [s.id, s]));
  const kept = [];
  const dropped = [];
  const seen = new Set();
  for (const s of Array.isArray(shots) ? shots : []) {
    const planned = plan.get(String(s?.id || ''));
    if (!planned || seen.has(planned.id)) continue;
    seen.add(planned.id);
    if (!s.png && planned.state === 'result' && s.skipped && !s.failed) continue;
    if (!s.png) { dropped.push({ id: planned.id, reason: s.failed ? String(s.failed).slice(0, 200) : 'no image' }); continue; }
    const data = Buffer.from(String(s.png), 'base64');
    const size = pngSize(data);
    if (!size) { dropped.push({ id: planned.id, reason: 'not a PNG' }); continue; }
    if (data.length > MAX_SHOT_BYTES || Math.max(size.width, size.height) > MAX_SHOT_EDGE_PX) {
      dropped.push({ id: planned.id, reason: 'too large' });
      continue;
    }
    kept.push({
      ...planned, data, bytes: data.length, width: size.width, height: size.height,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
      status: Number.isInteger(s.status) ? s.status : null,
      consoleErrors: Number(s.consoleErrors) || 0,
      ...(planned.state === 'populated' || planned.state === 'empty' ? {
        overflowPx: numOrNull(s.overflowPx), smallTapTargets: numOrNull(s.smallTapTargets),
        lowContrast: numOrNull(s.lowContrast), nestedCards: numOrNull(s.nestedCards),
      } : {}),
      ...(planned.state === 'result' ? { action: tappedControl(s.action && s.action.used) } : {}),
    });
  }
  return { kept, dropped };
}

function numOrNull(v) {
  return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
}

function text(v, max) {
  return v == null || v === '' ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The control a result screen tapped, as its caption names it: { label, rule }, or null. Pure. */
function tappedControl(used) {
  if (!used || typeof used !== 'object') return null;
  return { label: actionLabel(used.label), rule: ACTION_RULES.includes(used.rule) ? used.rule : null };
}

/**
 * The step's account of the result state, kept in the capture beside the
 * checks: one entry per planned result screen, with the control it tapped
 * and why (`used`), or why it tapped none (`skipped`: no clear primary
 * action, `sameAs` when the same page in the other look already said so)
 * or what went wrong (`failed`), and what the tap set off. Null for a
 * capture from before the state existed. Pure.
 */
function cleanPrimaryAction(list) {
  if (!Array.isArray(list)) return null;
  const planned = new Set(plannedShots().filter((s) => s.state === 'result').map((s) => s.id));
  const out = [];
  for (const a of list) {
    const id = String(a?.id || '');
    if (!planned.has(id) || out.some((o) => o.id === id)) continue;
    const used = a.used && typeof a.used === 'object' ? { ...tappedControl(a.used), why: text(a.used.why, 200) } : null;
    out.push({
      id,
      ...(used ? {
        used, settled: text(a.settled, 60), changes: numOrNull(a.changes), revealed: !!a.revealed,
        dialogs: numOrNull(a.dialogs) || 0, blocked: numOrNull(a.blocked) || 0,
      } : {}),
      ...(a.skipped && !used ? { skipped: text(a.skipped, 300) } : {}),
      ...(a.failed ? { failed: text(a.failed, 300) } : {}),
      ...(planned.has(String(a.sameAs || '')) ? { sameAs: String(a.sameAs) } : {}),
      ms: numOrNull(a.ms),
    });
  }
  return out;
}

/**
 * The result state in words, one line per planned screen: what was tapped
 * and why, or why nothing was. For the grade item's signals and the
 * studio's trial view. Empty for a capture from before the state existed.
 * Pure.
 */
function describeActions(capture) {
  const list = Array.isArray(capture?.primaryAction) ? capture.primaryAction : [];
  const byId = new Map(plannedShots().map((s) => [s.id, s]));
  return list.filter((a) => byId.has(a.id)).map((a) => {
    const screen = screenWords(byId.get(a.id));
    if (a.used) {
      const label = a.used.label ? `"${a.used.label}"` : 'an unlabelled control';
      return `${screen}: tapped ${label}, ${a.used.why || 'the screen\'s primary action'}${a.failed ? `; the screenshot after it failed: ${a.failed}` : ''}`;
    }
    if (a.failed) return `${screen}: not shown, the tap failed: ${a.failed}`;
    return `${screen}: nothing tapped, ${a.skipped || 'no clear primary action'}`;
  });
}

/**
 * What the trial keeps of a capture (bench_trials.capture): no images, no
 * app log beyond a short tail, the checks and the tells as the step
 * measured them. `artifacts` maps a shot id to its stored artifact id. Pure.
 */
function summarize(output, kept = [], dropped = [], artifacts = {}) {
  const o = output || {};
  return {
    booted: o.booted === true,
    error: o.error ? String(o.error).slice(0, 600) : null,
    steps: o.steps && typeof o.steps === 'object' ? {
      install: o.steps.install ? {
        ran: !!o.steps.install.ran, ok: !!o.steps.install.ok, ms: numOrNull(o.steps.install.ms),
        ...(o.steps.install.error ? { error: String(o.steps.install.error).slice(0, 600) } : {}),
      } : null,
      boot: o.steps.boot ? {
        command: String(o.steps.boot.command || '').slice(0, 120),
        ...(o.steps.boot.log ? { log: String(o.steps.boot.log).slice(-1500) } : {}),
      } : null,
      emptied: o.steps.emptied ? { ok: !!o.steps.emptied.ok } : null,
    } : {},
    shots: kept.map((s) => ({
      id: s.id, viewport: s.viewport, look: s.look, state: s.state, width: s.width, height: s.height,
      bytes: s.bytes, sha256: s.sha256, status: s.status, consoleErrors: s.consoleErrors,
      ...(s.overflowPx !== undefined ? {
        overflowPx: s.overflowPx, smallTapTargets: s.smallTapTargets, lowContrast: s.lowContrast, nestedCards: s.nestedCards,
      } : {}),
      ...(s.state === 'result' ? { action: tappedControl(s.action) } : {}),
      artifactId: artifacts[s.id] || null,
    })),
    dropped,
    primaryAction: cleanPrimaryAction(o.primaryAction),
    checks: o.checks && typeof o.checks === 'object' ? o.checks : null,
    tells: o.tells && typeof o.tells === 'object' ? o.tells : null,
    ms: numOrNull(o.ms),
  };
}

/** The script the worker runs, read once. */
let scriptSource = null;
function script() {
  if (scriptSource == null) scriptSource = fs.readFileSync(SCRIPT_FILE, 'utf8');
  return scriptSource;
}

/** Store a trial's screenshots, replacing any it had. Resolves { shotId: artifactId }. */
async function storeShots(pool, trialId, kept) {
  const ids = {};
  await pool.query('DELETE FROM bench_trial_artifacts WHERE trial_id = $1', [Number(trialId)]);
  for (const s of kept) {
    const id = crypto.randomBytes(16).toString('hex');
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      `INSERT INTO bench_trial_artifacts
         (id, trial_id, shot_id, viewport, look, state, content_type, data, width, height, bytes, sha256)
       VALUES ($1, $2, $3, $4, $5, $6, 'image/png', $7, $8, $9, $10, $11)`,
      [id, Number(trialId), s.id, s.viewport, s.look, s.state, s.data, s.width, s.height, s.bytes, s.sha256],
    );
    ids[s.id] = id;
  }
  return ids;
}

/**
 * Run the step on a trial's worker and store what it took. Resolves
 * { ok: true, capture } (the summary for bench_trials.capture, booted or
 * not) or { ok: false, error } when the platform could not run the step.
 * Never throws.
 */
async function captureTrial({
  pool, trialId, worker, containerName, appId, timeoutMs = CAPTURE_TIMEOUT_MS,
  // Where the screenshots go when they are not a trial's own (the bot's
  // review rounds, services/bot-review.js storeRoundShots): kept => ids.
  store = null,
}) {
  let stdout;
  try {
    stdout = await worker.runBenchCapture(containerName, {
      source: script(),
      env: { INLOOP_PORT: CAPTURE_PORT, INLOOP_DATABASE_URL, BENCH_APP_ID: Number(appId) || 1 },
      timeoutMs,
    });
  } catch (err) {
    return { ok: false, error: `the screenshot step did not run: ${String(err.message || err).slice(0, 300)}` };
  }
  const output = parseOutput(stdout);
  if (!output) return { ok: false, error: 'the screenshot step wrote no result' };
  const { kept, dropped } = acceptShots(output.shots);
  let artifacts = {};
  try {
    artifacts = store ? await store(kept) : await storeShots(pool, trialId, kept);
  } catch (err) {
    log.warn('bench', 'Could not store a trial\'s screenshots', { trialId, err: err.message });
    return { ok: false, error: `the screenshots could not be stored: ${err.message}` };
  }
  return { ok: true, capture: summarize(output, kept, dropped, artifacts) };
}

/**
 * The screenshots grading shows, from a capture summary: in SHOT_PRIORITY
 * order, up to `max`, each with its caption; one identical to a screenshot
 * already chosen is skipped and named in `identical`. Pure.
 */
function pickShots(capture, max = MAX_GRADING_SHOTS) {
  const shots = new Map((capture?.shots || []).filter((s) => s.artifactId).map((s) => [s.id, s]));
  const chosen = [];
  const identical = [];
  const byHash = new Map();
  for (const id of SHOT_PRIORITY) {
    const s = shots.get(id);
    if (!s) continue;
    const twin = s.sha256 ? byHash.get(s.sha256) : null;
    if (twin) {
      identical.push({ caption: caption(s), sameAs: caption(twin) });
      continue;
    }
    if (s.sha256) byHash.set(s.sha256, s);
    if (chosen.length < max) chosen.push({ ...s, caption: caption(s) });
  }
  return { chosen, identical, total: shots.size };
}

/** Artifact rows by id, with their bytes, for one trial. */
async function readArtifacts(pool, trialId, ids) {
  if (!ids.length) return [];
  const { rows } = await pool.query(
    `SELECT id, shot_id, content_type, data, width, height
       FROM bench_trial_artifacts WHERE trial_id = $1 AND id = ANY($2::text[])`,
    [Number(trialId), ids],
  );
  return rows;
}

module.exports = {
  SCRIPT_FILE,
  MARKER,
  CAPTURE_TIMEOUT_MS,
  CAPTURE_PORT,
  MAX_SHOT_BYTES,
  MAX_GRADING_SHOTS,
  VIEWPORTS,
  LOOKS,
  STATES,
  RESULT_SCREENS,
  ACTION_RULES,
  SHOT_PRIORITY,
  plannedShots,
  caption,
  parseOutput,
  acceptShots,
  summarize,
  describeActions,
  storeShots,
  captureTrial,
  pickShots,
  readArtifacts,
};
