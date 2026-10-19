'use strict';

// #5365: advisory votes in the Needs you feed.
//
// A change whose outcome the viewer's vote does not decide — a non-approver
// on an approver project, someone outside every group a rules project's
// rules name, a test account's uncounted vote — is marked on its row
// (withViewerDecides), the feed puts the rows whose vote decides first
// (decidingFirst), and the item labels it and hands the flags to the vote
// sheet's picker. The same facts /promoted marks its cards with (#4747),
// so a card and its feed row cannot disagree.
//
// The governance module is stubbed ON ITS OWN EXPORTS (not the route's
// reference to it): withViewerDecides calls what /promoted calls, so the
// stub stands in for the database, and viewerDecides itself stays real.
//
// Run with: node --test tests/needs-feed-advisory.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const root = path.join(__dirname, '..');
const overview = require('../src/routes/workshop-overview');
const governance = require('../src/services/governance');

// A raw NEEDS_FEED_SQL row, before shaping: only the fields the code under
// test reads.
const row = (over = {}) => ({
  kind: 'proposal', app_id: 1, id: 1, counts: true,
  requires_explicit_approval: false, explicit_approval_reason: null,
  ...over,
});

// A proposal item for the reel adapter, in the shape GET /api/workshop/
// needs-feed serves (shapeNeedsFeed's output).
const item = (over = {}) => ({
  kind: 'proposal', id: 42, title: 'Dark mode', summary: 'Adds a dark theme.',
  author: 'ada', number: 7, epoch: 3, at: null, yes: 1, no: 0,
  app: { slug: 'demo-app', name: 'Demo', icon_url: null, icon_emoji: null },
  ...over,
});

// ── shapeNeedsFeed: the flags ride only when set ──────────────────────

test('shapeNeedsFeed carries advisory and uncounted only when set', () => {
  const unmarked = overview.shapeNeedsFeed([row()])[0];
  assert.ok(!('advisory' in unmarked) && !('uncounted' in unmarked), 'an unmarked row carries no flag at all');
  const both = overview.shapeNeedsFeed([row({ advisory: true, uncounted: false }), row({ id: 2, uncounted: true })]);
  assert.equal(both[0].advisory, true);
  assert.ok(!('uncounted' in both[0]));
  assert.equal(both[1].uncounted, true);
  assert.ok(!('advisory' in both[1]), 'never both: the test-account line wins');
});

// ── decidingFirst: a stable partition ─────────────────────────────────

test('decidingFirst puts the rows whose vote decides first, each group in order', () => {
  const a = item({ id: 1 });
  const b = item({ id: 2, uncounted: true });
  const c = item({ id: 3 });
  const d = item({ id: 4, advisory: true });
  const gov = item({ id: 5, kind: 'governance' });
  assert.deepEqual(overview.decidingFirst([a, b, c, d, gov]).map((it) => it.id), [1, 3, 5, 2, 4],
    'deciding rows first (a group decision with them), marked rows after, order kept within each group');
  assert.deepEqual(overview.decidingFirst([b, d]).map((it) => it.id), [2, 4], 'nothing marked stays as it is');
});

// ── withViewerDecides: the marks, against the real viewerDecides ──────

// Swap the governance module's reads for fixtures, per app id.
function stubGovernance(t, byApp, { fail = null } = {}) {
  const original = {
    getGovernance: governance.getGovernance,
    getElectorate: governance.getElectorate,
    rulesFacts: governance.rulesFacts,
  };
  governance.getGovernance = async (pool, appId) => {
    if (fail) throw fail;
    return byApp[appId].gov;
  };
  governance.getElectorate = async () => ({ approverIds: byApp[Object.keys(byApp)[0]].approverIds, active: 1 });
  governance.rulesFacts = async () => byApp[Object.keys(byApp)[0]].facts;
  t.after(() => { Object.assign(governance, original); });
}

const noopPool = { query: async () => { throw new Error('the pool must not be read: stub what it calls'); } };

test('withViewerDecides marks a non-approver on an invited project, and not an approver', async (t) => {
  stubGovernance(t, { 1: { gov: { rules: null, approverPolicy: 'invited' }, approverIds: [1, 2] } });
  const read = async (userId, id, kind = 'proposal') => {
    const rows = [row({ id, kind })];
    await overview.withViewerDecides(noopPool, rows, userId);
    return rows[0];
  };
  const nonApprover = await read(5, 1);
  assert.equal(nonApprover.advisory, true, 'not on the approver roster: advisory');
  assert.equal(nonApprover.uncounted, false);
  const approver = await read(1, 2);
  assert.equal(approver.advisory, false, 'an approver decides, so unmarked');
  assert.equal(approver.uncounted, false);
  const decision = await read(5, 3, 'governance');
  assert.ok(!('advisory' in decision) && !('uncounted' in decision), 'a group decision is never marked');
});

