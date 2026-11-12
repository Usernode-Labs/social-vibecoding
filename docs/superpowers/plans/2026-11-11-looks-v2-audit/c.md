# Audit, group c: s32 to s35, s38 to s43

Checkout read: `/Users/salah/Dev/lingash/sv-skins`, branch `redesign/skins-2026-11-11`. Paths below are relative
to it. Read only; nothing was run in a browser, so "today under a look" is from the code and the plan's notes.

Short names: `topic/` = `frontend/src/features/dev-board/topic/`, `fs/` = `frontend/src/features/first-session/`,
`kit.tsx` = `frontend/@/components/ui/kit.tsx`, `kit.css` = `frontend/looks/kit.css`,
`app.css` = `public/css/app.css` (hand block "THE FRAME IN THE SHELL" starts at line 26965).

---

## s32-request and s33-request-full (one page; s33 is the same page shown whole)

**Files**

- Kit parts: `topic/frame/topic-frame.tsx` (`TopicFrameHead` 18, `TopicFrameAbout` 42, `TopicFrameStatus` 78),
  `topic/frame/topic-page.ts` (`topicBack`, `dotLine`, `frameStop`), `topic/frame/side-stack.ts` (`useSideStack`),
  `topic/frame/topic-follow.ts` (`useFollowRow`).
- Standard page (which also hosts the kit parts): `topic/request-head.tsx`: `RequestBar` 115 (kit branch 137-138),
  `RequestStatus` 366 (kit branch 388-405), `SpecCard` 437, `RequestHead` 523 (`useFramePage` 530, `useSideStack` 531,
  status 686-687, plan 689, track card 692-701, About 715-725).
- The replies: `frontend/src/features/group-chat/transcript.tsx` (heading `.messages-reply-count` 1344-1346,
  `RequestEvent` 1239). The bot's card: `frontend/src/features/messages/bot-track.tsx` (`TrackCard` 537, `TrackBar` 320).
- CSS: `app.css` 27324-27378 ("A REQUEST'S PAGE"); wear map `frontend/looks/looks.json` 298-350 (`post`, `composer`,
  `card` on `.dev-request-ask`, `.dev-request-track > [role="group"]`).
- Host frame: `frontend/src/features/dev-board/topic-frame.tsx` (`DevTopicSubView`, takes no props; nothing to change).

**Today under a look**

1. Bar: project, Workshop, "Request #N", back = `topicBack`. Matches v2.
2. Head (`TopicFrameHead`): the title, then one line under it "Request #N · category", then ⋯.
3. Words column: the ask as a card (`.dev-request-ask`, Show more), spec cards, changes section, thread items.
4. Side column, 320px, absolutely placed from measured heights, in this order: `.dev-request-status` (kit card: stage
   pill "Asked/Spec/…", five-stop `Track` unless the bot's track card is up, sentence, fine print, the one action),
   `.dev-request-track` (the product's `TrackCard`, wearing the card), `.fr-topicside` (About: asker row, topic row,
   Follow switch).
5. Replies: the product's stream in the words column (heading line, posts wearing `post`, events in the standard
   look), then the product's composer wearing `composer`.
6. Phone: one column in the page's own order (words, status, track, About).

**Gap to v2**

1. Head: "Request #N" goes OVER the title as a small-caps line (`.cap.over`), not under it as a sentence. Change
   `TopicFrameHead` to take `over` instead of `purpose`; pass `kicker` (already computed in `RequestBar` 123-127,
   including the closed and done variants). Drop the phone rules that clamp the title to two lines and hide
   `.fr-purpose` (`app.css` 27372-27375) or re-aim them: v2 shows the full title.
2. Remove About and the Follow switch: delete the `TopicFrameAbout` block (`request-head.tsx` 715-725),
   `useFollowRow` (661) and `topic/frame/topic-follow.ts`; drop `.fr-topicside` from the `useSideStack` parts (531)
   and from `app.css` 27358/27377. Follow stays where the standard page has it: the ⋯ menu (`thread-items.tsx`).
   Catalog ids `project:frame.topic.about|asked|topic|follow|followLine` become unused: remove them.
