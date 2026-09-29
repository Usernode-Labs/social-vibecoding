# Logged-out screens: landing and sign-in in the shell's language

Date: 2026-09-18
Status: Built. Slices A–D implemented on branch claude/mobile-logged-out-eval-023c86 from base
a8158e1e, 2026-09-18. 246 mapped suites green (4516 tests, 0 failures), no console errors on any of
the four screens. Owner decisions 1–6 confirmed 2026-09-18; decisions 7–13 below were taken during
the build, 10–12 by the owner against the rendered screens.
Design authority: https://claude.ai/artifact/Qdoe7vKzmubxkAunJBedWD (version 11).
Boards 1–4 are the target. Board 5 is a reference copy of today's Home and is
not a change request except for its header wordmark.

## Problem

Signed-out, the app shows a website: a 52px header with two 28px chips, a
"Homeroom" heading over an italic tagline, a 67-word pitch card, a 36px
"Join the waitlist" button 560px down, and then 41 app tiles of which 36 are
locked and captioned "Account required". Measured on production at 375×812 on
2026-09-18: total scroll 3328px, four screens, three of them locked tiles.
The sign-in screen repeats the heading and tagline, and its primary button
says "Log in" while the alternate path says "Sign in with an email code".

The logged-in Home is a different product visually: warm ground with the
pastel auras, 800-weight sans headings, blue pills, white grouped cards. The
hand-off from sign-in to Home is a jump between two designs.

## Goal and scope

Four screens, all in the shell's existing language, with only two brand
elements added: the logotype and the people illustration.

1. **Landing.** Wordmark in the header. Illustration. A row of activity chips
   that runs off the right edge. Eyebrow "Opening gradually", heading "Come
   build the next version with us.", one sentence. Two pills at the bottom:
   "Join the waitlist" (primary, opens the marketing waitlist page) and
   "Sign in" (secondary), then one text line "Already joined? Check your
   status". No pitch card, no app grid, no header chips.
2. **Sign in.** Back disc, wordmark centred, heading "Sign in". Today's white
   grouped card and field order. Primary pill, then "Forgot password?" and
   "Sign in with an email code" as white pills. "Have an activation code?
   Register" as a text line at the bottom.
3. **Sign in with email.** Heading, the sentence "We'll email you a 6-digit
   code to sign in. New here? You'll get an account and a place on the
   waitlist.", one field, "Email me a code", "Sign in with a password" as the
   way back.
4. **Check your email.** Heading, the address echoed, "It expires in 10
   minutes", one code field, "Verify code", "Send a new code", "Wrong address?
   Go back".

The waitlist form itself stays on the marketing site. The app's `#waitlist`
screen is untouched and stays reachable from emails and deep links, but the
landing no longer points at it.

## How the designs become gates

A slice is done when it passes all of these. None is optional and none is
satisfied by a metric alone.

