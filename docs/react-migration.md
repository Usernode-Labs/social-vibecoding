# React migration plan

## Decision

The platform will move to React + Vite + TypeScript + official shadcn/Base UI
as a route-by-route strangler migration. Express remains the API server and
static-asset host. Existing routes, hashes, cookies, WebSocket/SSE streams,
the native bridge, iframe rules and service-worker policies are contracts, not
implementation details to casually replace.

## Candidate A authority

Candidate A governs the Social Vibecoding platform shell only:
platform-owned React routes, reusable shell patterns, and the shell-side
hosted-app frame. Child-app source, app-factory scaffolds/prompts, and existing
`usernode-native/v1` consumers remain outside this authority.

The authority is executable:

- DTCG tokens generate the runtime CSS;
- the manifest plus authority resolve to a component catalog;
- owned components are published through the shadcn CLI registry;
- style and architecture policies fail on raw styling and direct platform
  access unless an exact, owned, expiring exception exists;
- one portable skill and workflow resolver give every supported agent the same
  task-specific context and gates;
- the original Candidate A shell battery records T1–T5 and 5/5
  deliberate-violation enforcement; the current T1–T8 extension also proves
  semantic keep-distinct decisions, composable workflow routing, and harness
  self-integrity/CI parity.

The signed continuation record is
[candidate-a-shell-continuation.md](candidate-a-shell-continuation.md).

## Workstreams

1. **Foundation** — a compiled React bundle, default shadcn theme, typed
   route/API/bridge adapters, Storybook, browser tests and a small universal
   agent guide.
2. **Platform shell and home** — responsive sidebar/header, app discovery,
   search, favourite ordering, create permission state and direct-app entry.
3. **Hosted app boundary** — app/detail/full iframe views, token refresh,
   bridge capability states, back/history and offline/blocked states.
4. **Account and community** — profile, challenges, leaderboard,
   notifications, work drawer, settings and native chrome capabilities.
5. **Developer workspace** — Dev route, chat, sessions, issues, proposals,
   governance, kanban, previews and console.
6. **Administration and retirement** — admin routes, standalone legacy pages,
   service-worker/cache migration, route-parity evidence, then selective
   legacy removal.

## Tracked legacy parity backlog

Main continues to improve the production legacy shell while the React shell is
staged under `/react/`. These changes remain available through the legacy
fallback and are not mechanical rebase blockers, but the corresponding legacy
surface cannot be retired until React has equivalent implementation and route
evidence:

1. Topochain administrator and leaderboard screens.
2. Platform-environment and per-app secret administration panels.
3. The one-shot **Explore in Dev chat** advisor handoff.
4. Dev transcript read and fork flows.
5. Fleet-maintenance campaign administration for governance-approved changes
   across applications.
6. Pull-request import must never open the incomplete developer-chat view.
7. The homepage application options menu needs the production shell's solid
   surface treatment.

The in-process challenges interface added on main also changes session-identity
handling. Track that endpoint in the separate authentication contract matrix;
it is a session-boundary review item, not visual parity work.

## Definition of route parity

For every replacement route: existing hash/deep-link and browser-back behavior
must work; loading, empty, failure and unauthorised states must be explicit;
the same API and session constraints must remain; native bridge/iframe modes
must be capability-gated; mobile WebView and desktop browser states must be
tested; and legacy escape is retained until production equivalence is proven.

## Cutover proof ledger

The React shell is not ready to replace the legacy root merely because an
individual route renders. A production cutover must separately prove the host
contracts that are otherwise easy to miss in a desktop browser.

`npm run check:cutover-contract` emits a machine-readable inventory of the
static contracts currently verified by source inspection. It deliberately
reports open blockers without failing ordinary development. Release evidence
uses `npm run check:cutover-ready`; that command fails until every blocker is
closed with an executable test or a documented, reviewed platform decision.
The candidate tuple, browser fixture scope, service-worker decision, and
physical iOS/Android matrix live in
[the native cutover proof checklist](react-native-cutover-proof.md).

Current verified contract evidence:

- Express preserves `/react` history fallback, while Vite keeps the React
  asset base under `/react/` rather than shadowing the legacy root shell.
- Hosted apps preserve the exact legacy sandbox, typed short-lived iframe
  token refresh, same-origin `path` validation, and offline placeholder.
- `syncNativeTitle()` preserves Flutter's `Usernode` `titleChanged` signal;
  bridge-dependent UI remains capability-gated rather than assuming desktop
  and WebView have identical globals.
- The established root service worker still bypasses iframe tokens and SSE,
  caches only safe GETs, and clears API cache on logout. Its source tests are
  authoritative for the existing legacy shell only. React now registers its
  own separately-versioned, `/react/`-scoped shell worker in production builds.
  It caches the compiled shell/assets network-first and deliberately does not
  cache authenticated API data, iframe tokens, streams, or bridge traffic.

