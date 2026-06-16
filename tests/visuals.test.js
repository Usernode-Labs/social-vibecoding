// Tests for the before/after visuals plumbing (#195): the UI-affecting
// changed-file heuristic + capture-output sentinel parsing in
// src/services/visuals.js, and the PR-body "Before / after" block
// builder / marker upsert in src/services/pr-metadata.js.
//
// Run with: node --test tests/visuals.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const visuals = require('../src/services/visuals');
const { parseCookie, resolveTargets } = require('../capture/capture');
const { buildVisualsBlock, upsertVisualsBlock } = require('../src/services/pr-metadata');

const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);
const DOMAIN = 'example.test';

// ── isFrontendFile / isUiAffecting ─────────────────────────────────────

test('frontend extensions count regardless of location', () => {
  assert.equal(visuals.isFrontendFile('lib/widget.jsx'), true);
  assert.equal(visuals.isFrontendFile('style.css'), true);
  assert.equal(visuals.isFrontendFile('deep/nested/page.HTML'), true);
});

test('frontend directory segments count at any depth', () => {
  assert.equal(visuals.isFrontendFile('public/js/app.js'), true);
  assert.equal(visuals.isFrontendFile('src/components/button.ts'), true);
  assert.equal(visuals.isFrontendFile('a/b/views/x.ejs'), true);
});

test('backend-only files do not count', () => {
  assert.equal(visuals.isFrontendFile('server.js'), false);
  assert.equal(visuals.isFrontendFile('src/db/schema.sql'), false);
  assert.equal(visuals.isFrontendFile('lib/api/routes.ts'), false);
});

test('a file NAMED like a segment is not a directory match', () => {
  // Only directory segments (not the basename) trigger the location rule.
  assert.equal(visuals.isFrontendFile('src/pages.js'), false);
});

test('isUiAffecting needs >= 1 frontend file', () => {
  assert.equal(visuals.isUiAffecting(['server.js', 'README.md']), false);
  assert.equal(visuals.isUiAffecting(['server.js', 'public/index.html']), true);
  assert.equal(visuals.isUiAffecting([]), false);
});

// ── withToken (capture-auth query param) ───────────────────────────────

test('withToken joins with ? on a plain path', () => {
  assert.equal(visuals.withToken('http://x:3000/', 'tok'), 'http://x:3000/?token=tok');
  assert.equal(visuals.withToken('http://x:3000/board', 'tok'), 'http://x:3000/board?token=tok');
});

test('withToken joins with & when the path already carries a query string', () => {
  assert.equal(
    visuals.withToken('http://x:3000/board?demo-pr=1', 'tok'),
    'http://x:3000/board?demo-pr=1&token=tok'
  );
});

test('withToken URL-encodes the token', () => {
  assert.equal(visuals.withToken('http://x:3000/', 'a+b/c'), 'http://x:3000/?token=a%2Bb%2Fc');
});

test('withToken passes the URL through unchanged on an empty token', () => {
  assert.equal(visuals.withToken('http://x:3000/board?demo-pr=1', ''), 'http://x:3000/board?demo-pr=1');
  assert.equal(visuals.withToken('http://x:3000/', null), 'http://x:3000/');
});

test('withToken places the token BEFORE a #fragment (#353)', () => {
  // A self-app hash deep link: the token must reach the server, so it
  // belongs in the query string, never inside the fragment.
  assert.equal(
    visuals.withToken('http://x:3000/#app/social/dev/proposals/5', 'tok'),
    'http://x:3000/?token=tok#app/social/dev/proposals/5'
  );
});

test('withToken keeps an existing query AND the fragment in order (#353)', () => {
  assert.equal(
    visuals.withToken('http://x:3000/?demo=1#leaderboard', 'tok'),
    'http://x:3000/?demo=1&token=tok#leaderboard'
  );
});

// ── selfAppHashPath (hash-route normalisation, #353) ───────────────────

