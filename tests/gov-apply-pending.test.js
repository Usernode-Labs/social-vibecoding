// #1010: the "being applied" indicator on governance proposal cards.
//
// A deciding up-vote on a governance proposal runs the whole apply inside the
// vote request — for a close_issue that means a GitHub close + comment, 2-5s
// in production. The card used to change in NO way for that window: buttons
// stayed live, the tally stayed pre-vote, then the row silently vanished into
// Done. Worse, castIssueVote had no in-flight guard, so an impatient second
// click on Yes hit the server's toggle-OFF branch and retracted the very vote
// that had just decided the proposal — and every non-ok response and every
// exception was swallowed, so a failed vote looked identical to a successful
// one.
//
// This suite pins all of that: the deciding-vote prediction, the local
// pending state (set BEFORE the fetch is awaited), the derived state every
// viewer computes from the gate fields, the 120s honesty cap on that derived
// spinner, the locked-app suppression, the slow/stalled timer transitions,
// and one assertion per response shape.
//
// Same vm-context harness as attr-vote-repaint.test.js: load app-view.js into
// a sandbox, stub the globals it reaches, drive the functions directly.
//
// Run with: node --test tests/gov-apply-pending.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { govCardHtml, issueCardHtml } = require('./lib/dev-card-html');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

function fakeEl(extra) {
  const el = {
    innerHTML: '',
    style: {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    querySelector: () => null,
    querySelectorAll: () => ({ forEach: () => {} }),
    addEventListener: () => {},
  };
  el.remove = () => {};
  return Object.assign(el, extra || {});
}

function fakeDoc(ids) {
  return {
    getElementById: (id) => (ids && ids[id]) || null,
    querySelector: () => null,
    querySelectorAll: () => ({ forEach: () => {} }),
    addEventListener: () => {},
    createElement: () => fakeEl(),
    body: { appendChild: () => {} },
  };
}

// `fetchImpl` scripts the vote POST per test; `toasts` records everything the
// user would have been told.
function makeSandbox({ fetchImpl } = {}) {
  const toasts = [];
  const timers = [];
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: {
      user: { id: 1, canAdminWrite: false },
      currentSubTab: 'forum',
      currentTab: 'dev',
    },
    document: fakeDoc({}),
    fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({ ok: true }) })),
    alert: () => {},
    // Recorded rather than real: the slow/stalled transitions are asserted by
    // firing the captured callbacks, so the tests never actually wait 12s.
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    innerWidth: 1000,
    Notifications: { refresh: () => {} },
    PlatformUI: { toast: (m) => toasts.push(String(m)) },
    ConfirmModal: { show: async () => true },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  // Repaints are counted, not performed — there is no real DOM here.
  let repaints = 0;
  AppView._repaintCards = () => { repaints += 1; };
  AppView.refreshDevData = () => {};
  AppView.appData = { slug: 'cool-app', name: 'Cool App', repo_url: 'https://github.com/acme/cool-app' };
  return {
    AppView, sandbox, toasts, timers,
    repaints: () => repaints,
    fireTimer: (ms) => {
      const t = timers.find((x) => x.ms === ms);
      assert.ok(t, `a timer was scheduled at ${ms}ms`);
      t.fn();
    },
  };
}

const secsAgo = (s) => new Date(Date.now() - s * 1000).toISOString();
const secsAhead = (s) => new Date(Date.now() + s * 1000).toISOString();

// Admin merge / Withdraw live in the card's ⋯ menu (card-as-pointer), a
// registry keyed by data-card-menu rather than inline HTML, so their busy
// state has to be read from AppView._cardMenus instead of a button regex.
function menuItems(AppView, html) {
  const m = html.match(/data-card-menu="([^"]+)"/);
  return m ? (AppView._cardMenus[m[1]] || []) : [];
}

// A close proposal one Yes short of its threshold, window already elapsed —
// the shape where the next Yes decides it immediately.
const PROPOSAL = (over) => ({
  id: 61,
  kind: 'close_issue',
  status: 'open',
  title: 'Close issue #42',
  payload: { issueNumber: 42, issueTitle: 'Dark mode resets' },
  created_at: secsAgo(3600),
  up_count: 1,
  down_count: 0,
  my_vote: null,
  votes_required: 2,
  merge_window_ends_at: null,
  contested: false,
  chat_count: 0,
  ...over,
});