Current cutover blockers (intentionally not papered over):

1. **React offline proof.** React has a separately versioned `/react/` worker
   with shell-only network-first caching. Before React becomes `/`, exercise
   an actual offline reload of a warmed signed-in route, verify the visible
   data-unavailable/retry state, and decide whether encrypted/cleared API
   caching is worth adding. Do not silently expand the legacy root worker's
   scope or replay authenticated API data from this worker.
2. **Native WebView E2E.** Flutter's first-launch gate currently accepts the
   first `onPageFinished` as success and thereafter relies on the page service
   worker. A cutover must run on iOS and Android and prove cookie login,
   `Usernode` channel readiness, back/pushState behavior, safe-area/keyboard,
   external-link delegation, iframe token refresh, and offline recovery. iOS
   App-Bound Domains currently restrict top-level navigation/JS channel use to
   `usernodelabs.org`, `evanshapiro.dev`, and localhost; a hosting-domain
   change therefore requires a native release.
3. **Production observability.** The Flutter host currently logs bridge and
   WebView events locally; it does not provide production measurements for
   React boot, bridge readiness/failure, service-worker version, blank screens,
   or Web Vitals. Define a privacy-reviewed telemetry sink and alert thresholds
   before retiring the legacy shell.
4. **Cross-repo version matrix.** For the release candidate, record the
   Flutter app SHA/bridge capability version, SV deploy SHA, React bundle/SW
   version, and a fixture-backed compatibility result. A WebView shell cannot
   safely infer that those independent deployments are compatible.

## First implementation target

`frontend/` provides the compiled React host and the initial platform Apps
Home. It reads the real `/api/apps` endpoint and retains each app's existing
hash handoff rather than inventing a new app protocol. The initial host is
served under `/react/`, allowing real production contracts to be exercised
before it becomes the default shell.

## Local production Dev write scope

Production review remains read-only by default. For a deliberately bounded
end-to-end Dev exercise, the local Vite host may proxy real writes only for a
single app:

```sh
SV_API_TARGET=https://social-vibecoding.usernodelabs.org \
SV_LOCAL_HTTPS=true \
SV_PRODUCTION_WRITE_APP_SLUG=appraise-6945af \
npm run dev -- --host 127.0.0.1 --port 5175
```

This is not a production permission system. It is a local proxy guard for
manual React verification: non-safe API methods are allowed only for
`/api/apps/appraise-6945af/*` or a session whose authenticated production
response confirms `app_slug: appraise-6945af`; all other mutations are stopped
locally with `403`. Do not combine it with `SV_PRODUCTION_READONLY=true`.

## Current migration state

- **Done:** React/Vite/TypeScript build, official shadcn Base UI primitives,
  default neutral theme with persisted light and dark modes, responsive platform shell, Apps home, search,
  app detail, and the hosted child-app boundary. The latter preserves the
  sandbox, token refresh cadence, same-origin URL validation, offline event
  seam and native title bridge.
- **Verified:** Storybook validates the card's normal and unavailable states;
  Playwright exercises desktop and mobile catalogue, search, detail and hosted
  iframe flows; axe checks find no serious or critical violations in the Apps
  slice. CI runs the Storybook test build rather than a compile-only catalog.
  The production entry bundle has a 160 KiB gzip CI budget; feature routes are
  lazy chunks.
- **In progress:** the read-only public leaderboard now owns Top PRs, Top
  users, the signed-in viewer's private give-side record at
  `/react/community/leaderboard/history`, and addressable public contributor profiles at
  `/react/community/leaderboard/users/:username`. Those profiles preserve the
  existing public API's stats, keyset pagination and browser-back path, and
  their proposal rows open the owned React details. My history preserves its two independent
  Kudos/Votes filters (both selected or deselected means the server's `all`
  feed), 50-row keyset pagination and private 401 state. PR records open React
  proposal details, while bounty and platform-proposal records with a GitHub
  issue number open the React issue detail; an identifier-less row degrades to
  the app Dev overview. The legacy `#leaderboard/history` hash remains
  reachable only as a compatibility entry point. Cross-app Work retains the
  source APIs' promoted-session de-duplication and now hands its read-only
  session, proposal, and governance rows to the matching React detail routes;
  their actions remain explicit legacy Dev handoffs. Keep the legacy hash
  routes alive until React accepts their deep links and full behavior has
  matching evidence.
- **In progress:** Profile is now a capability-gated bridge read plus
  challenge-service read. It deliberately exposes a useful unavailable state
  outside Usernode. In Usernode it retains participant-earned completed
  challenges, their server-reported status and points, and an all-seasons or
  per-season read-only view using only the existing public season, challenge,
  ranking, and breakdown endpoints. A history fetch failure is isolated so the
  profile's ranking and allocation remain usable. The settings route now
  consumes the trusted top-frame bridge-v3 settings contract directly.
