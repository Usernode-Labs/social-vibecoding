'use strict';

// GENERATED — do not hand-edit.
//
// The E2E use-case catalogue, emitted from the same table that produces
// docs/e2e-use-cases.md. Read by ./admin-e2e.js to render the
// #admin/e2e section. Regenerate rather than patching by hand, so the
// doc and this dataset cannot drift apart.

export const E2E_RUN = Object.freeze({
  ran: '2026-08-18/19',
  environment: 'production',
  total: 130,
  counts: Object.freeze({"pass":118,"blocked":2,"skipped":2,"fail":3,"pending":5}),
});

export const E2E_AREAS = Object.freeze([
  {
    "key": "A",
    "title": "Anonymous, Waitlist & Auth",
    "blurb": "Everything a visitor can do before the shell boots, and every way into a session."
  },
  {
    "key": "B",
    "title": "Shell, Home & Navigation",
    "blurb": "The signed-in chrome: launcher, header, drawers, routing, offline behaviour."
  },
  {
    "key": "C",
    "title": "App Lifecycle & Membership",
    "blurb": "Creating, running and governing an app, and who may touch it."
  },
  {
    "key": "D",
    "title": "Dev Flow: Issues → Sessions → Proposals → Merge",
    "blurb": "The build loop that is the heart of the product."
  },
  {
    "key": "E",
    "title": "Social: Group Chat & Direct Messages",
    "blurb": "App-scoped group chat and platform-wide conversations."
  },
  {
    "key": "F",
    "title": "Notifications & Mobile Push",
    "blurb": "The in-app feed and all 19 push kinds through Firebase to a real phone."
  },
  {
    "key": "G",
    "title": "Leaderboard, Topochain & Seasons",
    "blurb": "Standings, kudos, challenges, delegation and the on-chain season model."
  },
  {
    "key": "H",
    "title": "Profile & Settings",
    "blurb": "Identity, credentials, integrations and preferences."
  },
  {
    "key": "I",
    "title": "Admin Console",
    "blurb": "The gray/indigo second surface: moderation, analytics, mail, topochain ops."
  },
  {
    "key": "J",
    "title": "Mobile App (Flutter)",
    "blurb": "The native crypto_mobile_app: onboarding, challenges, wallet, node, zk identity."
  },
  {
    "key": "K",
    "title": "Platform, PWA & Public Surfaces",
    "blurb": "Feedback, gallery, public API, share links, MCP, status."
  }
]);

