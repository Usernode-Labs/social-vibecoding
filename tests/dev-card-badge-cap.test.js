// The badge budget (app-view.js _cardBadgesHtml + the renderers' badge
// arrays), and the rule that UNSET metadata chips no longer render.
//
// A proposal card could carry up to fourteen badges at once. The
// card-as-pointer revision caps it at BADGE_MAX, plus the 💬 count pinned
// outside the cap (it's a count-with-shortcut, not a status signal), and
// everything demoted moves to the meta line, the pill's tooltip or the
// detail view.
//
// Run with: node --test tests/dev-card-badge-cap.test.js

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

const ISSUE = (over) => ({ number: 5, title: 'Fix the thing', ...over });

// Count the badge-row children: the tinted chips plus the composite pill.
// The chips are their own full-width row (.dev-card-badges) below the head,
// so everything after the meta line is in scope.
function badgeCount(html) {
  const scope = html.slice(html.indexOf('</div>', html.indexOf('dev-card-meta')));
  const chips = (scope.match(/class="attr-chip |class="gc-vote-count |text-\[0\.65rem\]/g) || []).length;
  return chips;
}
const ATTRS = {
  priority: { top: 'high', count: 2 },
  category: { top: 'bug', count: 1 },
  assignee: { top: 'maya', count: 3 },
};

// ── The cap ─────────────────────────────────────────────────────────────

test('_cardBadgesHtml slices to BADGE_MAX and pins 💬 outside it', () => {
  const AppView = makeAppView();
  const badges = ['<i>1</i>', '<i>2</i>', '<i>3</i>', '<i>4</i>', '<i>5</i>', '<i>6</i>'];
  const html = AppView._cardBadgesHtml(badges, 7);
  assert.equal((html.match(/<i>/g) || []).length, AppView.BADGE_MAX);
  assert.match(html, /<i>1<\/i><i>2<\/i><i>3<\/i><i>4<\/i>/, 'kept in priority order');
  assert.doesNotMatch(html, /<i>5</, 'the fifth is dropped, not wrapped');
  assert.match(html, /dev-chat-badge/, '💬 rides outside the cap');
  assert.match(html, /data-count="7"/);
});

test('_cardBadgesHtml drops falsy entries before counting', () => {
  const AppView = makeAppView();
  const html = AppView._cardBadgesHtml(['', null, '<i>a</i>', undefined, '<i>b</i>'], 0);
  assert.equal((html.match(/<i>/g) || []).length, 2, 'a conditioned-away badge costs no slot');
});

test('a null chat count omits the 💬 badge entirely', () => {
  const AppView = makeAppView();
  assert.doesNotMatch(AppView._cardBadgesHtml(['<i>a</i>'], null), /dev-chat-badge/);
  assert.match(AppView._cardBadgesHtml(['<i>a</i>'], 0), /dev-chat-badge/);
});

test('the detail head opts OUT of the cap (every chip must be reachable there)', () => {
  const AppView = makeAppView();
  const badges = ['<i>1</i>', '<i>2</i>', '<i>3</i>', '<i>4</i>', '<i>5</i>'];
  const capped = AppView._cardBadgesHtml(badges, 0);
  const uncapped = AppView._cardBadgesHtml(badges, 0, { uncapped: true });
  assert.equal((capped.match(/<i>/g) || []).length, AppView.BADGE_MAX);
  assert.equal((uncapped.match(/<i>/g) || []).length, 5);
});

// ── Unset chips no longer render ────────────────────────────────────────

test('a card with NO metadata carries no grey placeholder chips', () => {
  const AppView = makeAppView();
  const issue = AppView._renderIssueRow(ISSUE());
  assert.doesNotMatch(issue, /Set priority/);
  assert.doesNotMatch(issue, /Set category/);
  assert.doesNotMatch(issue, /Unassigned/);
  const pr = AppView._renderProposalCard(PR());
  assert.doesNotMatch(pr, /Set priority/);
  assert.doesNotMatch(pr, /Set category/);
  assert.doesNotMatch(pr, /Unassigned/);
});

test('a SET value still renders its chip', () => {
  const AppView = makeAppView();
  const html = AppView._renderIssueRow(ISSUE(ATTRS));
  assert.match(html, /High/);
  assert.match(html, /Bug/);
  assert.match(html, /@maya/);
});

test('a partially-set card renders only what is set', () => {
  const AppView = makeAppView();
  const html = AppView._renderIssueRow(ISSUE({ priority: { top: 'high', count: 1 } }));
  assert.match(html, /High/);
  assert.doesNotMatch(html, /Set category/);
  assert.doesNotMatch(html, /Unassigned/);
});

test('the DETAIL head keeps all three, including unset ones', () => {
  const AppView = makeAppView();
  const head = AppView._renderIssueRow(ISSUE(), { noNav: true });
  assert.match(head, /Set priority/, 'the detail view is where metadata gets set');
  assert.match(head, /Set category/);
  assert.match(head, /Unassigned/);
});

test('_attrChipsHtml: omitUnset, asArray and the field ORDER', () => {
  const AppView = makeAppView();
  // priority → assignee → category: who owns it reads before what kind of
  // work it is, which is also the badge-priority order.
  const arr = AppView._attrChipsHtml('issue', 5, ATTRS, { asArray: true });
  assert.equal(arr.length, 3);
  assert.match(arr[0], /High/);
  assert.match(arr[1], /@maya/);
  assert.match(arr[2], /Bug/);
  assert.equal(AppView._attrChipsHtml('issue', 5, {}, { omitUnset: true, asArray: true }).length, 0);
  assert.equal(AppView._attrChipsHtml('issue', 5, {}, { asArray: true }).length, 3);
  assert.equal(typeof AppView._attrChipsHtml('issue', 5, ATTRS, {}), 'string');
});