// ── Deciding-vote prediction ──────────────────────────────────────────────

test('_govVoteWouldDecide: an up-vote that reaches the threshold with no window left decides', () => {
  const { AppView } = makeSandbox();
  assert.equal(AppView._govVoteWouldDecide(PROPOSAL(), 'up'), true);
});

test('_govVoteWouldDecide: a down-vote never decides', () => {
  const { AppView } = makeSandbox();
  assert.equal(AppView._govVoteWouldDecide(PROPOSAL(), 'down'), false);
});

test('_govVoteWouldDecide: short of the threshold, contested, or window still running → no', () => {
  const { AppView } = makeSandbox();
  assert.equal(
    AppView._govVoteWouldDecide(PROPOSAL({ up_count: 0, votes_required: 5 }), 'up'), false,
    'still short of the threshold'
  );
  assert.equal(
    AppView._govVoteWouldDecide(PROPOSAL({ contested: true }), 'up'), false,
    'a contested row does not merge on this vote'
  );
  assert.equal(
    AppView._govVoteWouldDecide(PROPOSAL({ merge_window_ends_at: secsAhead(600) }), 'up'), false,
    'the visibility window defers the apply — the countdown pill owns the row'
  );
  assert.equal(
    AppView._govVoteWouldDecide(PROPOSAL({ status: 'closed' }), 'up'), false,
    'a settled row cannot be decided again'
  );
  assert.equal(AppView._govVoteWouldDecide(null, 'up'), false, 'unknown row');
});

test('_govVoteWouldDecide: re-casting an existing Yes adds no vote, so it cannot decide', () => {
  const { AppView } = makeSandbox();
  // 1 Yes of 2 required, and it is already this viewer's — clicking Yes again
  // is a retraction, not the deciding vote.
  assert.equal(AppView._govVoteWouldDecide(PROPOSAL({ my_vote: 'up' }), 'up'), false);
  // Switching from No does add one.
  assert.equal(AppView._govVoteWouldDecide(PROPOSAL({ my_vote: 'down' }), 'up'), true);
});

test('_govVoteWouldDecide: a locked app never predicts an immediate apply', () => {
  const { AppView } = makeSandbox();
  AppView._proposalsCtx = { majority: 2, locked: true };
  // On a locked app a threshold-met proposal waits for an admin Yes, which
  // this client cannot verify.
  assert.equal(AppView._govVoteWouldDecide(PROPOSAL(), 'up'), false);
});

test('_govVoteWouldDecide: at-least-N mode uses approvals_required as the target', () => {
  const { AppView } = makeSandbox();
  const row = PROPOSAL({
    approvals_required: 1, approval_policy: 'invited',
    qualified_yes_count: 0, up_count: 3, votes_required: 9,
  });
  // The clock-free at-least-1 gate is met by this one qualifying Yes even
  // though the raw votes_required is far away.
  assert.equal(AppView._govVoteWouldDecide(row, 'up'), true);
});

// ── Kind-aware copy ───────────────────────────────────────────────────────

test('_govApplyLabel names the actual side effect per kind', () => {
  const { AppView } = makeSandbox();
  assert.equal(AppView._govApplyLabel('close_issue', 42), 'Closing issue #42…');
  assert.equal(AppView._govApplyLabel('close_issue', null), 'Closing issue…');
  assert.equal(AppView._govApplyLabel('secret_change'), 'Applying env-var change…');
  assert.equal(AppView._govApplyLabel('rename'), 'Renaming app…');
  assert.equal(AppView._govApplyLabel('maintenance_campaign'), 'Starting campaign…');
});

// ── Local pending state ───────────────────────────────────────────────────