test('selfAppHashPath moves SPA hash routes into the fragment', () => {
  assert.equal(visuals.selfAppHashPath('/app/social/dev/proposals/5'), '/#app/social/dev/proposals/5');
  assert.equal(visuals.selfAppHashPath('/leaderboard'), '/#leaderboard');
  assert.equal(visuals.selfAppHashPath('/group-chat'), '/#group-chat');
  assert.equal(visuals.selfAppHashPath('/individual-chat/9'), '/#individual-chat/9');
});

test('selfAppHashPath leaves bare /, already-fragment, and server pages alone', () => {
  assert.equal(visuals.selfAppHashPath('/'), '/');
  assert.equal(visuals.selfAppHashPath('/#app/social/dev'), '/#app/social/dev');
  assert.equal(visuals.selfAppHashPath('/dashboard'), '/dashboard');
  assert.equal(visuals.selfAppHashPath('/admin'), '/admin');
  assert.equal(visuals.selfAppHashPath('/status'), '/status');
  assert.equal(visuals.selfAppHashPath('/node-status'), '/node-status');
});

// ── beforeContainerName ("before" target resolution) ───────────────────

test('normal slugs resolve to usernode-app-<slug>', () => {
  const config = { selfAppSlug: 'usernode-2d5619', selfAppContainer: 'usernode' };
  assert.equal(visuals.beforeContainerName(config, 'my-cool-app'), 'usernode-app-my-cool-app');
});

test('the self-app slug resolves to the platform container', () => {
  const config = { selfAppSlug: 'usernode-2d5619', selfAppContainer: 'usernode' };
  assert.equal(visuals.beforeContainerName(config, 'usernode-2d5619'), 'usernode');
});

test('SELF_APP_CONTAINER override is honoured, with a usernode fallback', () => {
  const overridden = { selfAppSlug: 'usernode-2d5619', selfAppContainer: 'my-fork-platform' };
  assert.equal(visuals.beforeContainerName(overridden, 'usernode-2d5619'), 'my-fork-platform');
  const unset = { selfAppSlug: 'usernode-2d5619' };
  assert.equal(visuals.beforeContainerName(unset, 'usernode-2d5619'), 'usernode');
});

// ── parseCookie (capture.js BEFORE_COOKIE / AFTER_COOKIE env form) ─────

test('parseCookie splits name=value on the first equals sign', () => {
  assert.deepEqual(parseCookie('session=abc123'), { name: 'session', value: 'abc123' });
  assert.deepEqual(parseCookie(' session = a=b=c '), { name: 'session', value: 'a=b=c' });
});

test('parseCookie returns null on unset or malformed input', () => {
  assert.equal(parseCookie(''), null);
  assert.equal(parseCookie(undefined), null);
  assert.equal(parseCookie('no-equals-here'), null);
  assert.equal(parseCookie('=value-without-name'), null);
  assert.equal(parseCookie('name='), null);
});

// ── parseShots ─────────────────────────────────────────────────────────

function frame(kind, media, payload) {
  const b64 = Buffer.from(payload).toString('base64');
  return `__USERNODE_SHOT__ kind=${kind} media=${media} status=200 bytes=${payload.length}\n${b64}\n__USERNODE_SHOT_END__\n`;
}

test('parseShots decodes well-formed frames and failures independently', () => {
  const stdout = frame('before', 'png', 'PNG1')
    + '__USERNODE_SHOT_FAIL__ kind=before media=webm reason=timeout%20x\n'
    + frame('after', 'gif', 'GIF1');
  const { shots, failures } = visuals.parseShots(stdout);
  assert.equal(shots.length, 2);
  assert.deepEqual(shots[0], { kind: 'before', media: 'png', status: 200, index: 0, buf: Buffer.from('PNG1') });
  assert.equal(shots[1].kind, 'after');
  assert.equal(shots[1].media, 'gif');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, 'timeout x');
});

