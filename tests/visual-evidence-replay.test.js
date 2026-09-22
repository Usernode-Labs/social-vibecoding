'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const replay = require('../evidence/replay-runner');
const { plan } = require('./fixtures/visual-evidence');

function input(overrides = {}) {
  return {
    runId: 'a'.repeat(32),
    pass: 2,
    publishArtifacts: true,
    origins: { base: 'http://base-evidence:3000', head: 'http://head-evidence:3000' },
    provenance: {
      baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40),
      fixtureFingerprint: 'fixture-123', baseImageDigest: 'sha256:base', headImageDigest: 'sha256:head',
    },
    authTokens: { member: 'member.jwt', read_only_admin: 'admin.jwt' },
    plan: plan(),
    ...overrides,
  };
}

test('runner accepts a validated pair and only publishes artifacts on pass two', () => {
  const parsed = replay.validateInput(input());
  assert.equal(parsed.pass, 2);
  assert.equal(parsed.publishArtifacts, true);
  assert.match(parsed.planHash, /^[0-9a-f]{64}$/);
  const first = replay.validateInput(input({ pass: 1 }));
  assert.equal(first.publishArtifacts, false);
});

test('runner refuses identical, credential-bearing, or non-origin targets', () => {
  assert.throws(() => replay.validateInput(input({ runId: 'not-a-run' })), { code: 'invalid_run_id' });
  assert.throws(() => replay.validateInput(input({ origins: { base: 'http://same:3000', head: 'http://same:3000' } })), { code: 'identical_origins' });
  assert.throws(() => replay.validateInput(input({ origins: { base: 'http://user:pass@base:3000', head: 'http://head:3000' } })), { code: 'invalid_origin' });
  assert.throws(() => replay.validateInput(input({ origins: { base: 'http://base:3000/path', head: 'http://head:3000' } })), { code: 'invalid_origin' });
  assert.throws(() => replay.validateInput(input({ provenance: { ...input().provenance, baseSha: 'moving-main' } })), { code: 'invalid_provenance' });
  assert.throws(() => replay.validateInput(input({ authTokens: { member: 'member.jwt' } })), { code: 'invalid_auth_tokens' });
});

test('runner refuses undeclared home, auth, error, and cross-origin fallbacks', () => {
  const origin = 'http://base-evidence:3000';
  assert.equal(replay.expectedFinalPath('/settings', `${origin}/settings?tab=profile`, origin), '/settings?tab=profile');
  assert.throws(() => replay.expectedFinalPath('/settings', `${origin}/`, origin, 'base'), { code: 'unexpected_fallback' });
  assert.equal(replay.expectedFinalPath('/settings', `${origin}/`, origin, 'base', { allowDeclaredHome: true }), '/');
  assert.throws(() => replay.expectedFinalPath('/settings', `${origin}/login`, origin, 'base'), { code: 'unexpected_fallback' });
  assert.throws(() => replay.expectedFinalPath('/settings', `${origin}/error?code=500`, origin, 'base'), { code: 'unexpected_fallback' });
  assert.throws(() => replay.expectedFinalPath('/settings', 'http://outside:3000/settings', origin, 'base'), { code: 'cross_origin_navigation' });
});

test('browser failures name the failing story and side without exposing fixture tokens', async () => {
  let contexts = 0;
  const browser = { newContext: async () => {
    contexts += 1;
    if (contexts === 1) return { newPage: async () => ({}), close: async () => {} };
    throw new Error('newContext failed at http://base-evidence:3000/?token=secret.jwt');
  } };
  await assert.rejects(replay.runReplay(browser, replay.validateInput(input())), (error) => {
    assert.equal(error.code, 'replay_failed');
    assert.equal(error.detail.storyId, 'invite-suggestions');
    assert.equal(error.detail.viewport, 'desktop');
    assert.equal(error.detail.phase, 'base');
    assert.equal(error.detail.side, 'base');
    assert.doesNotMatch(error.message, /secret\.jwt/);
    return true;
  });
});

