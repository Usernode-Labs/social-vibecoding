// Tests for the admin before/after gallery (/gallery) query builder and its
// admin gate (src/routes/gallery.js), plus the partial-output salvage in
// src/services/docker.js and the in-flight re-queue bookkeeping.
//
// Run with: node --test tests/gallery-route.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const gallery = require('../src/routes/gallery');

// ── resolveLimit (page-size clamping) ──────────────────────────────────

test('resolveLimit defaults to 20 and clamps to 50', () => {
  assert.equal(gallery.resolveLimit(undefined), 20);
  assert.equal(gallery.resolveLimit(''), 20);
  assert.equal(gallery.resolveLimit('0'), 20);
  assert.equal(gallery.resolveLimit('-5'), 20);
  assert.equal(gallery.resolveLimit('nonsense'), 20);
  assert.equal(gallery.resolveLimit('10'), 10);
  assert.equal(gallery.resolveLimit('50'), 50);
  assert.equal(gallery.resolveLimit('500'), 50);
});

// ── resolveCursor (keyset paging) ──────────────────────────────────────

test('resolveCursor needs BOTH halves to be valid', () => {
  const ok = gallery.resolveCursor('2026-07-20T10:00:00.000Z', '812');
  assert.deepEqual(ok, { before: '2026-07-20T10:00:00.000Z', beforeId: 812 });
  // A half-supplied or malformed cursor degrades to "first page", never throws.
  assert.equal(gallery.resolveCursor('2026-07-20T10:00:00.000Z', undefined), null);
  assert.equal(gallery.resolveCursor(undefined, '812'), null);
  assert.equal(gallery.resolveCursor('not-a-date', '812'), null);
  assert.equal(gallery.resolveCursor('', '812'), null);
  assert.equal(gallery.resolveCursor('2026-07-20T10:00:00.000Z', 'abc'), null);
});

// ── resolveProblem (filter allow-listing) ─────────────────────────────

test('resolveProblem accepts only known keys, ignoring anything else', () => {
  for (const key of Object.keys(gallery.PROBLEM_FILTERS)) {
    assert.equal(gallery.resolveProblem(key), key);
  }
  // Unknown values are IGNORED (unfiltered page), not errors.
  assert.equal(gallery.resolveProblem('bogus'), null);
  assert.equal(gallery.resolveProblem(undefined), null);
  assert.equal(gallery.resolveProblem(''), null);
  // Prototype keys must not leak through the hasOwnProperty check.
  assert.equal(gallery.resolveProblem('toString'), null);
  assert.equal(gallery.resolveProblem('constructor'), null);
});

// ── buildWhere (shared predicate assembly) ────────────────────────────

