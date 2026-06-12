// Tests for the before/after visuals plumbing (#195): the UI-affecting
// changed-file heuristic + capture-output sentinel parsing in
// src/services/visuals.js, and the PR-body "Before / after" block
// builder / marker upsert in src/services/pr-metadata.js.
//
// Run with: node --test tests/visuals.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const visuals = require('../src/services/visuals');
const { parseCookie } = require('../capture/capture');
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
  assert.deepEqual(shots[0], { kind: 'before', media: 'png', status: 200, buf: Buffer.from('PNG1') });
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

test('shapeAgg shapes the jsonb_object_agg form and drops junk keys', () => {
  const shaped = visuals.shapeAgg({
    before_png: ID_A, after_gif: ID_B, garbage_key: 'x', after_avi: 'y',
  });
  assert.deepEqual(shaped, { before: { png: ID_A }, after: { gif: ID_B } });
  assert.equal(visuals.shapeAgg(null), null);
  assert.equal(visuals.shapeAgg({}), null);
});
