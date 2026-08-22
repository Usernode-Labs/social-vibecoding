// The shell's element-id inventory, pinned.
//
// Every id in public/index.html is an API. public/js/** reaches for them with
// getElementById (57,799 lines of it, none of which the type checker sees),
// public/css/app.css styles some of them, and dapp.json's 315 declared tests
// select against deep chains of them — so a single lost id is a silently
// broken screen plus a blocked merge, and it is by far the most damaging way
// a markup conversion can go wrong.
//
// So: the set of ids the generated document carries must equal the set the
// hand-written one carried, exactly — minus whatever a conversion chunk has
// deliberately retired, plus whatever it has deliberately added.
//
// ── The baseline, not the fixture (#1078) ──────────────────────────────
//
// Step 1 compared against a byte copy of the pre-migration document
// (tests/fixtures/pre-migration-index.html). Step 2 converts screens on
// purpose, so whole-document comparison is the thing that has to go — but the
// id inventory outlives it. The id list now lives in
// tests/baselines/shell-markup.json, derived once from that fixture by
// scripts/derive-shell-baseline.js; the fixture itself is gone.
//
// EVERY CHUNK RECORDS ITS OWN ID CHANGES HERE, in the same commit, with a
// reason. That is the whole mechanism: the baseline stays frozen, and the two
// maps below are the reviewable log of what the migration moved.
//
// Run with: node --test tests/shell-id-inventory.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { idsOf } = require('./helpers/html-tokens');

const ROOT = path.join(__dirname, '..');