- **In progress:** `/react/account` now gives the native account boundary a
  deliberate, capability-gated home: it links the existing bridge-backed
  Profile and renders only read-only `getNodeStatus` / `getWalletState`
  snapshots when the v2/v3 bridge advertises those capabilities. It consumes
  the native node-status event rather than polling the device, and its only
  native action is the contract's existing allowlisted `openNativeScreen`
  settings escape hatch. The richer settings mutations live on
  `/react/settings`, not this read-only account summary. Desktop and old native builds render explicit
  unavailable/update states. It also makes the public `/react/node-status`
  diagnostic explicit as a separate, read-only platform surface rather than
  conflating server health with a user's device or wallet. Its Profile and
  Node status actions use the governed semantic link authority while
  preserving the existing React destinations and browser back history on
  narrow and desktop viewports.
- **In progress:** `/react/settings` now owns the established web account
  core rather than treating Settings as only a native escape hatch. Typed
  adapters preserve the current locale, AI progress estimate, Anthropic BYOK
  save/replace/remove, password-change, per-app AI grant, personal agent-file,
  and web-session logout contracts. App AI grants retain active/revoked state,
  today's spend, daily caps, personal-key spillover, and explicit revocation.
  Agent instructions and skills retain server-enforced kind/count/size/name
  validation plus upload, content inspection, and confirmed deletion.
  Usernode wallet linking preserves the established ten-minute server-issued
  transaction request and two-second status polling. Regular browsers receive
  the pinned QR flow; bridge-v3 WebViews with `sendTransaction` use the native
  confirmation sheet. Linked wallets remain deliberately non-unlinkable in the
  UI, matching the legacy safeguard. A linked native wallet also restores the
  authenticated wallet-signed password change through the existing single-use
  challenge and `signMessage` contract, while ordinary browsers retain
  current-password verification.
  Loading, empty, rejection, read-only production-review, and successful
  mutation states have desktop/mobile route evidence. A separate
  `NativeAppSettings` pattern now renders the bridge-v3 settings snapshot and
  capability-gates alarm permission, Android battery settings, iOS keep-alive,
  node sleep, debug mode, strict facematch, ZK reset, native diagnostics,
  terms, and Usernode-app login/logout. Every setter re-renders the refreshed
  native snapshot; desktop has an explicit unavailable state, and older builds
  retain the allowlisted `openNativeScreen("settings")` fallback. Web-session
  logout remains visibly separate from native-app logout. Administrator preview is now a
  persisted client-side mask shared by Settings, the platform shell,
  administrator routes, and app-detail write affordances. While active it
  blocks React administrator API reads before the network boundary, retains a
  visible restore banner, and leaves server authority unchanged. Developer-
  console visibility, Dev alert preferences, and today's aggregate
  BYOK/platform spend panel are now split from the old modal and independently
  exercised. Wallet linking now uses the existing on-chain request contract:
  browser sessions receive a copyable QR request, native-capable WebViews use
  the confirmed `sendTransaction` bridge path, and both poll the authoritative
  server status before showing the linked wallet. Linked native wallets may
  also change the web password through a fresh wallet challenge and native
  signature; unlinking remains deliberately unavailable in the React surface.
  `/react/feedback` replaces the dead feedback hash with the
  existing authenticated `/api/feedback` contract: app-scoped feedback is
  offered only for a loaded, non-self-hosted app with a GitHub repository;
  otherwise it safely files platform feedback. Title preview remains
  best-effort through `/api/feedback/title`; screenshots and app-state capture
  stay legacy-owned until their Screen Capture and iframe-provider contracts
  have independent React evidence. Both routes are non-mutating in local
  production-review mode.
- **In progress:** `/react/node-status` is the first standalone legacy
  surface migrated to React. It uses only the public cached
  `GET /api/node-status/full` snapshot, keeps the legacy two-second refresh
  cadence, and makes sidecar, explorer and partial-UTXO failures explicit.
  It does not expose an operator mutation or add a browser-to-sidecar
  connection; `/node-status` remains available until the route's production
  parity checklist is reviewed.
- **In progress:** `/react/status` is the companion public operational
  snapshot. It reads the existing server-redacted `GET /api/status` contract
  on a five-second cadence, with an explicit manual refresh. It renders only
  deployment, app, worker, stuck-session, drift, and node health evidence;
  host/database capacity, spend, event logs, model identifiers, live worker
  progress, and every operator control remain outside the React view even for
  an admin response. The legacy `/status` dashboard remains authoritative for
  those privileged diagnostics until each one has an independently reviewed
  access and operational contract.