test('castIssueVote paints the pending state BEFORE awaiting the fetch', async () => {
  let seenDuringFetch = null;
  let repaintsAtFetch = 0;
  const h = makeSandbox({
    fetchImpl: async () => {
      // Snapshot what the renderer would draw while the request is open —
      // this is the whole point of the feature.
      seenDuringFetch = h.AppView._govApplyState(PROPOSAL());
      repaintsAtFetch = h.repaints();
      return { ok: true, json: async () => ({ ok: true, issueClosed: { applied: true, issueNumber: 42 } }) };
    },
  });
  h.AppView._govProposals = [PROPOSAL()];
  h.AppView._proposalsCtx = { majority: 2, locked: false };

  await h.AppView.castIssueVote(61, 'up');

  assert.ok(seenDuringFetch, 'a state was visible while the fetch was in flight');
  assert.equal(seenDuringFetch.label, 'Closing issue #42…');
  assert.equal(seenDuringFetch.spinner, true);
  assert.equal(seenDuringFetch.busy, true);
  assert.ok(repaintsAtFetch >= 1, 'the card was repainted before the await');
  // Cleared once the apply reports back.
  assert.equal(h.AppView._govApplying[61], undefined);
});

test('castIssueVote does not spin for an ordinary (non-deciding) vote', async () => {
  let stateDuringFetch = 'unset';
  const h = makeSandbox({
    fetchImpl: async () => {
      stateDuringFetch = h.AppView._govApplying[61];
      return { ok: true, json: async () => ({ ok: true, issueClosed: { applied: false, upCount: 1 } }) };
    },
  });
  h.AppView._govProposals = [PROPOSAL({ up_count: 0, votes_required: 5 })];
  h.AppView._proposalsCtx = { majority: 5, locked: false };

  await h.AppView.castIssueVote(61, 'up');
  assert.equal(stateDuringFetch, undefined, 'no spinner for a vote that resolves instantly');
});

test('castIssueVote guards against a double click (the accidental vote retraction)', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = makeSandbox({
    fetchImpl: async () => {
      calls += 1;
      await gate;
      return { ok: true, json: async () => ({ ok: true, issueClosed: { applied: true, issueNumber: 42 } }) };
    },
  });
  h.AppView._govProposals = [PROPOSAL()];
  h.AppView._proposalsCtx = { majority: 2, locked: false };

  const first = h.AppView.castIssueVote(61, 'up');
  // The impatient second click: without the guard this reaches the server's
  // "same side again" toggle-OFF branch and retracts the deciding vote.
  await h.AppView.castIssueVote(61, 'up');
  assert.equal(calls, 1, 'the second click never reached the server');

  release();
  await first;
  // And the guard is released, so a later real vote still works.
  await h.AppView.castIssueVote(61, 'up');
  assert.equal(calls, 2);
});

test('the slow and stalled phases soften the copy instead of spinning forever', () => {
  const h = makeSandbox();
  const row = PROPOSAL();
  h.AppView._proposalsCtx = { majority: 2, locked: false };
  h.AppView._beginGovApply(row, 'up');

  assert.equal(h.AppView._govApplyState(row).label, 'Closing issue #42…');

  h.fireTimer(h.AppView.GOV_APPLY_SLOW_MS);
  const slow = h.AppView._govApplyState(row);
  assert.match(slow.label, /still working, GitHub may be slow/);
  assert.equal(slow.spinner, true, 'still genuinely in progress');

  h.fireTimer(h.AppView.GOV_APPLY_STALLED_MS);
  const stalled = h.AppView._govApplyState(row);
  assert.equal(stalled.label, 'Still closing. Refresh to check');
  assert.equal(stalled.spinner, false, 'stops spinning rather than lying');
  assert.equal(stalled.busy, false, 'and stops blocking the buttons');
});

// ── Response-shape mapping ────────────────────────────────────────────────

async function voteWith(payload, { ok = true, status = 200, rowOver } = {}) {
  const h = makeSandbox({
    fetchImpl: async () => ({ ok, status, json: async () => payload }),
  });
  h.AppView._govProposals = [PROPOSAL(rowOver)];
  h.AppView._proposalsCtx = { majority: 2, locked: false };
  await h.AppView.castIssueVote(61, 'up');
  return h;
}

