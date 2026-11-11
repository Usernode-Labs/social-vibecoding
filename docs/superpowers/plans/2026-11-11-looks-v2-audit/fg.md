# Audit `fg`: signed out and waitlist (o01–o27, w01–w14)

Checkout read: `/Users/salah/Dev/lingash/sv-skins` @ `redesign/skins-2026-11-11`. Paths below are relative to it.
`F/` = `frontend/src/features/`. Kit = `frontend/@/components/ui/kit.tsx`, kit CSS = `frontend/looks/kit.css`
(compiled into `public/css/app.css`; the guest rules are hand-written there at 27470–27624).

Shared plumbing every group below uses:

- **Chrome**: `F/frame/guest-chrome.tsx` — `GuestFrame` (133) is up only while one of six `#auth-*-screen` roots is
  visible (`SCREENS`, 130); `readLanding` (51), `readWaiting` (74), `readSolo` (88) read the bar off the standard
  screen's own header nodes; `GuestChromeView` (181) draws brand-or-crumb, `who`, actions.
- **Mount point**: `F/auth/landing.tsx` `LandingScreen` — `frame = isFrameSkin(useSkin())` (832); `gate` (1077),
  `gateSheet` (886, 1086); kit pages mounted at 2278–2297 ahead of the standard ones (2264–2322), sheets at
  2339–2420.
- **Router**: `public/js/app.js` 5436–5497 decides which anonymous screen an address gets
  (`AuthScreens.showSignInFor`, `showGuestPagesFor`, `showWaiting`; `public/js/auth-screens.js` 186, 195).

---

## A. Landing — o01-landing, o02-landing-full, o03-landing-games

**Files**
- Kit: `F/guest/frame/landing-frame.tsx` `LandingFrame` (54–238).
- Standard: `F/guest/guest-discover.tsx` `GuestDiscover` (326), `Card` (250), `CardCover` (171), `isNew` (86, not
  exported), `ProjectLink` (154), `appTile` (378); `F/home/communities-to-join.tsx` `CommunitiesToJoin` (44),
  `joinOrder` (38), `JOIN_PAGE`; `F/auth/story.tsx` `Story compact` (109, strings at 254–288);
  `F/guest/device-pins.ts`; `F/guest/guest-data.ts` (`featuredApps`, `presentCategories`, `filterApps`, `MIN_PEOPLE`).

**Today under a look** (in order): head = headline + `auth:guest.hero.line` + two buttons ("Try an app first",
Join the waitlist); kinds as page tabs under the head; Search; Sec "what an account adds" (3 rows); Pinned apps
tiles; "Try an app now" tiles (11); Featured as rows ending in "Look"; Communities as rows ending in "Look".
Side: Sec "Homeroom today" `Facts` (communities, apps).

**Gap to v2**
1. Head: add the small-caps line over the title, `auth:story.welcome` ("Welcome to Homeroom"). Remove the
   "Try an app first" button (143); keep the one primary (`auth:guest.hero.joinWaitlist` / `signUp`, `onStart`).
2. Move the kinds tabs out of `PageBody tabs` (150) into the Communities section, under its label and after
   Search (v2 order: Search → "Communities" label → tabs All/Games/Social/Other). Same `presentCategories` +
   `auth:guest.category.*`. Section label = `home:join.headingSignedOut` (what `CommunitiesToJoin` 113 uses), not
   `auth:frame.landing.communities`.
3. Remove Sec "Try an app now" (189–195) and `TRY_SHOWN`, `toTry`, `tryable` for the visitor path.
4. Replace both row lists (197–238) with picture cards in a grid: sub-label `home:join.featured` over the
   featured ones, then the rest; with a kind chosen and featured present, sub-label `home:join.more` over the rest
   (o03). Use `CommunitiesToJoin`'s own selection (`featured` 66, `list` 67–73) so order matches the standard page.
   A card = cover (illustration light/dark, else icon tile on its colour), "New" pill (`isNew`, 30 days,
   `auth:guest.card.new`), people pill (`active_users >= MIN_PEOPLE`, with `auth:guest.card.peopleLabel` as the
   link's aria-label), name, description clamped to two lines. Whole card is one link (`projectPath` +
   `openProject`, 45). No "Look", no buttons.
