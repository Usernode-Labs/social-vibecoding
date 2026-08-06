// The composite status pill (app-view.js statusPillState / statusPillHtml /
// blockReasons).
//
// A proposal card used to be able to show SEVEN separate elements all
// answering "where is this in its life": the proportional tally pill, a
// pulsing "Vote" badge, a merge-state badge, a checks badge, a console-errors
// badge, an advisory chip and an explicit-approval chip. They collapse into
// ONE pill chosen by a strict precedence, and this file is that precedence's
// contract:
//
//   0 settled → 1 in flight → 2 blocked → 3 contested → 4 counting down
//   → 5 needs your vote → 6 plain tally
//
// The load-bearing rule: a proposal whose checks FAIL must never degrade to
// reading as a neutral tally, because the pill's whole job is that a glance
// says whether the thing can land.
//
// Run with: node --test tests/dev-status-pill.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const MERGE_STATUS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'merge-status.js'), 'utf8');
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

const ME = 42;

function makeAppView(opts) {
  const o = opts || {};
  const sandbox = {
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: o.userId != null ? o.userId : ME, canAdminWrite: !!o.admin } },
    Kudos: { renderButton: () => '<button class="gc-vote-btn">kudos</button>',
      attach: () => {}, _ensureCache: () => ({ count: 0 }), give: () => {}, retract: () => {} },
    PlatformUI: { isTouch: () => !!o.touch, actionSheet: (spec) => { sandbox.__sheet = spec; },
      toast: () => {} },
    ConfirmModal: { show: async () => true },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${MERGE_STATUS_SRC}\n${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: o.majority != null ? o.majority : 3 };
  AppView._mergedCtx = { majority: 3 };
  AppView._visualsOpen = new Set();
  AppView._govProposals = [];
  AppView._ghIssuesMeta = {};
  if (o.readOnly) AppView.appData = { slug: 'x', can_collaborate: false };
  AppView.__sandbox = sandbox;
  return AppView;
}

const PR = (over) => ({
  id: 7, pr_number: 700, pr_title: 'Tidy the header', username: 'someone',
  user_id: 999, status: 'promoted', created_at: '2026-06-01T00:00:00Z',
  yes_count: 0, no_count: 0, ...over,
});

function menuKeyOf(html) {
  const m = html.match(/data-card-menu="([^"]+)"/);
  return m ? m[1] : null;
}
function menuItems(AppView, html) {
  const k = menuKeyOf(html);
  return k ? (AppView._cardMenus[k] || []) : [];
}
function menuLabels(AppView, html) {
  return menuItems(AppView, html).map((it) => it.label);
}

const hoursAhead = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

// ── Precedence, tier by tier ────────────────────────────────────────────

test('tier 0 — a merged row is settled and reads ✓ Merged', () => {
  const AppView = makeAppView();
  const s = AppView.statusPillState(PR({ status: 'merged', yes_count: 5 }));
  assert.equal(s.tier, 0);
  assert.equal(s.label, '✓ Merged');
  assert.equal(s.tone, 'ok');
});

test('tier 1 — in flight outranks everything below it', () => {
  const AppView = makeAppView();
  // Merging, even with failing checks and a conflict recorded: the merge is
  // happening, which is the highest-signal thing to say.
  const merging = AppView.statusPillState(PR({
    status: 'merging', check_state: 'failing', merge_conflict_state: 'failed',
  }));
  assert.equal(merging.tier, 1);
  assert.equal(merging.label, 'Merging…');
  assert.equal(merging.tone, 'progress');
  assert.ok(merging.spinner, 'in-flight stages carry the spinner');

  const resolving = AppView.statusPillState(PR({ resolving: true, check_state: 'failing' }));
  assert.equal(resolving.tier, 1);
  assert.equal(resolving.label, 'Resolving conflicts…');
  assert.equal(resolving.tone, 'progress');
});

