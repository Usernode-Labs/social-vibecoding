// src/services/waitlist-questions.js — the two-stage waitlist survey's
// question definitions and validators (ported from the original
// topochain waitlist so SV mirrors its structure and questions).
//
// Contracts guarded here:
//
//   1. Stage 1 is email-only: NOTHING in the survey is required, so a
//      bare join with just an address is valid and yields an empty
//      answers object. The doc's "Simpler waitlist flow proposal"
//      settled this, and Andrea and Evan agreed it in its comments.
//      Unknown enum values are still rejected, never stored, and
//      made_url has moved to stage 2.
//   2. Stage 2 is all-optional but still validates enum keys (group
//      size/role/tools, loss answers/kinds). The cleaned payload contains
//      only known keys — a hostile body can't smuggle arbitrary JSON into
//      answers, and the retired `invites` key is dropped rather than
//      rejected so a stale client still saves.
//   3. publicOptions() (what the SPA renders from) exposes exactly the
//      option sets the validators accept, so client and server can't
//      drift.
//
// Run with: node --test tests/waitlist-questions.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const q = require('../src/services/waitlist-questions');

// ─── 1. Stage 1 ───────────────────────────────────────────────────────

test('stage 1 accepts an email-only join — every survey field is optional', () => {
  const bare = q.validateStage1({});
  assert.equal(bare.ok, true);
  assert.deepEqual(bare.value, {});
});

test('stage 1 still rejects unknown enum values it is given', () => {
  assert.equal(q.validateStage1({ discovery_source: 'carrier-pigeon' }).ok, false);
  assert.equal(q.validateStage1({ country: 'ZZ' }).ok, false);
  for (const key of Object.keys(q.DISCOVERY_SOURCES)) {
    assert.equal(q.validateStage1({ discovery_source: key }).ok, true);
  }
});

test('stage 1 no longer accepts made_url — it belongs to stage 2 now', () => {
  const r = q.validateStage1({ made_url: 'https://example.com', made_note: 'a bot' });
  assert.equal(r.ok, true);
  assert.equal(r.value.made_url, undefined);
  assert.equal(r.value.made_note, undefined);
});

test('stage 1 cleans optional fields and rejects unknown countries', () => {
  const base = { discovery_source: 'friend' };

  const full = q.validateStage1({
    ...base,
    country: 'de',
    evil_extra: 'nope',
  });
  assert.equal(full.ok, true);
  assert.equal(full.value.country, 'DE'); // normalized upper-case
  assert.equal(full.value.discovery.source, 'friend');
  assert.equal('evil_extra' in full.value, false);

  assert.equal(q.validateStage1({ ...base, country: 'ZZ' }).ok, false);
  // The five region pseudo-codes are RETIRED — the picker is the complete
  // ISO 3166-1 list now, so there is a real entry for every place they stood
  // in for. Two of them (EU, AP) are not ISO codes at all and are simply
  // rejected; the other three ARE — LA is Laos, AF is Afghanistan, ME is
  // Montenegro — and are accepted as those countries, which is exactly why
  // the stored legacy answers were namespaced to `X-LA` and friends.
  assert.equal(q.validateStage1({ ...base, country: 'EU' }).ok, false);
  assert.equal(q.validateStage1({ ...base, country: 'AP' }).ok, false);
  for (const code of ['LA', 'AF', 'ME']) {
    const r = q.validateStage1({ ...base, country: code });
    assert.equal(r.ok, true, `${code} is a real ISO country now`);
    assert.equal(r.value.country, code);
  }
  // And the namespaced legacy form can never be submitted: the field is
  // capped at two characters, so `X-LA` is structurally unreachable.
  assert.equal(q.validateStage1({ ...base, country: 'X-LA' }).value.country, undefined);
});

// Andrea's 27 Aug 2026 review cut three stage-1 fields. A stale client
// still sending them must SAVE normally with the keys dropped — the same
// contract the retired `invites` array got — because a cached SPA is not a
// reason to refuse somebody's signup.
test('stage 1 drops the three retired fields instead of refusing them', () => {
  const r = q.validateStage1({
    discovery_source: 'friend',
    city: 'Berlin',
    discovery_detail: 'alice',
    referrer_handle: '@bob',
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.city, undefined);
  assert.equal(r.value.discovery.detail, undefined);
  assert.deepEqual(r.value.discovery, { source: 'friend' });
  assert.equal(r.value.referrer_handle, undefined);
});

// The eight options Andrea settled on, and the five keys that went with
// the old ten. Retired keys must be REJECTED on new submissions (they are
// not offered any more) while rows that already stored one keep it — the
// admin screen renders the stored key directly and nothing rewrites it.
test('stage 1 offers exactly the eight agreed discovery sources', () => {
  assert.deepEqual(Object.keys(q.DISCOVERY_SOURCES), [
    'x', 'linkedin', 'instagram', 'reddit', 'friend', 'podcast', 'event', 'other',
  ]);
  for (const retired of ['farcaster', 'chat', 'video', 'reading', 'search']) {
    assert.equal(q.validateStage1({ discovery_source: retired }).ok, false,
      `${retired} is no longer offered, so it cannot be submitted`);
  }
});

// ─── 2. Stage 2 ───────────────────────────────────────────────────────

test('stage 2 prepends https:// to a scheme-less made_url', () => {
  assert.equal(q.validateStage2({ made_url: 'not a link' }).ok, false);
  const r = q.validateStage2({ made_url: '  example.com/repo  ', made_note: '  A Discord bot  ' });
  assert.equal(r.ok, true);
  assert.equal(r.value.made_url, 'https://example.com/repo');
  assert.equal(r.value.made_note, 'A Discord bot');
});

test('stage 2 preserves explicit web schemes and rejects unsupported ones', () => {
  for (const url of ['https://example.com/repo', 'http://example.com/repo']) {
    const r = q.validateStage2({ made_url: url });
    assert.equal(r.ok, true);
    assert.equal(r.value.made_url, url);
  }
  for (const url of [
    'ftp://example.com/file',
    'mailto:hello@example.com',
    'javascript:alert.example.com',
  ]) {
    assert.equal(q.validateStage2({ made_url: url }).ok, false, `${url} is not a web URL`);
  }
});

test('stage 2 accepts an empty body (everything optional)', () => {
  const r = q.validateStage2({});
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, {});
});