test('buildWhere always restricts to merged proposals with a merged_at', () => {
  const { whereSql, params } = gallery.buildWhere({});
  assert.match(whereSql, /cs\.status = 'merged'/);
  assert.match(whereSql, /cs\.merged_at IS NOT NULL/);
  // Default requires artifacts to exist.
  assert.match(whereSql, /EXISTS \(SELECT 1 FROM session_visuals/);
  assert.deepEqual(params, []);
});

test('buildWhere accepts an app slug or a numeric id', () => {
  const bySlug = gallery.buildWhere({ app: 'block-game-54d305' });
  assert.match(bySlug.whereSql, /a\.slug = \$1/);
  assert.deepEqual(bySlug.params, ['block-game-54d305']);

  const byId = gallery.buildWhere({ app: '42' });
  assert.match(byId.whereSql, /cs\.app_id = \$1/);
  assert.deepEqual(byId.params, [42]);

  // An empty app filter adds nothing.
  assert.deepEqual(gallery.buildWhere({ app: '' }).params, []);
});

test('buildWhere appends the keyset comparison last, after the filters', () => {
  const { whereSql, params } = gallery.buildWhere({
    app: 'demo',
    cursor: { before: '2026-07-20T10:00:00.000Z', beforeId: 812 },
  });
  assert.match(whereSql, /\(cs\.merged_at, cs\.id\) < \(\$2, \$3\)/);
  assert.deepEqual(params, ['demo', '2026-07-20T10:00:00.000Z', 812]);
});

test('missing_recording keeps the has-artifacts precondition', () => {
  const { whereSql } = gallery.buildWhere({ problem: 'missing_recording' });
  assert.match(whereSql, /EXISTS \(SELECT 1 FROM session_visuals v WHERE v\.session_id = cs\.id\)/);
  assert.match(whereSql, /NOT EXISTS[\s\S]*media = 'webm'/);
});

test('failed_or_skipped RELAXES the has-artifacts precondition', () => {
  // A failed / console-only proposal stored nothing by definition, so
  // requiring artifacts would make this filter permanently empty.
  const { whereSql } = gallery.buildWhere({ problem: 'failed_or_skipped' });
  assert.doesNotMatch(
    whereSql,
    /AND EXISTS \(SELECT 1 FROM session_visuals v WHERE v\.session_id = cs\.id\)/
  );
  assert.match(whereSql, /capture_state IN \('failed', 'console_only', 'partial'\)/);
});

test('every problem filter is a self-contained boolean SQL fragment', () => {
  // The stats endpoint splices these into COUNT(*) FILTER (WHERE …), so none
  // may carry a leading AND / trailing semicolon.
  for (const [key, f] of Object.entries(gallery.PROBLEM_FILTERS)) {
    assert.ok(typeof f.sql === 'string' && f.sql.length, `${key} has sql`);
    assert.doesNotMatch(f.sql, /^\s*AND\b/i, `${key} has no leading AND`);
    assert.doesNotMatch(f.sql, /;/, `${key} has no semicolon`);
    // Must reference the outer row alias so it works in both queries.
    assert.match(f.sql, /cs\./, `${key} references cs.`);
  }
});

test('an unknown problem value produces the same SQL as no filter', () => {
  const none = gallery.buildWhere({});
  const bogus = gallery.buildWhere({ problem: gallery.resolveProblem('bogus') });
  assert.equal(bogus.whereSql, none.whereSql);
});

// ── the admin gate ────────────────────────────────────────────────────

// The guard must 403 with JSON, never 302-redirect: adminMiddleware branches
// on req.path, which Express strips of the mount prefix inside a sub-router,
// so reusing it here would redirect an API caller. This asserts the specific
// bug the routes/debug.js comment warns about stays fixed.
function findGateLayer() {
  const router = gallery.galleryRoutes({});
  const layer = router.stack.find((l) => l.regexp && l.regexp.test('/api/gallery') && !l.route);
  assert.ok(layer, 'a mount-level /api/gallery guard exists');
  return layer.handle;
}

function runGate(handle, user) {
  const res = {
    statusCode: null, body: null, redirected: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    redirect(to) { this.redirected = to; return this; },
  };
  let nexted = false;
  handle({ user, path: '/proposals', method: 'GET' }, res, () => { nexted = true; });
  return { res, nexted };
}

test('the gallery gate 403s a signed-out caller with JSON', () => {
  const { res, nexted } = runGate(findGateLayer(), undefined);
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Admin access required' });
  assert.equal(res.redirected, null, 'must not redirect an API caller');
});

test('the gallery gate 403s a signed-in NON-admin with JSON', () => {
  const { res, nexted } = runGate(findGateLayer(), { id: 7, username: 'someone', isAdmin: false });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.redirected, null);
});

test('the gallery gate passes a full admin AND a view-only admin', () => {
  // Read-only diagnostics: isAdmin covers both, no requireAdminWrite.
  const full = runGate(findGateLayer(), { isAdmin: true, canAdminWrite: true });
  assert.equal(full.nexted, true);
  assert.equal(full.res.statusCode, null);

  const viewOnly = runGate(findGateLayer(), { isAdmin: true, adminReadonly: true, canAdminWrite: false });
  assert.equal(viewOnly.nexted, true);
  assert.equal(viewOnly.res.statusCode, null);
});