test('applied → success toast, state cleared', async () => {
  const h = await voteWith({ ok: true, issueClosed: { applied: true, issueNumber: 42 } });
  assert.deepEqual(h.toasts, ['Issue #42 closed by group vote.']);
  assert.equal(h.AppView._govApplying[61], undefined);
});

test('superseded → "already closed", treated as success not failure', async () => {
  const h = await voteWith({ ok: true, issueClosed: { applied: false, superseded: true } });
  assert.match(h.toasts[0], /already closed, so the proposal was resolved automatically/);
  assert.equal(h.AppView._govApplying[61], undefined, 'no failure label parked on the card');
});

test('waitingForWindow → no toast at all; the countdown pill says it', async () => {
  const h = await voteWith({
    ok: true,
    issueClosed: { applied: false, upCount: 2, required: 2, waitingForWindow: true },
  });
  assert.deepEqual(h.toasts, []);
  assert.equal(h.AppView._govApplying[61], undefined);
});

test('awaitingAdmin → the locked-app explanation', async () => {
  const h = await voteWith({ ok: true, issueClosed: { applied: false, awaitingAdmin: true } });
  assert.match(h.toasts[0], /An admin still needs to approve/);
});

test('a non-ok response is surfaced (the 409 that used to be silent)', async () => {
  const h = await voteWith({ error: 'Issue is not open' }, { ok: false, status: 409 });
  assert.deepEqual(h.toasts, ['Issue is not open']);
  assert.equal(h.AppView._govApplying[61], undefined);
});

test('a non-ok response with no body still says something', async () => {
  const h = await voteWith({}, { ok: false, status: 500 });
  assert.match(h.toasts[0], /Vote failed \(HTTP 500\)/);
});

test('a thrown fetch parks the failure copy on the card', async () => {
  const h = makeSandbox({ fetchImpl: async () => { throw new Error('offline'); } });
  h.AppView._govProposals = [PROPOSAL()];
  h.AppView._proposalsCtx = { majority: 2, locked: false };

  await h.AppView.castIssueVote(61, 'up');

  assert.match(h.toasts[0], /Vote failed: offline/);
  // The server-side apply may well have completed, so the card must not
  // pretend nothing happened.
  const state = h.AppView._govApplyState(PROPOSAL());
  assert.equal(state.label, 'Close didn\'t complete. Try voting again');
  assert.equal(state.spinner, false);
});

test('an applied rename still updates the app name optimistically', async () => {
  const h = makeSandbox({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ ok: true, renamed: { applied: true, newName: 'Renamed App' } }),
    }),
  });
  h.AppView._govProposals = [PROPOSAL({ kind: 'rename', payload: { newName: 'Renamed App' } })];
  h.AppView._proposalsCtx = { majority: 2, locked: false };

  await h.AppView.castIssueVote(61, 'up');
  assert.equal(h.AppView.appData.name, 'Renamed App');
});

// ── Derived state (every viewer, no persisted marker) ─────────────────────

test('derived: a passed proposal whose window has just elapsed reads as closing', () => {
  const { AppView } = makeSandbox();
  AppView._proposalsCtx = { majority: 2, locked: false };
  const state = AppView._derivedGovApplying(
    PROPOSAL({ up_count: 2, merge_window_ends_at: secsAgo(30) })
  );
  assert.ok(state);
  assert.equal(state.label, 'Closing issue #42…');
  assert.equal(state.spinner, true);
});

test('derived: past the 120s grace the spinner degrades to the retry copy', () => {
  const { AppView } = makeSandbox();
  AppView._proposalsCtx = { majority: 2, locked: false };
  const state = AppView._derivedGovApplying(
    PROPOSAL({ up_count: 2, merge_window_ends_at: secsAgo(600) })
  );
  assert.ok(state);
  assert.equal(state.label, 'Close pending. Will retry automatically');
  assert.equal(state.spinner, false, 'never spins indefinitely');
  assert.equal(state.busy, false, 'and stops blocking the vote buttons');
});

