'use strict';

// Homeroom mobile polish, item 05 (24 Nov 2026): the Homeroom bot list's
// visits, the pure part (src/services/ai-visits.js). The database half is
// tests/ai-visits-postgres.test.js.
//
// What this pins:
//   1. What a visit may say it saw: the three bands, each a map of a row's
//      identity to where it stood, within bounds; anything else is refused
//      whole.
//   2. What opening the list does: keeps the last visit while another tab
//      has the list open or nothing was seen yet, carries a reloaded tab's
//      visit on, and otherwise makes the visit just left the last one.
//   3. Staging's ?demo=1 answer: a last visit that saw every demo row but
//      three, which the routes answer and record nothing for.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const visits = require('../src/services/ai-visits');
const { demoWork } = require('../src/routes/ai-work');
const { DEMO_NEEDS_FEED } = require('../src/routes/workshop-overview');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('a visit says what each band held: identities and where they stood, nothing else', () => {
  const seen = {
    needs: { 'need:proposal:12': '', 'thread:40': '', 'root:7': '' },
    busy: { 'thread:41': 'next:building', 'thread:42': 'waiting:up_for_vote' },
    done: { 'thread:43': '', 'root:8': '' },
  };
  assert.deepEqual(visits.parseSeen(seen), seen);
  // A band left out is an empty band.
  assert.deepEqual(visits.parseSeen({ needs: { 'thread:1': '' } }), { needs: { 'thread:1': '' }, busy: {}, done: {} });
  assert.deepEqual(visits.parseSeen({}), { needs: {}, busy: {}, done: {} });
  // Refused whole: not an object, a band that is not one, a key or value
  // that is not short and plain, a value that is not a string.
  for (const bad of [
    null, 'needs', [], { needs: [] }, { later: {} }, { needs: { 'a b': '' } },
    { busy: { 'thread:1': 'next building' } }, { busy: { 'thread:1': 3 } },
    { needs: { [`thread:${'9'.repeat(200)}`]: '' } }, { busy: { 'thread:1': 'x'.repeat(61) } },
  ]) {
    assert.equal(visits.parseSeen(bad), null, `refused: ${JSON.stringify(bad)?.slice(0, 60)}`);
  }
  // Bounded: the lists hold up to 500 threads a kind, so a thousand rows of
  // In progress fit; a body that says it holds more than the bound is refused.
  const busy = {};
  for (let i = 0; i < 1000; i += 1) busy[`thread:${100000 + i}`] = 'waiting:up_for_vote';
  assert.ok(visits.parseSeen({ busy }), 'a full In progress fits');
  const many = {};
  for (let i = 0; i <= visits.MAX_ENTRIES; i += 1) many[`thread:${i}`] = '';
  assert.equal(visits.parseSeen({ done: many }), null);
});

test('opening the list: keep, carry on after a reload, or measure from the visit just left', () => {
  const now = Date.parse('2026-11-24T10:00:00Z');
  const ago = (min) => new Date(now - min * 60000).toISOString();
  const seen = { needs: {}, busy: {}, done: {} };
  const gap = visits.VISIT_GAP_MS / 60000;
  // Nothing seen yet (a first visit, or one whose lists never loaded): keep.
  assert.equal(visits.openStep(null, null, now), 'keep');
  assert.equal(visits.openStep({ current_seen: null, current_at: null, current_tabs: {} }, null, now), 'keep');
  // Another tab still has the list open (heard from within the gap): keep,
  // so a phone opened beside a computer shares its last visit.
  const open = { current_seen: seen, current_at: ago(1), current_tabs: { tabAAAAAAAA: now - 60000 } };
  assert.equal(visits.openStep(open, null, now), 'keep');
  assert.equal(visits.openStep(open, 'tabBBBBBBBB', now), 'keep');
  // A tab that stopped being heard from without leaving has left once the gap is past.
  const quiet = { ...open, current_tabs: { tabAAAAAAAA: now - (gap + 1) * 60000 } };
  assert.equal(visits.openStep(quiet, null, now), 'promote');
  // The tab that left a moment ago comes back (a reload, a phone taken out
  // of a pocket): the same visit. After the gap, or any other tab: the next one.
  const left = { current_seen: seen, current_at: ago(2), current_tabs: {}, left_tab: 'tabAAAAAAAA', left_at: ago(2) };
  assert.equal(visits.openStep(left, 'tabAAAAAAAA', now), 'resume');
  assert.equal(visits.openStep(left, 'tabBBBBBBBB', now), 'promote');
  assert.equal(visits.openStep(left, null, now), 'promote');
  assert.equal(visits.openStep({ ...left, left_at: ago(gap + 1) }, 'tabAAAAAAAA', now), 'promote');
  // Tabs past the gap drop out; the newest are kept.
  assert.deepEqual(visits.liveTabs({ tabAAAAAAAA: now - 60000, tabBBBBBBBB: now - (gap + 1) * 60000, 'no good': now }, now),
    { tabAAAAAAAA: now - 60000 });
});

