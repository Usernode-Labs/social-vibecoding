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

test('stage 2 takes made_url and validates it looks like a link', () => {
  assert.equal(q.validateStage2({ made_url: 'not a link' }).ok, false);
  const r = q.validateStage2({ made_url: 'https://example.com/repo', made_note: '  A Discord bot  ' });
  assert.equal(r.ok, true);
  assert.equal(r.value.made_url, 'https://example.com/repo');
  assert.equal(r.value.made_note, 'A Discord bot');
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

test('stage 2 shapes handles and no longer accepts typed invites', () => {
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
  assert.equal(r.value.admit_together, true);
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