const baseline = require('./baselines/shell-markup.json');
const after = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// Ids a conversion chunk deliberately removed, each with the reason.
const RETIRED_IDS = {
  'drawer-row-app-version': 'Per-dApp SHA removed from platform information; app versions remain on app cards.',
  'app-version-pill-slot': 'Drawer-only per-dApp SHA renderer removed with its row.',
  // ── THE UI OVERHAUL: four header controls became one ──────────────
  // An app is just an app now, and everything you do *to* it lives behind
  // #improve-btn. Each id below moved to a row of that panel rather than
  // simply going away; the behaviour it named is still reachable.
  'app-mode-switch': 'App/Dev segmented switch retired — Dev is a destination the Improve panel links to, not a header mode. Both #app/<slug>/app and #app/<slug>/dev survive as routes.',
  'app-mode-seg-app': 'Segment of the retired App/Dev switch.',
  'app-mode-seg-dev': 'Segment of the retired App/Dev switch.',
  'feedback-btn': 'Header feedback bubble retired — the dialog opens from the Improve panel\'s "Give feedback" row. App.openFeedbackModal is unchanged.',
  'work-drawer-btn': 'Header work cog retired — its session list is the Improve panel\'s two session sections (this app, and an overflow for every other).',
  'work-drawer-icon': 'The cog glyph, retired with its button. The spinning-while-busy cue is the per-row busy dot in the Improve panel now.',
  'dev-console-btn': 'Header terminal icon retired — the Improve panel\'s "Developer terminal" row is shown on the same DevConsole signal. #staging-dev-console-btn survives; the staging overlay has its own chrome.',
  'dev-console-badge': 'Unseen-error count on the retired header terminal icon. #staging-dev-console-badge survives.',
  // ── #1367: two Improve rows became a segmented toggle ────────────
  // "Development kanban" and "Latest development activity" were list rows
  // with a chevron. They are two segments of the App/Feed/Kanban control now
  // (frontend/src/features/improve/view-toggle.tsx), which renders inside the
  // panel on a phone and in the header beside #improve-btn on a wide screen.
  // Improve.openDev(mode) — the handler both rows called — is unchanged, so
  // the behaviour each id named is reachable by one tap rather than two.
  'improve-row-kanban': 'Kanban row retired — the "Kanban" segment of the App/Feed/Kanban toggle. Same Improve.openDev(\'kanban\') call.',
  'improve-row-feed': 'Feed row retired — the "Feed" segment of the App/Feed/Kanban toggle. Same Improve.openDev(\'feed\') call.',
  // ── THE UI OVERHAUL: three top-right drawers became one ──────────
  // The bell and the cog merged INTO the hamburger. Nothing they carried was
  // dropped without a new home; each entry below names it.
  'notifications-btn': 'The bell. Its list is the first thing in the hamburger now, and both its badges ride that button.',
  'notifications-panel': 'The bell dropdown. features/notifications keeps its store, list components and module — only the panel around them is gone.',
  'work-drawer-panel': 'The cog drawer. Its session list is the Improve panel\'s (this app, plus an overflow for every other); its pinned rows are ordinary notifications in the merged hamburger.',
  'work-drawer-close': 'Close button of the retired cog drawer.',
  'work-drawer-mark-all': 'Mark-all-read of the retired cog drawer — the merged list has one, #notifications-mark-all.',
  'work-drawer-list': 'Body of the retired cog drawer.',
  'work-drawer-empty': 'Empty hint of the retired cog drawer.',
  // ── …and the hamburger itself lost everything that was not navigation ──
  'drawer-row-theme': 'Theme is a SETTING now, and the first one. A live control that changes how the whole product looks is not navigation. See features/settings/sections/theme.tsx — the track keeps its ids, so app.css draws it unchanged.',
  'drawer-status-pane': 'The kudos + AI-credit meters were ambient numbers nobody acts on from a menu.',
  'drawer-row-kudos': 'Kudos is a leaderboard concern; the home screen\'s Challenges area links there.',
  'kudos-budget-slot': 'Slot of the retired kudos row. Kudos.Budget still resolves it by id and no-ops when absent, so the figure can be re-homed without touching the module.',
  'drawer-row-leaderboard': 'Moved to the HOME SCREEN, into the Challenges area\'s header — beside the shared progress it links to, rather than in a menu you open from memory. #leaderboard is unchanged as a route.',
  'drawer-footer': 'The bottom-anchored reference block moved wholesale into the Improve panel: every line in it was about an app, and that panel is the surface scoped to one.',
  'drawer-row-github': 'View on GitHub — an Improve panel row now.',
  'drawer-row-share': 'Share App — an Improve panel row now.',
  // ── THE UI OVERHAUL: the home screen's widgets became four fixed areas ──
  // Discover, Challenges and Create app were draggable blocks on the launcher
  // canvas; they are sections in a fixed order under the grid now, so the
  // hosts and settings that existed for the PLACEMENT go with it.
  'home-panels': 'The widgets\' stacked FALLBACK host below the grid. It caught the moment before the first grid paint and the active-search view, because a block that lived IN #app-list vanished whenever #app-list did. The three sections are outside it and never re-rendered by a search keystroke, so there is nothing left to catch.',
  'settings-home-panels-section': 'Settings → Home screen widgets. A checkbox per widget only made sense while the blocks were optional furniture a viewer arranged; they are three fixed areas of the screen now. The ⋮ menu on a block still hides one, and POST /api/home-panels/:key/visibility is untouched.',
  'settings-home-panels-list': 'The checkbox list inside that retired section.',
  'settings-home-panels-status': 'Save/error line of that retired section.',
};