test('stage 2 validates enum keys in every section', () => {
  assert.equal(q.validateStage2({ group_size: 'huge' }).ok, false);
  assert.equal(q.validateStage2({ group_role: 'king' }).ok, false);
  assert.equal(q.validateStage2({ group_tools: ['discord', 'fax'] }).ok, false);
  assert.equal(q.validateStage2({ had_loss: 'maybe' }).ok, false);
  assert.equal(q.validateStage2({ loss_kind: ['shutdown', 'meteor'] }).ok, false);

  const ok = q.validateStage2({
    group_name: 'Indie devs Lagos',
    group_size: '50-250',
    group_role: 'organizer',
    group_tools: ['discord', 'spreadsheet'],
    group_need: 'Money and membership',
    had_loss: 'yes',
    loss_product: 'Google Reader',
    loss_kind: ['shutdown', 'api'],
    loss_story: 'Everyone scattered.',
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value.group.tools, ['discord', 'spreadsheet']);
  assert.equal(ok.value.loss.had, 'yes');
});

test('stage 2 shapes handles and drops the three retired keys', () => {
  const r = q.validateStage2({
    farcaster: '@fc',
    discord: 'disc',
    telegram: '@tg',
    other_handle: 'twitch.tv/me',
    invites: ['a@x.com', '', '  ', '@b', 'c', 'd', 'e', 'f'],
    admit_together: 1,
    referrer_handle: '@ref',
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.handles, {
    farcaster: '@fc', discord: 'disc', telegram: '@tg', other: 'twitch.tv/me',
  });
  // The share link replaced the typed rows, so a stale client still
  // sending `invites` gets a NORMAL save with the key dropped — not a
  // validation error somebody would have to debug.
  assert.equal(r.value.invites, undefined);
  // `admit_together` (#1534) is retired the same way. No admission path
  // ever read it, so it went out with the checkbox, and a stale client
  // still sending it gets the same normal save with the key dropped.
  assert.equal(r.value.admit_together, undefined);
  // `referrer_handle` went the same way on 27 Aug 2026, and for the same
  // reason the stage-1 copy did: the invite link records the relationship
  // as a row reference, so a typed handle was a claim nobody could resolve.
  assert.equal(r.value.referrer_handle, undefined);
});

// "Follow along" is a SELF-REPORT. It is stored under its own key and must
// never reach `answers.verified`, which OAuth actually proves: no network
// exposes an API that confirms a follow (LinkedIn returns aggregate
// statistics, Instagram a bare count, and X retired its boolean endpoint).
test('stage 2 stores the follow claim as a claim, not as a verification', () => {
  const on = q.validateStage2({ followed_claim: 1 });
  assert.equal(on.ok, true);
  assert.equal(on.value.followed_claim, true);
  assert.equal(on.value.verified, undefined);

  const off = q.validateStage2({ followed_claim: 0 });
  assert.equal(off.value.followed_claim, false);

  // Absent stays absent: a save that never mentions it must not invent one.
  assert.equal('followed_claim' in q.validateStage2({}).value, false);
});

test('stage 2 output contains only known keys', () => {
  const r = q.validateStage2({ group_name: 'g', is_admin: true, answers: { x: 1 } });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.value), ['group']);
});

// ─── 3. Client/server single source ───────────────────────────────────

test('publicOptions exposes exactly the option sets the validators accept', () => {
  const opts = q.publicOptions();
  assert.deepEqual(opts.discovery_sources, q.DISCOVERY_SOURCES);
  assert.deepEqual(opts.group_sizes, q.GROUP_SIZES);
  assert.deepEqual(opts.group_roles, q.GROUP_ROLES);
  assert.deepEqual(opts.group_tools, q.GROUP_TOOLS);
  assert.deepEqual(opts.loss_answers, q.LOSS_ANSWERS);
  assert.deepEqual(opts.loss_kinds, q.LOSS_KINDS);
  assert.deepEqual(opts.countries, q.COUNTRIES);
  // max_invites went with the typed invite rows.
  assert.equal('max_invites' in opts, false);
  // The per-source "Which one?" labels went with the detail field they
  // labelled, so the module must not still be publishing them.
  assert.equal('discovery_detail_labels' in opts, false);
  assert.equal(q.DISCOVERY_DETAIL_LABELS, undefined);
});

