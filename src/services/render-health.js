// Render health: the platform's own row in every proposal's checks.
//
// Why this exists. An app's declared checks ask whether an element or some
// text is on a page. A page that lost its stylesheet still has all of its
// markup, so every one of them passes. Sheep countrr shipped exactly that
// (#38): a feature proposal also made the server answer `/tailwind.css` with
// 204 to quiet a local error, every layout utility vanished in production,
// the 3D scene collapsed to nothing, and the checks stayed green because a
// 204 is not an error and never reaches the console.
//
// What it judges. The checks runner (capture/capture.js readRenderHealth)
// reads each checked document for two facts and reports them beside the
// check's own verdict, never inside it:
//
//   * same-origin stylesheets that fail, answer 204/205, or come back empty;
//   * a document that renders nothing visible at all.
//
// This module folds those readings into ONE row. No dapp.json setting reaches
// it — `allowConsoleErrors` included — because the point is a floor the app
// cannot talk itself below.
//
// Gating. The same #1019 earned gating as the unit-suite and asset-route
// rows: ADVISORY until this app has been observed passing it once, merge-
// BLOCKING from then on. Turning it on therefore never blocks an app whose
// pages were already broken before the row existed — it shows up, muted, and
// graduates on the first proposal that fixes them.
//
// No reading, no row: a run whose frames carry none (an older capture image,
// a suite whose every document failed to load) says nothing about render
// health, and must not graduate or fail anything.

'use strict';

const checkHistory = require('./check-history');
const appManifest = require('./app-manifest');
const log = require('./logger');

const RENDER_CHECK_NAME = 'Pages render with their stylesheets (platform check)';
const RENDER_CHECK_PATH = 'every checked page';
// Synthetic-row index namespace: -1 the missing-advisory rollup, -2 the
// over-ceiling guard (visuals.js), -3 the unit suite, -4 the asset route,
// -5 the content rules review. This row is -6.
const RENDER_CHECK_INDEX = -6;
const MAX_LISTED = 4;
const REASON_MAX = 900;

function isEnabled() {
  const v = String(process.env.RENDER_HEALTH_CHECK_ENABLED ?? '1').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

function readingOf(frame) {
  const r = frame && frame.render;
  return r && typeof r === 'object' && r.v === 1 ? r : null;
}

// Pure. `frames` are visuals.parseTests records. Returns null when no frame
// carried a reading, else { passed, reason }.
function summarize(frames) {
  const readings = [];
  for (const f of Array.isArray(frames) ? frames : []) {
    const r = readingOf(f);
    if (r) readings.push({ path: typeof f.path === 'string' && f.path ? f.path : '/', r });
  }
  if (!readings.length) return null;

  // One line per distinct problem, naming the first checked page it was seen
  // on: a broken stylesheet is usually shared by every page, and listing it
  // once per check would bury everything else.
  const sheetProblems = new Map();
  const blankPages = [];
  for (const { path, r } of readings) {
    for (const s of Array.isArray(r.stylesheets) ? r.stylesheets : []) {
      if (!s || typeof s.path !== 'string' || typeof s.problem !== 'string' || !s.problem) continue;
      const key = `${s.path}\n${s.problem}`;
      if (!sheetProblems.has(key)) sheetProblems.set(key, { sheet: s.path, problem: s.problem, page: path });
    }
    if (r.blank === true && !blankPages.includes(path)) blankPages.push(path);
  }
  if (!sheetProblems.size && !blankPages.length) return { passed: true, reason: null };

  const parts = [];
  const sheets = [...sheetProblems.values()];
  for (const s of sheets.slice(0, MAX_LISTED)) {
    parts.push(`the stylesheet ${s.sheet} ${s.problem} (on ${s.page})`);
  }
  if (sheets.length > MAX_LISTED) parts.push(`${sheets.length - MAX_LISTED} more stylesheet problem(s)`);
  if (blankPages.length) {
    const listed = blankPages.slice(0, MAX_LISTED).join(', ');
    const more = blankPages.length > MAX_LISTED ? ` and ${blankPages.length - MAX_LISTED} more` : '';
    parts.push(`nothing visible rendered on ${listed}${more}`);
  }
  const why = sheets.length
    ? ' A page whose stylesheet is missing or empty keeps all of its markup, so element and text checks still pass while people see it unstyled or collapsed.'
      + ' If the server answers that path itself (a route, a stub, a 204), remove that: the image build writes the file.'
    : '';
  const reason = `${parts.join('; ')}.${why}`;
  return { passed: false, reason: reason.length > REASON_MAX ? `${reason.slice(0, REASON_MAX - 1)}…` : reason };
}

function shapeOutcome({ passed, reason, graduated }) {
  const checkKey = appManifest.checkKey(RENDER_CHECK_NAME, RENDER_CHECK_PATH);
  return {
    row: {
      index: RENDER_CHECK_INDEX,
      name: RENDER_CHECK_NAME,
      path: RENDER_CHECK_PATH,
      status: passed ? 'pass' : 'fail',
      advisory: passed ? false : !graduated,
      consoleErrors: [],
      ...(passed ? {} : { failureReason: reason }),
    },
    history: { checkKey, name: RENDER_CHECK_NAME, path: RENDER_CHECK_PATH, passed },
  };
}

// Returns { row, history } or null when the row does not apply. Never throws:
// the checks run must not die because this reading did.
async function maybeBuildRenderHealthRow({ pool, appId, sessionId = null, frames } = {}) {
  try {
    if (!isEnabled()) return null;
    const verdict = summarize(frames);
    if (!verdict) return null;
    let graduated = false;
    if (!verdict.passed) {
      try {
        graduated = (await checkHistory.loadGraduated(pool, appId))
          .has(appManifest.checkKey(RENDER_CHECK_NAME, RENDER_CHECK_PATH));
      } catch (err) {
        log.warn('render-health', 'Graduation lookup failed — treating as advisory', {
          sessionId, appId, err: err.message,
        });
      }
      log.info('render-health', 'Render health failed', {
        sessionId, appId, graduated, reason: verdict.reason.slice(0, 200),
      });
    }
    return shapeOutcome({ ...verdict, graduated });
  } catch (err) {
    log.warn('render-health', 'Render health row failed to build (non-fatal)', {
      sessionId, appId, err: err.message,
    });
    return null;
  }
}

module.exports = {
  RENDER_CHECK_NAME,
  RENDER_CHECK_PATH,
  RENDER_CHECK_INDEX,
  isEnabled,
  summarize,
  maybeBuildRenderHealthRow,
};