5. Side column: replace `Facts` (123) with one unlabelled `Card` holding the three points (move rows 164–168
   there, drop the `auth:frame.landing.account` label). `sideFirst` so it leads on a phone. Does not change with
   the kind or the query (today the points hide when `!front`).
6. Add Pinned communities (missing in kit): `devicePinsStore.communities` → tiles under `home:communities.heading`
   (standard 426–438). Keep Pinned apps; the standard tile also has an unpin control
   (`toggleDevicePin('apps', slug)`, `home:guest.unpinApp`) the kit tile lacks.
7. Optional parity: standard pages 8 cards at a time on scroll (`JOIN_PAGE`, sentinel 76–95) and keeps the query in
   history (`guestSearchFrom`/`withGuestSearch`, 356–365); the kit page lists everything and forgets the query.

o02 = o01 scrolled, nothing extra. o03 = `kind='games'` (render test seeds it with `initialKind`).

**Kit/CSS needs**
- `Head`/`PageBody`: an `over` slot (tour `.cap.over`); kit.css has no `.over`.
- A picture-card grid: tour `.gF-grid` (3 cols, 2 on phone). `PicCard` (kit 446) is the sideways `fcard`
  (flex 0 0 208px) with no overlay: needs a grid variant and a cover-badge slot (pill bottom-start, `.new` top-start).
- `.cap.sub` (sub-label inside a section), `.t2`, `.s2.two` exist in the tour's kit, not in kit.css.

**Tests**: `tests/landing-frame.test.js` (all 8 cases; "apps to try", "Look", side Facts are asserted),
`tests/guest-discover.test.js`, `tests/landing-directory.test.js`, `tests/story-fit.test.js`,
`tests/first-session-make.test.js` (read guest-discover/story), `tests/looks-css.test.js` (new kit classes).
Catalog ids to retire: `auth:frame.landing.{tryFirst,try,noAccount,look,today,factCommunities,factApps,account,communities}`.

**Size**: M — one file rewritten plus one kit component. **Risks**: `landing-frame.test.js` pins the removed
sections; `isNew` must be exported, not copied; `LandingFrame` is shared with w03 (`waiting`).

---

## B. Sign-in sheet over the landing — o04-signin-sheet, o04b-signin-phone, o04c-signin-password, o05-signup-sheet, o06-waitlist-join

**Files**
- Kit: none. Worn standard sheet: `F/auth/sign-in-sheet.tsx` `SignInSheet` (940–2051; render 1716–2049) dressed by
  app.css 27596–27624 and `frontend/looks/looks.json` `wear.roots.card/btn` (`[data-sign-in-sheet] …`).
- Opened from `F/auth/landing.tsx` 2385–2420 (`sheet === 'signin' | 'start'`, titles `auth:landing.sheet.signIn`
  / `auth:landing.sheet.continue`). Kit `Sheet` (kit 566), `Fields`/`Field` (508/517), `Tabs` (337) exist unused here.

**Today under a look**: the product's DOM in the product's order — title + close; [Email code | Password switch];
`choose`: Apple, Google, terms, "or", Email field, Continue with email, phone link, password link. Only colours,
field box, title size and button height are the kit's.

**Gap to v2** (same content, kit sheet order)
- `choose` (o04, o05, o06): Email field in a card → Sec "or" (`auth:signInSheet.or`) with one card of single-line
  rows: Continue with Apple, Continue with Google (`providerButtons`, 1661), Use a phone number instead
  (`data-sign-in-sheet-to-phone`, 1799), Use a password (`ways`/`wayLine` or the method switch, whichever the step
  computes) → primary block button "Continue with email", dimmed until an address is typed (`hasAddress`,
  `data-sign-in-email-empty`) → terms line as the sheet's foot (`TermsNotice`). No sentence under the title
  (already none).
- `phone` (o04b): title stays the sheet's title; card with Phone number + country code (`PhoneInput`) → Sec "or"
  rows Apple, Google (2014–2024) → primary "Text me a code" (`auth:signInSheet.phone.send`) → foot:
  `auth:signInSheet.phone.haveAccount` then terms (`stepSaysTerms`, 2045).
