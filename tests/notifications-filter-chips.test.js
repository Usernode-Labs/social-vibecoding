'use strict';

// The bell's All tab, filterable (#4014).
//
// The All tab was one mixed list where a mention sat between a merge and a
// session notice, and the person who asked for this could not find their own
// rows in it. Three chips under the tab strip now gather the three things
// they are named for — Mentions, Votes and proposals, Merges — filtering the
// rows client-side off a `group` flag the row builder stamps, and paging the
// lit group SERVER-side on its own cursor so "See older" really does surface
// older rows of the thing that is filtered for.
//
// The grouping is defined once on the server (NOTIFICATION_KIND_GROUPS in
// src/services/notifications.js, the mechanism the Messages tab's
// `?kind=conversation` already rode) and mirrored in the client, which must
// never drift from it — the chip shows rows off the client flag and pages
// them off the server name, so a kind the two copies disagree on shows on one
// side and pages on the other. The first test here reads BOTH sources and
// compares them so that cannot happen silently.
//
// Frontend logic is extracted from the shipped source (so these cannot drift
// from what runs) and exercised against stubs, in the style of
// tests/notifications-messages-tab.test.js.
//
// Run with: node --test tests/notifications-filter-chips.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const notifications = require('../src/services/notifications');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const FE_SRC = read('frontend/src/features/notifications/notifications.js');
const SHEET_SRC = read('frontend/src/features/notifications/notifications-sheet.tsx');

// The client's grouping, extracted from the shipped source so the test
// compares what RUNS, not a copy of it. The slice carries the conversation
// set, the chip groups and the group-of-kind lookup together.
function clientGroups() {
  const start = FE_SRC.indexOf('const CONVERSATION_NOTIF_KINDS');
  const end = FE_SRC.indexOf('// #2387: where a conversation row opens.');
  assert.ok(start > -1 && end > start, 'the client group block found in notifications.js');
  return new Function(`${FE_SRC.slice(start, end)}\nreturn { CONVERSATION_NOTIF_KINDS, NOTIF_KIND_GROUPS, notifGroupOfKind };`)();
}

// ── 1. one grouping, two copies that cannot drift ──────────────────────

test('the client chip groups equal the server NOTIFICATION_KIND_GROUPS', () => {
  const client = clientGroups();
  const server = notifications.NOTIFICATION_KIND_GROUPS;
  assert.equal(Object.isFrozen(server), true, 'the server map is frozen');
  assert.deepEqual(
    Object.keys(server).sort(),
    ['conversation', 'mentions', 'merges', 'votes'],
  );
  for (const name of ['mentions', 'votes', 'merges']) {
    assert.deepEqual(
      [...client.NOTIF_KIND_GROUPS[name]],
      [...server[name]],
      `${name}: the chip shows rows off the client set and pages them off the server one`,
    );
  }
  // The conversation group keeps its own mirror (the Messages tab's set).
  assert.deepEqual([...client.CONVERSATION_NOTIF_KINDS], [...server.conversation]);
});

// ── 2. the row's group flag ─────────────────────────────────────────────

test('a kind maps to its chip, and a kind in no group maps to null', () => {
  const { notifGroupOfKind } = clientGroups();
  // Mentions include replies and reactions, in the app chat AND in Messages.
  for (const kind of [
    'mention', 'reply', 'reaction', 'thread_reply',
    'conversation_mention', 'conversation_reply',
    'conversation_thread_reply', 'conversation_reaction',
  ]) assert.equal(notifGroupOfKind(kind), 'mentions', kind);
  for (const kind of [
    'pr_proposed', 'proposal_vote', 'vote_digest', 'revision_recheck',
    'change_ready', 'stale_pr', 'check_failed',
  ]) assert.equal(notifGroupOfKind(kind), 'votes', kind);
  assert.equal(notifGroupOfKind('pr_merged'), 'merges');
  // A plain conversation message is not a mention: the chip answers "who
  // spoke to me", not "what was said" — that is the Messages tab's job. The
  // session rows, kudos, invites, friend rows and digests belong to no chip.
  for (const kind of [
    'conversation_message', 'conversation_invite', 'build_ready',
    'session_done', 'session_stalled', 'auto_solve_done', 'kudos',
    'spec_shared', 'friend_request',
  ]) assert.equal(notifGroupOfKind(kind), null, kind);
});

test('rowView stamps the group on every row, off the map', () => {
  assert.match(FE_SRC, /group: notifGroupOfKind\(n\.kind\),/,
    'the flag is set where NOTIF_KIND_GROUPS lives, so the sheet cannot drift from it');
});

// ── 3. the sheet filters on the flag, not on kind ──────────────────────

test('the All tab filters a lit chip off the row group flag', () => {
  assert.match(SHEET_SRC, /const chip = tab === 'all' \? snap\.filterKind \|\| null : null;/,
    'the lit chip is store state, one source of truth with the filtered pager');
  assert.match(SHEET_SRC,
    /: chip \? all\.filter\(\(view\) => view\.group === chip\) : all;/,
    'the same principle the Messages tab filters on `conversation` by');
  // Unread and Messages keep computing from the full list, so the badge and
  // those tabs are unaffected by whatever a chip is doing.
  assert.match(SHEET_SRC, /const unread = all\.filter\(\(view\) => view\.unread\);/);
  assert.match(SHEET_SRC, /const messages = all\.filter\(\(view\) => view\.conversation \|\| view\.agent\);/);
});

