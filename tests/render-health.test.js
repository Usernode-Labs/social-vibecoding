// Render health: the platform's own reading of every checked page, and the
// one checks row it folds into.
//
// Sheep countrr #38 is the case this exists for: a feature proposal made the
// server answer `/tailwind.css` with 204, every layout utility vanished in
// production, and every declared check passed — the markup was all still
// there, and a 204 never reaches the console.
//
// Run with: node --test tests/render-health.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  stylesheetProblem, makeStylesheetWatch, readRenderHealth, runTestGroup, setFrameSink,
} = require('../capture/capture');
const renderHealth = require('../src/services/render-health');
const visuals = require('../src/services/visuals');
const appManifest = require('../src/services/app-manifest');

const DOC = 'https://sheep.example/?round=1&token=abc';

function sheetResponse({ url = 'https://sheep.example/tailwind.css', status = 200, type = 'stylesheet',
  headers = { 'content-length': '5120' }, body = null } = {}) {
  return {
    url: () => url,
    status: () => status,
    headers: () => headers,
    request: () => ({ resourceType: () => type }),
    ...(body === null ? {} : { buffer: async () => Buffer.from(body) }),
  };
}

function failedRequest({ url = 'https://sheep.example/app.css', errorText = 'net::ERR_CONNECTION_REFUSED', type = 'stylesheet' } = {}) {
  return { url: () => url, resourceType: () => type, failure: () => ({ errorText }) };
}

// ── the runner's reading ───────────────────────────────────────────────────

test('a stylesheet is unusable when it fails, answers 204/205, or comes back empty', () => {
  assert.equal(stylesheetProblem({ status: 200, bytes: 5120 }), '');
  assert.equal(stylesheetProblem({ status: 200, bytes: null }), '', 'an unread body is not a failure');
  assert.equal(stylesheetProblem({ status: 304 }), '');
  assert.equal(stylesheetProblem({ status: 204 }), 'answered 204 with no content');
  assert.equal(stylesheetProblem({ status: 205 }), 'answered 205 with no content');
  assert.equal(stylesheetProblem({ status: 200, bytes: 0 }), 'came back empty');
  assert.equal(stylesheetProblem({ status: 401 }), 'answered HTTP 401');
  assert.equal(stylesheetProblem({ status: 502 }), 'answered HTTP 502');
  assert.equal(stylesheetProblem({ failed: 'net::ERR_CONNECTION_REFUSED' }), 'did not load (net::ERR_CONNECTION_REFUSED)');
});

test('the watch reads the document\'s own stylesheets and nothing else', async () => {
  const watch = makeStylesheetWatch(DOC);
  watch.onResponse(sheetResponse({ status: 204, headers: {} }));                        // #38 exactly
  watch.onResponse(sheetResponse({ status: 204, headers: {} }));                        // de-duplicated
  watch.onResponse(sheetResponse({ url: 'https://sheep.example/a.css', headers: { 'content-length': '0' } }));
  watch.onResponse(sheetResponse({ url: 'https://sheep.example/b.css', headers: {}, body: '' }));
  watch.onResponse(sheetResponse({ url: 'https://sheep.example/ok.css', headers: {}, body: '.a{}' }));
  watch.onResponse(sheetResponse({ url: 'https://fonts.example/f.css', status: 500 }));   // cross-origin
  watch.onResponse(sheetResponse({ url: 'https://sheep.example/moved.css', status: 301 })); // a hop
  watch.onResponse(sheetResponse({ url: 'https://sheep.example/x.js', status: 204, type: 'script' }));
  // The platform's hosted kit is the edge's to serve, not the app's.
  watch.onResponse(sheetResponse({ url: 'https://sheep.example/usernode-native/v1/native.css', status: 503 }));
  watch.onRequestFailed(failedRequest());
  watch.onRequestFailed(failedRequest({ url: 'https://sheep.example/gone.css', errorText: 'net::ERR_ABORTED' }));
  watch.onRequestFailed(failedRequest({ url: 'https://cdn.example/c.css' }));
  assert.deepEqual(await watch.problems(), [
    { path: '/tailwind.css', problem: 'answered 204 with no content' },
    { path: '/a.css', problem: 'came back empty' },
    { path: '/b.css', problem: 'came back empty' },
    { path: '/app.css', problem: 'did not load (net::ERR_CONNECTION_REFUSED)' },
  ]);
});

test('a blank reading is confirmed a moment later before it counts', async () => {
  const stylesheets = { problems: async () => [] };
  const answers = (...seq) => ({ evaluate: async () => seq.shift() });
  assert.deepEqual(await readRenderHealth(answers(false, false), stylesheets, { recheckMs: 1 }),
    { v: 1, stylesheets: [], blank: true });
  assert.equal((await readRenderHealth(answers(false, true), stylesheets, { recheckMs: 1 })).blank, false,
    'a screen still painting its first frame is not empty');
  assert.equal((await readRenderHealth(answers(true), stylesheets, { recheckMs: 1 })).blank, false);
  const throwing = { evaluate: async () => { throw new Error('Execution context was destroyed'); } };
  assert.equal((await readRenderHealth(throwing, stylesheets, { recheckMs: 1 })).blank, false,
    'a page that cannot be asked is not called blank');
});