- **In progress:** Challenges is a read-only Fair Rewards feed based on the
  mobile challenge contract: Featured, Today, This week, and Season bands;
  one card per earning mechanic; and explicit open, in-progress, pending,
  completed, missed, binary, fractional, and unknown-metric treatments.
  In Usernode, the existing read-only profile bridge supplies the participant
  ID for `/me/breakdown` progress. Desktop remains a public feed rather than
  guessing identity. The deterministic Storybook matrix and browser fixtures
  deliberately exercise sparse and malformed-looking backend shapes. The
  read-only detail route at `/react/community/challenges/:challengeId` reloads
  the same typed snapshot and uses only bridge-supplied participant identity;
  unavailable IDs have an explicit not-found state and existing CTAs are
  visible solely as legacy handoffs. Challenge CTA mutations remain legacy
  until their contracts migrate.
- **In progress:** Notifications owns the bell-only notification set,
  grouping, keyset cursor pagination, and identifier-safe React/legacy Dev
  handoffs. Identified session, issue, proposal, and scoped-discussion
  notifications now open their owned React detail routes; an incomplete legacy
  notification remains a root-hash document navigation rather than letting
  BrowserRouter silently rewrite it below `/react`. The
  existing cookie-authenticated `/ws/events` contract invalidates the first
  cursor page for `notification_new` and `notifications_changed`; the route
  dedupes by notification id rather than trusting a socket payload. Pending
  collaborator and approver invitations are sourced from the server's
  authoritative first-page `pendingInvites` list and accept/decline through
  their existing distinct contracts. In normal mode, visible bell rows are
  marked read individually so the endpoint cannot clear hidden Work-only
  session notifications or actionable invites. Production review mode makes
  every read and invitation operation explicitly non-mutating. The legacy
  drawer remains available through cutover while the header badge and
  drawer-specific adaptive sheet behavior receive independent parity proof.
- **In progress:** Login and activation-code registration now use their
  existing cookie-session endpoints through typed React adapters, with
  deterministic success, rejection and accessibility evidence. `/react/register`
  preserves an incoming `?code=` activation-code deep link and the login/register
  handoff preserves a legacy hash fragment. The server remains the authority for
  activation-code validity, username uniqueness, password handling, and session
  creation. In a capable native WebView, Login now discovers the bridge and
  wallet address, preserves the server's genesis eligibility decision, and
  exposes the established linked-wallet signature login, wallet-proven
  password reset, wallet-gated registration, and existing-account linking
  contracts. Link transactions retain native confirmation and server-status
  polling; ordinary browsers retain username/password login and the truthful
  administrator-assisted recovery explanation. The legacy `/login.html` and
  `/register.html` routes remain available until native-device evidence and
  production cutover are reviewed.