**Gate 1, the side-by-side.** Before submitting a slice, render the staging
build at 390×844 in light and dark and place each screenshot beside the
export of its board (the canvas's download button). The pair goes into the
proposal's description. The reviewer checks, per board, the eight properties
in the checklist below. A mismatch is a bug in the slice, not a note for
later. This is the rule recorded in memory after #2370: verify fidelity, not
quantity.

Checklist per board:

- Ground: `#f4f2e4` with the three auras from `app.css` in light; the dark
  triple in dark. No white page behind the content.
- Header: the `#landing-header` invariant holds (pt-2, pb-4, 28px lead, no
  height class). Wordmark height 28px on the landing, 24px on sign-in.
- Type: heading 30/34 800 on the landing, 28/32 800 on sign-in; body 16/22
  zinc-500; eyebrow 13 600 uppercase tracking 0.8px.
- Controls: primary pill 50px `violet-600` white 17/600; secondary pill 44px
  white 16/600; card radius 20px; field label 13 zinc-500, value 17.
- Spacing: 20px side gutter, 10px between stacked pills, 34px above the home
  indicator.
- Content: no element on the screen that is not on the board. No element on
  the board missing from the screen.
- Touch: every control at least 44px tall including the back disc's hit area.
- Console: no error on load or on the route change, in both themes.

**Gate 2, declared visual evidence.** Each proposal declares
`visual_evidence` stories in `submit_build` (`src/cli/main.js`, schema at
`visualEvidenceIntentSchema`): one story per board it changes, viewports
390×844 and 1280×800, `startPath` the real hash route, `steps` the real taps,
`checkpoint` the board's name. The pipeline replays these against base and
head. Open issue: the persona enum is `member | read_only_admin`; the landing
is anonymous. Confirm with the pipeline owner whether a member story that
starts signed out reaches `#landing`, or whether an `anonymous` persona is
needed. Until answered, the landing story starts at `#login` and backs out to
`#landing`.

**Gate 3, declared checks in `dapp.json`.** The checks live in the top-level `tests` array
(690 entries), read by the hand-written `readTestsWithMeta` in `src/services/app-manifest.js`, which
silently DROPS a malformed entry. `checkKey` hashes `name\npath`, so renaming a check retires it and
the replacement is advisory until ten consecutive passes — change `expectText`/`expectSelector`
freely, but rename only when the check's subject genuinely changed. Three checks select on landing
or sign-in markup this change moves:

- "Guest back arrow returns to the app directory (#1028)" (line 573). `expectText` becomes the new
  landing heading; the selector and the name are unchanged, so it keeps gating. **This check was the
  spec's one blocker and could not be fixed in `dapp.json` alone:** its
  `#app-viewer.hidden[data-anon-back="done"]` marker is stamped only at the end of `runAnonBackShot`,
  which opened the viewer by CLICKING a tile inside `#landing-apps`. With the grid gone it bailed
  `no-tile` and the check — at index 1 of the run window — would have failed on every submission.
  Slice B drives the shot through the live `openLandingApp` seam instead and degrades the two `zoomFx`
  origin callbacks to null.
- "Landing keeps its compact CTA and account-required apps carry locks (#1522)" (line 1541). Its
  subject is gone, so name and selector are both rewritten and it is knowingly advisory for ten
  builds. The selector may NOT name `#landing-apps` even inside `:not(:has())`:
  `tests/dapp-selectors-resolve.test.js` extracts every `#id` from the whole string and fails on one
  that was in the frozen baseline and no longer renders. It pins the live pill instead.
- "Landing offers the check-my-status way in (#1538)" (line 1695): untouched, per decision 3.

Sign-in: the spec's original numbering was wrong. The real "Log in" check is at **line 4121**, not
1596 — 1596 is a closing brace inside an unrelated `#waitlist` check. Changing its `expectText` alone
would have made it VACUOUS, because `expectText` is a case-insensitive substring of the whole
`document.body.innerText` and the page already renders "Sign in with an email code". Its
`expectSelector` therefore also pins the filled submit button. Its name still says "Log in" — kept
deliberately, because the name is the check's identity and renaming would cost its gating status.
The two pill checks (4128, 4135) and the code-step checks (3706, 3712) pass untouched.

**Gate 4, the node tests that pin this markup.** These are rewritten to the
new design in the same commit as the markup, never loosened:

- `tests/header-height-parity.test.js`: the header shape assertions stay
  exactly as they are. The CEILING test that counts three anchors inside
  `#landing-header-ctas` is rewritten: the header carries no CTAs any more, so
  the test asserts the wordmark's 28px box and that no anchor sits in the bar.
- `tests/landing-directory.test.js`: the tests named "landing CTAs: Sign in +
  Join waitlist only", "the landing CTA area is a compact CTA + link", "landing
  directory uses the homescreen launcher-grid shape" and the header-keeps-CTAs
  test describe the old screen and are replaced by tests of the new one. The
  `#app-viewer` and pull-to-refresh tests stay, because deep links to public
  apps still open in the viewer.
- `tests/shell-id-inventory.test.js`: every retired and added id is recorded
  in `RETIRED_IDS` / `ADDED_IDS` with a reason. The baseline is not refreshed.
- `tests/theme-ink-guards.test.js`: every new class pair carries its `dark:`
  twin.
- Three files the spec missed, found by reading the sources rather than the spec:
  `tests/offline-session-boot.test.js` slices the landing interior from `id="landing-waitlist-cta"`,
  so retiring that id made `indexOf` return −1; `tests/landing-auth-required.test.js` extracts
  `openLandingApp` by source text including its literal dependency array; and
  `tests/home-browse-header.test.js` compares the Home and Browse headers by string substitution,
  which cannot hold once one draws a graphic and the other a word.
- `tests/shell-icon-set.test.js` asserts every `d=` in the prerendered document comes from
  `icons.tsx`. Slice A widens only the STRAYS test to read `wordmark.tsx` as a second legal home;
  `modulePaths()` itself is untouched, because it also computes an exact `absent` list that would
  otherwise churn across three proposals.

**Gate 5, the copy pins.** Strings the tests hold: "Log in" (dapp 1596),
"Forgot password" (4128), "Sign in with an email code" (4135), the cooldown
templates in `tests/signup-invite-link.test.js`. A wording change is a
decision below, not a side effect.

## Work breakdown

Each slice is one native proposal through the `usernode-proposal` skill.
Slice A is a prerequisite for B and D.

**A. Brand assets as shell primitives.**
Files: `frontend/@/components/ui/wordmark.tsx` (new), `public/brand/people.png`
(new), `public/brand/README.md` (provenance, like `public/vendor/README.md`).
The wordmark is the eight paths exported from the Figma logotype node
(1246:118 in file 4kAYqXh9NhpoCU44QwWvYo), inlined as an SVG component with
`fill="currentColor"`, so it takes the ink of wherever it sits and needs no
dark variant. The illustration is the "people" node (1246:166), exported at
2x. Gate: the component renders in light and dark with no console output;
the new files are listed for the service worker only if the shell precaches
images today (check `SHELL_ASSETS` in `public/sw.js`).

**B. Landing.**
File: `frontend/src/features/auth/landing.tsx`. Keep `#auth-landing-screen`,
`#landing-header` (with its invariants), `#landing-back-btn`,
`#landing-header-title`, `#auth-landing-scroll`, `#app-viewer`,
`#app-viewer-frame` and the viewer mechanics. Replace the header's title text
with the wordmark. Retire `#landing-header-ctas`, `#landing-signin-cta`,
`#landing-waitlist-cta`, `#landing-back-to-waiting`, `#landing-waitlist`
(the card), `#landing-cta-queued`, `#landing-apps`. Keep
`#landing-waitlist-link` as the primary pill and give it the marketing URL,
with `target="_blank"` so the native shell's delegated listener hands it to
the bridge's `openExternal` and the system browser opens it (decision 6).
Keep `#landing-status-link` as a text line under the pills, same href and
text. Add the illustration, the chip row, eyebrow, heading, sentence, and
the "Sign in" secondary pill (`href="#login"`).
The marketing URL reaches the client through `GET /api/public/waitlist/options`,
which the landing already warms on show: add `waitlistUrl` built from
`config.marketingBaseUrl` and `MARKETING_WAITLIST_PATH` in
`src/services/marketing-links.js`. No hard-coded host in the frontend.
`loadLandingApps` stays, because a `/app/<slug>` deep link for a public app
still needs the directory to open the viewer; it no longer renders tiles.
The chip row ships with the four lines from the brand frame as static copy
(decision 4). The illustration sits straight on the ground in both themes;
the dark reading is judged at gate 1 (decision 5). Gate: board 1, both
themes, plus gates 3 and 4 above.

**C. Sign-in.**
File: `frontend/src/features/auth/login.tsx`. Replace the `<h1>Homeroom</h1>`
and tagline with the wordmark and a `<h1>` per step ("Sign in", "Sign in with
email", "Check your email"). Card, ids and field order unchanged. "Register"
moves from a pill to a text line; `#register-link` keeps its id. In the OTP
code step, echo the address in `#otp-email-echo` as the board shows and keep
`CODE_SENT_MSG` as the expiry line. The primary button says "Sign in"
(decision 1). The email step's sentence becomes "We'll email you a 6-digit
code to sign in. New here? You'll get an account and a place on the
waitlist." (decision 2: `email-signup.js` creates the account and links it to
the waitlist by email, so a non-admitted person lands in the waiting room).
Gate: boards
2, 3 and 4; dapp 1596, 4128, 4135, 3708, 3714;
`tests/email-code-password-account.test.js`,
`tests/password-visibility-toggle.test.js`, `tests/password-reset-ui.test.js`.

**D. Home header wordmark.**
File: `frontend/src/features/header/app-switcher-chip.tsx`. When the chip
names the platform itself, `#app-switcher-name` renders the wordmark at 20px
in the chip's ink; inside an app it renders the app's name as today. The pill
stays `h-7`. Gate: board 5's header only; the existing `#app-switcher-btn`
checks pass; the chip's accessible name stays "Homeroom".

Not in scope: the `#waitlist` screen, the OTP set-password step's look, wallet
sign-in, the Google Play install strip (Chrome only, never shown in the native
app), the `?shot=anon-back` screenshot state beyond keeping it green.

## Decisions (confirmed by the owner, 2026-09-18)

1. **Primary button says "Sign in."** One verb everywhere. dapp 1596's
   expected text changes in the same proposal.
2. **The email-code sentence is rewritten** to "New here? You'll get an
   account and a place on the waitlist." The code creates the account and
   links it to the waitlist by email; access still waits for admission.
3. **`#landing-status-link` stays** as a text line under the pills, same
   href, same text. dapp 1694 is untouched.
4. **Chips are static copy for now:** the four lines from the brand frame.
   A live public feed is a separate, later proposal with its own privacy
   decision.
5. **Illustration as is in dark mode**, judged on staging at gate 1. A tinted
   plate is the fallback if it does not read.
6. **"Join the waitlist" opens the system browser** through the bridge's
   `openExternal`, which the shell's delegated `target="_blank"` listener
   already provides. No new bridge work.

### Taken during the build

7. **The server field is `waitlist_url`**, snake_case, matching its seven siblings and the published
   integrator contract — not the spec's original `waitlistUrl`. It is never nullable.
8. **The waitlisted session keeps an affordance.** Board 1 draws only the anonymous state, but a
   signed-in, not-yet-admitted visitor still reaches `#landing`, and "Join the waitlist" and
   "Sign in" are both wrong for them. `#landing-back-to-waiting` survives as their single primary
   pill to the waiting room; `#landing-cta-queued` is retired.
9. **The primary pill has no href until the server answers**, and is hidden rather than shown inert.
   A fallback would have to hard-code the marketing host, and pointing at `#waitlist` for a tick is
   the one destination this design removes.
10. **The chips keep the built COPY and wear the Figma frame's LOOK** (owner, in two passes against
    the rendered screen). The four how-it-works lines stay, and "Access opens in batches, and we'll
    email you when your spot is ready." stays: the board's four named activity lines are not shipped,
    because a static strip of invented member activity reads as a live feed and is not true. The
    style is the brand frame's exactly — square corners, a 1px zinc-950 hairline, white ground, the
    36px height, the 8px gap, a 34px gradient block per chip, the 15px label, the 2px/2px hard
    shadow, and the row bleeding past the right edge. The gradients ride in an inline `style`
    because seven colour stops is not a class literal anyone can read. Dark mode is a judgement the
    frame does not answer: zinc-900 ground, a zinc-600 hairline and a black shadow, keeping the
    graphic character without making white boxes the loudest thing on a near-black screen.