// Ids a conversion chunk deliberately added, each with the reason.
const ADDED_IDS = {
  // #1281 — the session-CLI bridge opt-in. The spec marks that venue
  // settings-gated and "most users: no", so the gate needs somewhere to
  // live: Settings → Experimental, beside the other per-user preview flag.
  'session-bridge-enabled': 'Opt-in switch for the session-CLI bridge venue (#1281).',
  'session-bridge-status': 'Save/error line for the session-bridge switch (#1281).',
  'settings-mobile-push-preferences': 'Account-level Social mobile-push category controls in Settings → Alerts.',
  'drawer-row-native-app-version': 'Installed Flutter app version in the drawer footer (#1101).',
  'native-app-version-slot': 'Mobile app version/build rendered through the native bridge (#1101).',
  'feedback-queue-dot': 'Header dot for feedback saved offline and still waiting to send (#1054).',
  'feedback-screenshot-picker-btn': 'Photos fallback for mobile feedback screenshots (#824).',
  'feedback-screenshot-input': 'PNG/JPEG picker backing the mobile feedback fallback (#824).',
  // ── THE UI OVERHAUL: the Improve panel ───────────────────────────
  // One surface for everything you do *to* the app on screen rather than
  // *with* it. It absorbed four header controls (see RETIRED_IDS above)
  // plus the drawer's GitHub / Share / version footer. Fully React-owned,
  // so unlike most of the shell it holds real state — nothing in
  // public/js/** writes a node inside it.
  'improve-btn': 'Header control that opens the Improve panel; inherits the retired App/Dev switch\'s show/hide lifecycle (App.DrawerStatus.setAppOpen).',
  'improve-overlay': 'Backdrop behind the Improve panel. Never uses `hidden` — opacity fades it and pointer-events stops a closed backdrop eating clicks.',
  'improve-panel': 'The panel root. Right-edge slide-over at `sm` and up, bottom sheet below it, and a real native-kit sheet on touch where the kit is loaded.',
  'improve-target-name': 'Which app the panel is about — the platform\'s own row on the home screen.',
  'improve-close': 'Close button in the Improve panel header.',
  'improve-body': 'The panel\'s scroller.',
  'improve-row-feedback': 'Opens the feedback dialog — the retired #feedback-btn.',
  'notifications-caught-up': 'The drawer\'s "you\'re all caught up" state — nothing unread, but there IS history behind "See older notifications". Deliberately a different node and sentence from #notifications-empty, which still means "you have never had a notification".',
  'improve-row-new-session': 'Starts a dev session — the Dev "+" menu\'s "Propose a change".',
  'improve-footer': 'Reference block: View on GitHub, Share app, version — all three moved out of the hamburger drawer.',
  'drawer-notifications': 'The notifications region at the top of the hamburger, where the bell dropdown\'s body now renders.',
  'settings-theme-section': 'The Theme settings pane\'s inner node, matching every other section\'s wrapper/inner pair.',
  // ── THE UI OVERHAUL: the home screen's four areas ────────────────
  // Your apps, Discover, Challenges, Create app — stacked, in that order.
  // The last three were draggable widgets on the launcher canvas; each is a
  // fixed <section> host now, carrying the same `data-panel-slot` key its
  // grid host did so the dapp.json checks still select on it.
  'home-apps-section': 'Wraps the launcher grid and its "Show all" control, so area 1 is a section like the other three.',
  'home-apps-more': '"Show all N apps" — revealed only when a viewer has more than the two-row default shows. The cap is on what is DRAWN, never on what they may have.',
  'home-discover-section': 'Area 2: featured tiles, the Popular lane and the way into the app directory.',
  'home-challenges-section': 'Area 3: the season\'s open challenges, and under them the leaderboard standings the retired #drawer-row-leaderboard used to point at.',
  'home-create-section': 'Area 4: the create-an-app block, on every home screen regardless of quota.',
  // #1082 chunk E — the admin console's CHASSIS. These ids are not new to the
  // running page: admin-console.js._renderShell() has always created them, by
  // writing #admin-root.innerHTML on every open. They are new to
  // public/index.html because the chassis is React-owned markup now, so it is
  // prerendered instead of assembled at mount. Nothing below them moved —
  // #admin-section-content is still an innerHTML host owned by the module.
  'admin-nav-desktop': 'Admin console desktop sidebar host, empty until AdminConsole._renderShell fills it (#1082).',
  'admin-view-only-banner': 'Admin console view-only banner (#311), ships hidden and is toggled through classList (#1082).',
  'admin-section-content': 'Admin console section host — the phone level-1 menu and every section render into it (#1082).',
  'admin-temp-pw-modal': 'Admin console temporary-password dialog root (#282), now static React markup (#1082).',
  'admin-temp-pw-username': 'Recipient name in the temporary-password dialog (#1082).',
  'admin-temp-pw-value': 'The one-time plaintext temporary password (#1082).',
  'admin-temp-pw-copy': 'Copy button in the temporary-password dialog (#1082).',
  'admin-temp-pw-close': 'Done button in the temporary-password dialog (#1082).',
  // #1085 chunk H, step 2 — the ONE new id in the chunk. #app-content keeps its
  // id, its classes and its role as a hand-written innerHTML host; the embedded
  // app's iframe moves out from under it into this React-owned sibling, because a
  // region may only become stateful when its whole subtree is React-owned and
  // #app-content is written by half of public/js/**. Ships hidden and empty, so
  // the prerendered document is unchanged in what it renders. Exactly one of the
  // two is visible; both are flex-1 + min-height:0 children of #app-view's
  // column flex, so the visible one gets the box #app-content used to have.
  'app-frame-host': "React-owned host for the embedded app's #app-iframe, a hidden empty sibling of #app-content (#1085).",
  // #1218 follow-up — the "Stop the permission prompts" block in
  // Settings → Connectors. Static markup with a copy button, the same shape
  // as #connector-url / #connector-url-copy directly above it. It exists
  // because the scaffolded .claude/settings.json fixes one repo at a time and
  // the user's personal ~/.claude/settings.json is the only thing that fixes
  // every repo at once — so the block has to be somewhere they can copy it.
  'connector-prompt-help': 'Settings → Connectors block explaining how to stop the per-call connector permission prompts (#1218).',
  'connector-allow-rules': 'The three read-only allow rules, rendered for copying into a personal ~/.claude/settings.json (#1218).',
  'connector-allow-rules-copy': 'Copy button for that block (#1218).',
  // The in-chat setup tip fired once in production and locked itself out, and
  // the panel it points at had one flaw of its own: a single block headed "add
  // this to ~/.claude/settings.json", which is the wrong file for Claude Code
  // on the WEB — that container is built fresh, so nothing from the user's
  // machine is in it and only the repo's committed copy travels. So the block
  // became three labelled cases with a second copy block for the per-repo
  // file, plus a read-only line reporting the tip's own throttle state.
  //
  // The three case ids are toggled by Settings._renderConnectorCases() and
  // render VISIBLE, so a client name it cannot classify — or a page whose
  // script has not run — shows every case rather than none.
  'connector-case-cc-local': 'Settings → Connectors case for Claude Code on the user\'s own machine (personal settings file).',
  'connector-case-cc-web': 'Settings → Connectors case for Claude Code on the web, where only the repo\'s committed file travels.',
  'connector-case-chat': 'Settings → Connectors case for Claude.ai chat and ChatGPT, which have no per-call prompts to stop.',
  'connector-repo-allow-rules': 'The same three rules, rendered for committing as a repo\'s .claude/settings.json.',
  'connector-repo-allow-rules-copy': 'Copy button for the per-repo block.',
  'connector-hint-status': 'Read-only status of the in-chat setup tip; ships empty and hidden, filled by Settings._renderConnectorHint().',
  // A permission rule names the MCP server LITERALLY — there is no
  // `mcp__*__` — so a connector registered under any name but the one the
  // shipped rules were written for matches none of them, prompts on every
  // read, and produces no error saying why. Usernode now ships both
  // spellings it can predict (`usernode` and `Usernode`); this field covers
  // everything it cannot, because the user is the only party in the exchange
  // who can see what their tools are actually called. Typing a name rewrites
  // BOTH blocks above in place, so the copy buttons already there pick up the
  // corrected rules — hence a field and no button of its own.
  'connector-name-spelling': 'Settings → Connectors input that rewrites both allow-rule blocks for a connector registered under a different server name (#1222 follow-up).',
  'messages-screen': 'Fully React-owned platform direct/group Messages screen (#488).',
  'messages-create-dialog': 'React-owned direct/group conversation creation dialog (#488).',
  'messages-members-dialog': 'React-owned group membership and invitation dialog (#488).',
  'messages-share-dialog': 'React-owned typed Usernode item chooser for Messages (#488).',
  'drawer-row-messages': 'Platform Messages destination in the global navigation drawer (#488).',
  'drawer-messages-badge': 'Aggregate unread conversation count in the global navigation drawer (#488).',
  'notifications-saved': 'Pinned "Saved" section at the top of the bell drawer, holding the messages this user bookmarked (#1280).',
  // #1344 — verified users may claim one company-funded OpenRouter key.
  // These are static settings controls; settings.js owns their state and the
  // one-time plaintext reveal lifecycle.
  'settings-openrouter-managed-card': 'Included managed OpenRouter key status and claim card (#1344).',
  'settings-openrouter-managed-message': 'Eligibility/ownership/status copy for the included key (#1344).',
  'settings-openrouter-claim': 'One-time managed child-key provisioning action (#1344).',
  'settings-openrouter-reveal': 'One-time plaintext child-key reveal container (#1344).',
  'settings-openrouter-revealed-key': 'Read-only one-time child-key value shown only after creation (#1344).',
  'settings-openrouter-copy': 'Copy action for the one-time child-key reveal (#1344).',
  'settings-openrouter-dismiss-reveal': 'Clears the one-time plaintext key from the settings DOM (#1344).',
  'settings-openrouter-personal-controls': 'Personal-BYOK controls hidden while a managed key owns the credential slot (#1344).',
};