test('tier 2 — checks failing is BLOCKED and never a plain tally', () => {
  const AppView = makeAppView();
  // The vote is won and there is a merge window running; the pill must still
  // say the tests are broken.
  const s = AppView.statusPillState(PR({
    check_state: 'failing',
    test_results: [
      { name: 'Home', status: 'pass' },
      { name: 'Feed', status: 'fail' },
      { name: 'Board', status: 'fail' },
    ],
    yes_count: 5, votes_required: 3, merge_window_ends_at: hoursAhead(4),
  }));
  assert.equal(s.tier, 2);
  assert.equal(s.label, 'Checks failing · 2');
  assert.equal(s.tone, 'blocked');
  assert.ok(!s.fill, 'a hard block drops the tally — the count is not the story');
});

test('tier 2 — every hard blocking state, in severity order', () => {
  const AppView = makeAppView();
  const cases = [
    [{ merge_conflict_state: 'failed' }, 'Conflict resolution failed', 'blocked'],
    [{ merge_conflict_state: 'conflict' }, 'Merge conflict', 'blocked'],
    [{ check_state: 'error' }, 'Preview won’t boot', 'blocked'],
    [{ check_state: 'failing', test_results: [] }, 'Checks failing', 'blocked'],
  ];
  for (const [row, label, tone] of cases) {
    const s = AppView.statusPillState(PR(row));
    assert.equal(s.tier, 2, label);
    assert.equal(s.label, label);
    assert.equal(s.tone, tone, label);
  }
  // A conflict outranks a checks failure: both are hard, and the conflict is
  // the one a human has to act on.
  const both = AppView.statusPillState(PR({
    merge_conflict_state: 'failed', check_state: 'failing', test_results: [],
  }));
  assert.equal(both.label, 'Conflict resolution failed');
  assert.equal(both.reasons.length, 2);
});

test('tier 2 — soft reasons read ATTENTION and keep the tally riding along', () => {
  const AppView = makeAppView();
  // Behind main resolves itself, so it does not stop the thing landing — the
  // vote is still the other half of the story.
  const behind = AppView.statusPillState(PR({ behind_main: 3, yes_count: 1, votes_required: 3 }));
  assert.equal(behind.tier, 2);
  assert.equal(behind.label, 'Behind main · 3 · 1/3');
  assert.equal(behind.tone, 'attention');
  assert.ok(behind.fill, 'the proportional fill survives a soft reason');

  const console_ = AppView.statusPillState(PR({
    console_check_state: 'errors', console_errors: [{ message: 'a' }, { message: 'b' }],
    yes_count: 2, votes_required: 3,
  }));
  assert.equal(console_.label, 'Console errors · 2 · 2/3');
  assert.equal(console_.tone, 'attention');
});

test('tier 2 — checks running / starting gate the merge, so they outrank the vote', () => {
  const AppView = makeAppView();
  const pending = AppView.statusPillState(PR({ check_state: 'pending' }));
  assert.equal(pending.label, 'Checks running…');
  assert.equal(pending.tone, 'neutral');
  assert.ok(pending.spinner);
  // #607: nothing recorded at all — the first run hasn't stamped 'pending'.
  const fresh = AppView.statusPillState(PR({}));
  assert.equal(fresh.label, 'Checks starting…');
  assert.ok(fresh.spinner);
});

test('tier 3 — contested turns the timed path off and says so', () => {
  const AppView = makeAppView();
  const s = AppView.statusPillState(PR({
    check_state: 'passing', contested: true, yes_count: 4, no_count: 3, votes_required: 6,
  }));
  assert.equal(s.tier, 3);
  assert.equal(s.label, 'Contested · 4/6');
  assert.equal(s.tone, 'attention');
  assert.ok(s.fill);
});

test('tier 4 — merge countdown, with the tally riding along below threshold', () => {
  const AppView = makeAppView();
  const reached = AppView.statusPillState(PR({
    check_state: 'passing', yes_count: 3, votes_required: 3, merge_window_ends_at: hoursAhead(48),
  }));
  assert.equal(reached.tier, 4);
  assert.match(reached.label, /^Merging in /);
  assert.equal(reached.suffix, '', 'at threshold the tally is redundant');
  assert.equal(reached.tone, 'ok');

  // Lazy consensus: below threshold but unopposed, so the count matters.
  const lazy = AppView.statusPillState(PR({
    check_state: 'passing', yes_count: 1, no_count: 0, votes_required: 2,
    merge_window_ends_at: hoursAhead(60),
  }));
  assert.equal(lazy.tier, 4);
  assert.match(lazy.label, /Merging in .* · 1\/2$/);
});