- **In progress:** Dev has an app-scoped owned-session overview plus a React
  conversation route at
  `/react/apps/:slug/dev/sessions/:id`. It reads the existing
  `GET /api/sessions/:id` transcript, verifies its app scope, preserves the
  legacy hash handoff for all actions, and uses official shadcn
  `MessageScroller`, `Message`, `Bubble`, and `Marker` primitives. Storybook
  replays deterministic streamed conversation states through
  `@shadcn/helpers/ai-sdk`; that helper is not the production transport. The
  route now also has an owned, read-only `EventSource` adapter for the existing
  resumable `GET /api/sessions/:id/events` stream: it renders tokens, planning,
  status, completion, and error events while relying on browser-managed
  Last-Event-ID replay. Its first write slice now uses the existing
  upload-before-send attachment endpoint and primary chat SSE, while the
  resumable session bus remains the sole React display stream. Server-side
  validation, ownership, attachment limits, worker lifecycle, and billing are
  unchanged. User-message history now projects the server's validated
  `metadata.attachments` records through the official Attachment component and
  the existing owner-authorized download route; malformed attachment ids are
  never turned into links. A read-only session-status probe supplies reload-recovery evidence
  for in-progress work; it gates the existing owner-scoped stop control rather
  than duplicating worker state. React
  now owns the server-authoritative model picker for each Dev turn: it reads
  `GET /api/models`, retains the legacy `usernode:dc:model` preference only
  when the current server allowlist permits it, and sends the selected id in
  the existing chat payload. Session pause/resume/archive use the existing
  lifecycle endpoints and server-owned capacity handling. React also owns the
  server-authored quick-reply contract: suggestions on the newest assistant
  message prefill the composer without sending, persist as the current
  session's draft, focus only on fine-pointer devices, and disappear while a
  turn is streaming. Structured assistant questions use the same current-model
  send contract: a single answer can be sent directly, while multi-question
  prompts collect explicit selections and compose the established numbered
  reply. Suggested defaults remain an explicit user action. These controls
  disable whenever the user has typed a draft or attached a file, so
  server-authored suggestions cannot silently replace unsent work; production
  review mode also keeps them read-only. Stop controls and the current
  per-session draft are migrated. The compact Dev budget status now reads the
  existing user/global allowance, BYOK spillover, and provider-availability
  fields. It stays quiet when either account or budget reads fail, because the
  server remains the billing authority, and an exhausted allowance links to
  the unified React Settings surface for Anthropic-key management. Shared,
  BYOK, exhausted, and unavailable states are registered as deterministic
  Storybook evidence. React now also owns the existing named/saved-draft
  contract. While Builder is working, the composer remains writable and offers
  an explicit save-for-later action; its plain-text drafts keep using the
  established `usernode:dc-saved-drafts:<sessionId>` localStorage key, retain
  the 20-draft cap, and never auto-send. Send stays disabled during a live
  turn, while edit and delete remain explicit. Pending attachments are not
  captured into a named draft and stay parked in the composer. The desktop
  docked staging mode remains legacy.
  The nested React session-spec view is inspection-only: the owner-authorized
  latest buffer and immutable version history retain the server's privacy rules,
  with user-facing/technical section tabs where the existing markers exist.
  It now also owns both existing owner-only sharing contracts. Group sharing
  posts the selected immutable version through
  `POST /api/sessions/:id/specs/:version/share`, then reloads version metadata
  so the server's `shared_to_group_at` stamp remains authoritative. Private
  sharing sends one exact username through the existing `share-user` endpoint,
  preserves its collaborator/privacy rejection, and uses the app's canonical
  mention-candidate read solely as optional suggestions. The compiled
  production-review profile disables both actions before any request. Manual
  spec editing and version creation are not migration gaps: those legacy
  routes were retired server-side because Mayor mutations already auto-freeze
  immutable numbered versions.
  The session route also projects existing owner-scoped persisted Claude Code
  progress/output/log metadata into a collapsed read-only build timeline; its
  active segment is fed only by the existing session SSE stream. It has no
  retry, rebuild, or separate realtime control path.
  React now owns a responsive full-screen staging-preview
  route: normal migration environments call the existing rebuild endpoint and
  wait for TLS readiness; the local production-review profile instead opens
  only an already-live preview and never calls that rebuild endpoint. Both
  modes compose only a validated relative testing path under the returned staging
  origin, and requests the existing iframe token before mounting. The
  immutable before/after capture evidence is rendered from the existing
  server-owned artifact ids.
  Cross-app Work now also subscribes to the established authenticated global
  `ws/events` channel through a typed `session_update` adapter. Partial
  events trigger a coalesced re-read of the authorised Work snapshot rather
  than client-side patching; a 3-second reconnect and the legacy 15-second
  busy/disconnected poll retain freshness when the socket is unavailable.
  The Dev overview now exposes the same user-selectable `?view=list|kanban|pm`
  route vocabulary as legacy Dev. The query value is a one-shot override;
  an explicit selection persists per app in local storage. List is a linear
  projection of the existing board snapshot, Kanban retains the existing
  same-column ordering contract. PM groups open issues and proposals by the
  server-reported leading community assignee and applies the existing
  per-person `/pm-order` overlay. Collaborators may drag within a person to
  replace that person's saved order, across people to cast their own reversible
  assignee vote, or into Unassigned to withdraw that vote. The server remains
  authoritative for the leading tally, collaborator access, rate limits and
  last-write-wins order fan-out; React reloads the canonical board after each
  move and on the scoped global `board_order_update` event rather than patching
  another collaborator's partial payload. View-only users and
  production-review mode receive the same projection without mutation
  affordances.
  The app-scoped Dev overview now also owns read-only promoted-proposal and
  open-governance lists using the existing `/promoted` and `/issues` APIs,
  including vote and discussion counts. Proposal and governance detail routes
  now own the existing direct vote contracts: respectively
  `POST /api/sessions/:id/vote` with `yes|no`, and
  `POST /api/issues/:id/vote` with `up|down`. They never optimistically mutate
  tallies, because the server may merge or apply a change after a vote; both
  reload the canonical forum snapshot on success. The compiled production-review
  profile disables those controls with no mutation request. Proposal detail
  also owns direct, reversible `POST|DELETE /api/sessions/:id/kudos`: server
  eligibility, self-recognition prevention, weekly allowance, and notification
  fan-out remain authoritative, while React reloads the forum rather than
  altering its local count. Force-merge, withdrawal, general issue/proposal
  creation, moderation, and console actions remain explicit legacy Dev
  handoffs until their distinct authorization and side-effect contracts have
  equivalent evidence. The narrowly scoped GitHub-issue close proposal is the
  exception described below. Governance keeps its database proposal ID
  distinct from a GitHub issue number throughout.
  React owns the latest 50 general app-discussion rows at
  `/react/apps/:slug/dev/chat` and the issue, proposal/session, and governance
  discussions embedded in their respective detail routes. All use the existing
  view-authorized history API and official Shadcn message, bubble, attachment,
  marker, and message-scroller primitives. Existing attachment download links,
  quoted context, system rows, edited markers, and reaction aggregates render
  from canonical history. The general discussion route no longer exposes a
  legacy-Dev escape hatch: its history, replies, edits, reactions, attachments,
  typing, unread state and pagination are all owned by the React surface.
  Collaborators may post messages and toggle reactions through the existing cookie-authenticated
  `/ws/chat/:slug` protocol. Scoped sends preserve the server's exact
  `{thread:{type,ref}}` envelope, and scoped chat/edit broadcasts invalidate
  only the matching mounted topic; reaction broadcasts trigger a harmless
  canonical reread because the established event omits thread provenance.
  React never invents an optimistic chat cache. The compiled production-review
  profile and non-collaborators cannot post, reply, edit, or react. Replies use
  the established minimal `{source,refMsgId}` reference: the server validates
  the source row inside the same app, re-derives its author and snippet, and
  owns notification fan-out. The controlled reply preview is shared by general
  and scoped topic composers, and a scoped reply preserves both `thread` and
  `quote` in the same socket envelope. Authenticated authors can edit their own
  ordinary messages inline; the socket sends only `{type:"edit",messageId,
  content}`, while the server rechecks app membership, authorship and row type,
  preserves quote metadata/reactions, and broadcasts the canonical thread
  scope. General and scoped composers also upload as many as four immutable
  files through the established raw-byte endpoint before sending their IDs in
  the same socket envelope; attachments-only messages remain valid, failed
  uploads stay out of the send, and the server owns classification, size,
  storage and collaborator checks. Typing sends are throttled through that
  socket and carry the mounted topic envelope; remote indicators expire
  automatically, announce politely, and ignore unrelated general/topic events.
  Canonical history flags message-level unread mention/reply/reaction state;
  React exposes an accessible mark-read action, clears only that message
  optimistically, and reconciles all mounted discussions through the shared
  server notification event stream. Fifty-row earlier-page browsing remains
  available on scoped topics. Notification destinations remain inside React:
  rows carrying a session, issue or thread identifier open the matching owned
  detail, while older rows without a stable identifier open the app Dev
  overview rather than guessing a detail or falling back to legacy.
  The app Dev overview and `/react/apps/:slug/dev/issues/:number` now also
  render the existing view-authorized GitHub issue feed and lazy GitHub
  comment reader. Issue body, native GitHub link, activity status and comments
  are read-only. The recorded issue author may rename an open issue through the
  existing canonical GitHub-first title PATCH; the server remains the sole
  authority for collaborator access, open-issue state and authorship, and the
  compiled production-review profile disables the control before any request.
  Collaborators may also create or clear only their own reversible,
  platform-local in-progress claim through the existing open-issue-verified
  claim endpoints; after either server-confirmed action React refreshes the
  canonical issue feed rather than deriving a local status. A collaborator
  may also propose closing an open GitHub issue through the existing
  `POST /api/apps/:slug/issues` governance contract. React submits
  `kind: close_issue` with the issue number and an optional reason; it never
  closes GitHub directly. The server re-verifies collaborator access and the
  open GitHub issue, rejects duplicate close proposals, and remains the sole
  authority for later governance application. React loads the current open
  governance feed before exposing the action, preserves canonical failure
  reasons inside its confirmation dialog, and links a successful result to the
  owned governance detail route. A write-capable admin may also clear one
  specific collaborator's stale in-progress claim from the React issue detail.
  React sends the existing target `userId` payload, never assumes admin access
  from presentation state, refreshes the canonical issue feed after success,
  and preserves server authorization errors without hiding the action. View-only
  admins, regular collaborators, and the compiled production-review profile
  never receive the control. The issue's platform discussion now supports the
  scoped text, reply, author-edit, attachment, reaction, typing, and unread
  actions described above. A collaborator may create an ordinary,
  issue-linked Dev session through the canonical session endpoint. React opens
  the owned session immediately with the legacy-compatible kickoff message
  preserved as an editable, unsent session draft; the user decides whether
  and when to send it. A collaborator may also explicitly start the existing
  headless proposal generator from an issue after selecting an allowed model;
  the server remains authoritative for collaborator access, model validation,
  personal billing, worker capacity, and the strictly no-PR/no-deploy outcome.
  React presents its generating/ready/question states and lets a collaborator
  clone a ready shared proposal into a private Dev session through the existing
  clone contract. A collaborator may place one
  explicit, non-retractable issue-kudos pledge through the canonical bounty
  endpoint; the server still verifies the issue is open, access, duplicate
  pledges and the shared weekly allowance before recording it. A collaborator
  may independently cast or withdraw personal priority, assignee, and category
  votes through one owned topic-attribute pattern. These are reversible social
  signals, not private assignments or workflow commands. React loads all three
  server tallies independently, uses the app's canonical built-in/custom
  category vocabulary, permits the existing free-text category and assignee
  suggestions, preserves rejected drafts, and treats every returned tally as
  authoritative. The compiled production-review profile exposes none of the
  controls. Completed proposal and applied-governance cards now stay within
  React. Active items resolve from the board feeds; completed/deep-linked
  items recover through view-authorized single-item readers, preserving their
  discussion context without returning to legacy Dev. The completed feed also
  follows the existing mixed-type keyset cursor, so users can progressively
  load older PR and applied-governance history without leaving the React
  workspace.
  React also owns shared-session detail at
  `/react/apps/:slug/dev/shared/:id`. It first proves that the session remains
  in the existing view-authorized shared-session list before loading its public
  session thread; this deliberately avoids the owner-only session API. Replies,
  reactions, author edits, attachments, typing, unread reconciliation and
  earlier-page browsing reuse the same canonical `session` chat thread as
  proposal discussion. Collaboration access remains server-authoritative:
  viewers receive the complete transcript without mutation affordances, while
  collaborators use the existing authenticated app socket and React rereads
  canonical history after broadcasts. The page does not expose owner-only
  visibility, rebuild, or worker controls because those belong to the owner’s
  separately authorized session route rather than this shared public surface.
  Generic session creation now uses the established bodyless
  `POST /api/apps/:slug/sessions` contract and immediately opens the newly
  created React session route. The server remains the source of truth for
  collaborator access, repository readiness, capacity, and branch creation;
  its actionable errors are displayed without rewriting them. The compiled
  production-review profile disables this mutation and has an explicit
  no-request browser assertion. The owned session detail now also calls the
  server's pause and resume transition directly, including its promoted
  "free worker" behavior and capacity errors. Archive uses the official
  shadcn/Base UI confirmation dialog, warns that it closes the PR and frees
  the worker slot, and returns to the app Dev overview only on server success.
  An idle active session can now also be proposed through the existing
  owner-scoped `POST /api/sessions/:id/promote` contract. React waits for the
  canonical worker-status probe before exposing that transition, confirms the
  consequential vote lifecycle, then reloads the server-owned session state;
  proposal capacity, pull-request preparation, staging recovery, and GitHub
  state remain server-authoritative. The production-review profile disables
  this mutation with no request. Owners can also use the established
  `POST /api/sessions/:id/share|unshare` transitions from the React session
  detail; the page reloads canonical state after the server's WebSocket fan-out
  rather than predicting visibility. Archived owner sessions also expose the
  existing reversible `POST /api/sessions/:id/unarchive` transition behind an
  explicit confirmation. The server restores the session to paused, decides
  whether its pull request can reopen, and reports whether its retained Builder
  workspace expired; React reloads the canonical result rather than deriving
  it locally. Promoted owner sessions whose automated checks are pending,
  failing, or errored can also explicitly request the existing
  `POST /api/sessions/:id/recheck` pipeline. The confirmation explains that
  it can rebuild staging; the server keeps authorization, duplicate coalescing,
  check-state stamping, and event fan-out authoritative. Live WebSocket
  reconciliation beyond that narrow invalidation
  remains legacy until its state transitions and permission contracts migrate
  as a unit.