test('the shell still carries every id in the frozen baseline', () => {
  // The baseline was taken from main's hand-written markup at the point the
  // fixture was retired. It is asserted anyway: a SILENT drop (a truncated
  // JSON write, a bad merge) would otherwise make the comparison below
  // vacuous.
  assert.equal(
    baseline.ids.length, 444,
    `tests/baselines/shell-markup.json has ${baseline.ids.length} ids, not the expected 444. The `
    + 'baseline is frozen — record deliberate changes in RETIRED_IDS / ADDED_IDS rather than '
    + 'refreshing it.',
  );

  const actual = new Set(idsOf(after));
  const missing = baseline.ids.filter((id) => !actual.has(id) && !(id in RETIRED_IDS));

  assert.deepEqual(
    [...new Set(missing)], [],
    `${new Set(missing).size} element id(s) disappeared from public/index.html. public/js/** looks `
    + 'these up by getElementById and dapp.json selects on them, so each one is a broken screen. '
    + 'If a removal is intentional, add it to RETIRED_IDS with a reason in the same commit.',
  );
});

test('the shell has not grown ids nobody declared', () => {
  const expected = new Set(baseline.ids);
  const added = [...new Set(idsOf(after))].filter((id) => !expected.has(id) && !(id in ADDED_IDS));
  assert.deepEqual(
    added, [],
    'public/index.html gained element id(s) the baseline does not have. A new id is fine, but '
    + 'declare it in ADDED_IDS with a reason so the inventory stays a deliberate list.',
  );
});