test('tier 4 — a rejection countdown reads BLOCKED', () => {
  const AppView = makeAppView();
  const s = AppView.statusPillState(PR({
    check_state: 'passing', yes_count: 0, no_count: 2, votes_required: 3,
    rejection_armed: true, reject_window_ends_at: hoursAhead(6),
  }));
  assert.equal(s.tier, 4);
  assert.match(s.label, /^Rejecting in /);
  assert.equal(s.tone, 'blocked');
  assert.ok(s.reject);
});

test('an admins-changing proposal NEVER promises a merge countdown', () => {
  const AppView = makeAppView();
  // The server sends no window for one of these; this is the belt-and-braces
  // guard so a stale cached row can't promise a merge that will never happen.
  const s = AppView.statusPillState(PR({
    check_state: 'passing', requires_explicit_approval: true,
    yes_count: 3, votes_required: 3, merge_window_ends_at: hoursAhead(4), my_vote: 'yes',
  }));
  assert.notEqual(s.tier, 4);
  assert.doesNotMatch(s.label, /Merging in/);
  assert.ok(s.lock, 'the lock modifier explains why');
});

test('tier 5 — needs your vote absorbs the pulsing "Vote" badge', () => {
  const AppView = makeAppView();
  const s = AppView.statusPillState(PR({ check_state: 'passing', yes_count: 2, votes_required: 5 }));
  assert.equal(s.tier, 5);
  assert.equal(s.label, 'Vote · 2/5');
  assert.equal(s.tone, 'progress');
  assert.ok(s.dot, 'the pulsing dot moved INSIDE the pill');
  assert.ok(s.fill);
});

test('tier 5 is skipped for a read-only viewer (they cannot vote)', () => {
  const AppView = makeAppView({ readOnly: true });
  const s = AppView.statusPillState(PR({ check_state: 'passing', yes_count: 2, votes_required: 5 }));
  assert.equal(s.tier, 6);
  assert.equal(s.label, '2 / 5');
  assert.ok(!s.dot);
});

test('tier 6 — the plain tally, and the at-least-N approvals variant', () => {
  const AppView = makeAppView();
  const voted = AppView.statusPillState(PR({
    check_state: 'passing', yes_count: 2, no_count: 0, votes_required: 5, my_vote: 'yes',
  }));
  assert.equal(voted.tier, 6);
  assert.equal(voted.label, '2 / 5');
  assert.equal(voted.tone, 'progress');

  const won = AppView.statusPillState(PR({
    status: 'merged', yes_count: 5, votes_required: 5,
  }));
  assert.equal(won.tone, 'ok');

  const approvals = AppView.statusPillState(PR({
    check_state: 'passing', approvals_required: 3, yes_count: 2,
  }));
  assert.equal(approvals.label, '2 of 3 approvals');
  assert.ok(approvals.fill, 'clock-free, but still a progress pill');
});

// ── Modifiers folded into the pill ──────────────────────────────────────

test('the advisory surplus rides inside the label, not beside the pill', () => {
  const AppView = makeAppView();
  const html = AppView.statusPillHtml(PR({
    check_state: 'passing', approval_policy: 'invited',
    yes_count: 3, qualified_yes_count: 1, votes_required: 2, my_vote: 'yes',
  }));
  assert.match(html, /gc-vote-count-suffix[^>]*>\+2</);
  assert.doesNotMatch(html, /gc-vote-advisory/, 'no separate chip any more');
});

test('explicit approval is a lock glyph inside the pill, not a chip', () => {
  const AppView = makeAppView();
  const html = AppView.statusPillHtml(PR({
    check_state: 'passing', requires_explicit_approval: true,
    yes_count: 1, votes_required: 3, my_vote: 'yes',
  }));
  assert.match(html, /gc-vote-count-lock/);
  assert.match(html, /won’t merge on a timer/, 'the tooltip carries the explanation');
  assert.doesNotMatch(html, /gc-vote-explicit/, 'no separate chip any more');
});