test('the setting entry points move into ⋯, wording by set/unset', () => {
  const AppView = makeAppView();
  const unset = menuLabels(AppView, AppView._renderIssueRow(ISSUE()));
  assert.ok(unset.includes('Set priority…'));
  assert.ok(unset.includes('Set category…'));
  assert.ok(unset.includes('Assign someone…'));
  const set = menuLabels(AppView, AppView._renderIssueRow(ISSUE(ATTRS)));
  assert.ok(set.includes('Change priority…'));
  assert.ok(set.includes('Change assignee…'));
});

test('read-only viewers get no attribute rows at all', () => {
  const AppView = makeAppView({ readOnly: true });
  assert.equal(AppView._attrMenuItems('issue', 5, ATTRS).length, 0);
});

// ── The four badges that survive, in order ──────────────────────────────

test('proposal: the pill LEADS one merged status band, chips beside it', () => {
  const AppView = makeAppView();
  const html = AppView._renderProposalCard(PR({ ...ATTRS, my_vote: 'yes', check_state: 'passing' }));
  // History: the pill first led the badge row and counted against the cap,
  // then got a full-width row of its own (.dev-status-row) underneath. The
  // four-band card merges those two rows back into ONE reserved status band,
  // because two variable rows are what made card heights disagree. The pill
  // keeps its bar shape — it just flexes to whatever width the chips leave.
  assert.doesNotMatch(html, /dev-status-row/, '.dev-status-row is retired');
  assert.match(html, /dev-card-badges dev-card-status/, 'one merged band');
  assert.match(html, /dev-status-pill-block/, 'the pill keeps its bar treatment');
  assert.ok(html.indexOf('dev-status-pill-block') < html.indexOf('Bug'),
    'the pill LEADS the band now — it is the card\'s headline state');
  // The chips keep their own order within the band.
  assert.ok(html.indexOf('High') < html.indexOf('@maya'));
  assert.ok(html.indexOf('@maya') < html.indexOf('Bug'));
});

test('the detail head keeps the INLINE capsule, not a second full-width bar', () => {
  const AppView = makeAppView();
  const head = AppView._renderProposalCard(PR({ my_vote: 'yes', check_state: 'passing' }), { noNav: true });
  assert.match(head, /gc-vote-count/, 'the pill is still there');
  assert.doesNotMatch(head, /dev-status-pill-block/, 'as a capsule — that page is already full width');
  // And no reserved band either: the detail head is the one non-dense caller,
  // so its rows still collapse when they have nothing to say.
  assert.doesNotMatch(head, /dev-card-status/);
});

test('the pill is exempt from the cap, so four chips still fit beside it', () => {
  const AppView = makeAppView();
  const html = AppView._renderIssueRow({
    number: 5, title: 'x', ...ATTRS,
    in_progress: { users: ['maya'], mine: false, claims: [], target: null },
  });
  // In progress + priority + assignee + category is exactly BADGE_MAX.
  for (const chip of ['In progress · maya', 'High', '@maya', 'Bug']) {
    assert.ok(html.includes(chip), `${chip} survives the cap`);
  }
});

test('issue: the In-progress chip leads, then the three chips', () => {
  const AppView = makeAppView();
  const html = AppView._renderIssueRow(ISSUE({
    ...ATTRS, in_progress: { users: ['maya'], mine: false, claims: [], target: null },
  }));
  assert.ok(html.indexOf('In progress · maya') < html.indexOf('High'));
});

test('an over-budget proposal drops the LOWEST-priority chip, never the pill', () => {
  const AppView = makeAppView();
  // Pill + three chips = exactly four. Adding the In-progress signal (which
  // proposals don't carry) would be a fifth, so the cap is exercised via the
  // composer instead — but the pill must always survive on the card.
  const html = AppView._renderProposalCard(PR({ ...ATTRS, my_vote: 'yes', check_state: 'passing' }));
  assert.match(html, /gc-vote-count/, 'the pill is never the one dropped');
  assert.match(html, /High/);
  assert.match(html, /Bug/, 'four badges exactly fit the budget');
});

// ── What moved to the meta line ─────────────────────────────────────────

test('proposal provenance reads on the meta line, not as badges', () => {
  const AppView = makeAppView();
  const html = AppView._renderProposalCard(PR({
    source: 'imported', imported_pr_author: 'octo', external_agent: 'codex',
    pr_title_fallback: true,
  }));
  const meta = html.slice(html.indexOf('dev-card-meta'), html.indexOf('</div>', html.indexOf('dev-card-meta')) + 6);
  assert.match(meta, /imported from GitHub \(octo\)/);
  assert.match(meta, /built with Codex/);
  assert.match(meta, /auto-title pending/);
  // …and none of them as a chip.
  assert.doesNotMatch(html, /Imported PR/);
  assert.doesNotMatch(html, /Auto-title pending/);
  assert.doesNotMatch(html, /Platform maintenance/);
});

test('_proposalProvenanceWords is empty for an ordinary in-platform proposal', () => {
  const AppView = makeAppView();
  assert.equal(AppView._proposalProvenanceWords(PR()), '');
  assert.equal(AppView._proposalProvenanceWords(PR({ source: 'maintenance' })), 'platform maintenance');
});

test('the issue bounty count reads on the meta line, not as a ★ chip', () => {
  const AppView = makeAppView();
  const html = AppView._renderIssueRow(ISSUE({ bounty_count: 3, title_fallback: true }));
  assert.match(html, /dev-card-meta[\s\S]*?&#9733; 3/);
  assert.match(html, /auto-title pending/);
});