function collect() {
  const chunks = [];
  setFrameSink((s) => chunks.push(s));
  return () => visuals.parseTests(chunks.join(''));
}

test('the runner reports the reading beside a check that still passes on its own terms', async () => {
  const read = collect();
  const handlers = new Map();
  const page = {
    on(ev, fn) { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(fn); },
    async setViewport() {},
    async goto() {
      for (const fn of handlers.get('response') || []) fn(sheetResponse({ status: 204, headers: {} }));
      return { status: () => 200 };
    },
    async waitForNetworkIdle() {},
    async $() { return {}; },
    async evaluate() { return true; },
    async close() {},
  };
  await runTestGroup({ newPage: async () => page },
    [{ index: 0, name: 'Round 1', path: '/?round=1', url: DOC, expectSelector: '#round-badge' }],
    { settleQuietMs: 10, settleMaxMs: 50, assertMaxMs: 50, assertPollMs: 5, renderRecheckMs: 1 });
  const frames = read();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].status, 'pass', 'the declared check keeps its own verdict');
  assert.deepEqual(frames[0].render, {
    v: 1, stylesheets: [{ path: '/tailwind.css', problem: 'answered 204 with no content' }], blank: false,
  });
  const row = renderHealth.summarize(frames);
  assert.equal(row.passed, false);
  assert.match(row.reason, /the stylesheet \/tailwind\.css answered 204 with no content \(on \/\?round=1\)/);
});

test('a document that failed to load carries no reading', async () => {
  const read = collect();
  const page = {
    on() {}, async setViewport() {}, async waitForNetworkIdle() {}, async $() { return null; },
    async goto() { return { status: () => 502 }; },
    async evaluate() { return false; },
    async close() {},
  };
  await runTestGroup({ newPage: async () => page },
    [{ index: 0, name: 'Home', path: '/', url: DOC }],
    { settleQuietMs: 10, settleMaxMs: 50, assertMaxMs: 50, assertPollMs: 5, renderRecheckMs: 1 });
  const frames = read();
  assert.equal(frames[0].status, 'fail');
  assert.equal(frames[0].render, undefined);
  assert.equal(renderHealth.summarize(frames), null);
});

// ── the row ────────────────────────────────────────────────────────────────

const frame = (path, render) => ({ index: 0, name: path, path, status: 'pass', ...(render ? { render } : {}) });

test('no reading, no row: an older capture image says nothing about render health', () => {
  assert.equal(renderHealth.summarize([]), null);
  assert.equal(renderHealth.summarize([frame('/'), frame('/b')]), null);
  assert.equal(renderHealth.summarize([frame('/', { v: 2, blank: true })]), null, 'an unknown shape is not read');
});

test('clean readings pass; problems are listed once each, naming the first page', () => {
  const clean = { v: 1, stylesheets: [], blank: false };
  assert.deepEqual(renderHealth.summarize([frame('/', clean), frame('/b', clean)]), { passed: true, reason: null });

  const sheet = { path: '/tailwind.css', problem: 'answered 204 with no content' };
  const out = renderHealth.summarize([
    frame('/?round=1', { v: 1, stylesheets: [sheet], blank: false }),
    frame('/?round=8', { v: 1, stylesheets: [sheet], blank: false }),
    frame('/?scene=intro', { v: 1, stylesheets: [sheet], blank: true }),
    frame('/leaderboard', { v: 1, stylesheets: [], blank: true }),
  ]);
  assert.equal(out.passed, false);
  assert.equal(out.reason.match(/\/tailwind\.css/g).length, 1, 'a sheet every page shares is listed once');
  assert.match(out.reason, /answered 204 with no content \(on \/\?round=1\)/);
  assert.match(out.reason, /nothing visible rendered on \/\?scene=intro, \/leaderboard/);
  assert.match(out.reason, /element and text checks still pass/);
  assert.match(out.reason, /remove that: the image build writes the file/);

  const blankOnly = renderHealth.summarize([frame('/', { v: 1, stylesheets: [], blank: true })]);
  assert.equal(blankOnly.reason, 'nothing visible rendered on /.');
});

test('long lists are bounded', () => {
  const frames = [];
  for (let i = 0; i < 12; i += 1) {
    frames.push(frame(`/p${i}`, { v: 1, stylesheets: [{ path: `/s${i}.css`, problem: 'came back empty' }], blank: true }));
  }
  const out = renderHealth.summarize(frames);
  assert.match(out.reason, /8 more stylesheet problem\(s\)/);
  assert.match(out.reason, /and 8 more/);
  assert.ok(out.reason.length <= 900);
});

function historyPool(graduatedKeys) {
  return {
    async query(sql) {
      // Merged proposals' passes are folded in first (check-history.js
      // settleMergedPasses); the graduated set is what merges passed.
      if (/^WITH merged AS/.test(sql.trim())) return { rows: [], rowCount: 0 };
      assert.match(sql, /merged_pass_at IS NOT NULL/);
      return { rows: graduatedKeys.map((k) => ({ check_key: k })) };
    },
  };
}

