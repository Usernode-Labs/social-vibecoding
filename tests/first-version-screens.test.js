// #4387: what a first version's App tab shows its members while it is
// built (services/first-version-screens.js): the first look drawn in the
// build's worker, the build agent's "Adding …" caption, the real screens
// kept from its review, and the members-only reads of them.
//
// Run with: node --test tests/first-version-screens.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fvs = require('../src/services/first-version-screens');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// A real 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function fakePool(answers = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      for (const [re, rows] of answers) if (re.test(String(sql))) return { rows: typeof rows === 'function' ? rows(params) : rows };
      return { rows: [] };
    },
  };
}

// ── The caption ──────────────────────────────────────────────────────────

test('the caption is read off the command, in either harness, and cleaned', () => {
  const cases = [
    ['$ usernode-progress "Adding the tier rows"', 'Adding the tier rows'],
    ['$ /bin/bash -lc \'usernode-progress "Adding today\'s list"\'', 'Adding today\'s list'],
    ['$ bash -lc "usernode-progress \\"Adding the map\\""', 'Adding the map'],
    ['$ cd app && usernode-progress \'Adding rows\' && npm test', 'Adding rows'],
    ['$ usernode-progress Adding the chart; ls', 'Adding the chart'],
    // Too long: cut at a word, at most 40 characters.
    ['$ usernode-progress "Adding a very long phrase that goes on and on past forty characters"', 'Adding a very long phrase that goes on'],
  ];
  for (const [line, want] of cases) assert.equal(fvs.captionOf(line), want, line);
  for (const line of [
    '$ usernode-progress "Removing the old list"', // not "Adding …"
    '$ usernode-progress "Adding"', // nothing being added
    '$ usernode-progress', // no phrase
    'Reading usernode-progress', // not a command
    '… thinking about usernode-progress "Adding x"', // not a command
    '$ echo usernode-progressive "Adding x"',
    null,
  ]) assert.equal(fvs.captionOf(line), null, String(line));
  // Plain text only: markup and control characters never come through.
  const odd = fvs.captionOf('$ usernode-progress "Adding <b>bold</b>\u0007 rows"');
  assert.ok(odd === null || /^[\p{L}\p{N} ,.'’&+\-/()]+$/u.test(odd), odd);
  for (const [line] of cases) assert.ok(fvs.captionOf(line).length <= fvs.CAPTION_MAX);
});

test('the watcher keeps the newest phrase on the run, once per change, and never throws', async () => {
  const pool = fakePool();
  const watch = fvs.captionWatcher(pool, 42);
  watch('$ usernode-progress "Adding the tier rows"');
  watch('$ usernode-progress "Adding the tier rows"');
  watch('Reading src/app.js');
  watch('$ usernode-progress "Adding drag to reorder"');
  await new Promise((r) => setTimeout(r, 10));
  const writes = pool.calls.filter((c) => /build_caption/.test(c.sql));
  assert.deepEqual(writes.map((c) => c.params), [[42, 'Adding the tier rows'], [42, 'Adding drag to reorder']]);
  const failing = { query: async () => { throw new Error('down'); } };
  assert.doesNotThrow(() => fvs.captionWatcher(failing, 1)('$ usernode-progress "Adding x"'));
  await new Promise((r) => setTimeout(r, 10));
});

test('the build agent has the command, and the first version\'s prompt asks for it', () => {
  const script = read('worker/usernode-progress');
  assert.match(script, /^#!\/bin\/sh/);
  assert.match(script, /exit 0\s*$/, 'a note never fails a build');
  const dockerfile = read('worker/Dockerfile');
  assert.match(dockerfile, /COPY usernode-progress \/usr\/local\/bin\/usernode-progress/);
  assert.match(dockerfile, /\/usr\/local\/bin\/usernode-progress \\/);
  const live = require('../src/services/homeroom-bot-live');
  const lines = live.FIRST_VERSION_PROGRESS_LINES.join(' ');
  assert.match(lines, /usernode-progress "Adding the tier rows"/);
  assert.match(lines, /starts with "Adding" and is at most 40 characters/);
  assert.ok(live.buildPrompt({ seed: 'S', buildNote: 'p', firstVersion: true }).includes('usernode-progress'));
  assert.ok(!live.buildPrompt({ seed: 'S', buildNote: 'p' }).includes('usernode-progress'), 'later changes are not asked');
});

// ── The first look ───────────────────────────────────────────────────────

const SPEC = '<article data-spec><h1>Plants</h1><section data-spec-tab="user"><figure data-screens>'
  + '<template data-screen data-size="desktop"><div>wide</div></template>'
  + '<template data-screen data-size="phone" data-height="1600"><div data-side="after" data-change="1"><h2>Today</h2><script>alert(1)</script></div></template>'
  + '<ol data-changes><li>The list</li></ol></figure></section><section data-spec-tab="tech"><p>t</p></section></article>';

test('the first look is the spec\'s main phone screen, in a document that loads nothing', () => {
  const screen = fvs.mainScreenOf(SPEC);
  assert.deepEqual(screen, {
    markup: '<div data-side="after" data-change="1"><h2>Today</h2><script>alert(1)</script></div>', width: 390, height: 844,
  });
  assert.equal(fvs.mainScreenOf('# a markdown spec'), null);
  assert.equal(fvs.mainScreenOf(null), null);
  assert.equal(fvs.mainScreenOf('<article data-spec><section data-spec-tab="user"><p>no screens</p></section></article>'), null);
  const doc = fvs.firstLookDocument(screen, '.btn-primary{color:red}</style><script>x</script>');
  assert.match(doc, /^<!doctype html><html data-side="after">/);
  assert.match(doc, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"/);
  assert.ok(!doc.includes('</style><script>x'), 'the kit\'s text cannot close its style early');
  assert.ok(doc.includes('<h2>Today</h2>'));
});

test('the worker draws it with scripts off and nothing loaded but data, and always exits 0', () => {
  const src = read('worker/usernode-first-look.js');
  assert.match(src, /javaScriptEnabled: false/);
  assert.match(src, /offline: true/);
  assert.match(src, /url\.startsWith\('data:'\) \? route\.continue\(\) : route\.abort\(\)/);
  assert.match(src, /process\.exit\(0\)/);
  assert.match(src, /__USERNODE_FIRST_LOOK__/);
  assert.equal(fvs.MARKER, '__USERNODE_FIRST_LOOK__');
});

test('renderFirstLook runs the script in its own file in the build\'s worker and keeps only a real PNG', async () => {
  const sent = [];
  const worker = {
    async runBenchCapture(container, opts) {
      sent.push({ container, ...opts });
      return `noise\n${fvs.MARKER} ${JSON.stringify({ ok: true, png: PNG.toString('base64') })}\n`;
    },
  };
  const pool = fakePool();
  assert.equal(await fvs.renderFirstLook({ pool, worker, containerName: 'w-1', runId: 9, specHtml: SPEC }), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].container, 'w-1');
  assert.equal(sent[0].scriptPath, '/tmp/usernode-first-look.js', 'never the capture\'s own file');
  assert.match(sent[0].source, /^'use strict';\nconst FIRST_LOOK = \{"html":"<!doctype html>/);
  const insert = pool.calls.find((c) => /INSERT INTO first_version_screens/.test(c.sql));
  assert.deepEqual(insert.params.slice(1, 4), [9, 'first_look', 0]);
  assert.ok(Buffer.isBuffer(insert.params[4]) && insert.params[4].equals(PNG));
  assert.ok(pool.calls.findIndex((c) => /DELETE FROM first_version_screens/.test(c.sql)) < pool.calls.indexOf(insert), 'replaces what the run had');

  // Anything else is no first look, and never a throw.
  for (const out of ['', `${fvs.MARKER} {"ok":false,"error":"no"}`, `${fvs.MARKER} ${JSON.stringify({ ok: true, png: Buffer.from('<svg/>').toString('base64') })}`]) {
    const p = fakePool();
    assert.equal(await fvs.renderFirstLook({ pool: p, worker: { runBenchCapture: async () => out }, containerName: 'w', runId: 1, specHtml: SPEC }), false);
    assert.ok(!p.calls.some((c) => /INSERT/.test(c.sql)));
  }
  assert.equal(await fvs.renderFirstLook({ pool, worker: { runBenchCapture: async () => { throw new Error('gone'); } }, containerName: 'w', runId: 1, specHtml: SPEC }), false);
  assert.equal(await fvs.renderFirstLook({ pool, worker: {}, containerName: 'w', runId: 1, specHtml: SPEC }), false);
  assert.equal(await fvs.renderFirstLook({ pool, worker, containerName: 'w', runId: 1, specHtml: '# markdown' }), false);
});

test('a script of its own file only: the worker refuses any other path', () => {
  const worker = require('../src/services/worker');
  assert.match(worker.buildBenchCaptureCommand({}, '/tmp/usernode-first-look.js')[2], /node \/tmp\/usernode-first-look\.js$/);
  assert.match(worker.buildBenchCaptureCommand({})[2], /node \/tmp\/usernode-bench-capture\.js$/);
  for (const bad of ['/etc/passwd', '/tmp/usernode-x.js; rm -rf /', '/tmp/../x.js']) {
    assert.throws(() => worker.buildBenchCaptureCommand({}, bad), /invalid script path/);
  }
});

// ── The real screens ─────────────────────────────────────────────────────

test('the real screens are the booted capture\'s main phone screens, three at most, none twice', () => {
  const shot = (id, sha) => ({ id, sha256: sha, artifactId: `a-${id}` });
  const capture = {
    booted: true,
    shots: [
      shot('desktop-light-populated', '1'), shot('phone-light-empty', '4'), shot('phone-light-result', '2'),
      shot('phone-light-populated', '2'), shot('phone-dark-populated', '3'),
    ],
  };
  // The result looked exactly like the populated screen: kept once.
  assert.deepEqual(fvs.realShotsOf(capture), ['a-phone-light-populated', 'a-phone-light-empty']);
  assert.deepEqual(fvs.realShotsOf({ ...capture, booted: false }), [], 'an app that did not boot shows nothing');
  assert.deepEqual(fvs.realShotsOf(null), []);
});

test('keepRealScreens copies them from the run\'s own captures', async () => {
  const capture = { booted: true, shots: [{ id: 'phone-light-populated', sha256: 'x', artifactId: 'abc' }] };
  const pool = fakePool([[/FROM bot_capture_artifacts/, [{ id: 'abc', data: PNG, width: 390, height: 844 }]]]);
  assert.equal(await fvs.keepRealScreens(pool, 7, capture), 1);
  const select = pool.calls.find((c) => /FROM bot_capture_artifacts/.test(c.sql));
  assert.match(select.sql, /WHERE bot_run_id = \$1 AND id = ANY/, 'only this run\'s');
  assert.deepEqual(select.params, [7, ['abc']]);
  const insert = pool.calls.find((c) => /INSERT INTO first_version_screens/.test(c.sql));
  assert.deepEqual(insert.params.slice(1, 4), [7, 'real', 0]);
  assert.equal(await fvs.keepRealScreens({ query: async () => { throw new Error('down'); } }, 7, capture), 0, 'never throws');
});

// ── What the App tab is told ─────────────────────────────────────────────

test('the caption while it is built; the first look while built, the real screens from Testing it', () => {
  const look = { count: 1, at: '2026-10-08T10:00:00.000Z' };
  const real = { count: 3, at: '2026-10-08T10:20:00.000Z' };
  const both = { caption: 'Adding rows', screens: { first_look: look, real } };
  assert.deepEqual(fvs.firstVersionShowcase(both, 'building'), {
    caption: 'Adding rows', screens: { kind: 'first_look', count: 1, at: look.at, v: String(Date.parse(look.at)) },
  });
  assert.deepEqual(fvs.firstVersionShowcase(both, 'testing').screens.kind, 'real');
  assert.deepEqual(fvs.firstVersionShowcase(both, 'ready').screens.kind, 'real');
  assert.equal('caption' in fvs.firstVersionShowcase(both, 'testing'), false);
  const lookOnly = { caption: null, screens: { first_look: look } };
  assert.equal(fvs.firstVersionShowcase(lookOnly, 'testing').screens.kind, 'first_look', 'no review: the first look stays');
  assert.deepEqual(fvs.firstVersionShowcase(lookOnly, 'ready'), {}, 'ready with no real screens: the thumbnail');
  assert.deepEqual(fvs.firstVersionShowcase(lookOnly, 'planning'), {});
  assert.deepEqual(fvs.firstVersionShowcase(null, 'building'), {});
});

test('GET /api/apps/:slug carries them to members only', async () => {
  const { firstVersionShowcaseFields } = require('../src/routes/apps');
  const communities = require('../src/services/communities');
  const pool = fakePool([
    [/FROM homeroom_bot_first_versions f/, [{ id: 3, build_caption: 'Adding the tier rows' }]],
    [/FROM first_version_screens WHERE bot_run_id = \$1 GROUP BY kind/, [{ kind: 'first_look', count: 1, at: '2026-10-08T10:00:00Z' }]],
  ]);
  const real = communities.isMember;
  try {
    communities.isMember = async (_pool, _appId, userId) => userId === 5;
    const member = await firstVersionShowcaseFields(pool, 1, 5, { line: 'building' });
    assert.equal(member.caption, 'Adding the tier rows');
    assert.equal(member.screens.kind, 'first_look');
    assert.deepEqual(await firstVersionShowcaseFields(pool, 1, 6, { line: 'building' }), {}, 'not a member');
    assert.deepEqual(await firstVersionShowcaseFields(pool, 1, null, { line: 'building' }), {}, 'signed out');
    assert.equal((await firstVersionShowcaseFields(pool, 1, 6, { mine: true, line: 'building' })).caption, 'Adding the tier rows', 'its maker');
  } finally {
    communities.isMember = real;
  }
  const src = read('src/routes/apps.js');
  assert.match(src, /\.\.\.showcase,/);
});

test('the images are served only to members, as PNGs that run nothing', () => {
  const src = read('src/routes/apps.js');
  const at = src.indexOf("router.get('/api/apps/:slug/first-version/screens/:kind/:n'");
  assert.ok(at > 0);
  const route = src.slice(at, src.indexOf('\n  });', at));
  assert.match(route, /appAccess\.getAppForUser\(pool, req\.params\.slug, req\.user, 'view'/);
  assert.match(route, /!req\.user\?\.id/);
  assert.match(route, /communities\.isMember\(pool, app\.id, req\.user\.id\)/);
  assert.match(route, /'Content-Type': 'image\/png'/);
  assert.match(route, /'Cache-Control': 'private, max-age=3600'/);
  assert.match(route, /'X-Content-Type-Options': 'nosniff'/);
  assert.match(route, /'Content-Security-Policy': "default-src 'none'"/);
  assert.match(route, /row\.content_type !== 'image\/png'/);
});

test('readScreen reads the newest run of the first version, in range only', async () => {
  const pool = fakePool([
    [/FROM homeroom_bot_first_versions f/, [{ id: 3, build_caption: null }]],
    [/FROM first_version_screens\s+WHERE bot_run_id/, [{ content_type: 'image/png', data: PNG }]],
  ]);
  assert.equal((await fvs.readScreen(pool, 1, 'real', 2)).content_type, 'image/png');
  const q = pool.calls.find((c) => /FROM first_version_screens\s+WHERE bot_run_id/.test(c.sql));
  assert.deepEqual(q.params, [3, 'real', 2]);
  for (const [kind, n] of [['html', 0], ['real', 3], ['real', -1], ['first_look', 1.5]]) {
    assert.equal(await fvs.readScreen(pool, 1, kind, n), null, `${kind} ${n}`);
  }
});

test('the table keeps images for a run, privately', () => {
  const schema = read('src/db/schema.sql');
  const at = schema.indexOf('CREATE TABLE IF NOT EXISTS first_version_screens');
  const table = schema.slice(at, schema.indexOf(');', at));
  assert.match(table, /bot_run_id\s+INTEGER NOT NULL REFERENCES homeroom_bot_runs\(id\) ON DELETE CASCADE/);
  assert.match(table, /kind\s+VARCHAR\(16\) NOT NULL CHECK \(kind IN \('first_look', 'real'\)\)/);
  assert.match(schema, /COMMENT ON TABLE first_version_screens IS 'staging:private';/);
  assert.match(schema, /ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS build_caption TEXT;/);
});

test('the live lane wires all three into a first version\'s build, and no other', () => {
  const src = read('src/services/homeroom-bot.js');
  const at = src.indexOf('async function buildLive(');
  const body = src.slice(at, src.indexOf('\n}\n', at));
  assert.match(body, /\.\.\.\(firstVersion \? \{\s*onProgress: firstVersionScreens\(\)\.captionWatcher\(pool, runId\),\s*onFirstLook: /);
  assert.match(body, /if \(firstVersion && built\?\.review\?\.finalCapture\) \{\s*await firstVersionScreens\(\)\.keepRealScreens\(pool, runId, built\.review\.finalCapture\);/);
});
