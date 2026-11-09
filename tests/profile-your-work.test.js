'use strict';

// Profile's "Your work" (UI overhaul): Your changes, Your requests and Your
// votes, three rows on Me. 5 Nov 2026: they open the Homeroom bot tab's
// History on that kind (frontend/src/features/ai/history.ts); the screen they
// opened (`#profile-proposals-screen`) is gone.
//
//   - the server's numbers and rows (src/routes/profile.js: the summary's
//     in-progress count and GET /api/me/requests; the SQL itself runs in
//     tests/me-requests-postgres.test.js), which Profile's rows still say;
//   - the old addresses, which land on History.
//
// Run with: node --test tests/profile-your-work.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const STORE = 'frontend/src/features/profile/profile-store.js';
const SCREEN = 'frontend/src/features/profile/my-proposals.tsx';
const NOW = Date.parse('2026-09-23T12:00:00Z');

// ── The server ─────────────────────────────────────────────────────────

test('the summary counts what is in progress: in an agent session or up for a vote', () => {
  const profile = require('../src/routes/profile');
  assert.equal(profile.shapeSummary({ counts: { merged: 9, in_progress: 2 } }).inProgress, 2);
  const sql = read('src/routes/profile.js');
  // A merged change still going live (live_at null) is in progress too.
  assert.match(sql, /COUNT\(\*\) FILTER \(WHERE cs\.status IN \(\s*'active', 'paused', 'promoted', 'merging'\s*\) OR \(cs\.status = 'merged' AND cs\.live_at IS NULL\)\)::int AS in_progress,/);
});

test('your requests: each says where it stands, and the counts are the whole set\'s', () => {
  const profile = require('../src/routes/profile');
  const row = (number, over) => ({
    number, title: `Request ${number}`, created_at: '2026-09-20T10:00:00Z',
    app_slug: 'run-club', app_name: 'Run Club', self_hosted: false,
    shipped: false, closed: false, underway: false, total: 9, done: 3, ...over,
  });
  const body = profile.shapeRequests([
    row(1),
    row(2, { underway: true }),
    row(3, { shipped: true, underway: true }),
    row(4, { closed: true }),
    row(5, { app_slug: 'usernode-2d5619', app_name: 'usernode', self_hosted: true }),
  ]);
  assert.deepEqual(body.requests.map((r) => [r.number, r.state, r.appName]), [
    [1, 'waiting', 'Run Club'],
    [2, 'underway', 'Run Club'],
    [3, 'shipped', 'Run Club'],
    [4, 'closed', 'Run Club'],
    [5, 'waiting', 'Homeroom'],
  ], 'shipped wins over under way; the platform\'s own are Homeroom\'s');
  assert.equal(body.open, 6);
  assert.equal(body.done, 3);
  assert.equal(body.truncated, true, 'nine in all, five shown');
  assert.deepEqual(profile.shapeRequests([]), { requests: [], open: 0, done: 0 });
  // Staging's demo fills an empty list only, with one of each standing.
  const demo = profile.withDemoRequests({ requests: [], open: 0, done: 0 }, { slug: 'usernode-2d5619' }, NOW);
  assert.deepEqual(demo.requests.map((r) => r.state), ['waiting', 'underway', 'shipped']);
  assert.equal(demo.open, 2);
  const real = { requests: [{ number: 7 }], open: 1, done: 0 };
  assert.equal(profile.withDemoRequests(real, { slug: 'x' }), real, 'real rows win');
  // Me-scoped, and registered behind the signed-in gate.
  assert.match(read('src/routes/profile.js'), /router\.get\('\/api\/me\/requests', requireUser,/);
});

test('your votes can link a group decision to its page', () => {
  const kudos = read('src/routes/kudos.js');
  assert.match(kudos, /i\.github_issue_number AS issue_number, i\.title AS issue_title, i\.kind AS issue_kind, i\.id AS issue_id,/);
  assert.equal((kudos.match(/NULL::int AS issue_id,/g) || []).length, 3, 'every other arm lines up with a NULL');
  assert.match(kudos, /item\.issue = \{ id: r\.issue_id, number: r\.issue_number, title: r\.issue_title, kind: r\.issue_kind \};/);
});

// ── Where Your work goes now ──────────────────────────────────────────

test('5 Nov 2026: Your work\'s old addresses land on the Homeroom bot tab\'s History, on their kind', () => {
  // The screen is gone: History (frontend/src/features/ai/history.ts) lists
  // the same work, and what Homeroom bot built from your requests. Its three
  // addresses, which no username can have, still mean what they said.
  const app = read('public/js/app.js');
  assert.match(app, /PROFILE_WORK: \{\s*proposals: 'change',\s*'your-changes': 'change',\s*'your-requests': 'request',\s*'your-votes': 'vote',\s*\},/);
  assert.match(app, /if \(parts\[0\] === 'profile' && App\.PROFILE_WORK\[parts\[1\]\]\) \{[\s\S]{0,1200}?history\.replaceState\(null, '', App\._rootUrl\(App\.profileWorkAddress\(parts\[1\]\)\)\);[\s\S]{0,80}?App\.restoreFromHash\(\);/);
  assert.match(app, /return kind \? `#homeroom-bot\/history\?kind=\$\{kind\}` : '#homeroom-bot\/history';/);
  assert.doesNotMatch(app, /navigateToProfileProposals|_inProfileProposals|profile-proposals-screen/, 'and nothing of the screen is left');
  assert.ok(!fs.existsSync(path.join(ROOT, SCREEN)), 'its component is gone');
  // Profile's rows open it, each on its kind.
  const panel = read('frontend/src/features/profile/account-panel.tsx');
  for (const kind of ['change', 'request', 'vote']) assert.match(panel, new RegExp(`href="#homeroom-bot/history\\?kind=${kind}"`));
  // The dialog's "See your requests" opens the tab, where what is still
  // moving is listed above History.
  assert.match(read('frontend/src/features/dialogs/feedback-controller.js'), /const SEE_MINE_ROUTE = '#homeroom-bot';/);
  // The Monday digest of the votes decided opens History on votes.
  assert.match(read('frontend/src/features/notifications/notifications.js'), /window\.location\.hash = '#homeroom-bot\/history\?kind=vote';/);
});

