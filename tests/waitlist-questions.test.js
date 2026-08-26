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
    city: 'Berlin',
    discovery_detail: 'alice',
    referrer_handle: '@bob',
    evil_extra: 'nope',
  });
  assert.equal(full.ok, true);
  assert.equal(full.value.country, 'DE'); // normalized upper-case
  assert.equal(full.value.city, 'Berlin');
  assert.equal(full.value.discovery.detail, 'alice');
  assert.equal(full.value.referrer_handle, '@bob');
  assert.equal('evil_extra' in full.value, false);

  assert.equal(q.validateStage1({ ...base, country: 'ZZ' }).ok, false);
  // Region pseudo-codes are valid countries.
  assert.equal(q.validateStage1({ ...base, country: 'EU' }).ok, true);
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
  assert.equal(r.value.referrer_handle, '@ref');
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
  // Every detail label points at a real source.
  for (const key of Object.keys(q.DISCOVERY_DETAIL_LABELS)) {
    assert.ok(key in q.DISCOVERY_SOURCES, `label for unknown source: ${key}`);
  }
});