test('a retired id is really gone, and an added id is really there', () => {
  // Keeps the two maps honest: a stale entry that no longer describes the
  // markup is a hole in the inventory, not a harmless leftover.
  const actual = new Set(idsOf(after));
  for (const id of Object.keys(RETIRED_IDS)) {
    assert.ok(
      !actual.has(id),
      `#${id} is listed in RETIRED_IDS but is still in public/index.html — drop the entry.`,
    );
  }
  for (const id of Object.keys(ADDED_IDS)) {
    assert.ok(
      actual.has(id),
      `#${id} is listed in ADDED_IDS but is not in public/index.html — drop the entry.`,
    );
  }
});

// Ids that appear more than once in the hand-written shell. getElementById
// returns the first match, so a duplicate is latent breakage — but these
// predate the React chassis swap and fixing one is a behavioural change to a
// live screen, which the scaffolding steps must not make. They are pinned
// here so the count can only go DOWN, and so a chunk converting either screen
// has the problem in front of it.
//
//   wallet-status — one in the Settings screen's wallet-link row, one in the
//   anonymous login screen's wallet sign-in block. Only one is ever mounted
//   at a time in practice, which is why this has never bitten.
const KNOWN_DUPLICATE_IDS = { 'wallet-status': 2 };

test('no id is used twice beyond the duplicates that predate this migration', () => {
  const seen = new Map();
  for (const id of idsOf(after)) seen.set(id, (seen.get(id) || 0) + 1);
  const duplicates = Object.fromEntries([...seen.entries()].filter(([, n]) => n > 1));

  assert.deepEqual(
    duplicates, KNOWN_DUPLICATE_IDS,
    'the set of duplicated element ids in public/index.html changed. getElementById returns the '
    + 'first match, so a NEW duplicate silently binds handlers to the wrong element — and JSX '
    + 'makes pasting a subtree easy. If you FIXED one, delete its entry from KNOWN_DUPLICATE_IDS.',
  );
});

