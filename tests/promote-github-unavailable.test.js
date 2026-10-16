// What a promote answers when lazy PR creation fails (2026-07-24 outage).
//
// A change that has no pull request gets one when it goes up for a vote.
// Since the proposal machine, that is its review.open work
// (src/workflow/proposal/services.ts), and platform.promoteProposal answers
// the promote route with what review.open came to. When applyPrMetadata
// throws:
//   - code 'github_unavailable' (GitHub-side outage) → 503 with an honest
//     "GitHub is failing, wait a few minutes" message that names the HTTP
//     status/request id — NOT the generic "re-run your request" 502 that
//     sent users (and the Mayor) chasing ghosts during the outage.
//   - code 'no_commits' → the honest 409.
//   - anything else / a null result → the generic 502.
// In every case the change stays Underway, with the status it had.
//
// Runs the promote through the platform with a real workflow runtime against
// the full PostgreSQL schema (tests/lib/promote-platform.js); GitHub and
// lazy PR creation are stubbed.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/promote-github-unavailable.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { startPromotePlatform } = require('./lib/promote-platform');

test('lazy PR creation failures, as the promote answers them', { timeout: 120000 }, async (t) => {
  const h = await startPromotePlatform(t, { name: 'wf_promote_gh' });
  if (!h) { t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return; }

  await t.test('github_unavailable → 503 with the honest GitHub-side message (status + request id)', async () => {
    h.behaviour.applyPrMetadata = async () => {
      const e = new Error('GitHub failed to create the PR for acme:whiteboard after 3 attempts (HTTP 500, request id AB36:1).');
      e.code = 'github_unavailable';
      e.status = 500;
      e.requestId = 'AB36:1';
      throw e;
    };
    const s = await h.session();
    const res = await h.promote(s);
    assert.equal(res.status, 503);
    assert.match(res.body.error, /GitHub is currently failing to create pull requests/);
    assert.match(res.body.error, /HTTP 500 from GitHub/);
    assert.match(res.body.error, /AB36:1/);
    assert.match(res.body.error, /safe on its branch/);
    assert.ok(!/re-run/i.test(res.body.error.replace(/do not re-run.*/i, '')),
      'no "please retry / re-run" framing as the remedy');
    assert.equal(await h.status(s), 'active', 'the change stays Underway');
  });

  await t.test('no_commits → the honest 409', async () => {
    h.behaviour.applyPrMetadata = async () => {
      const e = new Error('No commits between main and dev/evan-1: the branch has no pushed commits.');
      e.code = 'no_commits';
      throw e;
    };
    const s = await h.session({ status: 'paused' });
    const res = await h.promote(s);
    assert.equal(res.status, 409);
    assert.match(res.body.error, /no committed code on its branch/);
    assert.equal(await h.status(s), 'paused', 'a paused change stays paused');
  });

  await t.test('untyped failure (null result) → the generic 502', async () => {
    h.behaviour.applyPrMetadata = async () => null;
    const s = await h.session();
    const res = await h.promote(s);
    assert.equal(res.status, 502);
    assert.match(res.body.error, /Could not create the pull request/);
  });

  await t.test('untyped thrown failure → also the generic 502', async () => {
    h.behaviour.applyPrMetadata = async () => { throw new Error('kaboom'); };
    const s = await h.session();
    const res = await h.promote(s);
    assert.equal(res.status, 502);
    assert.match(res.body.error, /Could not create the pull request/);
    assert.equal(await h.status(s), 'active');
  });
});