test('parseShots drops frames with bad kind/media or a missing terminator', () => {
  const noEnd = `__USERNODE_SHOT__ kind=after media=png status=200 bytes=4\n${Buffer.from('PNG1').toString('base64')}\n`;
  assert.equal(visuals.parseShots(noEnd).shots.length, 0);
  assert.equal(visuals.parseShots(frame('sideways', 'png', 'x')).shots.length, 0);
  assert.equal(visuals.parseShots(frame('after', 'avi', 'x')).shots.length, 0);
});

// ── buildVisualsBlock ──────────────────────────────────────────────────

test('two-column block with GIF preferred over PNG', () => {
  const block = buildVisualsBlock(
    { before: { png: ID_A, gif: ID_B }, after: { png: ID_B, gif: ID_A } },
    DOMAIN
  );
  assert.ok(block.startsWith('<!-- usernode:visuals -->'));
  assert.ok(block.endsWith('<!-- /usernode:visuals -->'));
  assert.ok(block.includes('| Before | After |'));
  assert.ok(block.includes(`![Before](https://${DOMAIN}/visuals/${ID_B})`));
  assert.ok(block.includes(`![After](https://${DOMAIN}/visuals/${ID_A})`));
});

test('falls back to PNG when no GIF stored, and webm is never embedded', () => {
  const block = buildVisualsBlock({ after: { png: ID_A, webm: ID_B } }, DOMAIN);
  assert.ok(block.includes(`![After](https://${DOMAIN}/visuals/${ID_A})`));
  assert.ok(!block.includes(ID_B));
});

test('after-only renders the one-column variant with a note', () => {
  const block = buildVisualsBlock({ after: { gif: ID_A } }, DOMAIN);
  assert.ok(block.includes('| After |'));
  assert.ok(!block.includes('| Before |'));
  assert.ok(block.includes('No production version to compare'));
});

test('empty when there is no usable after artifact', () => {
  assert.equal(buildVisualsBlock(null, DOMAIN), '');
  assert.equal(buildVisualsBlock({ before: { png: ID_A } }, DOMAIN), '');
  assert.equal(buildVisualsBlock({ after: { webm: ID_A } }, DOMAIN), '');
});

// ── upsertVisualsBlock ─────────────────────────────────────────────────

test('appends when no markers exist', () => {
  const block = buildVisualsBlock({ after: { gif: ID_A } }, DOMAIN);
  const out = upsertVisualsBlock('Body text.', block);
  assert.equal(out, `Body text.\n\n${block}`);
});

test('replaces an existing marker-delimited block idempotently', () => {
  const block1 = buildVisualsBlock({ after: { gif: ID_A } }, DOMAIN);
  const block2 = buildVisualsBlock({ after: { gif: ID_B } }, DOMAIN);
  const body = `Intro.\n\n${block1}\n\nFooter.`;
  const out = upsertVisualsBlock(body, block2);
  assert.ok(out.includes(ID_B));
  assert.ok(!out.includes(ID_A));
  assert.ok(out.startsWith('Intro.'));
  assert.ok(out.endsWith('Footer.'));
  // Re-upserting the same block is a no-op.
  assert.equal(upsertVisualsBlock(out, block2), out);
});

// ── shapeAgg (vote-panel query shaping) ────────────────────────────────

test('shapeAgg accepts the legacy kind_media key as a single group 0', () => {
  const shaped = visuals.shapeAgg({
    before_png: ID_A, after_gif: ID_B, garbage_key: 'x', after_avi: 'y',
  });
  assert.deepEqual(shaped, {
    captures: [{ index: 0, path: '/', before: { png: ID_A }, after: { gif: ID_B } }],
  });
  assert.equal(visuals.shapeAgg(null), null);
  assert.equal(visuals.shapeAgg({}), null);
});