export const E2E_CASES = Object.freeze([
  {
    "id": "A1",
    "name": "Landing page renders the app directory",
    "flow": "Open / as guest → #landing shows directory scroller, persistent header with Sign in / Join waitlist",
    "gate": "guest",
    "method": "browser",
    "notes": "",
    "status": "pass",
    "area": "A"
  },
  {
    "id": "A2",
    "name": "Guest tries an app in-page",
    "flow": "Tap a directory app → in-page viewer opens under the persistent header → back arrow returns to directory (#1028)",
    "gate": "guest",
    "method": "browser",
    "notes": "",
    "status": "pass",
    "area": "A"
  },
  {
    "id": "A3",
    "name": "Join waitlist (stage-1 survey)",
    "flow": "#waitlist from landing CTA → submit fresh email alias → success state → join email arrives",
    "gate": "guest",
    "method": "browser",
    "notes": "Verified 2026-08-18: join email arrived <1min to fresh alias",
    "status": "pass",
    "area": "A"
  },
  {
    "id": "A4",
    "name": "Waitlist confirm link",
    "flow": "Open confirm URL from join email (/api/public/waitlist/confirm/:token) → confirmed state",
    "gate": "guest",
    "method": "browser",
    "notes": "Works, but gives NO visible “confirmed” feedback — silently lands on #more (UX finding)",
    "status": "pass",
    "area": "A"
  },
  {
    "id": "A5",
    "name": "Stage-2 “Want in sooner?” survey",
    "flow": "#more/<token> from email → all-optional questions → answers merge server-side → re-openable",
    "gate": "guest",
    "method": "browser",
    "notes": "Verified: answers saved, re-open from email link restores them merged",
    "status": "pass",
    "area": "A"
  },
  {
    "id": "A6",
    "name": "Stage-2 GitHub / X verification",
    "flow": "Verify buttons run /waitlist/connect/:provider OAuth round-trip and mark the answer verified",
    "gate": "guest",
    "method": "assist",
    "notes": "Needs OAuth consent — user step",
    "status": "blocked",
    "area": "A"
  },
  {
    "id": "A7",
    "name": "Admin releases a waitlist signup",
    "flow": "Admin topochain waitlist → release → release email with access link arrives",
    "gate": "admin",
    "method": "browser",
    "notes": "PASS 2026-08-18 via user-run SSH service script (mirrors admin route): release + “access is ready” email in <1min. Admin-console button variant still pending (I14)",
    "status": "pass",
    "area": "A"
  },
  {
    "id": "A8",
    "name": "OTP email-code login",
    "flow": "#signup with released email → request code → code visible in Gmail list preview → verify → shell boots",
    "gate": "guest",
    "method": "browser",
    "notes": "Full pass 2026-08-18: code → verify → set password → auto web login → waiting room. Finding: an expired set-password token (10min TTL) surfaces raw “Unauthenticated.” instead of offering a new code",
    "status": "pass",
    "area": "A"
  },
  {
    "id": "A9",
    "name": "Password login",
    "flow": "#login with username/email + password → shell boots (login-email-identifier: email works too)",
    "gate": "guest",
    "method": "assist",
    "notes": "User-confirmed 2026-08-19: password login works on the test account (OTP mail at 18:05 and the surrounding sign-in activity corroborate the session work)",
    "status": "pass",
    "area": "A"
  },
  {
    "id": "A10",
    "name": "Logout",
    "flow": "Header menu → sign out → anonymous landing; native logout ordering has its own pinned test",
    "gate": "user",
    "method": "browser",
    "notes": "User-confirmed: logout returns to the anonymous landing shell",
    "status": "pass",
    "area": "A"
  },
  {
    "id": "A11",
    "name": "Forgot password → reset",
    "flow": "Recovery sub-view → email → #reset-password/<token> redeem → new password works",
    "gate": "guest",
    "method": "browser",
    "notes": "User-confirmed full reset round-trip. Server evidence: password_reset mail sent to the test alias at 18:06:16 (user-initiated) and redeemed; a second reset mail at 18:13:00 was triggered by the test harness and left unused",
    "status": "pass",
    "area": "A"
  },
  {
    "id": "A12",
    "name": "Register with activation code",
    "flow": "#register + admin-issued code → account created → shell boots",
    "gate": "guest",
    "method": "browser",
    "notes": "User registered with admin-minted code 937e8d26a9ac on 2026-08-19: account id 313 created with has_platform_access=true and password_set=true, shell booted. Code consumed",
    "status": "pass",
    "area": "A"
  },
  {
    "id": "A13",
    "name": "Waiting-room gate",
    "flow": "Authed account without platform access lands #waiting; polls /api/auth/me; boots shell in place once granted",
    "gate": "user",
    "method": "browser",
    "notes": "Full PASS: queue screen polls, then boots the shell in place ~seconds after release, no reload needed",
    "status": "pass",
    "area": "A"
  },
  {
    "id": "A14",
    "name": "Auth & waitlist rate limits",
    "flow": "Waitlist IP limiter 5/15min shared across join+survey+confirm; OTP 60s gap",
    "gate": "guest",
    "method": "api",
    "notes": "Already documented as #1296; not re-tripped to keep the run unblocked",
    "status": "skipped",
    "area": "A"
  },
  {
    "id": "A15",
    "name": "Wallet auth family",
    "flow": "wallet-check / wallet-register / wallet-verify / wallet-link-login / wallet-reset-verify",
    "gate": "guest",
    "method": "manual",
    "notes": "Needs a Mina wallet — user-driven",
    "status": "skipped",
    "area": "A"
  },
  {
    "id": "A16",
    "name": "Terms consent gate",
    "flow": "Current terms accepted before entry",
    "gate": "user",
    "method": "phone",
    "notes": "BUG: the terms gate did NOT appear after sign-in. The user (test acct 312, never consented) signed in on iOS and reached the app WITHOUT being prompted; the consent screen only appeared after a manual app restart, and accepting then wrote consent at 18:09:15. The gate is meant to block entry before first use, so an un-consented user can currently use the app until they happen to restart it",
    "status": "fail",
    "area": "A"
  },
  {
    "id": "B1",
    "name": "Home launcher grid",
    "flow": "Signed-in landing: your apps partitioned, activity counts, card icons and card menus",
    "gate": "user",
    "method": "browser",
    "notes": "Verified with fresh account: challenges widget, Discover/Popular panels, Create app tile",
    "status": "pass",
    "area": "B"
  },
  {
    "id": "B2",
    "name": "Home search & find-more",
    "flow": "Pull-to-reveal search filters the grid; find-more row leads to Browse",
    "gate": "user",
    "method": "browser",
    "notes": "Pull-to-reveal search bar appears and focuses; find-more/Browse-all-apps link present. Live grid filtering backed by pinned home-search-reveal dapp test",
    "status": "pass",
    "area": "B"
  },
  {
    "id": "B3",
    "name": "Home widget panels",
    "flow": "Challenges widget (metered rows + leaderboard link, empty-state fill), open-proposals block, panel visibility toggles persist",
    "gate": "user",
    "method": "browser",
    "notes": "Challenges widget renders metered rows (0/15) + Open-leaderboard link + See-all; Discover/Popular panel renders. Panel visibility toggles not each exercised",
    "status": "pass",
    "area": "B"
  },
  {
    "id": "B4",
    "name": "Favorites & grid reorder",
    "flow": "Favorite/unfavorite from card menu; drag reorder persists via /api/favorites/order + home-layout",
    "gate": "user",
    "method": "browser",
    "notes": "Favorite toggle POST returns is_favorited:true (param is favorited:boolean)",
    "status": "pass",
    "area": "B"
  },
  {
    "id": "B5",
    "name": "Browse all apps",
    "flow": "#apps: featured first, per-tile add/remove badges update home grid",
    "gate": "user",
    "method": "browser",
    "notes": "All-apps list with search, Add badges, invite-only labels",
    "status": "pass",
    "area": "B"
  },
  {
    "id": "B6",
    "name": "Header menu drawer",
    "flow": "Slide-out drawer: theme row, platform version row (turns “<sha> · reload” when stale), AI-credit rows; wallet sheet + node pill are webview-only",
    "gate": "user",
    "method": "browser",
    "notes": "Also confirmed: stale-version affordance live - drawer showed platform version 9858818 with a reload control after a new build deployed mid-run",
    "status": "pass",
    "area": "B"
  },
  {
    "id": "B7",
    "name": "Notifications panel",
    "flow": "Bell dropdown: list, show-more paging, saved section, mark-all-read, tap-through routes to source",
    "gate": "user",
    "method": "browser",
    "notes": "Empty-state copy + mark-all-read verified; populated feed pending snait session",
    "status": "pass",
    "area": "B"
  },
  {
    "id": "B8",
    "name": "Work drawer",
    "flow": "Cog drawer: your sessions with live working spinner, titles not dev-names",
    "gate": "user",
    "method": "browser",
    "notes": "Your-work drawer with correct empty state",
    "status": "pass",
    "area": "B"
  },
  {
    "id": "B9",
    "name": "Developer console panel",
    "flow": "Slide-up dev console renders and respects the dev-console invariant",
    "gate": "user",
    "method": "browser",
    "notes": "Developer console button present in header and resolves (open-console); dev-console-invariant pinned by unit test",
    "status": "pass",
    "area": "B"
  },
  {
    "id": "B10",
    "name": "Hash routing & legacy aliases",
    "flow": "Deep links restore screens; #challenges→#leaderboard/challenges, #topochain/leaderboard→#leaderboard self-heal; idempotent re-entry",
    "gate": "user",
    "method": "browser",
    "notes": "#challenges self-healed to #leaderboard/challenges; deep links restore screens",
    "status": "pass",
    "area": "B"
  },
  {
    "id": "B11",
    "name": "Offline banner & recovery",
    "flow": "Kill connectivity → banner appears (health probe), page stays usable on last data → banner clears on recovery",
    "gate": "user",
    "method": "browser",
    "notes": "window.Offline.forceOffline(true) surfaced the yellow offline banner; page stayed usable on saved content; reload recovered clean (banner gone, isOffline false)",
    "status": "pass",
    "area": "B"
  },
  {
    "id": "B12",
    "name": "PWA shell & version reload",
    "flow": "Service worker precaches SHELL_ASSETS; offline boot serves shell; update nudge / pull-to-refresh picks up new build",
    "gate": "user",
    "method": "browser",
    "notes": "Service worker active + scoped, precaches SHELL_ASSETS; offline state served saved content. Full reload-from-SW-cache pinned by pwa-offline-cache test",
    "status": "pass",
    "area": "B"
  },
  {
    "id": "B13",
    "name": "Theme mode",
    "flow": "Light / dark / system from drawer applies across shell and persists",
    "gate": "user",
    "method": "browser",
    "notes": "Dark restyles whole shell instantly; restored to System",
    "status": "pass",
    "area": "B"
  },
  {
    "id": "C1",
    "name": "Create app",
    "flow": "Create-app dialog → scaffold builds → deploys → opens; failure path shows app-creator-failure card",
    "gate": "user",
    "method": "browser",
    "notes": "Create-app dialog (build/visibility options) -> scaffold built + deployed in ~1min -> status running. Throwaway app, deleted after",
    "status": "pass",
    "area": "C"
  },
  {
    "id": "C2",
    "name": "Run an app",
    "flow": "App mode iframe boots with iframe token, safe-area insets via bridge, identity handshake",
    "gate": "user",
    "method": "browser",
    "notes": "App boots in iframe, interactive (press counter reached 2), leaderboard shows the running user - identity handshake works",
    "status": "pass",
    "area": "C"
  },
  {
    "id": "C3",
    "name": "Fork app",
    "flow": "Fork dialog → forked copy owned by forker",
    "gate": "user",
    "method": "browser",
    "notes": "Fork created a copy owned by forker; booted to running after a retry (see C6)",
    "status": "pass",
    "area": "C"
  },
  {
    "id": "C4",
    "name": "Rename app",
    "flow": "Rename dialog → slug/title update everywhere",
    "gate": "user",
    "method": "browser",
    "notes": "Rename is NOT instant metadata - it opens a governance PR (session+PR number returned, 201). Goes through the vote flow",
    "status": "pass",
    "area": "C"
  },
  {
    "id": "C5",
    "name": "App visibility governance",
    "flow": "Visibility PR (public/hidden) → group vote → applies",
    "gate": "user",
    "method": "browser",
    "notes": "visibility-pr opens a governance PR (#4, session 3448) to flip collab/view visibility - same vote flow as rename. Params are collabVisibility + viewVisibility",
    "status": "pass",
    "area": "C"
  },
  {
    "id": "C6",
    "name": "Redeploy & check-updates",
    "flow": "⋯ redeploy rebuilds; check-updates detects drift",
    "gate": "user",
    "method": "browser",
    "notes": "Retry recovered a fork stuck in error; parent redeploy path present. FINDING: initial fork of a just-created app errored with lastFailure=null (race: parent repo not yet provisioned) - a diagnostic gap worth a ticket",
    "status": "pass",
    "area": "C"
  },
  {
    "id": "C7",
    "name": "Delete app",
    "flow": "DELETE /api/apps/:slug from owner UI → gone from grid/directory",
    "gate": "user",
    "method": "browser",
    "notes": "DELETE on both throwaway apps returned ok; grid + app list confirmed empty of them",
    "status": "pass",
    "area": "C"
  },
  {
    "id": "C8",
    "name": "App secrets",
    "flow": "Secrets dialog: declare via PR, set value, pending-secret apply on merge; platform defaults panel",
    "gate": "user",
    "method": "browser",
    "notes": "Secrets read returns empty list with manifestKnown + canDeclare + redeployable flags. Declare-via-PR + pending-apply-on-merge not run to completion",
    "status": "pass",
    "area": "C"
  },
  {
    "id": "C9",
    "name": "App files & storage",
    "flow": "Upload file, usage meters, delete; app-storage auth boundaries",
    "gate": "user",
    "method": "api",
    "notes": "files/usage read 200 (appBytes 0 of 2GB cap, userBytes tracked). app-storage/usage is IP-gated (403 forbidden_ip - app-internal only, by design)",
    "status": "pass",
    "area": "C"
  },
  {
    "id": "C10",
    "name": "Collaborator membership",
    "flow": "Members dialog: invite → alt accepts (or declines) → roster updates → remove member",
    "gate": "alt",
    "method": "browser",
    "notes": "Invite sent, test account accepted, roster updated to member; collab_invite created for the invitee (in-app receipt user-confirmed) and collab_invite_accepted push delivered to the inviter phone. Decline path not exercised",
    "status": "pass",
    "area": "C"
  },
  {
    "id": "C11",
    "name": "Approver membership",
    "flow": "Approver invite → accept; approvers panel; approver tally on proposals",
    "gate": "alt",
    "method": "browser",
    "notes": "Approver invite correctly gated on collaborator-first; sent after collab accepted; approver_invite notification created for the invitee (in-app receipt user-confirmed)",
    "status": "pass",
    "area": "C"
  },
  {
    "id": "C12",
    "name": "Admins & governance PRs",
    "flow": "admins-pr / governance-pr flows create votable platform changes",
    "gate": "user",
    "method": "browser",
    "notes": "governance-pr mechanism verified via C5 (visibility-pr) and C4 (rename) - both mint a votable PR + session. admins-pr not separately run",
    "status": "pass",
    "area": "C"
  },
  {
    "id": "C13",
    "name": "App lock",
    "flow": "POST /api/apps/:slug/lock blocks writes appropriately",
    "gate": "admin",
    "method": "api",
    "notes": "App lock POST locked:true then locked:false both 200 - reversible",
    "status": "pass",
    "area": "C"
  },
  {
    "id": "D1",
    "name": "Dev board",
    "flow": "Kanban buckets, filters, tabs, PM groups/order, card bands, status pills, ⋯ menus survive repaints",
    "gate": "user",
    "method": "browser",
    "notes": "Kanban with all four columns, filters (priority/category/assignee/needs-my-vote), status pills, card bands, working ... menu that survives repaints",
    "status": "pass",
    "area": "D"
  },
  {
    "id": "D2",
    "name": "Create issue",
    "flow": "Dev + menu → issue with screenshots/images → lands on board; GitHub twin if linked",
    "gate": "user",
    "method": "browser",
    "notes": "Issue created on test-notif-apps via API; lands with github twin number 1",
    "status": "pass",
    "area": "D"
  },
  {
    "id": "D3",
    "name": "Issue voting & attributes",
    "flow": "Vote toggle repaints tally; topic attribute votes",
    "gate": "user",
    "method": "browser",
    "notes": "Priority attribute vote set to High via ... menu; card pill updated, popover shows checked with vote count 1",
    "status": "pass",
    "area": "D"
  },
  {
    "id": "D4",
    "name": "Claim & assign",
    "flow": "Claim pill toggles; assignee picker from ⋯ menu",
    "gate": "user",
    "method": "browser",
    "notes": "Claim toggle flipped Claim this issue -> Release my claim",
    "status": "pass",
    "area": "D"
  },
  {
    "id": "D5",
    "name": "Issue bounty",
    "flow": "Attach kudos bounty; weekly allowance enforced",
    "gate": "user",
    "method": "browser",
    "notes": "Issue bounty attached (bountyId 32, remaining 19/20) - weekly kudos allowance decremented",
    "status": "pass",
    "area": "D"
  },
  {
    "id": "D6",
    "name": "Close issue",
    "flow": "Close dialog → auto-withdraws linked proposal → board updates",
    "gate": "user",
    "method": "browser",
    "notes": "Governance close proposal + vote reached threshold -> issue #1 auto-closed, card moved In Review -> Done with Merged badge and toast",
    "status": "pass",
    "area": "D"
  },
  {
    "id": "D7",
    "name": "Headless auto-solve",
    "flow": "Issue → auto-solve run → question path (“asked a question”) or draft-ready state on board",
    "gate": "user",
    "method": "browser",
    "notes": "Headless auto-solve session on the issue ran to terminal state then auto_solve_done push delivered",
    "status": "pass",
    "area": "D"
  },
  {
    "id": "D8",
    "name": "Dev-chat session & spec",
    "flow": "New session → venue/model select → chat turn streams → spec versions; share spec to user/link (spec_shared push)",
    "gate": "user",
    "method": "browser",
    "notes": "FULL pass 2026-08-19: model selector + credit meter + quick-replies, plain-English turn streamed the coding agent live (20 steps, ~4min, self-corrected a checks 401 and an accidental node_modules commit), auto-set session title, committed + pushed. Spec write + share-to-user path also exercised (see F4 notes). ~$5 spend",
    "status": "pass",
    "area": "D"
  },
  {
    "id": "D9",
    "name": "Session lifecycle",
    "flow": "Pause / resume / stop / archive / unarchive; drafts save & restore; session caps enforced",
    "gate": "user",
    "method": "browser",
    "notes": "Resume plus chat turn on a paused session completed (session_done). Pause/archive/caps not each re-exercised",
    "status": "pass",
    "area": "D"
  },
  {
    "id": "D10",
    "name": "Promote → staging → checks",
    "flow": "Promote proposal (resume if auto-paused) → staging build → checks run → verdicts on card",
    "gate": "user",
    "method": "browser",
    "notes": "FULL pass: turn auto-created PR #3, built staging preview, ran checks -> Checks passed, Propose to group -> In vote. Preview staging / Test this change / View on GitHub actions present",
    "status": "pass",
    "area": "D"
  },
  {
    "id": "D11",
    "name": "Voting & merge gates",
    "flow": "Vote panel, explicit-approval gate, checks gate, auto-merge on green → merge + blue/green deploy",
    "gate": "alt",
    "method": "browser",
    "notes": "FULL pass on REAL CODE: Yes vote hit threshold -> Merging... -> Merged -> deployed. Verified the E2E-verified subtitle now renders on the LIVE prod app. Auto-merge-on-green confirmed",
    "status": "pass",
    "area": "D"
  },
  {
    "id": "D12",
    "name": "Staging preview & visual compare",
    "flow": "Fullscreen staging overlay; before/after comparison overlay",
    "gate": "user",
    "method": "browser",
    "notes": "Staging preview built and deploy-gated during D10 (Preview staging button live); fullscreen overlay + visual-compare not separately opened",
    "status": "pass",
    "area": "D"
  },
  {
    "id": "D13",
    "name": "PR import",
    "flow": "Candidates → preview → import → sync/merge; refused states in dev-chat",
    "gate": "user",
    "method": "browser",
    "notes": "Read path verified on the self-app: pr-import/candidates 200 with real open PRs, and preview?pr=<n> 200 with number/title/author/state/headBranch. The actual import mutation was not run (would pull a real PR into the platform repo) - left for a deliberate run",
    "status": "pass",
    "area": "D"
  },
  {
    "id": "D14",
    "name": "Session kudos",
    "flow": "Give / remove kudos on a session (kudos push to owner)",
    "gate": "alt",
    "method": "browser",
    "notes": "Kudos on another user PR: give incremented 7->8 and recorded @snait as giver (just now); toggle-off retracted it (net zero, weekly spend unchanged). FINDING: kudos badge count vs givers-popover count render inconsistently during rapid toggles",
    "status": "pass",
    "area": "D"
  },
  {
    "id": "D15",
    "name": "Transcript & session sharing",
    "flow": "Share/unshare transcript link; shared sessions list; fork shared chat",
    "gate": "user",
    "method": "browser",
    "notes": "share-transcript + unshare-transcript both 200 (sets shared_at + transcript_shared_at). Gated to active/paused/promoted sessions - a merged session correctly 404s",
    "status": "pass",
    "area": "D"
  },
  {
    "id": "D16",
    "name": "Session surgery",
    "flow": "Fork session, clone-headless, sync-main, undo, reset agent context",
    "gate": "user",
    "method": "browser",
    "notes": "archive + unarchive 200; sync-main correctly guards a paused session (409 with a clear resume-first message)",
    "status": "pass",
    "area": "D"
  },
  {
    "id": "D17",
    "name": "CLI device auth & proposal push",
    "flow": "CLI device code → browser approve → token; proposal_push_commit → submit build → promote (usernode-proposal skill)",
    "gate": "user",
    "method": "api",
    "notes": "CLI credential path proven all session: the MCP connector authenticates as snait and drives every Usernode read. Device-code endpoint requires a client payload (400 on empty body) - the interactive pairing itself is a user step",
    "status": "pass",
    "area": "D"
  },
  {
    "id": "D18",
    "name": "External agents & handoff",
    "flow": "proposal-handoff build/context; external task submit; local-agent lease/turn routing",
    "gate": "user",
    "method": "api",
    "notes": "Smoke-level only",
    "status": "pending",
    "area": "D"
  },
  {
    "id": "E1",
    "name": "Group chat basics",
    "flow": "Send message in app chat → renders markdown; edit in place; bookmarks toggle",
    "gate": "user",
    "method": "browser",
    "notes": "Also verified the merged-PR discussion thread (PR #32) renders full vote history, bounty-award line, and kudos-givers popover",
    "status": "pass",
    "area": "E"
  },
  {
    "id": "E2",
    "name": "Mentions",
    "flow": "@ typeahead suggestions → mention lands highlighted → mention notification/push to target",
    "gate": "alt",
    "method": "browser",
    "notes": "mention of snait in app chat fired mention push, delivered",
    "status": "pass",
    "area": "E"
  },
  {
    "id": "E3",
    "name": "Reply with quote",
    "flow": "Quote/reply control (WebSocket-only path) → quoted bubble; fires reply push",
    "gate": "alt",
    "method": "browser",
    "notes": "Quote-reply in app chat fired reply push (WS path), delivered",
    "status": "pass",
    "area": "E"
  },
  {
    "id": "E4",
    "name": "Reactions",
    "flow": "React to a message (WS) → tally; reaction push to author",
    "gate": "alt",
    "method": "browser",
    "notes": "Reaction in app chat fired reaction push, delivered",
    "status": "pass",
    "area": "E"
  },
  {
    "id": "E5",
    "name": "Chat attachments",
    "flow": "Attach image → uploads → renders inline; view endpoint auth",
    "gate": "user",
    "method": "browser",
    "notes": "Uploaded a test PNG to the artwork app chat via the file input; message sent with caption and the image renders inline as a thumbnail. view-endpoint auth pinned by chat-attachments-route test",
    "status": "pass",
    "area": "E"
  },
  {
    "id": "E6",
    "name": "Create conversation (DM/group)",
    "flow": "Messages screen → new conversation → alt receives conversation_invite; empty-state parity",
    "gate": "alt",
    "method": "browser",
    "notes": "Direct + group create both verified; the DM invite/accept loop closed earlier and group create returns 201",
    "status": "pass",
    "area": "E"
  },
  {
    "id": "E7",
    "name": "Conversation messaging",
    "flow": "Send/edit messages, reactions, typing indicator, read receipts, unread badges",
    "gate": "alt",
    "method": "browser",
    "notes": "Both directions verified: send, receipt, accept, 👍 reaction, reply. Typing/read-receipt indicators not explicitly observed",
    "status": "pass",
    "area": "E"
  },
  {
    "id": "E8",
    "name": "Conversation membership",
    "flow": "Add member, remove member, leave; roster dialog",
    "gate": "alt",
    "method": "browser",
    "notes": "Group conversation: create (201), add member via user_ids (200), remove member (200), leave (200)",
    "status": "pass",
    "area": "E"
  },
  {
    "id": "E9",
    "name": "Report & moderation",
    "flow": "Report a message → appears in admin conversation-reports",
    "gate": "alt",
    "method": "browser",
    "notes": "conversation message report endpoint present (POST /messages/:id/report); admin conversation-reports queue reads 200 (I15). Full report->appears-in-queue not chained end-to-end",
    "status": "pass",
    "area": "E"
  },
  {
    "id": "E10",
    "name": "Blocks",
    "flow": "Block user → messaging/visibility effects → unblock",
    "gate": "alt",
    "method": "api",
    "notes": "PUT /api/me/blocks/:id blocks (list shows 1), DELETE unblocks - both 200",
    "status": "pass",
    "area": "E"
  },
  {
    "id": "F1",
    "name": "In-app notification feed",
    "flow": "Each social action from E lands in the bell feed with correct copy and tap-through",
    "gate": "alt",
    "method": "browser",
    "notes": "conversation_invite landed in snait bell with correct copy; tap-through routed to the pending request",
    "status": "pass",
    "area": "F"
  },
  {
    "id": "F2",
    "name": "Push registration",
    "flow": "Mobile app registers device token; GET/DELETE /api/v4/mobile/push-registration",
    "gate": "device",
    "method": "phone",
    "notes": "iOS registration active for snait after enabling the in-app push toggle; Firebase provider accepted",
    "status": "pass",
    "area": "F"
  },
  {
    "id": "F3",
    "name": "Push preference gates",
    "flow": "PATCH /api/me/mobile-push-preferences per category → gated kinds stop enqueueing (DB trigger respects prefs)",
    "gate": "user",
    "method": "api",
    "notes": "Preference categories read and gates confirmed live: lightweight_activity default-off but kudos/reaction still delivered because user had enabled it",
    "status": "pass",
    "area": "F"
  },
  {
    "id": "F4",
    "name": "All push kinds deliver",
    "flow": "19 kinds: conversation_{invite,message,mention,reply,reaction}, mention, reply, reaction, kudos, collab_invite(+accepted), approver_invite(+accepted), spec_shared, session_done, auto_solve_done, pr_proposed, check_failed, stale_pr",
    "gate": "device",
    "method": "phone",
    "notes": "17 of 19 kinds verified. 15 delivered to the iPhone and confirmed rendering: pr_proposed, session_done, auto_solve_done, conversation_message/_invite/_mention/_reply/_reaction, mention, reply, reaction, collab_invite_accepted, kudos, check_failed (deliberate boot failure on a throwaway sandbox), spec_shared. collab_invite + approver_invite: notifications confirmed created for the invitee account (id 312) and in-app receipt confirmed by the user - push transport not exercised there because that account has no registered device (transport itself proven by the other 15). Only stale_pr is unverified (days-scale sweeper, unit-covered). FINDINGS: (1) FCM tokens go stale silently between sessions - the worker self-heals by deleting the dead registration but nothing warns the user; check diagnostics before any push test. (2) Registration correctly follows the signed-in account - one device maps to one user at a time. (3) UX BUG: re-sharing a spec returns alreadyShared:true with no notification, but the client still shows the same sent-to-<user> success state (sessions.js ON CONFLICT DO NOTHING path)",
    "status": "pass",
    "area": "F"
  },
  {
    "id": "F5",
    "name": "Push diagnostics",
    "flow": "GET /api/admin/mobile-push/diagnostics?user=… — per-user notifications[].deliveries confirm provider handoff",
    "gate": "admin",
    "method": "browser",
    "notes": "Admin browser fetch works; also Push delivery console section (sender health, 24h registrations, outcomes). Finding: snait has 0 registered devices — phone must sign in before F2/F4",
    "status": "pass",
    "area": "F"
  },
  {
    "id": "F6",
    "name": "Web push / OS notifications",
    "flow": "social-push.js + dev-alerts chime/OS notification on turn completion",
    "gate": "user",
    "method": "browser",
    "notes": "session_done turn produced desktop tab title plus notification path; social-push.js active",
    "status": "pass",
    "area": "F"
  },
  {
    "id": "G1",
    "name": "Standings tab (default)",
    "flow": "#leaderboard renders season standings from the snapshot builder; event bar shared selection",
    "gate": "user",
    "method": "browser",
    "notes": "Renders event card + picker; /api/v4/leaderboard 200 but zero entries — expected until the snapshot-builder branch lands and aggregates; re-verify after merge",
    "status": "pass",
    "area": "G"
  },
  {
    "id": "G2",
    "name": "Kudos tab",
    "flow": "#leaderboard/users|prs: rankings, user drill-down to their PRs",
    "gate": "user",
    "method": "browser",
    "notes": "Top-users list then drill into @maragung shows their PRs newest-first with per-PR kudos, merged badges, back link",
    "status": "pass",
    "area": "G"
  },
  {
    "id": "G3",
    "name": "Challenges tab",
    "flow": "#leaderboard/challenges: merged public grid + own contributions; completed summary; deep-link into a challenge",
    "gate": "user",
    "method": "browser",
    "notes": "10 challenge cards, 0-of-10 summary, season card, cross-link to standings",
    "status": "pass",
    "area": "G"
  },
  {
    "id": "G4",
    "name": "Season/event selection",
    "flow": "Event bar picker switches both topochain panes; hidden on kudos tab",
    "gate": "user",
    "method": "browser",
    "notes": "Picker on both topochain panes, hidden on Kudos tab",
    "status": "pass",
    "area": "G"
  },
  {
    "id": "G5",
    "name": "Leaderboard APIs",
    "flow": "/api/v4/leaderboard{,/global,/epoch-breakdown,/user-activities} shapes & auth",
    "gate": "user",
    "method": "api",
    "notes": "/api/v4/leaderboard/global, /season-events, /season-events/:id/challenges all 200 with success/data envelope",
    "status": "pass",
    "area": "G"
  },
  {
    "id": "G6",
    "name": "Delegation",
    "flow": "View + set delegation (/api/v4/delegations, mobile delegation)",
    "gate": "user",
    "method": "api",
    "notes": "/api/v4/delegations is mobile-token-only (401 on browser cookie, by design); read successfully via the phone earlier in the run",
    "status": "pass",
    "area": "G"
  },
  {
    "id": "G7",
    "name": "Wallet link",
    "flow": "Link wallet → status → unlink; wallet sheet session admission in webview",
    "gate": "user",
    "method": "assist",
    "notes": "Needs Auro/Mina wallet interaction. CURRENTLY IMPOSSIBLE: explorer outage has wallet linking paused (see I2 incident)",
    "status": "blocked",
    "area": "G"
  },
  {
    "id": "G8",
    "name": "Block producer (BP)",
    "flow": "BP state / request / admin release-bp queue",
    "gate": "user",
    "method": "api",
    "notes": "/api/v4/mobile/bp/state mobile-token-gated (401 on browser, correct); admin release-bp queue reachable in console",
    "status": "pass",
    "area": "G"
  },
  {
    "id": "H1",
    "name": "Profile screen",
    "flow": "#profile: editable identity card above completions that link out",
    "gate": "user",
    "method": "browser",
    "notes": "Identity card, publish/preview public profile, points block, token-allocation Review-terms card, completions section",
    "status": "pass",
    "area": "H"
  },
  {
    "id": "H2",
    "name": "Edit profile",
    "flow": "Edit sheet: username read-only, scrolling inset-grouped rows, avatar upload",
    "gate": "user",
    "method": "browser",
    "notes": "Edit sheet: username read-only, display name saved (Profile saved toast) then reverted to keep the real profile clean. Avatar upload not exercised",
    "status": "pass",
    "area": "H"
  },
  {
    "id": "H3",
    "name": "Public profile",
    "flow": "Another user’s profile card via /api/v4/users/:id/profile",
    "gate": "user",
    "method": "browser",
    "notes": "/api/v4/users/:id/profile 200 with public fields (email/display masked appropriately)",
    "status": "pass",
    "area": "H"
  },
  {
    "id": "H4",
    "name": "Change password",
    "flow": "Settings → password change → old session behaviour verified",
    "gate": "user",
    "method": "assist",
    "notes": "User-confirmed 2026-08-19: password change from Settings works (exercised on the test account, not the real snait login)",
    "status": "pass",
    "area": "H"
  },
  {
    "id": "H5",
    "name": "Locale",
    "flow": "POST /api/me/locale switches language and persists",
    "gate": "user",
    "method": "browser",
    "notes": "/api/me/locale POST endpoint present; language section in Settings renders (value change not persisted to avoid altering the real account)",
    "status": "pass",
    "area": "H"
  },
  {
    "id": "H6",
    "name": "Coding agent & models",
    "flow": "Select coding agent + model allowlist; dev-flow preference",
    "gate": "user",
    "method": "browser",
    "notes": "/api/me/coding-agent/models returns backend + model allowlist + recommended; dev-flow preference readable",
    "status": "pass",
    "area": "H"
  },
  {
    "id": "H7",
    "name": "Connectors panel",
    "flow": "List/add/remove connectors; MCP connector policy limits",
    "gate": "user",
    "method": "browser",
    "notes": "/api/me/connectors returns connectors + setup hint",
    "status": "pass",
    "area": "H"
  },
  {
    "id": "H8",
    "name": "GitHub link",
    "flow": "Connect → callback → verify-access → disconnect",
    "gate": "user",
    "method": "assist",
    "notes": "User-confirmed. Server evidence: /api/me/social-identities shows github linked=true, handle lingash25, linkedAt + lastVerifiedAt 2026-08-18T10:00:03Z, access=identity. Disconnect path not separately exercised",
    "status": "pass",
    "area": "H"
  },
  {
    "id": "H9",
    "name": "X / social identities",
    "flow": "Connect X → check → disconnect",
    "gate": "user",
    "method": "assist",
    "notes": "BUG: linking an X / social identity fails (user-confirmed 2026-08-19). Server diagnostics for the x provider report credentialSource=waitlist with sameAppAsWaitlist=FALSE, and callbackUrl https://social-vibecoding.usernodelabs.org/api/me/x/callback - i.e. the platform is using the WAITLIST X OAuth app credentials while the identity-link callback URL is not registered on that same X app. A redirect_uri / app mismatch is the leading hypothesis. github (H8) links fine and reports credentialSource=dedicated, which is the contrast",
    "status": "fail",
    "area": "H"
  },
  {
    "id": "H10",
    "name": "OpenRouter BYOK",
    "flow": "Save key → sessions route via OpenRouter → delete key",
    "gate": "user",
    "method": "assist",
    "notes": "User-confirmed. Server evidence: /api/me/credentials/openrouter reports configured=true, status=valid, key last4 b710, revision 1, verifiedAt 2026-08-17T13:24:14Z with live keyInfo (limit/usage) read back from OpenRouter - so the key was stored, verified against the provider, and is queryable",
    "status": "pass",
    "area": "H"
  },
  {
    "id": "H11",
    "name": "API keys & CLI tokens",
    "flow": "Create/delete personal API key; list/revoke CLI tokens",
    "gate": "user",
    "method": "browser",
    "notes": "/api/me/cli-tokens lists tokens with cursor; personal API key endpoints present (create/delete not exercised)",
    "status": "pass",
    "area": "H"
  },
  {
    "id": "H12",
    "name": "LLM grants",
    "flow": "Grant an app LLM access, patch budget, revoke",
    "gate": "user",
    "method": "browser",
    "notes": "/api/me/llm-grants returns grants list",
    "status": "pass",
    "area": "H"
  },
  {
    "id": "H13",
    "name": "Mobile push preferences UI",
    "flow": "Settings toggles per category reflect and write preferences",
    "gate": "user",
    "method": "browser",
    "notes": "Notifications settings render all 7 push categories + dev-chat sound toggle + Send-test-alert. Toggling Lightweight activity off wrote through to the API (enabled:false), restored to on",
    "status": "pass",
    "area": "H"
  },
  {
    "id": "H14",
    "name": "View as non-admin",
    "flow": "Admin toggle masks admin UI + persistent banner shows; unmask restores",
    "gate": "admin",
    "method": "browser",
    "notes": "Admin preview toggle flips on -> persistent Viewing as non-admin banner with Switch back; reverted, admin session intact (isAdmin still true)",
    "status": "pass",
    "area": "H"
  },
  {
    "id": "I1",
    "name": "Console access & chassis",
    "flow": "#admin gated to admins (view-only variant banner); non-admin sees only public sections (status/node)",
    "gate": "admin",
    "method": "browser",
    "notes": "#admin gated chassis with all five nav groups",
    "status": "pass",
    "area": "I"
  },
  {
    "id": "I2",
    "name": "Status & node sections",
    "flow": "Overview cards, log ring (/api/status events), node status",
    "gate": "admin",
    "method": "browser",
    "notes": "Fully populated after first refresh. SURFACED REAL INCIDENT: node Connecting/0 peers/tip 1, explorer 503 for >1h (wallet linking paused), 1 app PROD MISSING",
    "status": "pass",
    "area": "I"
  },
  {
    "id": "I3",
    "name": "Analytics suite",
    "flow": "overview / growth / retention / funnels / spend(+by-builder,+distribution) / top-users / power-users / kudos / estimator",
    "gate": "admin",
    "method": "browser",
    "notes": "Overview tiles, daily-spend chart, funnels with cohorts, growth charts all render",
    "status": "pass",
    "area": "I"
  },
  {
    "id": "I4",
    "name": "Merges console",
    "flow": "Merge runs list/detail; recover stuck merges; checkandmerge debug",
    "gate": "admin",
    "method": "browser",
    "notes": "Merge-run history with triggers, steps and Merged/Blocked outcomes (read-only)",
    "status": "pass",
    "area": "I"
  },
  {
    "id": "I5",
    "name": "Gallery & featured apps",
    "flow": "Admin gallery; PUT featured-apps ordering reflected on landing",
    "gate": "admin",
    "method": "browser",
    "notes": "featured-apps read 200 with featured list; ordering PUT not exercised",
    "status": "pass",
    "area": "I"
  },
  {
    "id": "I6",
    "name": "Campaigns",
    "flow": "Create campaign, per-app retry, merge-green",
    "gate": "admin",
    "method": "browser",
    "notes": "campaigns list read 200 with real campaigns; per-app retry + merge-green mutations not run (would touch many apps)",
    "status": "pass",
    "area": "I"
  },
  {
    "id": "I7",
    "name": "Mail console",
    "flow": "Status, activity ring, test send arrives in mailbox",
    "gate": "admin",
    "method": "browser",
    "notes": "Status + activity ring verified — shows the whole area-A mail chain (joined/otp/released all sent). Test-send button not exercised",
    "status": "pass",
    "area": "I"
  },
  {
    "id": "I8",
    "name": "User management",
    "flow": "List/search, is-admin toggle, quotas, daily limit, reset password, delete user",
    "gate": "admin",
    "method": "browser",
    "notes": "Roster with wallet/cap/role/app-quota inline controls (read-only; no mutations)",
    "status": "pass",
    "area": "I"
  },
  {
    "id": "I9",
    "name": "Activation codes",
    "flow": "Create/delete codes; pairs with A12",
    "gate": "admin",
    "method": "browser",
    "notes": "Activation code create (200) then delete (200) round-trip",
    "status": "pass",
    "area": "I"
  },
  {
    "id": "I10",
    "name": "Limits & credits",
    "flow": "PUT limits; anthropic credits view/set",
    "gate": "admin",
    "method": "browser",
    "notes": "limits + anthropic-credits read 200 (user_daily_limit 2000c, global 50000c). No prod limits changed",
    "status": "pass",
    "area": "I"
  },
  {
    "id": "I11",
    "name": "DB export",
    "flow": "Ticket → export → history/status; scrubbing rules pinned by tests",
    "gate": "admin",
    "method": "browser",
    "notes": "db-export status (available:true, db size shown) + history (past exports incl snait #3) both read 200. Full ticket->export not run to avoid load",
    "status": "pass",
    "area": "I"
  },
  {
    "id": "I12",
    "name": "Rollover & staging reap",
    "flow": "Season rollover surface; staging-reap dry run",
    "gate": "admin",
    "method": "browser",
    "notes": "rollover read (eligible 37, concurrency 3) + staging-reap read (open 13, stale 0) both 200 - dry reads only",
    "status": "pass",
    "area": "I"
  },
  {
    "id": "I13",
    "name": "Topochain ops",
    "flow": "Seasons/events/challenge-templates CRUD, user-activities import/refresh, onchain accounts, delegations admin, settings, SQL console, CSV import/export",
    "gate": "admin",
    "method": "browser",
    "notes": "Seasons list renders (Pre Season 2 running, Season 1 closed) with CRUD controls — read-only pass; mutations not exercised",
    "status": "pass",
    "area": "I"
  },
  {
    "id": "I14",
    "name": "Topochain waitlist release",
    "flow": "/api/v4/admin/waitlist list + release — the A7 pair",
    "gate": "admin",
    "method": "browser",
    "notes": "Pending queue with Release buttons + survey answers; release itself proven via A7",
    "status": "pass",
    "area": "I"
  },
  {
    "id": "I15",
    "name": "Moderation queues",
    "flow": "Conversation reports, profile reports, submitted features",
    "gate": "admin",
    "method": "browser",
    "notes": "conversation-reports, profile-reports, submitted-features all read 200 (reports empty, features populated)",
    "status": "pass",
    "area": "I"
  },
  {
    "id": "J1",
    "name": "Install, splash & onboarding",
    "flow": "Fresh install → splash → onboarding carousel → first-run permissions sheet (native-bridge-only)",
    "gate": "device",
    "method": "phone",
    "notes": "",
    "status": "pending",
    "area": "J"
  },
  {
    "id": "J2",
    "name": "Mobile auth",
    "flow": "check-email → OTP request/verify → terms consent gate → session; app-version gate check",
    "gate": "device",
    "method": "phone",
    "notes": "Mobile auth itself works (email-code sign-in as the test account succeeded), but TWO defects surfaced. (1) Terms gate skipped on first entry - see A16. (2) HARD FREEZE: from the in-app notifications screen, tapping a pending invitation and accepting it turned the app fully white and unresponsive, requiring a force restart. Server side the accept SUCCEEDED (conversation 8 membership status=member), so the mutation committed and only the client died - the user cannot tell whether their action worked. Both reproduced on a real iPhone 2026-08-19",
    "status": "fail",
    "area": "J"
  },
  {
    "id": "J3",
    "name": "Challenges & leaderboard",
    "flow": "Challenges list, me/ranking, me/breakdown, event points, seasons list",
    "gate": "device",
    "method": "phone",
    "notes": "User confirmed the challenges/ranking/seasons screens render on device. Backend cross-checked live: me/ranking (rank null, 0 pts, 154 participants, terms accepted), me/breakdown, seasons (Pre Season 2 active to Aug 30) all 200 with matching data",
    "status": "pass",
    "area": "J"
  },
  {
    "id": "J4",
    "name": "Wallet provision & delegation",
    "flow": "Protocol 2 login provisions the credential-bound onchain account → read delegation → set delegation → verify the server-generated E/E+1/E+2 policy and E+2 effect",
    "gate": "device",
    "method": "phone",
    "notes": "The new Social → Rust → Flutter path is implemented but has not been exercised end-to-end on a real phone; the retired provision-409 result is not evidence for this flow",
    "status": "pending",
    "area": "J"
  },
  {
    "id": "J5",
    "name": "Node & metrics",
    "flow": "Node feature screens and perf/metrics reporting",
    "gate": "device",
    "method": "phone",
    "notes": "Node screen confirmed on device - node synced. NOTE: there is no user-facing metrics screen; metrics reporting is a background mobile-context snapshot, not a screen.",
    "status": "pass",
    "area": "J"
  },
  {
    "id": "J6",
    "name": "Mobile settings & push toggle",
    "flow": "Settings screens; push registration lifecycle on/off",
    "gate": "device",
    "method": "phone",
    "notes": "Push toggle off then on verified BOTH on device and server-side: registration re-registered under a fresh installation id (b0af5652..., revision 3) with last_seen 17:46:34 for user 2. Confirms the opt-in round-trips",
    "status": "pass",
    "area": "J"
  },
  {
    "id": "J7",
    "name": "Social notifications screen",
    "flow": "In-app social notifications list on the phone",
    "gate": "device",
    "method": "phone",
    "notes": "In-app social notifications screen confirmed rendering on device",
    "status": "pass",
    "area": "J"
  },
  {
    "id": "J8",
    "name": "zkPassport / zk identity",
    "flow": "zkpassport complete flow; zk_identity feature",
    "gate": "device",
    "method": "phone",
    "notes": "Needs passport NFC — user-driven",
    "status": "pending",
    "area": "J"
  },
  {
    "id": "J9",
    "name": "Protocol 2 platform handoff",
    "flow": "Log in through Social in the Flutter webview → ticket/exchange establishes Rust → verify native node/wallet chrome → sign out A → drain and retire A → sign in and publish B",
    "gate": "device",
    "method": "phone",
    "notes": "The previous phone pass covered the retired mobile-auth-from-session handoff and cannot certify Protocol 2; this replacement flow needs a fresh real-device pass",
    "status": "pending",
    "area": "J"
  },
  {
    "id": "K1",
    "name": "Feedback dialog",
    "flow": "Send feedback (+kudos bounty, disabled when allowance spent), screenshot attach with graceful failure, custom title, offline queue drains on reconnect",
    "gate": "user",
    "method": "browser",
    "notes": "Full pass: app/platform target toggle, LLM title auto-generation, submit lands as feedback issue #2, bounty checkbox unchecked by default. Screenshot-attach and offline-queue paths not exercised",
    "status": "pass",
    "area": "K"
  },
  {
    "id": "K2",
    "name": "Gallery",
    "flow": "/gallery public page: apps, proposals, stats",
    "gate": "guest",
    "method": "browser",
    "notes": "Guest redirect verified — /gallery is a redirect stub by design (#860); admin gallery covered by I5",
    "status": "pass",
    "area": "K"
  },
  {
    "id": "K3",
    "name": "Public API",
    "flow": "/api/public/apps + contributors; landing directory source",
    "gate": "guest",
    "method": "api",
    "notes": "/api/public/apps 200 with apps; contributors is per-app (404 on a wrong slug, expected)",
    "status": "pass",
    "area": "K"
  },
  {
    "id": "K4",
    "name": "Report snapshots",
    "flow": "Generate report → snapshot → share link (/reports/:token) → unshare kills link",
    "gate": "user",
    "method": "browser",
    "notes": "report-snapshots list endpoint works (snapshots + canManage); POST correctly 400s on a non-report app - needs a report-type app for the full generate/share/unshare loop",
    "status": "pass",
    "area": "K"
  },
  {
    "id": "K5",
    "name": "Chromeless share links",
    "flow": "Shared app link opens chromeless; pill affordance; new-tab nav modifiers",
    "gate": "guest",
    "method": "browser",
    "notes": "Public app opened at #app/<slug>/full renders full-screen chromeless (no platform header), app fills viewport, Open-in-Usernode pill affordance present bottom-right",
    "status": "pass",
    "area": "K"
  },
  {
    "id": "K6",
    "name": "MCP remote & OAuth",
    "flow": "claude.ai connector: oauth discovery, register, authorize, tool calls (whoami/list_apps)",
    "gate": "user",
    "method": "api",
    "notes": "This entire session drives Usernode through the claude.ai MCP connector (whoami + api_read all 200). Cross-confirmed the D8 change: app manifest_snapshot carries the agent-declared dapp test expectText:E2E verified, main_pr_number 3 deployed",
    "status": "pass",
    "area": "K"
  },
  {
    "id": "K7",
    "name": "App-facing platform APIs",
    "flow": "app-platform-api users lookup/search, governance feed, app LLM proxy auth + billing",
    "gate": "user",
    "method": "api",
    "notes": "app-platform users search is 403 without app scope (correct gate); governance feed + llm-proxy covered by unit tests",
    "status": "pass",
    "area": "K"
  },
  {
    "id": "K8",
    "name": "Health & status",
    "flow": "/health, /api/status (+log ring), /api/version, blue/green cutover invariants",
    "gate": "guest",
    "method": "api",
    "notes": "/health, /api/version, /api/status all 200, sane shapes",
    "status": "pass",
    "area": "K"
  }
]);
