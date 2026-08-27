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
  // ── #1443: one control names where you are ──────────────────────
  // The chip's menu lists every destination with its own page, so the header
  // stopped needing a second, third and fourth way to say the same thing.
  'back-icon-home': 'The house glyph inside #back-btn. Home is a row of the chip\'s menu, immediately reachable from every screen, so a house icon an inch to the chip\'s left was the second control answering one question. #back-btn keeps #back-icon-arrow and means one thing now — back a level — which is why its own `hidden` is the whole of the visibility state.',
  // ── Streamlined Concept: the drawer became the APP's surface ──────
  // The Figma board draws ONE app-scoped drawer (the app, its Board, its
  // Activity, "+ New change", the changes here and elsewhere, over a
  // Profile/Settings foot). The short-lived split — a platform drawer plus an
  // #app-context-sheet behind the title tab — collapsed into it. What the
  // drawer gave up in exchange: alerting, which is the two header glyphs
  // (#notifications-btn, #messages-btn), and the app list, which is the Apps
  // sheet behind the title tab.
  'app-context-sheet': 'The second surface is gone: its rows ARE the drawer now (features/app-context/app-context-rows.tsx). The element id lives on as #apps-switcher-sheet, which reuses its controller and kit bottom-sheet lifecycle.',
  'app-context-overlay': 'Backdrop of that surface — #apps-switcher-overlay now.',
  'app-context-body': 'Scroller of that surface; the drawer\'s own #header-menu-rows is the scroller now.',
  'app-context-close': 'Close control of that surface — #apps-switcher-close now.',
  'drawer-top-rows': 'The drawer\'s Notifications + Messages block. Both are header glyphs now, because platform-wide alerting has no business inside the app\'s own surface.',
  'drawer-row-notifications': 'Became #notifications-btn, the bell in the header\'s right group. Same #notifications route, same badge id.',
  'drawer-row-messages': 'Became #messages-btn, the chat bubble beside it. Same #messages route; its badge keeps the id its row used.',
  'drawer-notifications-badge': 'The notifications count rides #notifications-badge on the bell again — one badge, not two.',
  'drawer-your-apps': 'The Your-apps section. Switching apps is the Apps sheet behind the title tab (#apps-switcher-sheet), which is what the board draws.',
  'drawer-row-your-apps': 'Nav row of that section; the sheet\'s Home button is the way to the grid now.',
  'drawer-your-apps-toggle': 'Its fold, retired with the section.',
  // ── Streamlined Concept: the notification list left the drawer ───
  // The rows render on the full-screen #notifications view now
  // (notifications-sheet.tsx, its own ids in ADDED_IDS below); the saved +
  // invites sections moved WITH the surface keeping their ids, so only the
  // drawer-specific chrome is gone.
  'notifications-mark-all': 'The drawer block\'s mark-all control; the screen renders its own (#notifications-screen-mark-all), React-wired.',
  'notifications-list': 'The drawer\'s list scroller; the screen renders rows directly.',
  'notifications-empty': 'Drawer-only never-had-one hint; the screen\'s All tab empty state says it now.',
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
  // ── The version dot's round trip ──────────────────────────────────
  // #1412 renamed #header-menu-deploy-dot to #improve-version-dot and moved
  // it onto #improve-btn; the Streamlined Concept moved it straight back to
  // the hamburger under its ORIGINAL id — the board keeps the hamburger as
  // the badge cluster, and the Improve slot slims to a text action. So the
  // id matches the baseline again and neither map lists it. What #1412
  // actually added is kept: the violet "the platform rolled past the SHA
  // this tab loaded against" state, and a reader
  // (DrawerStatus.refreshDeployDot) that publishes a state through
  // improveStore instead of toggling a class — the dot renders from
  // <MenuIndicators/> in platform-header.tsx now.
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
  // (#notifications-btn's own round trip: THE UI OVERHAUL folded the bell into
  // the hamburger, and the Streamlined Concept gives it back its control in the
  // header's right group — the drawer is the APP's surface now, so platform
  // alerting needs a seat of its own. The id matches the baseline again, so it
  // is listed in neither map; what changed is only which panel it opens.)
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
  // ── Streamlined Concept: the reference footer has no successor ───
  // The block THE UI OVERHAUL carried from the drawer into the Improve panel
  // (and the Streamlined Concept then carried into the drawer again, as
  // #improve-footer) is dissolved. The board draws a drawer of navigation and
  // work only, and every line of that footer was a different KIND of thing
  // wearing the same row: two of them described the platform, two described
  // the app, and exactly one was an action. Each went where it belongs.
  // ── Streamlined Concept: the hamburger, and the rows it held ─────
  // The drawer's app rows merged into the Improve panel — one surface for
  // the app's navigation AND its work, rather than two that half-overlapped —
  // and the button that opened it went with them. The header's left slot is
  // the board's own cluster now: the app glyph (or a back arrow) beside the
  // title tab, both opening the Apps sheet.
  // ── Streamlined Concept, second pass: the two alerting screens
  //    became SHEETS. A screen reachable from every route has to answer
  //    "back to where?", and both answered "home".
  // ── The hamburger, and the drawer it opened, are gone ────────────
  // The Streamlined Concept retired the hamburger button and left the drawer
  // with no trigger — its rows were reachable only through the ?shot=menu
  // capture links, which is why ten declared checks kept passing over a
  // surface no user could open. The whole panel goes; every row it held has
  // a home on a SCREEN now, with an address and a back arrow of its own.
  'header-menu-panel': 'The drawer itself. Its account rows are the Profile screen\'s account group (features/profile/account-panel.tsx), reached from Home\'s account row.',
  'header-menu-overlay': 'Its backdrop.',
  'header-menu-rows': 'Its scroller.',
  'header-menu-close': 'Its close control.',
  'drawer-main-rows': 'The account group inside it — #profile-account now.',
  'drawer-row-profile': 'Profile is reached from Home\'s #home-account-row, which is the one entrance the drawer\'s removal would otherwise have taken away.',
  'drawer-avatar': 'The viewer\'s picture on that row — #home-account-avatar, same writer (App.applyUserAvatar), same contract.',
  'drawer-profile-glyph': 'Its fallback glyph — #home-account-glyph.',
  'drawer-row-settings': 'Settings is #switcher-row-settings, a row of the chip\'s menu (#1443) — it has its own page, and the menu lists everything that does.',
  'drawer-byok-dot': 'The BYOK dot on that row — #switcher-byok-dot. settings.js publishes the flag through the visibility store rather than writing the class by id, because the row renders inside a React-owned subtree.',
  'drawer-row-admin': 'Admin & moderation is #switcher-row-admin, same isAdmin gate, published rather than class-written for the same reason.',
  'drawer-node-dot': 'Its status dot — #account-node-dot. It also stops PRERENDERING: the row renders inside the Profile screen\'s account group, which draws from profile data, where the drawer shipped on every page.',
  'drawer-node-status': 'Its status text — #account-node-status, same note.',
  'drawer-wallet-balance': 'The wallet row\'s balance readout — #account-wallet-balance, same note.',
  'drawer-row-node': 'The native node row — #account-row-node, same component, same module.',
  'drawer-row-wallet': 'The native wallet row — #account-row-wallet, ditto.',
  'notifications-screen': 'The Notifications screen ROOT. It is #notifications-sheet now — an overlay over the current screen, out of App.SCREEN_IDS entirely, so there is no back arrow to point anywhere. Its children kept their ids.',
  'header-menu-btn': 'The hamburger. Its slot is the app-glyph/back-arrow pair (features/header/header-app-icon.tsx + #back-btn), and its badge cluster moved to #improve-btn — the control whose panel actually holds the work those badges report.',
  'header-menu-deploy-dot': 'Renamed #improve-version-dot with that move. A `header-menu-*` id on the Improve button would be a lie that outlives everyone who remembers it.',
  'drawer-app-rows': 'The app rows\' scroller in the drawer. The Improve panel renders them now, and #improve-sessions is the scroller.',
  'app-context-new-change': 'Merged INTO #improve-row-new-session, the panel\'s middle quick action. Two ids calling one Improve.startSession() was the duplication the merge exists to remove.',
  'improve-row-share': 'Share app is the Improve panel\'s third action (features/improve/improve-panel.tsx) — the one line in that footer that was an action rather than a reference. Same id, same `canShare` gate.',
  'drawer-row-app-fork': 'Fork lineage renders on the app\'s page from the detail descriptor (features/apps/browse-detail.tsx, #browse-detail-fork) — lineage is a fact about an app, not about the drawer you have open.',
  'app-fork-badge-slot': 'Slot AppView.renderForkBadge wrote into. Both the function and App.DrawerStatus.setForkVisible are gone with it.',
  // ── THE UI OVERHAUL: the home screen's widgets became four fixed areas ──
  // Discover, Challenges and Create app were draggable blocks on the launcher
  // canvas; they are sections in a fixed order under the grid now, so the
  // hosts and settings that existed for the PLACEMENT go with it.
  'home-panels': 'The widgets\' stacked FALLBACK host below the grid. It caught the moment before the first grid paint and the active-search view, because a block that lived IN #app-list vanished whenever #app-list did. The three sections are outside it and never re-rendered by a search keystroke, so there is nothing left to catch.',
  'settings-home-panels-section': 'Settings → Home screen widgets. A checkbox per widget only made sense while the blocks were optional furniture a viewer arranged; they are three fixed areas of the screen now. The ⋮ menu on a block still hides one, and POST /api/home-panels/:key/visibility is untouched.',
  'settings-home-panels-list': 'The checkbox list inside that retired section.',
  'settings-home-panels-status': 'Save/error line of that retired section.',
  // ── Andrea's simpler waitlist flow: joining is email-only ─────────
  // "Link something you've made" was a REQUIRED stage-1 field, which
  // contradicted the flow the onboarding doc settled on and that Andrea
  // and Evan agreed in its comments ("Just an email!"). The question is
  // not gone — it moved to the stage-2 "Want in sooner?" form as
  // #more-made-url / #more-made-note, where it is one of the things that
  // helps you move up rather than a gate on joining.
  'waitlist-made-url': 'Moved to the stage-2 survey as #more-made-url; joining no longer asks it.',
  'waitlist-made-note': 'Moved to the stage-2 survey as #more-made-note, with its url field.',
  // ── Andrea's simpler waitlist flow: the invite link is real now ────
  // The five typed-address rows collected emails and did nothing with
  // them: no invite was sent, no attribution was recorded, no count was
  // ever shown. They are replaced by a share link whose joins ARE
  // attributed (waitlist_signups.invited_by), which is the mechanic the
  // doc asks for. Nothing that worked was removed, because nothing here
  // worked.
  'more-invites': 'Typed-address invite rows retired for the share link (#more-invite-url); they sent nothing.',
  'more-invite-add': 'The "add another" button for the retired invite rows.',
};