test('shapeAgg parses the new kind_index_media key into ordered groups', () => {
  const shaped = visuals.shapeAgg({
    before_0_png: ID_A, after_0_png: ID_B,
    after_1_gif: ID_A, before_1_png: ID_B,
    junk_2_x: 'q',
  });
  assert.equal(shaped.captures.length, 2);
  assert.deepEqual(shaped.captures[0], { index: 0, path: '/', before: { png: ID_A }, after: { png: ID_B } });
  assert.deepEqual(shaped.captures[1], { index: 1, path: '/', before: { png: ID_B }, after: { gif: ID_A } });
});

test('shapeAgg drops a group with no after artifact', () => {
  // index 1 has only a before — nothing to show, so it's omitted.
  const shaped = visuals.shapeAgg({ before_0_png: ID_A, after_0_png: ID_B, before_1_png: ID_A });
  assert.equal(shaped.captures.length, 1);
  assert.equal(shaped.captures[0].index, 0);
});

// ── parseShots index attribute (#270) ──────────────────────────────────

test('parseShots reads the index attribute, defaulting to 0 when absent', () => {
  const withIdx = `__USERNODE_SHOT__ kind=after media=png status=200 bytes=4 index=2\n${Buffer.from('PNG1').toString('base64')}\n__USERNODE_SHOT_END__\n`;
  const r1 = visuals.parseShots(withIdx);
  assert.equal(r1.shots.length, 1);
  assert.equal(r1.shots[0].index, 2);
  // Legacy frame with no index= → 0.
  const r2 = visuals.parseShots(frame('after', 'png', 'PNG1'));
  assert.equal(r2.shots[0].index, 0);
});

// ── storeArtifacts grouping (#270) ─────────────────────────────────────

// Minimal fake pool: records the INSERTed rows so we can assert grouping
// without a real database. connect() returns a client whose query() is a
// no-op for BEGIN/DELETE/COMMIT and captures INSERT params.
function fakePool() {
  const inserted = [];
  const client = {
    query: async (sql, params) => {
      if (/^INSERT INTO session_visuals/.test(sql)) inserted.push(params);
      return { rows: [] };
    },
    release: () => {},
  };
  return { inserted, connect: async () => client };
}

test('storeArtifacts groups rows by capture_index and labels each group', async () => {
  const pool = fakePool();
  const buf = Buffer.from('x');
  const targets = [{ index: 0, path: '/' }, { index: 1, path: '/board' }];
  const shots = [
    { kind: 'before', media: 'png', status: 200, index: 0, buf },
    { kind: 'after', media: 'png', status: 200, index: 0, buf },
    { kind: 'before', media: 'png', status: 200, index: 1, buf },
    { kind: 'after', media: 'png', status: 200, index: 1, buf },
  ];
  const stored = await visuals.storeArtifacts(pool, 7, 'abc', targets, shots);
  assert.equal(stored.captures.length, 2);
  assert.equal(stored.captures[0].index, 0);
  assert.equal(stored.captures[0].path, '/');
  assert.ok(stored.captures[0].before.png && stored.captures[0].after.png);
  assert.equal(stored.captures[1].index, 1);
  assert.equal(stored.captures[1].path, '/board');
  // Each row was persisted with its capture_index (last param) + path.
  assert.equal(pool.inserted.length, 4);
  assert.equal(pool.inserted[0][8], 0); // capture_index column
  assert.equal(pool.inserted[2][7], '/board'); // captured_path column
  assert.equal(pool.inserted[2][8], 1);
});

test('storeArtifacts keeps only groups that have an after artifact', async () => {
  const pool = fakePool();
  const buf = Buffer.from('x');
  const targets = [{ index: 0, path: '/' }, { index: 1, path: '/settings' }];
  const shots = [
    { kind: 'after', media: 'png', status: 200, index: 0, buf },
    { kind: 'before', media: 'png', status: 200, index: 1, buf }, // no after → dropped
  ];
  const stored = await visuals.storeArtifacts(pool, 7, null, targets, shots);
  assert.equal(stored.captures.length, 1);
  assert.equal(stored.captures[0].index, 0);
});