// ── 4. the chip rail ────────────────────────────────────────────────────

test('the chip rail renders only on All, as toggle buttons beside the tablist', () => {
  const railAt = SHEET_SRC.indexOf("{tab === 'all' ? (");
  assert.ok(railAt > -1, 'the rail is gated on the All tab');
  const tabsAt = SHEET_SRC.indexOf('id="notifications-screen-tabs"');
  assert.ok(tabsAt > -1 && tabsAt < railAt, 'the rail sits under the tab strip');
  const rail = SHEET_SRC.slice(railAt, SHEET_SRC.indexOf("The sheet's own scroller"));
  assert.ok(rail.length > 0 && rail.length < SHEET_SRC.length - railAt);
  assert.doesNotMatch(rail, /role=/,
    'toggle buttons with aria-pressed, never entries in the tablist above them');
  assert.match(rail, /aria-pressed=\{chip === def\.group\}/);
  for (const group of ['mentions', 'votes', 'merges']) {
    assert.match(rail, /id=\{`notifications-chip-\$\{def\.group\}`\}/);
    assert.match(SHEET_SRC, new RegExp(`group: '${group}'`),
      `${group} is one of the chips, named after the things it gathers`);
  }
  // Tapping the lit chip again is how you get back to everything; there is
  // no separate "All" chip.
  assert.match(rail, /onClick=\{\(\) => controller\(\)\?\.setFilter\(chip === def\.group \? null : def\.group\)\}/);
});

// ── 5. the filtered pager ───────────────────────────────────────────────

test('switching chips resets the filtered cursor; the loader pages the lit group', () => {
  const start = FE_SRC.indexOf('setFilter(name) {');
  const end = FE_SRC.indexOf('async loadOlderFiltered()');
  const setFilter = FE_SRC.slice(start, end);
  assert.ok(start > -1 && end > start, 'setFilter found beside loadOlderFiltered');
  assert.match(setFilter, /if \(Notifications\.filterKind === next\) return;/,
    'no reset for a press that changes nothing');
  assert.match(setFilter, /Notifications\.filterNextBefore = null;/);
  assert.match(setFilter, /Notifications\.filterHasMore = true;/,
    'the first press under a new chip re-pages from its newest row');
  assert.match(setFilter, /Notifications\._renderList\(\);/);

  const loader = FE_SRC.slice(end, FE_SRC.indexOf('handleIncoming(notif) {'));
  assert.ok(loader.includes('loadOlderFiltered'), 'the loader found');
  assert.match(loader, /const group = Notifications\.filterKind;/);
  assert.match(loader, /if \(!group \|\| Notifications\.filterLoading \|\| !Notifications\.filterHasMore\) return;/);
  // Its OWN query and cursor — not the shared page and not the Messages
  // tab's. Sharing either would strand rows the other queries must reach.
  assert.match(loader, /new URLSearchParams\(\{ limit: '100', kind: group \}\)/);
  assert.match(loader, /if \(Notifications\.filterNextBefore\) \{/);
  assert.doesNotMatch(loader, /Notifications\.nextBefore/);
  assert.doesNotMatch(loader, /Notifications\.msgNextBefore/);
  // Rows land in the one shared items array, deduped and re-sorted
  // newest-first with id as tiebreak, so both the filtered view and clearing
  // the filter see them in feed order.
  assert.match(loader, /const seen = new Set\(Notifications\.items\.map\(\(n\) => n\.id\)\);/);
  assert.match(loader, /Number\(b\.id\) - Number\(a\.id\)/);
  assert.match(loader, /Notifications\.filterHasMore = !!data\.hasMore;/);
  assert.match(loader, /Notifications\.filterNextBefore = data\.nextBefore \|\| null;/);
});

test('the footer pages the lit chip on its own loader, and only while it has more', () => {
  const messagesAt = SHEET_SRC.indexOf('id="notifications-see-older-messages"');
  const filteredAt = SHEET_SRC.indexOf("tab === 'all' && chip ? (");
  const idAt = SHEET_SRC.indexOf('id="notifications-load-older-filtered"');
  const jumpAt = SHEET_SRC.indexOf("tab !== 'all' && (all.length > rows.length || snap.screenCanLoadMore)");
  assert.ok(messagesAt > -1 && filteredAt > -1 && idAt > -1 && jumpAt > -1);
  assert.ok(filteredAt > messagesAt && idAt > filteredAt && jumpAt > idAt,
    'a lit chip replaces the footer with the filtered pager alone');
  const filtered = SHEET_SRC.slice(filteredAt, jumpAt);
  assert.match(filtered, /snap\.filterCanLoadMore \? \(/,
    'rendered only while the group still has an older page');
  assert.match(filtered, /onClick=\{\(\) => controller\(\)\?\.loadOlderFiltered\(\)\}/,
    'not the shared loadMore and not loadOlderMessages');
  assert.match(filtered, /disabled=\{snap\.filterLoading\}/);
});

test('the store publishes the chip state and its pager beside the tabs', () => {
  // Both _renderList branches push it, so the empty drawer re-renders the
  // rail and the pager as correctly as the populated one.
  assert.equal(
    (FE_SRC.match(/filterCanLoadMore: Notifications\.filterHasMore/g) || []).length, 2);
  assert.equal(
    (FE_SRC.match(/filterLoading: Notifications\.filterLoading/g) || []).length, 2);
  assert.equal(
    (FE_SRC.match(/filterKind: Notifications\.filterKind/g) || []).length, 2);
});