const BROKEN = [frame('/', { v: 1, stylesheets: [{ path: '/tailwind.css', problem: 'answered 204 with no content' }], blank: false })];
const KEY = appManifest.checkKey(renderHealth.RENDER_CHECK_NAME, renderHealth.RENDER_CHECK_PATH);

test('earned gating: advisory until a merged change has passed it, blocking after', async () => {
  const fresh = await renderHealth.maybeBuildRenderHealthRow({ pool: historyPool([]), appId: 7, frames: BROKEN });
  assert.equal(fresh.row.index, renderHealth.RENDER_CHECK_INDEX);
  assert.equal(fresh.row.status, 'fail');
  assert.equal(fresh.row.advisory, true, 'an app broken before the row existed is not blocked by it');
  assert.deepEqual(fresh.history, { checkKey: KEY, name: renderHealth.RENDER_CHECK_NAME, path: renderHealth.RENDER_CHECK_PATH, passed: false });

  const earned = await renderHealth.maybeBuildRenderHealthRow({ pool: historyPool([KEY]), appId: 7, frames: BROKEN });
  assert.equal(earned.row.advisory, false, 'once an app has rendered cleanly, breaking it blocks the merge');
  assert.match(earned.row.failureReason, /\/tailwind\.css answered 204/);

  const ok = await renderHealth.maybeBuildRenderHealthRow({
    pool: historyPool([]), appId: 7, frames: [frame('/', { v: 1, stylesheets: [], blank: false })],
  });
  assert.deepEqual([ok.row.status, ok.row.advisory, ok.history.passed], ['pass', false, true]);
});

test('the row never throws, and can be switched off platform-wide', async () => {
  const broken = { async query() { throw new Error('db down'); } };
  const out = await renderHealth.maybeBuildRenderHealthRow({ pool: broken, appId: 7, frames: BROKEN });
  assert.equal(out.row.advisory, true, 'an unreadable history proves nothing has graduated');
  assert.equal(await renderHealth.maybeBuildRenderHealthRow({ pool: broken, appId: 7, frames: null }), null);
  const prev = process.env.RENDER_HEALTH_CHECK_ENABLED;
  process.env.RENDER_HEALTH_CHECK_ENABLED = '0';
  try {
    assert.equal(await renderHealth.maybeBuildRenderHealthRow({ pool: broken, appId: 7, frames: BROKEN }), null);
  } finally {
    if (prev === undefined) delete process.env.RENDER_HEALTH_CHECK_ENABLED;
    else process.env.RENDER_HEALTH_CHECK_ENABLED = prev;
  }
});

test('the row blocks the verdict only when it has earned it', async () => {
  const frames = [{ index: 0, name: 'Home', path: '/', status: 'pass', consoleErrors: [], failureReason: '' }];
  const advisory = (await renderHealth.maybeBuildRenderHealthRow({ pool: historyPool([]), appId: 7, frames: BROKEN })).row;
  assert.equal(visuals.classifyTests(frames, 1, { extraRows: [advisory] }).state, 'passing');
  const blocking = (await renderHealth.maybeBuildRenderHealthRow({ pool: historyPool([KEY]), appId: 7, frames: BROKEN })).row;
  assert.equal(visuals.classifyTests(frames, 1, { extraRows: [blocking] }).state, 'failing');
});

test('no dapp.json setting reaches the row: allowConsoleErrors changes nothing', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/render-health.js'), 'utf8');
  assert.doesNotMatch(src, /allowConsoleErrors\s*[?&|]/, 'the row reads no per-check opt-out');
});

test('settlement carries the row and records it in the guarded history block', () => {
  // Source pin, like the asset-route row's: the settlement half is shared
  // with the harvester, so the wiring has to live in settleCaptureRun.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'visuals.js'), 'utf8');
  const body = src.slice(src.indexOf('async function settleCaptureRun('));
  assert.match(body, /const renderOutcome = shotsOnly \? null : await renderHealth\.maybeBuildRenderHealthRow\(\{/);
  assert.match(body, /if \(renderOutcome\) extraRows\.push\(renderOutcome\.row\);/);
  assert.match(body, /if \(renderOutcome\) historyRows\.push\(renderOutcome\.history\);/);
  assert.ok(body.indexOf('extraRows.push(renderOutcome.row)') < body.indexOf('classifyTests(parsedTests'),
    'the row is in place before the verdict is taken');
});

test('its synthetic index collides with no other synthetic row', () => {
  const taken = [-1, -2, require('../src/services/unit-suite-row').UNIT_CHECK_INDEX,
    require('../src/services/asset-route-check').ASSET_CHECK_INDEX];
  const content = require('node:fs').readFileSync(require.resolve('../src/services/content-review.js'), 'utf8');
  taken.push(Number(/const CONTENT_CHECK_INDEX = (-\d+);/.exec(content)[1]));
  assert.ok(!taken.includes(renderHealth.RENDER_CHECK_INDEX), `${renderHealth.RENDER_CHECK_INDEX} is free`);
});