- **In progress:** App Detail now owns the existing saved-app action through
  `POST /api/apps/:slug/favorite`, preserving the subtle server distinction:
  removing a collaborator app changes only the current user's hidden
  preference, while removing an ordinary saved app removes the favorite. The
  grouped Detail action hub updates only from the server-confirmed result and
  makes the mutation unavailable in production-review mode. It also renders
  the existing public, wallet-free contributor roster; private apps preserve
  the endpoint's 404 boundary rather than leaking membership. Apps Home is
  intentionally an uncluttered catalogue: `Your apps` is quick access while
  `All apps` includes every app, including saved ones. App Detail also owns
  the narrow, full-admin `POST /api/apps/:slug/lock` transition: it confirms
  the consequence, uses the returned canonical `locked` value, and is absent
  for view-only/non-admin users and disabled in production-review mode. The
  server remains responsible for authorization, system chat, and WebSocket
  fan-out. App Detail also owns rename as an explicitly confirmed
  `POST /api/apps/:slug/rename` manifest-PR proposal: it never changes the
  visible app name locally, and it sends the user to the server-created Dev
  session where the existing vote/merge/deployment lifecycle remains intact.
  The Members and visibility route now owns the exact
  `POST /api/apps/:slug/visibility-pr` governance contract. Official Shadcn
  toggle groups express the server's valid paired access policies: public
  collaboration forces public viewing, while private collaboration may choose
  public or collaborator-only viewing. The currently deployed policy remains
  visually authoritative; React never applies the draft optimistically.
  The server remains responsible for manager authorization, self-hosted and
  repository exclusions, proposal deduplication and rate limits, pending-invite
  cleanup after an accepted policy change, and deploy reconciliation. A newly
  created or already-open proposal links to its React Dev session. Non-managers
  cannot edit the draft, and production-review mode issues no write request.
  App Detail also owns the legacy share contract as an official Shadcn sheet:
  it exposes only the app's resolved bare URL, never an iframe token or session
  credential, and offers copy plus open-in-new-tab without a server mutation.
  The hosted app remains responsible for deciding whether an external visitor
  must authenticate.
  Apps Home now owns the
  personal full-list `PUT /api/favorites/order` contract through an explicit
  Earlier/Later reorder mode. It operates only on the caller's complete `Your
  apps` rail, preserves the collaborator-hide distinction of the favourite
  endpoint, restores a server read on failure, and is unavailable in
  production-review mode. The remaining app-management writes remain legacy
  contracts.
  The isolated `/react/apps/:slug/recovery` route now owns only the existing
  `POST /api/apps/:slug/retry` failure-recovery transition. It first reloads
  the view-authorized app snapshot, exposes the action only for an errored
  app with `can_manage`, and redirects to the canonical app detail only after
  the server confirms the retry. It deliberately does not combine retry with
  secrets, redeploy, deletion, or configuration changes; server-side manager
  access and retry caps remain authoritative. Production-review mode disables
  the write with an explicit no-request browser assertion.
  The dedicated `/react/apps/:slug/members` route now adapts the canonical
  collaboration-gated roster and username-prefix typeahead. It preserves the
  server's non-disclosing 404 boundary for private apps, shows accepted and
  pending collaborators separately, and only invokes the existing invite or
  delete endpoint after an explicit user action. The backend remains the
  authority for invite-only visibility, self-hosted exclusions, duplicate
  invites, creator/app-admin removal rights, and self-leave. The React view
  never infers those permissions from its own list; it merely hides impossible
  controls and reloads the canonical roster after a server-confirmed write.
  Visibility is presented alongside membership as a governance proposal, not
  an instant settings mutation: neither current access nor pending invitations
  change locally before the accepted proposal deploys. Production-review mode
  disables all membership and visibility writes. Public contributor
  display remains the separate wallet-free App Detail roster.
- **In progress:** Admin starts with the explicit access-gated, read-only
  Operations snapshot at `/react/admin`; Users, Activation Codes, and Spend
  Limits are capability-gated management surfaces at `/react/admin/users`,
  `/react/admin/codes`, and `/react/admin/limits`. Any administrator can
  also inspect the server-ranked cross-app general-feature feed at
  `/react/admin/features`, filter its existing statuses, and download a local
  CSV assembled from the existing paginated read endpoint; it deliberately
  adds no feature moderation or other write path. `/react/admin/debug` also
  preserves the any-admin, read-only merge/conflict trace with server-side
  filters, keyset pagination, and on-demand run-step expansion. Code generation now
  uses the existing bodyless `POST /api/admin/codes` endpoint only when the
  loaded admin capability permits writes; the returned code is prepended to
  the visible list and server errors are kept verbatim. Production-review and
  view-only admin profiles make this unavailable. The same capability gate now
  protects code revocation through `DELETE /api/admin/codes/:id`; React offers
  it only for unused codes and requires an explicit no-undo confirmation
  before removing the server-confirmed code from the list. React now also
  copies a displayed activation code locally without a server request. The Users page also
  owns the existing per-user app-quota and daily-limit overrides, and Spend
  Limits owns the server's atomic platform-cap update; both use canonical
  responses and stay disabled in production-review/view-only profiles. Roles,
  deletion, password/wallet administration, bulk updates, exports, and all
  other mutations remain in `#admin` until their permission and audit
  contracts have independent parity evidence.
- **In progress:** `/react/admin/gallery` is the any-admin, read-only React
  counterpart to legacy `/gallery`. It reads only the existing
  `/api/gallery/apps`, `/api/gallery/stats`, and keyset-paged
  `/api/gallery/proposals` metadata contracts, retains the server's
  administrator gate, and renders artifact ids solely through the existing
  public immutable `/visuals/:id` URLs. It does not proxy artifact bytes,
  reveal proposal-index metadata to non-admins, or add a visual-capture
  mutation. Filters, empty/error states, mobile layout, and the legacy escape
  are fixture-tested; legacy `/gallery` remains reachable until production
  parity is reviewed.

## Existing harness caveat

The legacy `npm test` command is still useful evidence, but it runs Node with
`--test-force-exit`; its aggregate process result should not be treated as the
only failure signal. The new React CI gate reports its individual lint, type,
browser and accessibility checks directly. Tightening the legacy runner is a
separate compatibility task, not a reason to block the first migrated route.
