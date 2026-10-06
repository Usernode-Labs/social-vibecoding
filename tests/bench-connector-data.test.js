'use strict';

// What a full admin's connector reads of the live Homeroom bot and of the
// recent before/after screenshots (services/bench/connector-data.js): the
// console's own payloads, curated field by field, so a field added to
// either screen later never reaches a connector by accident.

const test = require('node:test');
const assert = require('node:assert/strict');

const data = require('../src/services/bench/connector-data');

test('the bot\'s run filters are checked, and a page is 1 to 50 runs', () => {
  assert.deepEqual(data.botFilters({}), { app: null, before: null, limit: 20, budgetOnly: false, verdict: null });
  assert.deepEqual(data.botFilters({ app: 'Bad Slug!', verdict: 'nope', before: 'x', limit: 500 }), { app: null, before: null, limit: 50, budgetOnly: false, verdict: null });
  assert.deepEqual(data.botFilters({ app: 'bread-bot', verdict: 'budget', before: '41', limit: 0 }), { app: 'bread-bot', before: 41, limit: 20, budgetOnly: true, verdict: null });
  assert.equal(data.botFilters({ verdict: 'question' }).verdict, 'question');
});

test('the bot overview carries the console\'s fields it names, and nothing else', async () => {
  let asked;
  const bot = {
    async adminPayload(_pool, _config, f) {
      asked = f;
      return {
        settings: { mode: 'live', audience: 'all', turnSeconds: 600, concurrency: 2, secretThing: 'never' },
        bot: { models: { triage: 'a/b' }, weeklyLimitCents: 5000, weeklySpentCents: 1200, hasIncludedKey: true, apiKey: 'sk-never' },
        defaultModel: 'a/b',
        totals: { question: 2 },
        queue: { depth: 1, items: [{ app_slug: 'bread', issue_number: 3, reason: 'new', enqueued_at: '2026-10-01T00:00:00Z' }] },
        runs: [{
          id: 9, app_slug: 'bread', issue_number: 3, verdict: 'question', question: 'q'.repeat(500), cost_usd: '0.12',
          build_ok: true, build_branch: 'b', build_sha: 'c'.repeat(40), replayStages: ['triage'], created_at: '2026-10-01T00:00:00Z',
          prompt: 'never', user_email: 'never@example.com',
        }],
      };
    },
  };
  const out = await data.botOverview(null, {}, { app: 'bread', limit: 1 }, { bot });
  assert.equal(asked.app, 'bread');
  assert.equal(out.settings.mode, 'live');
  assert.equal(out.settings.secretThing, undefined);
  assert.equal(out.spend.apiKey, undefined);
  assert.equal(out.runs[0].costUsd, 0.12);
  assert.equal(out.runs[0].question.length, 400, 'a question is clipped');
  assert.equal(out.runs[0].prompt, undefined);
  assert.equal(out.runs[0].user_email, undefined);
  assert.equal(out.runs[0].build.ok, true);
  assert.equal(out.nextBefore, 9, 'a full page names the next one');
  assert.equal(out.queue.items[0].app, 'bread');
});

test('recent shots page through the gallery\'s own listing and counts, and keep only what they name', async () => {
  const gallery = {
    async listProposals(_pool, q) {
      assert.equal(q.app, 'bread');
      assert.equal(q.before_id, 7);
      return {
        proposals: [{
          id: 70, appSlug: 'bread', appName: 'Bread', prNumber: 12, prUrl: 'https://github.com/x/y/pull/12', title: 'Add rye',
          mergedAt: '2026-10-01T00:00:00Z', captureState: 'ok', authorEmail: 'never@example.com',
          shots: { state: 'verified', claims: [{ id: 'c1', claim: 'Rye is a choice' }], artifacts: [{ media: 'png' }, { media: 'png' }, { media: 'webm' }] },
          visuals: [{}, {}],
        }],
        nextCursor: { before: '2026-09-30T00:00:00Z', before_id: 69 },
      };
    },
    async galleryStats() { return { stats: { total: 3, no_shots: 1 } }; },
  };
  const out = await data.recentShots(null, { app: 'bread', beforeId: 7 }, { gallery });
  const p = out.proposals[0];
  assert.equal(p.sessionId, 70);
  assert.equal(p.shots.images, 2);
  assert.equal(p.shots.clips, 1);
  assert.equal(p.legacyCaptures, 2);
  assert.equal(p.authorEmail, undefined);
  assert.deepEqual(out.nextCursor, { before: '2026-09-30T00:00:00.000Z', beforeId: 69 });
  assert.deepEqual((await data.shotStats(null, {}, { gallery })).stats, { total: 3, no_shots: 1 });
});

test('one proposal\'s shots: only a verified run\'s stills, focus first, within the count and the bytes', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const pool = (session, artifacts) => ({
    async query(sql) {
      if (/FROM chat_sessions/.test(sql)) return { rows: session ? [session] : [] };
      return { rows: artifacts };
    },
  });
  assert.equal((await data.shotImages(pool(null, []), 1)).status, 404);
  const unverified = await data.shotImages(pool({ id: 1, shots_run_id: 4, shots_state: 'failed' }, []), 1);
  assert.deepEqual(unverified.images, []);
  assert.match(unverified.note, /no verified/);

  const rows = Array.from({ length: data.MAX_SHOT_IMAGES + 3 }, (_, i) => ({
    id: i, story_id: `c${i}`, viewport: 'phone', side: i % 2 ? 'head' : 'base', variant: 'focus', content_type: 'image/png', data: png, width: 1, height: 1,
  }));
  const out = await data.shotImages(pool({ id: 1, shots_run_id: 4, shots_state: 'verified', pr_number: 12, app_slug: 'bread' }, rows), 1);
  assert.equal(out.images.length, data.MAX_SHOT_IMAGES);
  assert.equal(out.leftOut, 3);
  assert.equal(out.images[0].caption, 'c0 · phone · before · focus');
  assert.equal(out.images[1].caption, 'c1 · phone · after · focus');
  assert.equal(out.prNumber, 12);
});