- `password` (o04c): switch drawn as kit `Tabs` full width (Email code | Password,
  `auth:signInSheet.method.*`, `toStep`); one card with Username or email + Password (`PasswordInput`); primary
  "Sign in"; "Forgot password?" link (`data-sign-in-sheet-forgot`). No rows, no terms (as today).
- o05 and o06 are o04 with title `auth:landing.sheet.continue`: nothing else differs. o06's entry is the head's
  Join the waitlist (`onStart` → `setSheet('start')`).
- Not in the mockups but must keep working in the same dress: `email`, `code`, `phone-code`, `username`,
  `account`, `forgot`, `link` steps.

Two ways to do it; pick one for the whole sheet:
(a) a kit branch in `SignInSheet`'s render (`isFrameSkin(useLiveSkin())`, as `guest-project.tsx` 256 does) that
returns kit `Sheet` + `Fields` + rows and reuses every handler/state already in the component (`requestCode`,
`submitPhoneStep`, `signInWithPassword`, `toStep`, `close`, refs); or
(b) CSS only: `display: contents` on the step's `<form>` plus `order`, and wear the provider buttons/links as
`.row`s. (b) keeps one DOM but cannot put four separate buttons in one card without new wrapper markup.
Recommended: (a) for `choose`, `phone`, `password`; leave the other steps worn.

**Kit/CSS needs**: `Sheet` has no slot between head and stack for the switch (tour `.tabs.gF-seg`: full-width,
centred tabs); `Field` needs a `before` country-code box (exists: `before`) and a trailing show-password button;
`Row` as a `<button>` with a brand glyph lead (Apple/Google icons are not in kit `Icon`); `.foot` exists.
`Sheet` portals to `<body>` and takes focus itself: the sign-in sheet's keyboard handling
(`platform-kb-sheet`, `HOLD_FIELD_FOCUS`, `mayFocusByCode`) must survive.

**Tests**: `sign-in-sheet-flow`, `sign-in-sheet-email-ready`, `sign-in-providers`, `invite-join-sheet`,
`phone-invite-join`, `phone-country-input`, `keyboard-surface`, `first-run-safari-toolbar`,
`landing-signing-in`, `release-link-straight-flow`, `waitlist-release-link`, `terms-first-run`,
`contact-opt-ins-ui`, `auth-code-boxes`, `community-invites`, `first-session`, `first-session-make`,
`guest-discover`, and `guest-chrome.test.js` case "the sign-in sheet is the kit's sheet" (pins app.css 27596+).

**Size**: L — 2,051-line component with 11 steps, 19 suites reading its source. **Risks**: `data-sign-in-*`
attributes are selected by tests and declared checks: keep every one in the kit branch; hand-off/closing
animation (`leaving`, `closing`, `data-sign-in-sheet-cover`) and the native-app provider path live in the same
render.

---

## C. Stand-alone auth pages — o07-login, o08-forgot, o09-email-code, o10-register, o11-waitlist-status

**Files**
- Kit: none. Worn standard screens under the guest bar: app.css 27554–27574 (504px column, field box) +
  looks.json `wear.roots.title/card/btn` (`#auth-login-screen, #auth-register-screen, #auth-waitlist-screen,
  #auth-more-screen`).
- Standard: `F/auth/login.tsx` `LoginScreen` (482; password view 1527–1623, `#otp-view` 1650+,
  `#recovery-view` 1875–2025); `F/auth/register.tsx` `RegisterScreen` (67; 163–280); `F/auth/waitlist.tsx`
  (`#waitlist-joined`/`#waitlist-confirm` 659–765).

**Today under a look**: bar = back + brand. Page = product markup: title, [sentence], fields card, primary
button, terms, then the other ways as quiet pills under it. Own wordmark and back disc hidden.

**Gap to v2** — content is already today's; what differs is order and the dress of the secondary links:
v2 = title [+ sentence] → fields card → one card of rows for the other ways → primary block button last → terms
as foot.