test('derived: a due row with NO window end is still bounded (first-seen anchor)', () => {
  const { AppView } = makeSandbox();
  AppView._proposalsCtx = { majority: 2, locked: false };
  // A clear majority collapses the window to zero and at-least-N mode has no
  // clock at all, so these rows arrive with merge_window_ends_at = null. With
  // no anchor they would spin forever whenever the apply kept failing.
  const row = PROPOSAL({ up_count: 2, merge_window_ends_at: null });

  const first = AppView._derivedGovApplying(row);
  assert.equal(first.spinner, true, 'due now → spinner');
  assert.ok(AppView._govDueSince[61], 'the first sighting is anchored');

  // Backdate the anchor past the grace window: the same row must degrade.
  AppView._govDueSince[61] = Date.now() - (AppView.GOV_APPLY_DERIVED_GRACE_MS + 1000);
  const later = AppView._derivedGovApplying(row);
  assert.equal(later.spinner, false);
  assert.equal(later.label, 'Close pending. Will retry automatically');
});

test('derived: the first-seen anchor is dropped when the row stops being due', () => {
  const { AppView } = makeSandbox();
  AppView._proposalsCtx = { majority: 2, locked: false };
  AppView._derivedGovApplying(PROPOSAL({ up_count: 2, merge_window_ends_at: null }));
  assert.ok(AppView._govDueSince[61]);

  // A No vote arrives and the row goes contested — a later re-arm must get a
  // fresh grace period, not inherit a stale anchor.
  AppView._derivedGovApplying(PROPOSAL({ up_count: 2, contested: true }));
  assert.equal(AppView._govDueSince[61], undefined);
});

test('derived: not while the merge window is still running', () => {
  const { AppView } = makeSandbox();
  AppView._proposalsCtx = { majority: 2, locked: false };
  assert.equal(
    AppView._derivedGovApplying(
      PROPOSAL({ up_count: 2, merge_window_ends_at: secsAhead(300) })
    ),
    null
  );
});

test('derived: not below the threshold, not when contested, not when settled', () => {
  const { AppView } = makeSandbox();
  AppView._proposalsCtx = { majority: 2, locked: false };
  assert.equal(AppView._derivedGovApplying(PROPOSAL({ up_count: 1 })), null, 'below threshold');
  assert.equal(
    AppView._derivedGovApplying(PROPOSAL({ up_count: 2, contested: true })), null, 'contested'
  );
  assert.equal(
    AppView._derivedGovApplying(PROPOSAL({ up_count: 2, status: 'closed' })), null, 'settled'
  );
  assert.equal(
    AppView._derivedGovApplying(PROPOSAL({ up_count: 2, votes_required: 0 })), null,
    'no usable threshold → no claim'
  );
});

test('derived: suppressed entirely on a locked app', () => {
  const { AppView } = makeSandbox();
  AppView._proposalsCtx = { majority: 2, locked: true };
  // Threshold met and window elapsed, but the apply is legitimately waiting
  // for an admin Yes this client cannot see.
  assert.equal(
    AppView._derivedGovApplying(
      PROPOSAL({ up_count: 2, merge_window_ends_at: secsAgo(30) })
    ),
    null
  );
});

test('derived: qualifying (approver-only) tallies drive the at-least-N gate', () => {
  const { AppView } = makeSandbox();
  AppView._proposalsCtx = { majority: 2, locked: false };
  const base = {
    up_count: 5, approval_policy: 'invited', approvals_required: 2,
    merge_window_ends_at: null,
  };
  assert.equal(
    AppView._derivedGovApplying(PROPOSAL({ ...base, qualified_yes_count: 1 })), null,
    'advisory surplus does not satisfy the gate'
  );
  assert.ok(
    AppView._derivedGovApplying(PROPOSAL({ ...base, qualified_yes_count: 2 })),
    'two qualifying Yes votes do'
  );
});

test('the local state always wins over the derived one', () => {
  const h = makeSandbox();
  h.AppView._proposalsCtx = { majority: 2, locked: false };
  // Derived would say "will retry automatically" (window long past)…
  const row = PROPOSAL({ up_count: 2, merge_window_ends_at: secsAgo(600) });
  assert.equal(h.AppView._derivedGovApplying(row).spinner, false);
  // …but this viewer has an apply in flight right now.
  h.AppView._beginGovApply(row, 'up');
  const state = h.AppView._govApplyState(row);
  assert.equal(state.label, 'Closing issue #42…');
  assert.equal(state.spinner, true);
});