test('the gallery router registers the three read endpoints', () => {
  const router = gallery.galleryRoutes({});
  const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);
  assert.ok(paths.includes('/api/gallery/proposals'));
  assert.ok(paths.includes('/api/gallery/apps'));
  assert.ok(paths.includes('/api/gallery/stats'));
  // Read-only surface: no mutating verbs anywhere on this router.
  for (const l of router.stack.filter((x) => x.route)) {
    assert.deepEqual(Object.keys(l.route.methods), ['get'], `${l.route.path} is GET-only`);
  }
});

// ── the artifact query must never select image bytes ──────────────────

test('the proposals query selects artifact metadata, never the data column', () => {
  // A regression guard on the endpoint's SQL: 5,753 artifact rows averaging
  // ~2 MB each must never stream through this JSON endpoint.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'routes', 'gallery.js'), 'utf8'
  );
  const jsonbBlock = src.slice(src.indexOf('jsonb_agg'), src.indexOf('AS artifacts'));
  assert.ok(jsonbBlock.length, 'found the artifact aggregate');
  assert.doesNotMatch(jsonbBlock, /\bv\.data\b/, 'artifact aggregate never selects v.data');
  assert.match(jsonbBlock, /v\.captured_path/);
  assert.match(jsonbBlock, /v\.before_fell_back/);
});

// ── runOneShot partial-output salvage (improvement 5) ──────────────────

const docker = require('../src/services/docker');

// salvageStdout isn't exported (it's an internal of runOneShot), so drive the
// behaviour through the documented contract instead: the capture pipeline
// passes salvagePartial and must receive partial frames rather than a throw.
// These assert the SHAPE the caller depends on, from the source, since
// spawning real docker isn't available in the test env.
test('runOneShot accepts a salvagePartial option', () => {
  assert.equal(typeof docker.runOneShot, 'function');
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'services', 'docker.js'), 'utf8'
  );
  // Opt-in, defaulting OFF so every existing caller keeps the throwing
  // contract (a truncated `docker build` log is not a usable result).
  assert.match(src, /salvagePartial = false/);
  // Only timeout / maxBuffer kills are salvaged — not arbitrary failures.
  assert.match(src, /ERR_CHILD_PROCESS_STDIO_MAXBUFFER/);
  assert.match(src, /err\.killed === true/);
  // The salvaged result carries the partial marker the caller branches on.
  assert.match(src, /partial: true/);
  assert.match(src, /partialReason/);
});

test('the capture pipeline opts INTO salvage and records it on the outcome', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'services', 'visuals.js'), 'utf8'
  );
  assert.match(src, /salvagePartial: true/);
  // A salvaged run is 'partial', never silently 'captured'.
  assert.match(src, /runPartial\) \? 'partial' : 'captured'/);
  assert.match(src, /runCutShort/);
});

// ── in-flight re-queue (improvement 5) ────────────────────────────────

test('a capture arriving while one is in flight is re-queued, not dropped', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'services', 'visuals.js'), 'utf8'
  );
  // Parked in a Map keyed by session (depth 1 — latest wins) …
  assert.match(src, /const key = captureKey\(session\.id\)/);
  assert.match(src, /_queued\.set\(key/);
  // … and drained from the finally block of the run that blocked it.
  assert.match(src, /_queued\.get\(key\)/);
  assert.match(src, /_queued\.delete\(key\)/);
  assert.doesNotMatch(src, /Capture already in flight — skipping/);
});

// ── stats semantics: artifact-less proposals must not inflate counts ────

test('artifact-dependent filters are not vacuously true for a proposal with no artifacts', () => {
  // The stats endpoint counts over a row set that can include console_only /
  // failed proposals (which stored nothing). A bare NOT EXISTS would count
  // every one of them as "missing recording", inflating the headline number
  // this page exists to report honestly.
  for (const key of ['missing_recording', 'missing_before', 'root_only']) {
    assert.match(
      gallery.PROBLEM_FILTERS[key].sql,
      /EXISTS \(SELECT 1 FROM session_visuals v WHERE v\.session_id = cs\.id\)\s*\n?\s*AND NOT EXISTS/,
      `${key} guards its NOT EXISTS with a has-artifacts check`
    );
  }
});