- **o07** `#login-form`: move `#forgot-link-wrap` + `#otp-link-wrap` (1606–1623) above the Sign in button and
  draw them as two rows in one card; `TermsNotice verb="signing in"` after the button as the foot. The links sit
  outside the form, so reordering needs `display: contents` on `#login-form` + `order`, or markup.
- **o08** `#recovery-view` (`recoveryPath === 'email'`): title `auth:login.recovery.title` + lead
  `auth:login.emailReset.lead` as the head; Email card; the amber admin note (`ADMIN_LEAD_WITH_EMAIL` +
  `ADMIN_LEAD_SUPPORT_INSTRUCTIONS`, 1990–2000) as kit `.note`; `#btn-recovery-back` as a row in a card;
  `#btn-email-reset` last. Today the button is above the note and the `<hr>`; hide the `<hr>`. The `h1` is
  `SCREEN_H1_HIDDEN` on this view and the title is an inner heading: check the wear's `h1` rule reaches it.
- **o09** `#otp-step-email`: title `auth:login.otp.title`, lead, Email card, `#btn-otp-back`
  ("Sign in with a password") as a row card above `#btn-otp-request`. Code step and account step stay worn.
- **o10** register: h1 "Homeroom" + `auth:register.tagline` as title/purpose (remove italic, already done);
  `auth:register.lead` as a 15px sub-heading; three fields with their hints in ONE card (today each field is its
  own block: check the `.rounded-2xl.overflow-hidden` hook matches, register uses `space-y-4`);
  `auth:register.haveAccount` as a row card above Register.
- **o11** `#waitlist-confirm-address`: head `auth:waitlist.joined.titleStatus` + `leadStatusAddress`; field with
  its hint under it in the card; `#waitlist-request-code` primary block, `#waitlist-have-code` quiet block under
  it. Closest to v2 already; verify `#waitlist-join-instead` and `#waitlist-request-note` stay hidden as today.

**Kit/CSS needs**: none new if done by CSS (wear `.row` onto the link wraps; `.note` onto the admin notice).
`.hint` exists.

**Tests**: `guest-chrome.test.js` "a stand-alone page is the kit's one column" (pins the app.css block),
`looks-css.test.js`; if markup moves: `password-reset-ui`, `email-code-password-account`,
`otp-signup-onboarding`, `register-account-rules`, `username-first-choice`, `waitlist-two-step`,
`waitlist-status-panel`, `waitlist-field-primitives`, `shell-id-inventory`, `return-to-next`,
`tests/lib/lazy-interiors.js`.