3. Split the status in two, as the standard page already does when the bot's track card is up:
   - Main column, right after the ask: a card with the sentence (`sentences([s.lead, s.note || specLine])`, lead in
     bold), `s.fine`, and the action (`s.action`: label, `act` through `call(a.act.fn, …)`, keeps class
     `dev-request-primary`). No pill and no track in this card. This is `RequestStatus`'s kit branch minus `pill`
     and `at`; take `.dev-request-status` out of the side-stack parts so it stays in the page flow.
   - Side column, under a "Status" label: pill + five stops + one line. With a track (`r.track`): build it from the
     same data `TrackCard` reads, in `bot-track.tsx`: pill word = `trackEyebrow(track)`, stops = `stepLooks(track)`
     (not exported today; export it, it returns done/now/next/live per stop), line = the `facts` string
     (`trackDetail`, `trackPlace`, `trackClock`), plus `trackLinks(track, { request: false })` and `TrackPictures`
     when it has them. Without a track: pill = stage word (`STAGES[at].label`), stops = `frameStop(stage)`, no line.
     Keep the outer `.dev-request-track` node with `data-request-track` and `inert` (tests and `trackPending` read
     it); draw the kit card inside it under a look instead of `TrackCard`.
   - kit `Track` takes one `at` and a `state` of now/wait; `stepLooks` gives a state per stop and a `live` state.
     Either map (first `now` index, `wait` when the track's tone is amber) or let `Track` take per-stop states.
4. Section labels: "The request" over the ask (new catalog id, e.g. `project:frame.topic.theRequest`); "Status" over
   the side card (new id, or `changes:` has none; `project:topic.request.status.label` is the aria label, check its
   text before reusing). `TopicFrameStatus` already takes `label`; the note at its prop ("no room for a label")
   goes, since the side stack must now leave room for the label (it measures `offsetHeight`, so a label inside the
   measured part is enough).
5. Replies as the kit draws them: the heading (`.messages-reply-count`, already says "1 reply" / "No replies yet"
   from `project:topic.request.stream.replies|noReplies`) styled as the kit's `.cap` section label, and the stream
   under it inside one card. Events (`.dev-request-event`, glyph + text + time) wear the kit's `.evt` (add an `evt`
   root to the wear map: `to: .dev-request-event`, part `ei: .dev-request-event-glyph`). The card around
   `#gc-thread-messages` is CSS only (the wear `card` on the stream's list node); no React change in transcript.tsx.
6. Phone: Status first, above the request (`.stack.first`). Today it is after the words. On a phone make
   `[data-image-viewer-scope]` a flex column and give `.dev-request-track` (the side Status) `order: -1`.
7. Keep, unchanged, everything the standard page has that the mock's one request does not show: the "part of a
   thread" line (642-660), the editor, Translate, `RequestPlan`, `OwnAgentLink`, spec cards, `ThreadChanges`,
   `ThreadItems`. They stay in the words column.

**Kit/CSS needs**

- `Head` (`kit.tsx` 324) has no `over` slot; `kit.css` has no `.cap.over` (mock: `.cap.over{margin-bottom:8px}`).
- `Track` per-stop states (see 3), or a mapping helper in `topic-page.ts`.
- Wear root `evt` in `looks.json`; wear `card` extended to the stream's list under `#dev-topic-thread .dev-request`.
- `.status .sub15` (the main card's 15px sentence with a bold lead) is in the mock; `kit.css` has `.status .txt`
  (13px, muted) only.

**Tests that pin it**

- `tests/request-frame.test.js` (10 tests; every one reads these files: head "one line saying what it is" 24, About
  rows 31, side stack parts and CSS 54, status card 88/103, Follow row 120). Most need rewriting.
- Read `request-head.tsx` by string: `tests/request-thread-page.test.js`, `thread-page.test.js`,
  `thread-one-page.test.js`, `thread-page-menu.test.js`, `request-bot-plan.test.js`, `request-shots.test.js`,
  `translate-toggle.test.js`, `claude-code-link.test.js`, `work-with-bot.test.js`, `messages-bot-track.test.js`
  (`bot-track.tsx`), `looks-css.test.js` (wear map and compiled CSS), `frame-app.test.js` (the trail).
- 52 suites read `transcript.tsx` or its classes; none should move if the stream is dressed by CSS alone.

**Size**: L. The status split touches the measured side stack, the bot track's data and the phone order, and
`request-frame.test.js` is mostly rewritten. **Risks**: `request-head.tsx` is pinned line by line by about fifteen
suites (add, never rewrite; the plan's note at line 207); the side stack is absolute and measured, so a label or a
taller part changes `--fr-side-pull`; `.dev-request-track` holds its place unseen while `trackPending`; the status
card must not appear twice (the plan's "left as they are" notes the bot's sentence showing twice while building,
which this split fixes).

---

## s34-change and s35-change-full (one page; s35 is the same page shown whole)

Only a change with no request has this page; a change built for a request is a section of the request's page
(`thread-changes.tsx`), which v2 does not redraw.

**Files**

- Kit parts: the same `topic/frame/*` files; `topic-page.ts` `changeStop` 39, `pillKind` 51.
- Standard page: `topic/change-head.tsx`: `ChangeBar` 88 (kit branch 103-104), `GateCard` 251 (name and figure
  304-308, bar 310, action 318, note 340-370), `MergeCard` 402, `ChangeGates` 594, `ChangeThreadHead` 660
  (`useFramePage` 678, `useSideStack` 679, by-line 716-720, summary 725, kit status 754-763, gates 767,
  `WorkWithBotButton` 772, About 777-786). `topic/work-with-bot.tsx` (button, 46-68).
- Replies: `transcript.tsx` 1468-1516 (`.messages-reply-count`, `ChangeEvent`).
- CSS: `app.css` 27346-27355 (gate cards in the 320px column), 27357-27364.

**Today under a look**

1. Bar: project, Workshop, "Change #N". Matches v2.
2. Head: the change's title, one line "Change #N · category", ⋯.
3. Words column: summary as a card; diagram, description fold, plan card, linked requests, thread items; then
   "Ask Homeroom bot privately" in the standard pill; the stream; the composer.
4. Side column: `.dev-change-status` (kit card: status pill AND the five-stop line from `changeStop`),
   `.dev-change-pair` (Votes and Tested as the product's gate cards wearing the card, name inside each card),
   `.fr-topicside` (About: author, time · via, topic).

**Gap to v2**

1. Head: "Change #N" over the title (same `over` slot as the request). `ChangeBar` already has both strings.
2. Status card: pill only. Remove the `Track` (pass `at={null}`; `TopicFrameStatus` already skips it), add the
   "Status" label. `changeStop` then has no caller: delete it and its test. The pill's words are `v.status.label`
   ("Live · 1 yes" comes from there); a green pill wants a check glyph (`Pill` has no icon slot).
3. Remove About (`change-head.tsx` 777-786) and `.fr-topicside` from the side-stack parts (679). Its facts move
   into the summary card: a by-line row (28px avatar, author in bold, "time · via") at the top of "The change"
   card. The data is already on the page and only hidden: `.messages-message-head` (author, `<time>`,
   `.dev-change-via`, 716-720) is put away by `app.css` 27344. Either un-hide and restyle it for the change page
   only (`.dev-change-root`), or draw a kit by-line from `v.author`, `v.time`, `v.via`, `swatchFor(v.author)`.
   The category has no place in v2's change page; see open questions.
4. Section labels: "The change" over the summary card; "Votes" and "Tested" as labels over their cards instead of
   names inside them. `GateCard` has the words (`shown.name`; `changes:page.votes.name`,
   `changes:page.testing.name.tested` and its siblings). Cheapest: keep `GateCard`'s markup and, under a look,
   lay `.dev-change-gate-name` out as the label above the card by CSS (it is the first child of the head), with
   the figure ("Voted in", "All checks passed") staying inside as the card's top line with its check. The cards
   are separate measured parts already (`.dev-change-pair` is one part: its two or three cards stack inside it).
5. "Ask Homeroom bot privately" as the kit's quiet small button, in the words column directly under the summary
   card (today it follows the gates in source order; in the words column it already lands after the summary's
   siblings). Wear `btn quiet sm` on `[data-work-with-bot] button`, or draw `Btn kind="quiet" small` under a look.
6. Replies: the heading as a `.cap` label ("No replies yet" from `project:topic.change.stream.noReplies`), the
   stream in one card, events as `.evt` lines with small icons (the `ChangeEvent` rows; same wear root as the
   request's). "Try it" inside "The preview is ready" stays the product's link.
7. Keep what the standard page has and this one change does not show: diagram, `SummaryMore`, upstream card,
   stale note, plan card, `IncludedIn`, `IssueAssociations`, `ThreadItems`, `CodeMissingNotice`, `StackNotice`,
   `MergeCard`, `UpstreamDecline`, `ShotsCard` (before and after, when the change shows something).
8. Phone: Status, Votes and Tested first (`.stack.first`), as for the request.

**Kit/CSS needs**

- `Head` `over` and `.cap.over` (shared with the request).
- A by-line class (mock `.gC-by`: avatar, bold name, muted "time · via", padded 16px 16px 0) is not in `kit.css`.
- The mock's gate (`.gC-gate`: green top line with check, 8px bar, 13px note, button row) is a mock-only class;
  the product's `.dev-change-gate` already wears the card, so no kit component is needed if 4 is done by CSS.
- `Pill` icon slot (check before "Live · 1 yes").

**Tests that pin it**

- `tests/request-frame.test.js` 79 ("its votes and checks in the context column") and 133 (the status card and
  `changeStop`).
- Read `change-head.tsx` by string: `tests/change-thread-page.test.js`, `change-merge-gate.test.js`,
  `change-page-live-states.test.js`, `change-vote-facts.test.js`, `change-votes-in-view.test.js`,
  `proposal-body-details.test.js`, `proposal-code-missing-render.test.js`, `proposal-stacked-render.test.js`,
  `shots-failed-change.test.js`, `unified-change-detail.test.js`, `versions-ui.test.js`, `vote-row-card.test.js`,
  `needs-you-change-page.test.js`, `work-with-bot.test.js`.

**Size**: M. Mostly removals and CSS once the request page's shared pieces exist. **Risks**: not verifiable on the
local copy (the plan, line 236: every change address there lands on its request's page), so it is held by tests
only; `ChangeGates` sticks its pair on a phone (`data-stick`), which must still work when the pair moves first.

---

## s38-app-running

**Files**

- Chrome: `frontend/src/features/frame/frame-app.tsx` (`FrameApp` 102: the chrome is up only while
  `platform-tabs` is published visible; `FrameChrome` 115; crumbs 137-144; bar 286-322).
- Standard: `frontend/src/features/header/in-app-actions.tsx` (`InAppControls` 78, `#header-in-app-suggest`,
  `Improve.giveFeedback({ target: 'app' })`, shown by `useInAppShown` from `improveStore`);
  `public/js/app.js` `_syncPlatformTabs` 6964 (`inApp`, `railPinned`, publish at 7011);
  `frontend/src/features/app-frame/` (the app's own frame, untouched).

**Today under a look**

- Desktop (768px up, "Keep sidebar open in apps" on, the default): the tabs stay published, so the kit's chrome is
  up: sidebar, bar, and the app beside and under them. The bar says the project's tile and name only: the trail
  adds a place word only from `placeStore` (`here`), and the App tab publishes none, so "App" is missing (and a
  stale place from the same project's page could show). There is no Suggest in the kit's bar; the standard header
  that carries it is hidden (`app.css` `html[data-frame-chrome] #platform-header`).
- Phone, or the sidebar setting off: `platform-tabs` is published hidden, `FrameApp` returns `GuestFrame`, which
  draws nothing for a member. The app runs in the standard header and full screen: no look at all.
- No title, sentence, "Full screen", "Ask for a change" or side column are drawn. Nothing to remove.

**Gap to v2**

1. Bar trail: add "App" after the project while the running app is up. In `FrameChrome`, read the app tab
   (`App.currentTab === 'app'` is what `_syncPlatformTabs` uses; `improveStore.tab === 'app'` is the React-side
   copy) and use `placeName('app')` or the place list's own word for the App row
   (`features/dev-board/workshop/project-places.tsx`); ignore `placeStore` while on the app tab.
2. Suggest in the bar on a desktop: a `Btn kind="line" small` with class `d`, before the search button, shown by
   the same rule as `useInAppShown()` (export it) and pressing `Improve.giveFeedback({ target: 'app' })`. Words:
   `core:header.inApp.suggest`, `core:header.inApp.suggestLabel`. The standard rule also shows it on the project's
   other pages; v2's other project mockups (group b) decide whether the kit bar does too.
3. Phone: v2 draws the frame's bar and tab bar around the app. Today the product gives an app the whole phone
   screen and takes the tabs away. See open questions before building this.

**Kit/CSS needs**: none (`.btn.line.sm`, `.d` exist). The mock's 16px gutter around the app on a desktop
(`.gC-app{padding:0 16px 16px}`) is the stand-in's; the product keeps no gutter around a running app (`rail-pinned`).

**Tests that pin it**: `tests/frame-app.test.js`, `tests/in-app-actions.test.js` (+ `tests/fixtures/in-app-actions-api.ts`),
`tests/request-frame.test.js` 49 (the trail's order).

**Size**: S for 1 and 2. **Risks**: `frame-app.tsx` reads the shell's header by node (`useNodeText`,
`useNodeShown`); the app tab is known to `app.js` before React, so read a store, not `App.currentTab`, in render.

---

## s39-discover, s40-discover-full, s41-app-detail: RETIRED

- **s39, s40**: nothing of the kit draws Discover. `#apps` and `#discover` are rewritten to Home in
  `public/js/app.js` 5723-5740 (and the prerender map at 10186-10189); Home's kit page
  (`features/home/frame/home-frame.tsx`) holds Pinned apps, Pinned communities, Featured and Communities to join.
  Nothing to remove.
- **s41**: nothing of the kit draws an app's detail page. `#apps/<slug>` is rewritten to the project's Hub
  (`App._hubHref`, `AppView._landOnHub`, same block). Nothing to remove.

---

## s42-make

**Files**

- Kit: none. `app.css` 27258-27275 places the standard screen in the frame's page area
  (`html[data-skin][data-frame-chrome] .platform-kb-surface.platform-under-header`); the title wears the kit's
  (`looks.json` wear `title` → `#first-session-make-title`).
- Standard: `fs/make.tsx` `MakeScreen` 384 (all the form's state is local: 420-470; `make()` about 650-710;
  render 744-1062: ✕ 761, title 796, ideas 804-846, brief card 848-966 with the template sentence, choices,
  `SpeakButton` 959, name 969-988, speed line 996, `MakeRuleLine` 1006, allowance 1007, error 1008, Make it
  1010-1021, import link 1024-1033, `MoreSheet` portal 1051). `frontend/src/features/who-decides/make-rule.tsx`
  (`MakeRuleLine` 157: the line 189, ⓘ 208 opening the "What happens next" tip 227, Change 218 opening the rule
  sheet 117). `fs/more-sheet.tsx`, `fs/examples.ts`. Mounted by `fs/index.tsx` 1643/1669 (`underHeader` 1593).

**Today under a look**: the product's form as it is (centred 576px column: ✕, title, "Start from an idea" and four
tiles, the brief and name in one white card, speed line, the rule line with ⓘ and Change, Make it full width,
"Import from a GitHub repo" link), on the look's ground, with the kit's title type. The bar says whatever the
header says (Home); no "New project" in the trail.

**Gap to v2** (from Create only, `entry === 'create' && underHeader`; the first session's Make keeps the whole
screen and its own look)

1. Bar: publish the trail with `useFramePage([t('core:tabs.home'), t('home:create.label')], leave)` ("New
   project" exists as `home:create.label`); under a look drop the ✕ (761-771), since the bar's back is the way
   out (`leave`).
2. Head: `Head title={makeTitle(entry, who)}` with acts: "Import from a GitHub repo" (`Btn kind="line"`, desktop
   only, `setMode('import')`, `onboarding:firstSession.make.importLink`) and "Make it" (primary, submits the form;
   `making` while busy; disabled by `dictating || busy || quotaBlocks`). No sentence under the title.
3. Two columns (`Cols`). Main:
   - Sec "Start from an idea" (`onboarding:firstSession.make.startFromIdea`): four cards in a 2 by 2 grid, each a
     wrapped row (lead = the tile's emoji or `TierChart`, title = `t(example.short)`), pressed state from
     `picked`; handlers `pickTemplate(example)` and `setSheetOpen(true)` for the fourth; keep
     `data-first-session-example` and `aria-pressed`.
   - Sec "Your idea" (new catalog id): one card of two fields. "What should it do?"
     (`…make.briefLabel`): the textarea `#first-session-brief` with `SpeakButton` inside the box, OR, when a
     template is picked, the sentence with its blank and choice chips (`data-make-sentence`, `#make-words`,
     `data-make-choice`, "Write it yourself"). The mock shows only the plain box; the template mode must be kept.
     "What should we call it?" (`…make.nameLabel`, `#first-session-name`). Hints and errors as the field's hint
     line (`missing`, `needed`, the waitlist and search idea lines).
   - Under the card: the speed line (`makeSpeed`, `SPEED_LINE`, `data-make-speed`), the allowance row, the error.
   - Phone only: the import link under the stack (`.gC-under.p`), since the head's import button is desktop only.
4. Side column: Sec "Who can change it" (new id, or the rule sheet's title `…make.rule.title` "Who can change
   it?" without its question mark is not the same string: add one): a card of two rows. Row 1: title
   `presetName(rule, who)`, right `Btn kind="quiet" small` "Change" (`…make.rule.change`) opening the rule sheet.
   Row 2: "What happens next" (`…make.next.title`), a chevron, opening today's note (the tip at
   `make-rule.tsx` 227). `MakeRuleLine` keeps both the sheet and the tip inside itself: split it so the sheet
   (`RuleSheet`, 117) and the tip's body can be opened from the kit rows, or give `MakeRuleLine` a `variant="rows"`.
5. Remove under a look: the full-width Make it at the foot and the centred title block (their jobs moved to the
   head). Keep `data-make-submit` on the head's button; Return in the name field must still submit.

Build it as a second render branch inside `MakeScreen` (the state and handlers cannot be reached from outside),
or first lift the form's state into a `useMakeForm()` hook that both renders call. The second is cleaner and
larger.

**Kit/CSS needs**

- `Field` (`kit.tsx` 517) is an `<input>` only: needs a textarea form (`.inp.area` exists in `kit.css` 203) and an
  `after` slot inside or beside the box (the microphone; Check on the import form). Mock: `.gC-field`.
- An ideas grid (mock `.gC-ideas`: two equal columns, 8px gap, no margin between cards) and a pressed state for a
  card (the product lights the picked tile with a 2px accent ring; `.row.on` exists for rows, nothing for a card).
- The speed line (mock `.gC-speed`) and the centred under-link (`.gC-under`): small, but not in `kit.css`.
- A kit sheet for the rule and "Something else…" would be consistent (`Sheet` exists, `kit.tsx` 566); the plan
  made the product's sheets solid under a look (`--fr-solid`) instead, which is enough for v2.

**Tests that pin it**: `tests/make-frame.test.js` (the CSS rule and the two root class strings),
`tests/first-session-make.test.js`, `first-session-under-header.test.js`, `make-screen-leaves.test.js`,
`create-front-door.test.js`, `create-description-limit.test.js`, `keyboard-surface.test.js`, `page-lock.test.js`,
`who-decides-model.test.js`, `app-templates.test.js`, `app-sketch.test.js`, `app-creation-quota-display.test.js`,
`app-allowance-server-limit.test.js`, `error-text-red.test.js`, `first-run-safari-toolbar.test.js`,
`release-link-straight-flow.test.js`, `return-to-next.test.js`, `transition-glitches.test.js`,
`no-glass-one-scheme.test.js`, `shell-id-inventory.test.js` (ids), `language-extraction.test.js` (new ids).

**Size**: L. A 1,064-line screen with two input modes, dictation, a kept draft, keyboard avoidance and about
twenty suites reading its source. **Risks**: `MAKE_ROOT*` class strings and the scroller's constant `className`
are pinned and the keyboard surface is attached to that scroller (`data-first-session-make-scroll`); the arrival
motion (`ARRIVING`/`ARRIVED`) and `usePageLock`; `underHeader` is read from `#platform-header`'s client rects,
which the chrome keeps laid out but invisible (works today, fragile); the plan records a ruling "Make keeps its
form" (line 431), which v2 overturns.

---

## s43-make-import

**Files**: `fs/import-repo.tsx` `ImportForm` 130 (state 141-153, `check` 156, `go` 180, URL field 205-241, Check
button 242-250, status line 252-260, name 262-277, `repoNote` line 279, Import it 283-293, "Describe a new
project instead" 294-298); mounted by `fs/make.tsx` 777-791 with the `header` (title `IMPORT_TITLE`, line
`IMPORT_LINE`). No kit file.

**Today under a look**: the product's form in the frame's page area: centred title and sentence, one white card
(URL with Check, the status line, the name), the note about the repo, Import it full width, "Describe a new
project instead".

**Gap to v2**

1. Bar trail "Home › New project": the same `useFramePage` call as s42 (it lives in `MakeScreen`, so one call
   covers both modes).
2. Head: title `t(IMPORT_TITLE)`, purpose `t(IMPORT_LINE)`, acts: "Describe a new project instead"
   (`Btn kind="line"`, desktop only, `onDescribe`, `onboarding:firstSession.import.describeInstead`) and "Import
   it" (primary, `go`; `importing` while busy; disabled by `busy || blocked`). The head sits outside `ImportForm`
   today (`header` prop) while `go` and `busy` are inside it: either let `ImportForm` draw the kit head itself
   under a look (a `frame` prop), or lift `go`/`busy` up.
3. One column, narrow (mock `.inner.narrow`). Sec "Repository" (new catalog id) with one card of two fields:
   - "GitHub repo URL" (`…import.urlLabel`): link icon, `#make-import-url`, and beside the box a
     `Btn kind="quiet" small` Check / Re-check (`…import.check`, `…import.recheck`, `data-make-import-check`,
     disabled while checking). Hint line = today's `#make-import-status` (`role="status"`, `data-import-state`):
     green `ok` after a pass (`…import.hasAccess`), red on error or a missing repo, the default
     `…import.inviteBot` line otherwise, with the spinner while checking.
   - "What should we call it?" (`…import.nameLabel`, `#make-import-name`, the `needed.name` hint).
4. Keep, though the mock's one state does not show them: the repo note (`repoNote`, `data-make-import-note`), the
   allowance row, the error line. v2 drops only v1's "What we found" and the numbered steps, which the product
   never had.
5. Phone: "Describe a new project instead" as the link under the card. Remove the foot's full-width Import it
   under a look.

**Kit/CSS needs**: `Field` `after` slot (shared with s42); a narrow page (`PageBody` has `wide`, nothing narrow;
`kit.css` has no `.inner.narrow`); `.hint.ok` and `.hint.bad` exist.

**Tests that pin it**: `tests/create-app-repository-url.test.js`, `tests/first-session-make.test.js`,
`tests/create-front-door.test.js`, `tests/error-text-red.test.js`, `tests/make-frame.test.js`,
`tests/shell-id-inventory.test.js`.

**Size**: M (S once s42's head, trail and `Field` slot exist). **Risks**: the URL field is canonicalised on blur
and Return checks or moves on; keep the same input element and handlers, only its wrapper changes.

---

## Shared work (do once)

1. `Head` gains `over` (a small-caps line above the title) and `kit.css` gains `.cap.over`; `TopicFrameHead`
   passes it. Used by s32 to s35.
2. Remove `TopicFrameAbout`, `topic-follow.ts`, the `.fr-topicside` rules and the five `project:frame.topic.*`
   ids. Used by s32 to s35.
3. The stream dressed by the wear map: reply-count heading as a section label, the stream in a card, events as
   `.evt`. One change serves the request page, the change page and (check with group b) a channel.
4. Side column on a phone goes first (`order`), for both item pages.
5. `Field`: textarea form and an `after` slot. Used by s42, s43.
6. `useFramePage` trail "Home › New project" in `MakeScreen`; head buttons replacing the foot's primary button.
   Used by s42, s43.
7. `tests/request-frame.test.js` and `tests/make-frame.test.js` rewritten once each, after the code settles.

## Suggested order

1. Shared 1, 2 (small, unblocks both item pages).
2. s34/s35 (M): mostly removals; proves the head, labels and by-line.
3. Shared 3, 4, then s32/s33 (L): the status split and the side Status from the bot's track.
4. s38 (S): "App" in the trail and Suggest in the bar.
5. Shared 5, 6, then s43 (M), then s42 (L): the import form is the smaller proof of the Make head and fields.
6. s39 to s41: nothing.

## Open questions

1. **Request page, who asked.** The standard page says the asker and when over the title
   (`.messages-message-head`); v2 removes About and shows neither. Content "from the product as it is today"
   would keep them (for example as a by-line in "The request" card, as the change page's card has). Confirm.
2. **Category/topic.** The standard bars show the category under the title on both pages; v2 shows it nowhere
   (the two sample items may simply have none). Keep it (where?) or drop it.
3. **Request with no bot track.** The mock shows only a tracked request. Proposed above: main card = sentence and
   action, side = stage pill and five stops. The standard page then shows four stops (Asked, Spec, Built, Voted
   in), not five; the kit's five-stop mapping (`frameStop`) is an invention of the first build. Confirm which.
4. **A change inside a request's page** (the usual case) keeps the standard section (`thread-changes.tsx`): no v2
   mockup covers it. Its Votes and Tested cards stay in the words column.
5. **Running app on a phone.** v2 draws the frame's bar and tab bar around the app; the product gives the app the
   whole screen there and unpublishes the tabs (`_syncPlatformTabs`), which also takes the kit chrome down.
   Showing the kit's bar means changing that decision in `app.js` for a look, and the tab bar would cover the
   app's foot. Is the phone meant to change, or only the desktop?
6. **Suggest on other project pages.** The standard header shows Suggest on every page of a project, not only its
   App tab. v2's s38 shows it; whether the kit bar shows it on the Hub, Workshop and item pages depends on those
   mockups (s32 and s34 do not show it).
7. **"What happens next"** is a hover/press tip on ⓘ today; as a row it needs something to open (a kit sheet, or
   the row unfolding in place). Not specified.
8. **Template mode in Make** (a picked idea turns the brief into a sentence with a blank and chips) has no v2
   drawing. Assumed kept inside the "Your idea" card.