test('the known duplicates are the ones the baseline recorded', () => {
  // Guards the allow-list: if a duplicate turns out to have been introduced by
  // the conversion rather than inherited, it must not be excused here.
  assert.deepEqual(
    baseline.duplicateIds, KNOWN_DUPLICATE_IDS,
    'KNOWN_DUPLICATE_IDS no longer matches the duplicates the frozen baseline recorded, so one of '
    + 'them was introduced by the conversion and needs fixing rather than excusing.',
  );
});

test('the ids the dev-console and staging overlay bind are present', () => {
  // The dev-console island binds these on mount (#1079 chunk B moved the
  // module into frontend/src/features/dev-console). The staging twin in
  // particular lives deep inside #staging-overlay and is easy to lose in a
  // conversion, and its absence only shows up while previewing staging —
  // late, and far from the change that caused it.
  // #dev-console-btn and #dev-console-badge are NOT in this list any more:
  // THE UI OVERHAUL retired the header terminal icon in favour of the Improve
  // panel's "Developer terminal" row, which is driven by the same
  // DevConsole._refreshButtonVisibility signal. The staging twin is exactly
  // the one this test was written for, so it matters more than ever.
  for (const id of [
    'staging-dev-console-btn', 'dev-console-close',
    'dev-console-clear', 'dev-console-filter', 'dev-console-log',
  ]) {
    assert.ok(after.includes(`id="${id}"`), `the dev-console island binds #${id}, which is missing`);
  }
});

// ── No module may DEREFERENCE a retired id ────────────────────────────
//
// The regression guard for the worst kind of failure this whole inventory
// exists to prevent, and one THE UI OVERHAUL actually shipped for a moment.
//
// Retiring an id is only half the job: something usually still looks it up.
// `HeaderMenu.init()` kept two of them —
//
//   document.getElementById('drawer-row-github').addEventListener(…)
//   document.getElementById('drawer-row-share').addEventListener(…)
//
// — after both rows moved into the Improve panel. Each threw on null. The
// first one threw inside a React layout effect, which unmounted the whole
// shell root; the second threw out of App.init() before it had fetched the
// session. The page rendered nothing and 218 declared checks failed at once,
// none of them naming the actual cause.
//
// So: a retired id may still be MENTIONED (the comments recording where each
// one went are the point of RETIRED_IDS), and it may still be looked up
// GUARDED — `?.`, or a `const el = …; if (el)` — because a module that
// no-ops when its node is absent is exactly how a row gets re-homed without
// touching it. What it may not be is dereferenced on the spot.
test('no module dereferences a retired id without a guard', () => {
  const roots = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue; }
      if (/\.(js|ts|tsx)$/.test(entry.name)) roots.push(full);
    }
  };
  walk(path.join(ROOT, 'public/js'));
  walk(path.join(ROOT, 'frontend/src'));

  const offenders = [];
  for (const file of roots) {
    const src = fs.readFileSync(file, 'utf8');
    for (const id of Object.keys(RETIRED_IDS)) {
      // `getElementById('x').`  /  `querySelector('#x').` — a dot that is not
      // part of `?.` is an immediate dereference of a value that is null.
      const lookups = [
        new RegExp(`getElementById\\(\\s*['"]${id}['"]\\s*\\)\\s*(\\??\\.)`, 'g'),
        new RegExp(`querySelector\\(\\s*['"]#${id}['"]\\s*\\)\\s*(\\??\\.)`, 'g'),
      ];
      for (const re of lookups) {
        let m;
        while ((m = re.exec(src)) !== null) {
          if (m[1] === '?.') continue; // guarded — fine
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(`${path.relative(ROOT, file)}:${line} dereferences #${id}`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders, [],
    'a retired id is looked up and dereferenced on the spot, which throws on null. '
    + 'Inside a React effect that unmounts the shell; inside App.init() it stops the boot. '
    + 'Delete the lookup with the row it belonged to, or guard it with `?.`.',
  );
});