// Ids a conversion chunk deliberately added, each with the reason.
const ADDED_IDS = {
  // ── #1443: what came back ───────────────────────────────────────
  'messages-screen': 'The Messages screen root, restored. #1431 made it #messages-sheet because a header chat bubble on every route left a full-screen Messages with no honest answer to "back to where?" — the bubble is gone and Messages is a menu row now, so the screen is both the honest shape and the one every messaging product uses for reading past conversations.',
  'improve-footer': 'The panel\'s reference block, restored. #1431 dissolved it and rehomed each fact separately; every move was defensible alone and the sum meant leaving the app to read facts about the app you were standing in.',
  'drawer-row-native-app-version': 'The installed Flutter release, back in that footer. #1431 renamed it #about-row-native-app-version for the Settings About block it built; the block is gone with the rows it existed to hold, so the name goes back too. `.drawer-ver-row` is the shared CSS recipe, not a claim about a drawer.',
  // ── #1443: the chip and its menu ────────────────────────────────
  'app-switcher-btn': 'The chip: the header\'s label on EVERY screen, and the one control that opens a list. #1431 built this as #header-title-tab but gated it on being inside an app; the gate is the whole difference, and losing it is what let #header-menu-btn, #back-icon-home and #messages-btn all go.',
  'switcher-avatar': 'The viewer\'s picture in the chip. Ships with NO src, so a viewer with no photo issues no request; App.applyUserAvatar swaps which of this and the glyph carries `hidden`, the same contract it uses for Home\'s account row.',
  'switcher-avatar-glyph': 'The generic person glyph shown until a photo exists.',
  'app-switcher-name': 'The label inside the chip — the same text #header-title carried as a bare heading, now a named slot so a declared check can assert WHAT the chip says and not merely that it exists.',
  'switcher-nav': 'The menu\'s destination list, and its ONLY vertical scroller. The app strip above is horizontal and therefore vertically bounded, so no number of apps can push a destination out of reach — the clipping bug that hid Home and Profile on a 39-app account cannot occur in this shape.',
  'switcher-row-home': 'Home. Was the sheet\'s #apps-switcher-home footer button.',
  'switcher-row-discover': 'Discover (#apps). Was #apps-switcher-explore.',
  'switcher-row-messages': 'Messages. Was #messages-btn in the header; it has its own page, so it is a row. Carries #drawer-messages-badge, unchanged writer.',
  'switcher-row-profile': 'Profile.',
  // #switcher-row-app / -board / -activity are NOT here on purpose: they
  // render only while an app is on screen, so they never reach the prerender
  // this inventory reads. They were #app-context-row-* in the Improve panel.
  'switcher-row-settings': 'Settings. Was #profile-row-settings on the Profile screen.',
  'switcher-byok-dot': 'The BYOK dot on that row — was #profile-byok-dot. settings.js publishes the flag; the className stays a constant.',
  'switcher-row-admin': 'Admin & moderation. Was #profile-row-admin. Ships `hidden`; App.renderAdminButton publishes the isAdmin flag, unchanged.',
  // ── Streamlined Concept: the header's second alerting glyph ──────
  'drawer-messages-badge': 'Unread-messages count, on that chat bubble. It keeps the id it wore as the drawer row\'s badge — Notifications._renderBadge is still its only writer, so only the parent changed.',
  // ── …and the Apps sheet behind the title tab ─────────────────────
  'apps-switcher-sheet': 'The board\'s Apps sheet — its "Switching between Apps" connector. Reuses the retired #app-context-sheet\'s controller, store and kit bottom-sheet lifecycle.',
  'apps-switcher-overlay': 'Its backdrop.',
  'apps-switcher-close': 'Its close control.',
  'apps-switcher-create': 'The sheet\'s "Create New" action.',
  'apps-switcher-list': 'The horizontal strip of the viewer\'s apps.',
  // ── Streamlined Concept: the drawer leads with Your apps ─────────
  // ── Andrea's simpler waitlist flow ────────────────────────────────
  // The relocated join question (see RETIRED_IDS above).
  'more-made-url': "The \"link something you've made\" field, relocated from the join form (was #waitlist-made-url).",
  'more-made-note': 'Its one-line description (was #waitlist-made-note).',
  // The doc asks for "Email + verification code". The mailed link still
  // works and confirms the same row; the code exists for the phone, where
  // leaving for the mail app and back loses the WebView's place.
  'waitlist-confirm': 'The confirm-your-email block on the join success state. Hides once the code is accepted.',
  'waitlist-code': 'Six-digit email verification code; confirms the same row the mailed link does.',
  'waitlist-code-submit': 'Submits the verification code.',
  // The share link that replaced the typed rows (see RETIRED_IDS above).
  'more-invite-url': "The signup's shareable invite link; joins through it set waitlist_signups.invited_by.",
  'more-invite-copy': 'Copies the invite link to the clipboard.',
  'more-invite-joined': 'How many people joined through this link. Empty until the stage-2 load effect fills it.',
  // ── #1372: the mobile-browser install strip ──────────────────────
  // A visitor on a phone browser is offered the native app. The strip is
  // always in the document and starts `hidden` (the island rule: data loads
  // in effects, so the first render must match the prerender), which is why
  // these ids are present here even on a build where no store listing has
  // been published and the strip can never show.
  'mobile-install-banner': 'The phone-browser strip offering the native app (#1372). Sits under #offline-banner and stacks with it.',
  'mobile-install-open': 'The store link. href comes from app_version_configs.update_url via GET /api/public/mobile-app, per OS.',
  'mobile-install-dismiss': 'Dismisses the strip for good; the answer is kept in localStorage.',
  // #1281 — the session-CLI bridge opt-in. The spec marks that venue
  // settings-gated and "most users: no", so the gate needs somewhere to
  // live: Settings → Experimental, beside the other per-user preview flag.
  'session-bridge-enabled': 'Opt-in switch for the session-CLI bridge venue (#1281).',
  'session-bridge-status': 'Save/error line for the session-bridge switch (#1281).',
  // Username changes — Settings -> Username, the change-your-@handle form. It sits in
  // Settings rather than the profile edit sheet because the endpoint requires
  // the current password, which is the same reason Change password is here.
  'change-username-section': 'Settings -> Username section wrapper.',
  'cu-current': 'The handle the viewer holds right now, painted by Settings._renderChangeUsernameSection.',
  // The `cu-` prefix mirrors the `cp-` one the change-password controls
  // beside them have always used — and stays clear of the native kit's
  // `.un-*` class vocabulary.
  'cu-new': 'Requested new handle.',
  'cu-password': 'Current password, required by POST /api/me/username.',
  'cu-save': 'Submit for the username change.',
  'cu-status': 'Status line for the username change.',
  'settings-mobile-push-preferences': 'Account-level Social mobile-push category controls in Settings → Alerts.',
  // (#1412's #improve-version-dot came and went: the Streamlined Concept
  // returned the version cue to the hamburger under its original
  // #header-menu-deploy-dot id — see the note in RETIRED_IDS.)
  // ── #1191: the build-flow preference stops being injected ────────
  // These three were BUILT AT RUNTIME by Settings._renderDevFlowSection,
  // which created the block and inserted it into the Connections pane on
  // every render. The reason was this very baseline: the shell's body used to
  // be a hand-written document, so a new settings control had nowhere to go.
  // The pane is a component now, so the block is markup and its ids are a
  // deliberate line here — which is also what stops a legacy module writing
  // into a subtree React owns.
  'dev-flow-pref-section': 'The "Preferred build flow" block in Settings → Connections (#1049) — the escape hatch for the dev-chat picker\'s "remember my option" checkbox.',
  'settings-dev-flow': 'The build-flow dropdown itself. Settings binds its change and gates the two hand-off options on whether the deployment has external flows.',
  'settings-dev-flow-status': 'Save/error line for the build-flow dropdown.',
  'native-app-version-slot': 'Mobile app version/build rendered through the native bridge (#1101).',
  'feedback-queue-dot': 'Header dot for feedback saved offline and still waiting to send (#1054).',
  'feedback-screenshot-picker-btn': 'Photos fallback for mobile feedback screenshots (#824).',
  'feedback-screenshot-input': 'PNG/JPEG picker backing the mobile feedback fallback (#824).',
  // ── THE UI OVERHAUL: the Improve panel ───────────────────────────
  // One surface for everything you do *to* the app on screen rather than
  // *with* it. It absorbed four header controls (see RETIRED_IDS above)
  // plus the drawer's Share action. Fully React-owned,
  // so unlike most of the shell it holds real state — nothing in
  // public/js/** writes a node inside it.
  'improve-btn': 'Header control that opens the Improve panel; inherits the retired App/Dev switch\'s show/hide lifecycle (App.DrawerStatus.setAppOpen).',
  'improve-overlay': 'Backdrop behind the Improve panel. Never uses `hidden` — opacity fades it and pointer-events stops a closed backdrop eating clicks.',
  'improve-panel': 'The panel root. Right-edge slide-over at `sm` and up, bottom sheet below it, and a real native-kit sheet on touch where the kit is loaded.',
  'improve-target-name': 'Which app the panel is about — the platform\'s own row on the home screen.',
  'improve-close': 'Close button in the Improve panel header.',
  'improve-body': 'The panel\'s scroller.',
  'improve-row-feedback': 'Opens the feedback dialog — the retired #feedback-btn.',
  'improve-quick-actions': 'The panel\'s three circular actions — Feedback, New change, Share — captioned beneath so three fit across a phone.',
  'improve-sessions': 'The changes in flight, here and on the viewer\'s other apps — and the panel\'s ONE scroller, which is what keeps the actions and the views on screen at any height.',
  'improve-version-dot': 'The platform deploy/stale dot, renamed from #header-menu-deploy-dot when it followed the badge cluster onto #improve-btn.',
  'improve-row-new-session': 'Starts a dev session — the Dev "+" menu\'s "Propose a change".',
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
  'messages-create-dialog': 'React-owned direct/group conversation creation dialog (#488).',
  'messages-members-dialog': 'React-owned group membership and invitation dialog (#488).',
  'messages-share-dialog': 'React-owned typed Usernode item chooser for Messages (#488).',
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
  // #1383 — the #apps directory's Sort control. It rides INSIDE
  // #browse-search-bar rather than in a strip of its own: both narrow the
  // same list, and one sticky row costs the phone less of the fold than two.
  // The <select> is controlled off browse-store's `sort`, so the remembered
  // choice, a ?sort= deep link and a hand change all show the same value.
  'browse-sort-bar': 'Sort row inside the browse search bar (#1383).',
  'browse-sort-select': 'The five-order Sort control for the all-apps directory (#1383).',
  // ── Streamlined Concept: the Board Filters dialog ────────────────
  // The Figma board (Streamlined Concept / Dev Sessions and Navigation)
  // moves the Board's filter selects and the needs-vote toggle off the
  // filter bar into a dialog; the bar keeps search and gains a
  // `Filters (n)` chip plus dismissable active-filter chips (those are
  // runtime-injected, so only the dialog's ids land in the shell).
  'board-filters-modal': 'The Filters dialog root — tenth shell dialog, same useDialog/static-modal contract as the nine.',
  'board-filters-priority': 'Priority select inside the Filters dialog (was #dev-kanban-priority on the bar).',
  'board-filters-category': 'Category select inside the Filters dialog (was #dev-kanban-category on the bar).',
  'board-filters-assignee': 'Assignee select inside the Filters dialog (was #dev-kanban-assignee on the bar).',
  'board-filters-needsvote': 'The "Needs my vote" switch inside the Filters dialog (was the bar chip #dev-kanban-needsvote).',
  'board-filters-done': 'The dialog\'s Done button — applies the staged filters via AppView.applyKanbanFilters.',
  // ── Streamlined Concept: the app-context sheet ───────────────────
  // The surface behind the header's "app name ⌄" tab: the app's three
  // views, its changes in progress/elsewhere, and the reference footer
  // (which moved here from the Improve panel keeping its ids).
  // ── Streamlined Concept: the full-screen Notifications view ──────
  // A real screen behind the drawer's Notifications row, on the Messages
  // screen's fully-React pattern: All | Unread tabs, Today/Earlier
  // sections, avatar-initial rows. Renders from the same notifications
  // store as the drawer's list.
  'home-account-row': 'Home\'s entrance to Profile — the door the retired hamburger took away.',
  'home-account-avatar': 'The viewer\'s picture on it (was #drawer-avatar).',
  'home-account-glyph': 'Its fallback glyph (was #drawer-profile-glyph).',
  'home-account-section': 'The section that holds it, last in Home\'s reading order.',
  'notifications-sheet': 'The Notifications SHEET root. It was #notifications-screen, a screen root in App.SCREEN_IDS — but the bell is in the header on every route, so a full-screen view had to answer "back to where?" and answered "home", wrong every time it was opened from anywhere else. A sheet presents over the current screen and dismisses back to it.',
  'notifications-sheet-overlay': 'Its backdrop.',
  'notifications-sheet-close': 'Its close control — the desktop slide-over needs a visible dismiss, as the Apps sheet has.',
  'notifications-screen-tabs': 'The sheet\'s sticky All | Unread tab row, with its own Mark-all-read control. Keeps the `-screen-` id it was born with: the declared checks select on it, and renaming a node that did not move would be churn.',
  'notifications-screen-mark-all': 'Mark-all-read on the sheet — same controller action as the drawer\'s #notifications-mark-all, React-wired instead of id-bound. Same naming note as the tab row above.',
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