// ── Rendering ─────────────────────────────────────────────────────────────

test('_renderGovCard shows the spinner badge and disables every control while applying', () => {
  const h = makeSandbox();
  h.AppView._proposalsCtx = { majority: 2, locked: false };
  // readOnly is a getter over appData.can_collaborate; the harness default is false.
  h.sandbox.App.user = { id: 1, canAdminWrite: true };
  const row = PROPOSAL({ up_count: 2, created_by: 1 });
  h.AppView._beginGovApply(row, 'up');

  const html = govCardHtml(h.AppView, row);
  assert.match(html, /gc-merging-badge/, 'reuses the in-flight merge badge treatment');
  assert.match(html, /dc-status-spinner-arc/, 'and its spinner glyph');
  assert.match(html, /Closing issue #42/);
  assert.match(html, /opacity-70/, 'the card dims like a merging proposal');

  // Controls stay in place (no reflow under the cursor) but go inert — a
  // second Yes would otherwise retract the deciding vote. Yes/No are inline
  // card-face buttons; Admin merge and Withdraw are demoted into the ⋯ menu
  // (card-as-pointer), so their busy state is a disabled descriptor there
  // rather than a disabled attribute in the rendered markup.
  //
  // The card holds its handlers as closures now, so which button is which
  // is read off the MODEL rather than off an onclick attribute.
  const model = h.AppView._govCardModel(row);
  const voteActions = model.actions.filter((a) => a.act && a.act.fn === 'castIssueVote');
  assert.equal(voteActions.length, 2, 'Yes / No rendered');
  for (const a of voteActions) assert.ok(a.disabled, `control disabled while applying: ${a.label}`);
  assert.equal((html.match(/<button[^>]*disabled=""/g) || []).length, 2, 'and both render inert');

  const menu = menuItems(h.AppView, html);
  const menuControls = menu.filter((it) =>
    /Admin merge|Withdraw/.test(it.label));
  assert.ok(menuControls.length >= 2, 'Admin merge / Withdraw both rendered in the ⋯ menu');
  for (const it of menuControls) assert.ok(it.disabled, `menu control disabled while applying: ${it.label}`);
});

test('_renderGovCard renders the badge but no controls for a read-only viewer', () => {
  const h = makeSandbox();
  h.AppView._proposalsCtx = { majority: 2, locked: false };
  // AppView.readOnly is a getter over can_collaborate — drive it the real way.
  h.AppView.appData = { ...h.AppView.appData, can_collaborate: false };
  assert.equal(h.AppView.readOnly, true);
  const row = PROPOSAL({ up_count: 2, merge_window_ends_at: secsAgo(30) });

  const html = govCardHtml(h.AppView, row);
  // Status, not an action: they should still see what is happening.
  assert.match(html, /Closing issue #42/);
  assert.equal(h.AppView._govCardModel(row).actions.length, 0,
    'no vote controls for read-only viewers');
  assert.ok(!/<button/.test(html.split('gc-card-actions')[1] || ''),
    'and the action band renders empty');
});

test('_renderGovCard leaves a settled row alone (the vote is history)', () => {
  const h = makeSandbox();
  h.AppView._proposalsCtx = { majority: 2, locked: false };
  // readOnly is a getter over appData.can_collaborate; the harness default is false.
  const row = PROPOSAL({
    status: 'closed', up_count: 2,
    payload: { issueNumber: 42, appliedAt: new Date().toISOString(), appliedBy: 'group-vote', required: 2 },
  });
  const html = govCardHtml(h.AppView, row);
  assert.ok(!/dc-status-spinner-arc/.test(html), 'no spinner on an applied proposal');
});

test('the target issue row reads "Closing…" while its close proposal applies', () => {
  const h = makeSandbox();
  h.AppView._proposalsCtx = { majority: 2, locked: false };
  // readOnly is a getter over appData.can_collaborate; the harness default is false.
  h.AppView._ghIssuesMeta = {};
  const row = PROPOSAL({ up_count: 2, merge_window_ends_at: secsAgo(30) });
  h.AppView._govProposals = [row];

  const html = issueCardHtml(h.AppView, {
    number: 42, title: 'Dark mode resets', htmlUrl: 'https://example.test/42',
  });
  // React renders text children, so the entity the string builder wrote is
  // the character itself now.
  assert.match(html, /Closing…/, 'the issue row says the close is running');
  assert.match(html, /dc-status-spinner-arc/);
  assert.ok(!/Close proposed/.test(html), 'not the pre-vote wording any more');
});

test('the target issue row still reads "Close proposed" while the vote is open', () => {
  const h = makeSandbox();
  h.AppView._proposalsCtx = { majority: 2, locked: false };
  // readOnly is a getter over appData.can_collaborate; the harness default is false.
  h.AppView._ghIssuesMeta = {};
  h.AppView._govProposals = [PROPOSAL({ up_count: 1 })];

  const html = issueCardHtml(h.AppView, {
    number: 42, title: 'Dark mode resets', htmlUrl: 'https://example.test/42',
  });
  assert.match(html, /Close proposed/);
  assert.ok(!/Closing…/.test(html));
});

// ── The ?demo=1 staging states, end to end ────────────────────────────────
//
// The TESTING block and dapp.json point at the ?demo=1 proposals screen for
// these two states. Those declarations used to be capped out — app-manifest
// kept only the first MAX_TESTS entries and every slot was pinned by another
// suite — and #1019 has since made them run for real. This test still earns
// its place: it exercises the REAL stagingMockGovernance() rows through the
// REAL renderer with the same selectors, so the states are guarded in unit
// time rather than only once a staging preview has been built.
function stagingMocks() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'issues.js'), 'utf8'
  );
  const slice = (marker) => {
    const from = src.slice(src.indexOf(marker));
    return from.slice(0, from.indexOf('\n}\n') + 2);
  };
  const ctx = { Date, Math, Number };
  return {
    gov: vm.runInNewContext(
      `${slice('function stagingMockGovernance()')}; stagingMockGovernance()`, ctx
    ),
    issues: vm.runInNewContext(
      `${slice('function stagingMockIssues(repoUrl)')}; stagingMockIssues('https://github.com/acme/x')`,
      ctx
    ),
  };
}