**Size**: M for the five (each S) if CSS-only. **Risks**: every id here is in the shell baseline and in
dapp.json checks — do not move or rename nodes; `display: contents` on a `<form>` drops it from the
accessibility tree in old Safari; these screens hydrate (first render must stay the prerender's).

---

## D. Members' addresses opened signed out — o12-gated-messages, o13-gated-bot, o14-gated-profile, o15-gated-settings, o17-challenges, o22-homeroom-workshop, o23-homeroom-hub, o24-request, o25-change

**Files**
- Kit: `F/guest/frame/gated-frame.tsx` `GatedFrame`, `gatedKind`; mounted `landing.tsx` 2278–2287; sheet held
  back by `open={!frame || gateSheet}` (2364); app.css 27530–27531 hides the standard backdrop.
- Standard: `F/auth/deep-link-sign-in.tsx` `deepLinkPlace`, `deepLinkTitle`, `deepLinkReturnTo`,
  `DeepLinkBackdrop`; `landing.tsx` `gate` (1077), `closeGate` (888), the gate's `SignInSheet` (2362–2378).

**Today under a look**: a whole page per address (title, purpose, Sign in + Join buttons, "What lives here" rows
for Messages/bot/You, "Open without an account", "New here?" side card). The sheet opens only from its button.

**Gap to v2**: v2 is the standard behaviour in the kit's dress — bar, empty outline, sheet open by itself.
1. Remove `GatedFrame` from the landing (2278–2287), `gateSheet`/`gateSheetUp` (886–893, 1086–1087), set the
   gate sheet back to `open`; delete `gated-frame.tsx` and the 30 `auth:frame.gated.*` catalog entries.
   `closeGate` then behaves as standard (back to the landing).
2. Sheet = group B's `choose` step with `deepLinkTitle`'s title. Titles already right:
   messages → `deepLinkSignIn.messages`; settings → `.settings`; bot, You, Challenges → `.page`;
   `/app/usernode-…` → `.someProject` ("Sign in to open this project").
3. Bar must name the place; today `headerTitle` (1601) is the wordmark during a gate, so the bar shows the brand.
   Add a place name for the gate and let `readLanding` pick it up (e.g. a `data-landing-place` on
   `#landing-header-title`, or a prop into `GuestChrome`). Per step:
   - o12 "Messages" (`core:tabs.messages`), o13 "Homeroom bot" (`core:tabs.ai`), o14 "You" (`core:tabs.me`),
     o15 "Settings" (`core:tabs.settings`), o17 "Challenges" (needs its id from the leaderboard namespace).
   - o22: brand, then crumb "Workshop"; o23 (`?ws=status`): brand only; o24: "Workshop" › "Request #5998";
     o25: "Workshop" › "Change #6369". Place words from `dev-board/workshop/places.ts` `placeName`;
     "Request #{{number}}" / "Change #{{number}}" exist in `project.json` (2987, 2991). The address must be parsed
     further than `deepLinkPlace` does (it stops at the slug): `dev/issues/<n>`, `dev/changes/<n>`, `?ws=`.
     `gatedKind`'s head table is the start; extend rather than re-derive.
   - Sign in / Sign up are already in the bar (`data-landing-actions` shows while `guestPages`). While a gate is
     up they call `setSheet('signin'|'start')`, which the story sheet ignores (`open={!gate && …}`, 2386):
     harmless with the sheet already open, but they do nothing.
4. Backdrop: keep `DeepLinkBackdrop` (stop hiding it, app.css 27531) and restyle under a look: it is
   `fixed inset-0 z-[45]` and blurred, so it covers the bar (z 41). Needs `top: var(--fr-shell-top)`, no blur,
   kit surface blocks (tour `.gF-ghost`).

**Kit/CSS needs**: `.gF-ghost` outline blocks (CSS only, on `[data-deep-link-backdrop]`).

**Tests**: `tests/gated-frame.test.js` (delete), `tests/landing-frame.test.js` (reads gated-frame),
`tests/deep-link-sign-in.test.js`, `tests/guest-chrome.test.js` (bar cases), `tests/landing-auth-required.test.js`.

**Size**: M — mostly deletion; the crumb parsing and its tests are the work. **Risks**: o22–o25 assume the
Homeroom project is NOT a public-directory entry signed out; `landing.tsx` 1067–1069 opens the read-only page
for any slug in `/api/public/apps`, in which case there is no gate at all (see open questions).

---

## o16-discover — RETIRED
`#apps` signed out: router → `showSignInFor` → `discoverLink` (1071) → no gate → `LandingFrame` (group A).
Nothing to remove; `deepLinkSignIn.discover` and `SCREEN_FOR_HEAD.apps/discover` are still used by that path.

---

## E. Public project page — o20-app-page, o21-app-page-full (visitor); w12-app-page, w13-homeroom-workshop (account in line)

**Files**
- Kit: `F/guest/frame/project-frame.tsx` `GuestProjectFrame` (`voteRow` 67, `acts` 81, `membersOnly` 107,
  `side` 121, hub 165, workshop 201), `Shot`.
- Standard: `F/guest/guest-project.tsx` `GuestProject` (190; hands over at 256), `VoteCard` (57),
  `MembersOnly` (129); `GuestCover`/`GuestIcon` (`guest-discover.tsx` 114/92); `fetchOverview`
  (`GET /api/public/apps/:slug/overview`); `bandBuilders`/`active`/`week` thresholds (233–236).

**Today under a look**: head = name, purpose = description (else "Public community"), acts = Share (icon), Pin,
Join, Try it. Tabs. A "You're reading as a guest" note. Hub main: What's happening rows, Up for a vote as plain
rows in one card (title, tally, "Vote"), Recently voted in. Side: People (builders row + a "Public community"
row); From the chat row on Hub. Workshop main: vote cards with before/after + row, then Requests. No cover.

**Gap to v2**
1. Head: add the icon tile before the title; "Public community" (`auth:guest.project.audience`) as a 13px line
   under the name; purpose = description when there is one; then the facts line "Built by N people · M people
   used it lately" using the standard's rule (`bandBuilders`/`active`, else `auth:guest.card.week`; 300–309).
   Remove the globe row from People (126).
2. Acts order: Try it (primary; or `signInToUse`) → Join → Pin → Share with its word. Account in line
   (`signedIn`): Try it and Share only (already so).
3. Remove the guest note (163) and `auth:frame.project.guest`.
4. Add the cover at the top of the side column: `app.illustration_url`/`illustration_dark_url`, else icon on the
   community colour (`useCommunityColor`, `GuestCover`). w12 draws it at the top of the main column on a phone.
5. Hub votes: replace `voteRow` rows with one card per vote as the standard `VoteCard`: before/after pictures
   (`v.pictures`), title, `v.summary`, tally (`auth:guest.project.tally`), and "Vote" (`onIntent({kind:'vote'})`)
   or, in line, `auth:guest.project.voteLater`. First three on Hub (`voteCards(3)`), all on Workshop. `v.summary`
   is not drawn anywhere in the kit page today.
6. Hub layout, o20: side = cover, What's happening (move from main, 167–184), then People and From the chat;
   on a phone People and From the chat come last, after Recently voted in. w12 draws What's happening in the
   main column instead (see open questions). From the chat: add the line `auth:guest.project.chatJoin`
   (visitor) / `joinLater` (in line) and the Join button, as `MembersOnly`.
7. Workshop (w13): main = Up for a vote cards only; move Requests (217–231) to the side column in place of
   People (the standard page shows People on Hub only). "and N more" = `auth:guest.project.moreRequests`.
8. Bar: name the tab when it is not Hub (w13: project tile + name, then "Workshop"); the tab is local state in
   `GuestProject` (224), so publish it (attribute on the frame root or a store) for `readLanding`. w12's bar
   shows "Home" › name; today it is back-arrow + name.

o21 = o20 scrolled. w12 = o20 with `signedIn`. w13 = same page opened on `tab='workshop'`
(`startOnWorkshop`, `linksToWorkshop`).

**Kit/CSS needs**: `Head` slots for a leading tile and a line under the title (`.sub13` missing in kit.css);
a cover block (tour `.gF-cov.big` / `.gG-cover`); a vote card for a visitor: `.shots` exists in kit.css (207)
and a product `.fr-shots` in app.css (27539–27542) — settle on one; `Ballot` (kit 274) needs `of`/`need`, which
the overview does not give, so this is a new small component (pictures, `sub17`, summary, tally + action);
`.later` (muted word at the row's end).

**Tests**: `tests/guest-project-frame.test.js` (all 7), `tests/guest-discover.test.js`,
`tests/shots-public.test.js`, `tests/guest-chrome.test.js` (crumb).

**Size**: M — one view file, one kit component, data already loaded. **Risks**: hub/workshop/discussion state
and the device pin live in `GuestProject`; keep the frame a view only. Before/after pictures can 404 (`Shot`
handles it; keep that).

---

## o26-public-profile

**Files**: standard `F/profile/profile-view.tsx` 465–468 (`view.kind === 'publicNotFound'`,
`profile:public.unavailable`); router `app.js` 5437–5439 (`publicProfileRoute` → `AuthScreens.hideAll()`).
Kit: none for a visitor (`F/profile/public-profile-card.tsx` `data-public-profile-frame` is the member's).

**Today under a look**: no chrome at all. `FrameApp` (frame-app.tsx 103–112) needs a platform viewer, and
`GuestFrame` is up only for `#auth-*` screens, so `#profile-screen` shows as the standard page with its one line.

**Gap to v2**: bring the guest bar up for a signed-out `#profile/<name>`: add a case to `GuestFrame` (profile
screen visible and no `App.user`), crumb `@<name>` from the hash, Sign in / Sign up drawn directly (the
landing's buttons are not mounted here: go to `#landing` and open its sheet, or `#login`). Body: the line,
centred and muted (tour `.gF-lone`), wearing kit tokens.

**Kit/CSS needs**: `.gF-lone` (or reuse an empty-state class). **Tests**: `guest-chrome.test.js`
("it is up for a visitor only…" pins the six screens), `frame-app.test.js`, `me-page`/`you-frame` read
profile-view. **Size**: S–M. **Risks**: `useVisibility` hooks in `GuestFrame` are positional (one per screen,
135–139); the bar's actions have no node to press on this screen.

---

## o27-invite-invalid

**Files**: standard `F/auth/invite-card.tsx` `DeadInvite` (362–388, `DEAD` map 98–105), mounted `landing.tsx`
1921. Kit: none; no wear rule names `[data-landing-invite="dead"]`.

**Today under a look**: the standard centred section inside the landing under the guest bar (picture, small
caps, 26px heading, sentence, violet pill), unstyled by the look.

**Gap to v2**: stand-alone column: `auth:story.welcome` over the title, title `t(dead.title)`
(`auth:invite.dead.unknown` etc.), sentence `t(dead.next)`, one block primary `auth:invite.dead.continue`
(`href="/"`). Hide the picture. Either a kit branch in `DeadInvite` (`PageBody`/`Head` + `Btn block`) or CSS on
`[data-landing-invite="dead"]` + add its `h1`/button to the wear map. All five reasons, not only `unknown`.

**Kit/CSS needs**: the `over` slot from group A. **Tests**: `invite-page-join`, `invite-landing-pending`,
`community-invites`, `session-guard-screens` (read invite-card). **Size**: S.

---

## F. Waiting room — w01-waiting, w02-waiting-full; and w04-home, w05-messages, w06-bot, w07-profile, w08-settings, w09-create, w14-waitlist-status

**Files**: standard `F/auth/waiting.tsx` `WaitingScreen` (147; render 405–522), `waiting-about.tsx`,
`add-phone.tsx`. Kit: none; worn by app.css 27576–27594 + looks.json (`#auth-waiting-screen h1`,
`[data-waiting-queued]`, `[data-waiting-invite]`); bar from `readWaiting` (name + Sign out).

**Today under a look**: bar = brand, avatar + @name, Sign out. Column: title, sentence, "Signed in as", Look
around as a full-width primary, then `WaitingAbout`, queued note, the invite card. Wordmark, picture and the
foot's Sign out hidden.

**Gap to v2**
- Order: Look around while you wait goes last, after the invite card (the column is a flex column, 413: CSS
  `order` on `[data-waiting-look-around]` is enough).
- Invite card: "Have an invite link?" (`auth:waiting.invite.title`) as the section label over the card, the
  lead as the hint inside, field + Join in one line, Join dimmed while empty (already `disabled`). The `h2` is
  inside the `<form>` card today; a label outside needs markup or a negative-margin trick.
- `WaitingAbout`, the queued note and `AddPhoneCard` are not in the mockup but are today's content when they
  apply: keep them worn.
- w02 = w01 scrolled.
- w04, w05, w06, w07, w08, w09, w14: the router sends each address to this screen (`app.js` 5463–5494,
  `showWaiting`); nothing per step. `none` beyond w01's gap.

**Kit/CSS needs**: none. **Tests**: `guest-chrome.test.js` "the waiting room is a stand-alone page…",
`waiting-screen-words`, `waitlist-account-answers`, `shell-id-inventory`. **Size**: S. **Risks**: not verified
live with a real account in line (plan Notes say so too).

---

## G. Look around while waiting — w03-look-around

**Files**: kit `LandingFrame` with `waiting` (landing-frame.tsx 113–148); standard `GuestDiscover` with
`hero={<WaitlistCard/>}` (`F/guest/waitlist-card.tsx`), `signedIn`.

**Today under a look**: guest bar (name, no Sign out here). Head = "You're on the waitlist" + lead + a
"Your spot on the waitlist" button; kinds tabs; Search; Pinned apps; "Try an app now"; Featured and Communities
rows ending in "Look". Side: "Your spot" row + "Homeroom today" Facts.

**Gap to v2** (differs from group A as listed)
- Head: title "Home" (`core:tabs.home`), purpose "Your apps and your communities." (needs the member Home
  frame's purpose id from `F/home/frame/home-frame.tsx`), Search inside the head. No button.
- Side column (first on a phone): Sec `auth:waiting.title` with a card: the sentence
  (`auth:guest.waitlist.leadEmail`/`lead`) and one row `auth:landing.backToWaiting` → `#waiting`. Remove Facts.
- Communities: as group A (kinds, Featured, the rest), except v2 draws Featured as small cards (tile, pills,
  name, sentence) and the rest as rows (tile, name, sentence, people pill) rather than cover cards. No "Look".
  Remove "Try an app now"; keep Pinned apps when the device has one.
- Frame: v2 shows the member's sidebar (Home, Homeroom bot, Messages; "Open to look at" communities; You) and
  the phone tab bar. Today a waiting account gets the guest bar, and every one of those rows routes back to the
  waiting room. See open questions.

**Kit/CSS needs**: `.hcard` and `.hc-top` (tour kit, not in kit.css). **Tests**: `landing-frame.test.js` case
"an account still in line looks around…", `waiting-screen-words`, `private-member-shell`, `first-session`
(read waitlist-card). **Size**: M without the sidebar; L with it.

---

## Shared work (do once)

1. **Kit `Head` slots**: `over` (small caps above the title), a leading tile, a 13px line under the title.
   Used by A, E, o27. Add `.over`, `.sub13` to kit.css.
2. **Picture card grid + cover badges** (A, G) and a **cover block** (E).
3. **Visitor vote card** (E: o20, w12, w13).
4. **Guest bar crumbs from more than the landing's header**: a place name for a gate (D), the project tab (E),
   a profile (o26). One small change to `readLanding`/`GuestFrame` plus a way for the screen to say its place.
5. **The sign-in sheet in the kit's order** (B) — also what every D step shows.
6. **"Other ways as rows in a card, primary last"** as one CSS/wear pattern for C, F and the sheet's worn steps.
7. Catalog cleanup: `auth:frame.landing.*`, `auth:frame.gated.*`, `auth:frame.project.guest`.

## Suggested order

1. Kit additions (shared 1–3) with `looks-css.test.js`.
2. A landing (o01–o03), then G (w03) on the same component.
3. E project page (o20, o21, w12, w13).
4. D gated: delete `GatedFrame`, restore the auto sheet, bar crumbs, backdrop (works with today's worn sheet).
5. B sign-in sheet (largest, most tests); D inherits it.
6. C stand-alone pages and F waiting room (CSS).
7. o26, o27.

## Open questions

1. **Sidebar and tab bar for an account in line (w03, w12, w13).** v2 keeps the first tour's member frame with
   "Open to look at". The product has no such chrome for a waiting account and Home/Homeroom bot/Messages/You all
   route to the waiting room. Build a look-around chrome variant (new, L, not "content from today"), or keep
   the guest bar?
2. **Is the Homeroom project in the public directory?** o22–o25 (capture) show the sign-in sheet for
   `/app/usernode-2d5619/...` signed out; w13 says the same address opens the read-only page for an account in
   line. The code uses one test for both (`linkedApp` from `/api/public/apps`, landing.tsx 1067): if it is
   listed, a visitor gets group E's page and o22/o23 never show; a request or change address (o24, o25) then
   opens the project page on Workshop (`linksToWorkshop`), not a sheet.
3. **o20 vs w12 column split**: What's happening is in the side column in o20 and in the main column in w12.
   One layout for both, or really two?
4. **Phone bar**: the guest bar hides Sign up on a phone (`k('d')`, guest-chrome 226). v2 draws both; intended?
5. **Sheet scope**: only `choose`, `phone`, `password` are drawn in v2. Are `code`, `account`, `username`,
   `forgot`, `phone-code`, `link` to follow the same kit layout, or stay worn?
6. **o04 "Use a password" row vs the Email code | Password switch**: from the bar's Sign in
   (`from="signin"`) `hasMethodSwitch` (485) puts the switch on the first step too; o04 draws a row and no
   switch. The product's computed state should win; confirm.
7. **Challenges crumb / Home purpose ids**: the exact catalog ids for "Challenges" and "Your apps and your
   communities." were not looked up; both strings exist in the member frames.