test('staging ?demo=1: a last visit 70 minutes ago that saw every demo row but three', () => {
  const now = Date.parse('2026-11-24T10:00:00Z');
  const work = demoWork();
  const answer = visits.demoVisit({ feed: DEMO_NEEDS_FEED, work, privateRoots: [501, 502] }, now);
  assert.equal(answer.since, '2026-11-24T08:50:00.000Z');
  assert.ok(visits.parseSeen(answer.seen), 'the demo answer is a visit the page can read');
  const { needs, busy, done } = answer.seen;
  // Arrived since: one vote of the demo feed; every other card, ask and private thread was seen.
  assert.equal('need:proposal:-103' in needs, false);
  for (const item of DEMO_NEEDS_FEED.filter((it) => it.id !== -103)) assert.ok(`need:${item.kind}:${item.id}` in needs, `${item.kind} ${item.id} seen`);
  for (const t of work.needs) assert.ok(`thread:${t.threadId}` in needs);
  for (const rootId of [501, 502, ...work.private.map((p) => p.rootId)]) assert.ok(`root:${rootId}` in needs);
  // Moved: the tag filter was being read, and is being built now.
  assert.equal(busy['thread:-9208'], 'next:reading');
  assert.equal(work.next.find((t) => t.threadId === -9208).work.stage, 'building');
  for (const t of [...work.next, ...work.waiting].filter((x) => x.threadId !== -9208)) {
    assert.equal(busy[`thread:${t.threadId}`], `${t.group}:${t.work.stage}`, `${t.title} stood where it stands`);
  }
  // Arrived in Done: the bigger cover picture went live; the rest were seen.
  assert.equal('thread:-9221' in done, false);
  for (const t of work.live.filter((x) => x.threadId !== -9221)) assert.ok(`thread:${t.threadId}` in done);
  assert.ok('root:-9104' in done, 'the private thread marked done this week was seen');

  // The routes answer it on staging's ?demo=1 and record nothing there.
  const routes = read('src/routes/ai-work.js');
  const open = routes.slice(routes.indexOf("router.post('/api/ai/visit',"), routes.indexOf("router.post('/api/ai/visit/seen',"));
  assert.match(open, /IS_STAGING && req\.query\.demo === '1'[\s\S]*aiVisits\.demoVisit\(/);
  const seenRoute = routes.slice(routes.indexOf("router.post('/api/ai/visit/seen',"));
  assert.match(seenRoute, /IS_STAGING && req\.query\.demo === '1'\) return res\.json\(\{ ok: true \}\)/);
  // Both are a browser's own writes: same-origin only, never cached.
  for (const route of [open, seenRoute.slice(0, 900)]) {
    assert.match(route, /sameOriginBrowserOnly/);
    assert.match(route, /Cache-Control', 'private, no-store'/);
  }
});