test('multiple reasons: the pill names the worst and counts the rest', () => {
  const AppView = makeAppView();
  const pr = PR({
    check_state: 'failing', test_results: [{ name: 'a', status: 'fail' }],
    behind_main: 2, console_check_state: 'errors', console_errors: [{ message: 'x' }],
  });
  const html = AppView.statusPillHtml(pr);
  assert.match(html, /Checks failing · 1/);
  assert.match(html, /and 2 more reasons — open for details/);
  assert.equal(AppView.blockReasons(pr).length, 3);
});

// ── Markup contract ─────────────────────────────────────────────────────

test('the proportional fill markup is preserved on the tally tiers', () => {
  const AppView = makeAppView();
  const partial = AppView.statusPillHtml(PR({
    check_state: 'passing', yes_count: 1, no_count: 1, votes_required: 4, my_vote: 'yes',
  }));
  assert.match(partial, /gc-vote-fill gc-vote-fill-yes" style="width:25%/);
  assert.match(partial, /gc-vote-fill gc-vote-fill-no" style="width:25%/);

  // A side crossing the threshold still fills the pill solid.
  const wonYes = AppView.statusPillHtml(PR({
    check_state: 'passing', yes_count: 4, votes_required: 4, my_vote: 'yes',
  }));
  assert.match(wonYes, /gc-vote-fill-full gc-vote-fill-full-yes/);
  const wonNo = AppView.statusPillHtml(PR({
    check_state: 'passing', yes_count: 0, no_count: 4, votes_required: 4, my_vote: 'no',
  }));
  assert.match(wonNo, /gc-vote-fill-full gc-vote-fill-full-no/);
});

test('a countdown carries the ticker contract the 30s timer reads', () => {
  const AppView = makeAppView();
  const html = AppView.statusPillHtml(PR({
    check_state: 'passing', yes_count: 1, no_count: 0, votes_required: 2,
    merge_window_ends_at: hoursAhead(30),
  }));
  assert.match(html, /gc-merge-countdown/);
  assert.match(html, /data-window-ends="\d+"/);
  assert.match(html, /data-label-suffix=" · 1\/2"/, 'the ticker preserves the tally suffix');
});

test('every tone maps to a declared class, and the pill is one element', () => {
  const AppView = makeAppView();
  for (const tone of AppView.STATUS_PILL_TONES) {
    assert.ok(typeof tone === 'string' && tone.length);
  }
  const html = AppView.statusPillHtml(PR({ check_state: 'passing', yes_count: 1, votes_required: 2, my_vote: 'yes' }));
  assert.equal((html.match(/class="gc-vote-count /g) || []).length, 1, 'exactly one pill');
  assert.match(html, /dev-status-pill/);
  assert.equal(AppView.statusPillHtml(null), '');
});

// ── A governance proposal has no checks ─────────────────────────────────

test('kind "gov" skips every checks/conflict state', () => {
  const AppView = makeAppView();
  // A gov row has no check_state, which the #607 branch would otherwise read
  // as "the first run hasn't stamped pending yet" and label Checks starting….
  const s = AppView.statusPillState(
    { status: 'promoted', yes_count: 0, no_count: 0, approvals_required: 1 },
    { kind: 'gov', majority: 1 }
  );
  assert.equal(s.label, '0 of 1 approval');
  assert.doesNotMatch(s.label, /Checks/);
  assert.equal(AppView.blockReasons({}).length, 0);
});

// ── blockReasons is the shared source of truth ──────────────────────────

test('blockReasons: severity order, labels, and the detail sentences', () => {
  const AppView = makeAppView();
  assert.equal(AppView.blockReasons(null).length, 0);
  assert.equal(AppView.blockReasons({ check_state: 'passing' }).length, 0);

  const r = AppView.blockReasons({
    merge_conflict_state: 'conflict',
    check_state: 'failing',
    test_results: [{ name: 'Feed renders', status: 'fail' }],
    behind_main: 4,
    console_check_state: 'errors',
    console_errors: [{ message: 'x' }],
  });
  assert.equal(r.map((x) => x.key).join(','), 'merge_conflict,checks_failing,behind,console_errors');
  assert.match(r[1].detail, /Feed renders/, 'the detail names WHICH test failed');
  assert.match(r[2].detail, /4 commits behind main/);
  assert.ok(r[2].soft && r[3].soft, 'behind main and console errors do not block');
  assert.ok(!r[0].soft && !r[1].soft, 'a conflict and a failing check do');
});