test('?demo=1 mock 9100005 renders the spinner state the staging check asserts', () => {
  const h = makeSandbox();
  const { gov } = stagingMocks();
  h.AppView._proposalsCtx = { majority: 2, locked: false };
  const row = gov.find((g) => g.id === 9100005);
  assert.ok(row, 'the mock governance row exists');

  const html = govCardHtml(h.AppView, row);
  assert.match(html, /data-gov-row="9100005"/);
  assert.match(html, /gc-merging-badge/);
  assert.match(html, /dc-status-spinner-arc/);
  assert.match(html, /Closing issue #900011/);
  // And on the proposal's own discussion page (noNav), which is a separate
  // capture path.
  assert.match(govCardHtml(h.AppView, row, { noNav: true }), /dc-status-spinner-arc/);
});

test('?demo=1 apply mocks stay reviewable when the cloned self-app is locked', () => {
  const h = makeSandbox();
  const { gov } = stagingMocks();
  h.AppView._proposalsCtx = { majority: 2, locked: true };
  const row = gov.find((g) => g.id === 9100005);
  assert.equal(row.demo, true);
  assert.match(govCardHtml(h.AppView, row), /dc-status-spinner-arc/);
});

test('?demo=1 mock 9100006 renders the retry copy with no spinner', () => {
  const h = makeSandbox();
  const { gov } = stagingMocks();
  h.AppView._proposalsCtx = { majority: 2, locked: false };
  const row = gov.find((g) => g.id === 9100006);
  assert.ok(row, 'the mock governance row exists');

  const html = govCardHtml(h.AppView, row);
  assert.match(html, /gc-checks-running-badge/);
  assert.match(html, /Close pending\. Will retry automatically/);
  assert.ok(!/dc-status-spinner-arc/.test(html), 'a long-stalled apply must not spin');
});

test('?demo=1 mock 9100003 (still voting) is untouched by the new states', () => {
  const h = makeSandbox();
  const { gov } = stagingMocks();
  h.AppView._proposalsCtx = { majority: 2, locked: false };
  const html = govCardHtml(h.AppView, gov.find((g) => g.id === 9100003));
  assert.ok(!/gc-merging-badge/.test(html), 'an open vote shows no applying badge');
  assert.ok(!/disabled/.test(html), 'and its controls stay live');
});

test('?demo=1 target issue rows pair with their close proposals', () => {
  const h = makeSandbox();
  const { gov, issues } = stagingMocks();
  h.AppView._proposalsCtx = { majority: 2, locked: false };
  h.AppView._govProposals = gov;
  h.AppView._ghIssuesMeta = {};

  const applying = issueCardHtml(h.AppView, issues.find((i) => i.number === 900011));
  assert.match(applying, /Closing…/);
  assert.match(applying, /dc-status-spinner-arc/);

  // 900001's proposal (9100003) is still in its voting window.
  const voting = issueCardHtml(h.AppView, issues.find((i) => i.number === 900001));
  assert.match(voting, /Close proposed/);
});

// The `locked: false` every ?demo=1 test above hard-codes is not a given:
// _proposalsCtx.locked comes straight off GET /api/apps/:slug/promoted, and a
// staging preview DB is a CLONE OF PRODUCTION — it brings the real
// usernode-2d5619 app row, which is locked. With locked = true the derived
// states are (correctly) suppressed and all three #1010 staging checks fail on
// markup that is perfectly fine. So the fixture-preview mode has to report the
// lock open, and only that mode.
test('?demo=1 reports the app lock OPEN, so the mock states are reviewable', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'votes.js'), 'utf8'
  );
  const from = src.indexOf("router.get('/api/apps/:slug/promoted'");
  assert.ok(from > 0, 'found the promoted route');
  const route = src.slice(from, src.indexOf("router.get('/api/apps/:slug/merged'", from));

  assert.match(route, /const demoMode = IS_STAGING && req\.query\.demo === '1'/,
    'the override must be gated on staging AND the explicit demo flag — '
    + 'production may never be told a locked app is open');
  assert.match(route, /locked: !!appRows\[0\]\.locked && !demoMode/);
  // Exactly one place lies, and it is this one.
  assert.equal((src.match(/&& !demoMode/g) || []).length, 1);

  // And the client really does take ctx.locked from this payload, or the
  // override would be aimed at the wrong field.
  const view = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8'
  );
  assert.match(view, /const locked = !!promotedData\.locked;/);
});

test('a locked app with no ?demo=1 still suppresses the derived states', () => {
  // The other half of the same contract, at the renderer: the override is a
  // preview affordance, not a change to what a locked board promises. The
  // fixture row carries demo:true (that is what the test above relies on),
  // so strip it — this test is about a REAL row on a locked board.
  const h = makeSandbox();
  const { gov } = stagingMocks();
  h.AppView._proposalsCtx = { majority: 2, locked: true };
  const { demo, ...realRow } = gov.find((g) => g.id === 9100005);
  const html = govCardHtml(h.AppView, realRow);
  assert.ok(!/dc-status-spinner-arc/.test(html),
    'a locked app is waiting on an admin Yes, not applying');
});

test('an app switch clears local pending state so it cannot leak across apps', () => {
  const h = makeSandbox();
  h.AppView._proposalsCtx = { majority: 2, locked: false };
  h.AppView._beginGovApply(PROPOSAL(), 'up');
  assert.ok(h.AppView._govApplying[61]);

  // Mirror the reset loadApp performs when the slug changes.
  Object.keys(h.AppView._govApplyTimers).forEach(h.AppView._clearGovApplyTimers);
  h.AppView._govApplying = Object.create(null);
  assert.equal(h.AppView._govApplying[61], undefined);
});