test('storeArtifacts returns null when no after artifact at all', async () => {
  const pool = fakePool();
  const buf = Buffer.from('x');
  const shots = [{ kind: 'before', media: 'png', status: 200, index: 0, buf }];
  assert.equal(await visuals.storeArtifacts(pool, 7, null, [{ index: 0, path: '/' }], shots), null);
});

// ── buildVisualsBlock grouped + back-compat (#270) ─────────────────────

test('buildVisualsBlock single root group is byte-identical to the legacy form', () => {
  // Legacy flat shape and a single-root grouped shape produce the same block.
  const legacy = buildVisualsBlock({ before: { gif: ID_A }, after: { gif: ID_B } }, DOMAIN);
  const grouped = buildVisualsBlock(
    { captures: [{ index: 0, path: '/', before: { gif: ID_A }, after: { gif: ID_B } }] },
    DOMAIN
  );
  assert.equal(legacy, grouped);
  assert.ok(legacy.includes('## Before / after\n'));
  assert.ok(!legacy.includes('Before / after —'));
});

test('buildVisualsBlock emits one labelled table per capture group', () => {
  const block = buildVisualsBlock({
    captures: [
      { index: 0, path: '/board', before: { gif: ID_A }, after: { gif: ID_B } },
      { index: 1, path: '/settings', before: null, after: { png: ID_A } },
    ],
  }, DOMAIN);
  assert.ok(block.includes('### Before / after — `/board`'));
  assert.ok(block.includes('### Before / after — `/settings`'));
  assert.ok(block.includes('| Before | After |'));
  // The after-only group falls back to the one-column variant.
  assert.ok(block.includes('No production version to compare'));
  // GIF preferred over PNG within a group.
  assert.ok(block.includes(`![Before](https://${DOMAIN}/visuals/${ID_A})`));
});

test('buildVisualsBlock labels a single non-root group with its path', () => {
  const block = buildVisualsBlock(
    { captures: [{ index: 0, path: '/board', after: { gif: ID_A } }] },
    DOMAIN
  );
  assert.ok(block.includes('### Before / after — `/board`'));
});

// ── resolveTargets (container env, #270) ───────────────────────────────

test('resolveTargets parses the TARGETS JSON into normalized targets', () => {
  const env = {
    TARGETS: JSON.stringify([
      { index: 0, beforeUrl: 'http://b/', afterUrl: 'http://a/', beforeFallbackUrl: '', beforeCookie: 'session=tok', afterCookie: '' },
      { index: 1, beforeUrl: '', afterUrl: 'http://a/board' },
    ]),
  };
  const t = resolveTargets(env);
  assert.equal(t.length, 2);
  assert.equal(t[0].index, 0);
  assert.deepEqual(t[0].beforeCookie, { name: 'session', value: 'tok' });
  assert.equal(t[1].beforeUrl, '');
  assert.equal(t[1].afterUrl, 'http://a/board');
});

test('resolveTargets falls back to the scalar env vars when TARGETS is unset', () => {
  const t = resolveTargets({ BEFORE_URL: 'http://b/', AFTER_URL: 'http://a/', BEFORE_FALLBACK_URL: 'http://b/root' });
  assert.equal(t.length, 1);
  assert.equal(t[0].index, 0);
  assert.equal(t[0].beforeUrl, 'http://b/');
  assert.equal(t[0].beforeFallbackUrl, 'http://b/root');
});

test('resolveTargets drops targets with neither before nor after url', () => {
  const env = { TARGETS: JSON.stringify([{ index: 0, beforeUrl: '', afterUrl: '' }, { index: 1, afterUrl: 'http://a/' }]) };
  const t = resolveTargets(env);
  assert.equal(t.length, 1);
  assert.equal(t[0].index, 1);
});

test('resolveTargets falls back to scalars on unparseable TARGETS', () => {
  const t = resolveTargets({ TARGETS: '{not json', AFTER_URL: 'http://a/' });
  assert.equal(t.length, 1);
  assert.equal(t[0].afterUrl, 'http://a/');
});