test('a failed browser action identifies its plan action and stage', async () => {
  const replayPlan = plan();
  replayPlan.stories[0].intent.animation = 'none';
  replayPlan.stories[0].replay.checkpoint.animation = 'none';
  let contexts = 0;
  const page = {
    on: () => {}, off: () => {}, goto: async () => {}, evaluate: async () => {},
    waitForTimeout: async () => {}, screenshot: async () => Buffer.from('png'),
    getByRole: () => ({ count: async () => 0 }),
  };
  const browser = { newContext: async () => {
    contexts += 1;
    if (contexts === 1) return { newPage: async () => ({}), close: async () => {} };
    return {
      route: async () => {}, addInitScript: async () => {},
      newPage: async () => page, close: async () => {},
    };
  } };
  await assert.rejects(replay.runReplay(browser, replay.validateInput(input({ plan: replayPlan }))), (error) => {
    assert.equal(error.code, 'ambiguous_locator');
    assert.deepEqual(Object.fromEntries(['storyId', 'viewport', 'side', 'phase', 'actionId', 'actionStage', 'actionType']
      .map((key) => [key, error.detail[key]])), {
      storyId: 'invite-suggestions', viewport: 'desktop', side: 'base',
      phase: 'action', actionId: 'open-members', actionStage: 'members', actionType: 'click',
    });
    return true;
  });
});

test('a targeted wait allows its element to render before enforcing uniqueness', async () => {
  let visible = false;
  const counts = [];
  const locator = {
    first: () => ({ waitFor: async ({ state, timeout }) => {
      assert.equal(state, 'visible');
      assert.equal(timeout, 8000);
      visible = true;
    } }),
    count: async () => {
      const count = visible ? 1 : 0;
      counts.push(count);
      return count;
    },
  };
  assert.equal(await replay.waitForOne(locator, 'browse-control', 8000), locator);
  assert.deepEqual(counts, [0, 1]);
});

test('focus crops use the same dimensions and remain within the viewport', () => {
  const viewport = { width: 1280, height: 800 };
  const pair = replay.normalizeCropPair(
    { x: 10, y: 20, width: 300, height: 200 },
    { x: 900, y: 650, width: 360, height: 130 },
    viewport,
  );
  assert.equal(pair.base.width, pair.head.width);
  assert.equal(pair.base.height, pair.head.height);
  for (const crop of Object.values(pair)) {
    assert.ok(crop.x >= 0 && crop.y >= 0);
    assert.ok(crop.x + crop.width <= viewport.width);
    assert.ok(crop.y + crop.height <= viewport.height);
  }
});

test('perceptual hash distance is a bounded bit count', () => {
  assert.equal(replay.hammingHex('0000000000000000', '0000000000000000'), 0);
  assert.equal(replay.hammingHex('0000000000000000', 'ffffffffffffffff'), 64);
  assert.equal(replay.hammingHex('0000000000000000', '0000000000000003'), 2);
});

test('capture image contains the separate evidence runtime and its pinned dependencies', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'capture/Dockerfile'), 'utf8');
  assert.match(dockerfile, /playwright-core@1\.55\.1/);
  assert.match(dockerfile, /pngjs@7\.0\.0/);
  assert.match(dockerfile, /COPY evidence\/replay-runner\.js \/app\/evidence-replay\.js/);
  assert.match(dockerfile, /COPY src\/services\/visual-evidence-plan\.js \/app\/visual-evidence-plan\.js/);
  const visuals = fs.readFileSync(path.join(__dirname, '..', 'src/services/visuals.js'), 'utf8');
  assert.match(visuals, /capture\/Dockerfile/);
});

test('image transforms share one explicitly-owned scratch context', () => {
  const runner = fs.readFileSync(path.join(__dirname, '..', 'evidence/replay-runner.js'), 'utf8');
  assert.doesNotMatch(runner, /browser\.newPage\(/);
  assert.match(runner, /const scratchContext = await browser\.newContext/);
  assert.match(runner, /finally \{\s*await scratchContext\.close\(\);\s*\}/);
});