// ─── 4. The question catalogue ────────────────────────────────────────
// ONE list of the seven questions, read by two things that must agree:
// waitlist-signals.js derives its SECTIONS from it (so the admin screen's
// "N of M answered" counts these), and the waitlist CSV export writes
// `questions_answered` plus the seven question/answer pairs from it. The
// denominator has drifted once already when there were two lists.

test('the catalogue is the seven survey sections, in file order', () => {
  assert.deepEqual(q.WAITLIST_QUESTIONS.map((x) => x.key),
    ['made', 'where', 'found', 'group', 'loss', 'handles', 'follow']);
  for (const item of q.WAITLIST_QUESTIONS) {
    assert.equal(typeof item.question, 'string');
    assert.ok(item.question.length > 0, item.key);
    assert.equal(typeof item.answered, 'function', item.key);
    assert.equal(typeof item.answer, 'function', item.key);
  }
});

test('waitlist-signals derives its sections from this catalogue', () => {
  const { SECTIONS } = require('../src/services/waitlist-signals');
  assert.deepEqual(SECTIONS.map(([k]) => k), q.WAITLIST_QUESTIONS.map((x) => x.key));
  assert.equal(SECTIONS.length, q.WAITLIST_QUESTIONS.length);
});

// The wording in an export is the wording the person READ. A reworded form
// with a stale question string in the catalogue is a file that misreports
// what was asked, and nothing else would catch it — so each question is
// pinned against the JSX that renders it.
//
// The JSX writes apostrophes as `&rsquo;`, so the source is normalised
// before the match. `follow`'s question carries a caveat the checkbox
// label does not ("(self-reported, not verified)"): that is deliberate —
// a column of "Yes" must not read as something we verified — so only the
// part before the parenthetical is looked for.
test('every question is the wording its form actually shows', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
    .replace(/&rsquo;/g, "'")
    .replace(/&amp;/g, '&');
  const sources = {
    stage1: read('frontend/src/features/auth/waitlist.tsx'),
    stage2: read('frontend/src/features/auth/more.tsx'),
  };
  const WHERE_ASKED = {
    made: 'stage2',
    where: 'stage1',
    found: 'stage1',
    group: 'stage2',
    loss: 'stage2',
    handles: 'stage2',
    follow: 'stage2',
  };
  for (const item of q.WAITLIST_QUESTIONS) {
    const asked = item.question.replace(/\s*\([^)]*\)$/, '');
    assert.ok(sources[WHERE_ASKED[item.key]].includes(asked),
      `${item.key}: "${asked}" is not in ${WHERE_ASKED[item.key]}`);
  }
});

test('answeredCount and answerLines survive a blob that is not an object', () => {
  for (const bad of [null, undefined, 'nope', 42, ['a'], true]) {
    assert.equal(q.answeredCount(bad), 0);
    const lines = q.answerLines(bad);
    assert.equal(lines.length, 7);
    assert.deepEqual(lines.map((l) => l.answer), Array(7).fill(''));
    assert.equal(q.otherAnswers(bad), '');
  }
});

// Retired option keys are never remapped — a row holding one still has to
// say something, so the code itself is the fallback rather than a blank.
test('an unknown answer code falls back to the code', () => {
  const lines = q.answerLines({
    discovery: { source: 'farcaster' },
    group: { size: 'gt9000', tools: ['pigeon'] },
    country: 'X-LA',
  });
  const by = Object.fromEntries(lines.map((l) => [l.key, l.answer]));
  assert.equal(by.found, 'farcaster');
  assert.equal(by.where, 'Elsewhere in Latin America (region)');
  assert.match(by.group, /Roughly how many people\?: gt9000/);
  assert.match(by.group, /What does it run on today\?: pigeon/);
});

// A section counts only when it holds real content: a partial save can
// leave an empty object behind, and an empty object is not an answer.
test('an empty section object is not an answered question', () => {
  assert.equal(q.answeredCount({ group: {}, loss: {}, handles: {} }), 0);
  assert.equal(q.answeredCount({ followed_claim: false }), 0);
  assert.equal(q.answeredCount({ followed_claim: true }), 1);
  // `city` alone still answers "where" — rows answered it before the form
  // stopped asking, and dropping the read would un-answer them.
  assert.equal(q.answeredCount({ city: 'Berlin' }), 1);
});

test('otherAnswers carries what no question covers, sorted, objects as JSON', () => {
  assert.equal(q.otherAnswers({
    _version: 3,
    made_url: 'https://x.invalid',
    verified: { x: true },
    why: 'Because',
    role: 'Validator',
    nested: { a: 1 },
  }), 'nested: {"a":1} · role: Validator · why: Because');
});
