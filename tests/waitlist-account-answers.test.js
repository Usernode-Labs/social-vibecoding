'use strict';

// One way onto the waitlist (#5261). The in-app join form on #waitlist made a
// waitlist row of its own beside the one Continue's account gets; it is
// retired, and the two optional questions it asked besides the address are
// asked in the waiting room after the account is made
// (frontend/src/features/auth/waiting-about.tsx), saved through
// POST /api/auth/waiting/about to the account's own row, in the keys the form
// wrote: answers.country and answers.discovery.source.
//
// Run with: node --test tests/waitlist-account-answers.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const waitlist = require('../src/services/waitlist');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** A pool that answers the account-row read with `row` and records every query. */
function fakePool(row) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/^SELECT id, answers FROM waitlist_signups/.test(sql.trim())) return { rows: row ? [row] : [] };
      if (/RETURNING answers/.test(sql)) {
        const patch = JSON.parse(params[1]);
        return { rows: [{ answers: { ...(row.answers || {}), ...patch } }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

test('the answers are read off the account\'s own row, in the form\'s keys', async () => {
  const pool = fakePool({ id: 7, answers: { country: 'UY', discovery: { source: 'friend' }, made_url: 'x' } });
  assert.deepEqual(await waitlist.accountAnswers(pool, 42), { country: 'UY', discovery: 'friend' });
  assert.deepEqual(pool.calls[0].params, [42]);
  assert.match(pool.calls[0].sql, /WHERE linked_user_id = \$1/);
  assert.equal(await waitlist.accountAnswers(fakePool(null), 42), null, 'no row, nothing to ask');
  assert.deepEqual(await waitlist.accountAnswers(fakePool({ id: 7, answers: null }), 42), { country: null, discovery: null });
});

test('a save merges the two keys in SQL, leaving every other answer alone', async () => {
  const pool = fakePool({ id: 7, answers: { made_url: 'x' } });
  const after = await waitlist.saveAccountAnswers(pool, {
    userId: 42,
    answers: { country: 'CH', discovery: { source: 'podcast' } },
  });
  assert.deepEqual(after, { country: 'CH', discovery: 'podcast' });
  const update = pool.calls.find((c) => /RETURNING answers/.test(c.sql));
  assert.match(update.sql, /SET answers = COALESCE\(answers, '\{\}'::jsonb\) \|\| \$2::jsonb/);
  assert.equal(update.params[0], 7, 'the account\'s own row');
  const patch = JSON.parse(update.params[1]);
  assert.deepEqual({ country: patch.country, discovery: patch.discovery }, { country: 'CH', discovery: { source: 'podcast' } });
  assert.ok(patch._version, 'versioned like every other answers write');
  assert.equal(pool.calls.length, 2, 'no invite code, no attribution query');
});

test('an account with no row saves nothing', async () => {
  const pool = fakePool(null);
  assert.equal(await waitlist.saveAccountAnswers(pool, { userId: 42, answers: { country: 'CH' } }), null);
  assert.equal(pool.calls.length, 1);
});

test('an old link\'s code attributes only a fresh, unattributed, unreleased row', async () => {
  const pool = fakePool({ id: 7, answers: null });
  await waitlist.saveAccountAnswers(pool, { userId: 42, answers: {}, inviteCode: 'abcdefghij' });
  const attribution = pool.calls.find((c) => /SET invited_by = s\.id/.test(c.sql));
  assert.ok(attribution, 'the code is honoured');
  assert.match(attribution.sql, /w\.invited_by IS NULL/, 'never re-parents a row');
  assert.match(attribution.sql, /w\.released_at IS NULL/);
  assert.match(attribution.sql, /w\.submitted_at > NOW\(\) - make_interval\(secs => \$3\)/, 'only as part of the first join');
  assert.match(attribution.sql, /s\.id <> w\.id/, 'never itself');
  assert.deepEqual(attribution.params, [7, 'abcdefghij', 3600]);
  assert.ok(!pool.calls.some((c) => /RETURNING answers/.test(c.sql)), 'and with no answers, none are written');

  const junk = fakePool({ id: 7, answers: null });
  await waitlist.saveAccountAnswers(junk, { userId: 42, answers: {}, inviteCode: "x' OR 1=1" });
  assert.ok(!junk.calls.some((c) => /invited_by/.test(c.sql)), 'a malformed code is ignored');
});

test('the routes: the caller\'s own row, the join\'s validation, limited and same-origin', () => {
  const routes = read('src/routes/auth.js');
  const get = routes.match(/router\.get\('\/api\/auth\/waiting\/about'[\s\S]*?\n  \}\);/)[0];
  assert.match(get, /if \(!req\.user\) return res\.status\(401\)/);
  assert.match(get, /waitlist\.accountAnswers\(pool, req\.user\.id\)/);
  const post = routes.match(/router\.post\('\/api\/auth\/waiting\/about'[\s\S]*?\n  \}\);/)[0];
  assert.match(post, /router\.post\('\/api\/auth\/waiting\/about', waitlistAnswersLimiter, sameOriginBrowserOnly, async/);
  assert.match(post, /if \(!req\.user\) return res\.status\(401\)/);
  assert.match(post, /waitlistQuestions\.validateStage1\(req\.body \|\| \{\}\)/);
  assert.match(post, /if \(!checked\.ok\) return res\.status\(422\)/);
  assert.match(post, /userId: req\.user\.id,/);
  // Under /api/auth/, which a waiting account may call.
  assert.match(read('src/middleware/auth.js'), /const GATE_OPEN_PATHS = \[[\s\S]*?'\/api\/auth\/',/);
  const limits = read('src/middleware/rate-limits.js');
  assert.match(limits, /const waitlistAnswersLimiter = makeLimiter\(\{\s+windowMs: 15 \* 60 \* 1000,\s+max: 10,\s+name: 'waitlist-answers',\s+keyByUser: true,/);
});

test('the waiting room asks them once, optionally, and can be skipped', () => {
  const src = read('frontend/src/features/auth/waiting-about.tsx');
  assert.match(read('frontend/src/features/auth/waiting.tsx'), /<WaitingAbout \/>/);
  assert.match(src, /if \(live && body\?\.listed && !body\.country && !body\.discovery && !skipped\(\)\) setView\('ask'\);/);
  assert.match(src, /if \(country\) body\.country = country;/);
  assert.match(src, /if \(discovery\) body\.discovery_source = discovery;/);
  assert.match(src, /disabled=\{saving \|\| \(!country && !discovery\)\}/);
  assert.match(src, /id="waiting-about-skip"/);
  // An old link's code is sent on whether or not the questions are answered.
  assert.match(src, /const ref = takeWaitlistRef\(\);\s+if \(ref\) void postAbout\(\{ invite_code: ref \}\)/);
  for (const [id, said] of [
    ['auth:waiting.about.title', 'Two quick questions'],
    ['auth:waiting.about.country', 'Country'],
    ['auth:waiting.about.discovery', 'How did you find us?'],
    ['auth:waiting.about.skip', 'Skip'],
  ]) {
    assert.ok(src.includes(`t('${id}')`), `the card reads ${id}`);
    assert.equal(message(id), said);
  }
});