test('withViewerDecides marks a viewer outside every group a rules project names', async (t) => {
  stubGovernance(t, {
    1: {
      gov: { rules: { rules: [{ group: 'admins', kind: 'majority' }], groups: [] }, approverPolicy: 'anyone' },
      approverIds: null,
      facts: { creatorId: 1, adminIds: [2], memberCount: 5, groups: new Map() },
    },
  });
  const rows = [row({ id: 1 })];
  await overview.withViewerDecides(noopPool, rows, 5);
  assert.equal(rows[0].advisory, true, 'outside the rules: advisory');
});

test('withViewerDecides marks counts=false as uncounted, never as advisory', async (t) => {
  stubGovernance(t, { 1: { gov: { rules: null, approverPolicy: 'invited' }, approverIds: [2, 3] } });
  const rows = [row({ counts: false })];
  await overview.withViewerDecides(noopPool, rows, 1);
  assert.equal(rows[0].uncounted, true, 'a test account’s vote: recorded but not counted');
  assert.equal(rows[0].advisory, false);
});

test('withViewerDecides leaves the rows unmarked when the governance read fails', async (t) => {
  stubGovernance(t, { 1: {} }, { fail: new Error('read failed') });
  const rows = [row({ id: 1 })];
  await overview.withViewerDecides(noopPool, rows, 1);
  assert.ok(!('advisory' in rows[0]) && !('uncounted' in rows[0]), 'so a deciding vote is never hidden at the back');
});

// ── The demo feed: the advisory card for ?demo=1 ──────────────────────

test('the demo feed’s shopping-list card is the advisory one', () => {
  const demo = overview.DEMO_NEEDS_FEED.find((it) => it.id === -104);
  assert.equal(demo.advisory, true);
  assert.ok(!overview.DEMO_NEEDS_FEED.some((it) => it.id !== -104 && it.advisory), 'and it is the only one');
  // The route orders the demo overlay too: the deciding cards first.
  const ordered = overview.decidingFirst(overview.withDemoNeedsFeed([])).map((it) => it.id);
  assert.deepEqual(ordered, [-103, -105, -106, -104], 'the advisory card last, behind the approval card');
});

// ── The reel and the sheet: the flags reach the card and the picker ───

const { reelRows } = loadTsx('frontend/src/features/workshop/needs-reel.tsx');
const { NeedsVoteForm } = loadTsx('frontend/src/features/dev-board/workshop/workshop.tsx');
const WORKSHOP = fs.readFileSync(path.join(root, 'frontend/src/features/dev-board/workshop/workshop.tsx'), 'utf8');

const noop = () => {};
const sheetForm = (over = {}) => {
  const [reelRow] = reelRows([item(over)]);
  return renderToHtml(createElement(NeedsVoteForm, {
    row: reelRow, side: 'yes', line: '',
    onSide: noop, onLine: noop, onBoxKey: noop, onCancel: noop, onSend: noop,
  }));
};

test('the reel carries the flags onto the row’s Yes, and the sheet’s picker shows the line', () => {
  const [plain] = reelRows([item()]);
  assert.ok(!(plain.yes.advisory || plain.yes.uncounted), 'an unmarked item’s Yes is bare');
  const html = sheetForm({ advisory: true });
  assert.match(html, /data-vote-uncounted="">Your vote is advisory: it’s recorded, but it doesn’t decide this change\./,
    'the same line the change’s own card shows');
  assert.doesNotMatch(html, /Test account/);
  const uncounted = sheetForm({ uncounted: true });
  assert.match(uncounted, /Test account: this vote won’t count\./, 'the test-account line wins on the sheet, as on the card');
});

test('the item’s eyebrow reads the new catalog entry for a marked row', () => {
  assert.equal(message('project:needsYou.eyebrow.changeAdvisory'), 'Change · Your vote is advisory');
  assert.match(WORKSHOP, /needsYou\.eyebrow\.changeAdvisory/, 'FeedItem names the id where the eyebrow is drawn');
  assert.match(WORKSHOP, /row\.yes && \(row\.yes\.advisory \|\| row\.yes\.uncounted\)/, 'on a change row whose Yes carries a flag');
});