11. **The side gutter is 16px on all four screens** (owner), matching `#landing-header`'s locked
    `px-4` parity class, rather than the boards' 20px. Gate 1's checklist line is amended to 16px.
12. **Sign-in keeps production's floating back disc** (owner) rather than the boards' header row, so
    `data-auth-back` and the `app.css` rules keyed off it are undisturbed.
13. **`public/brand/people.png` is precached.** The shell already precaches images (the three PWA
    icons), so the spec's conditional is satisfied. It is a two-part edit — the `SHELL_ASSETS` entry
    AND a matching `classifyRequest` `/brand/` rule — because an entry alone is install bandwidth
    nothing reads. `SW_VERSION` goes to v32 in the same change, per the worker's own v10 rule.

## Known deviations from the boards

Each was measured by rendering the built screen through the real cascade and putting it beside the
board export. All are accepted; none is an open bug.

- 16px gutter, not 20px (decision 11).
- The chips' copy and the landing sentence (decision 10). Their STYLE now matches the frame exactly.
- The sign-in heading is left-aligned under a centred mark, which is what boards 2–4 draw; the build
  had centred it until the boards were re-read.
- Sign-in's floating back disc rather than a header row (decision 12).
- Board 4 draws "We sent a 6-digit code to [address]. It expires in 10 minutes." as one sentence; the
  build keeps `CODE_SENT_MSG` intact as its own line, because a declared check asserts that whole
  sentence (decision 10 of the original set).
- Sign-in's bottom line sits under the pills rather than at the foot of the screen. The column is
  shared with the recovery, reset and wallet views, so pinning it would move screens out of scope.

## Rollout

Proposal A first, small and reviewable. Then B and C in either order; D last.
Each proposal's description carries its side-by-side pairs, its declared
stories, and the id ledger changes. Nothing is promoted for voting until its
gate 1 pairs are attached and gates 3 to 5 are green on staging.
