# Shell host cutover evidence

**Status:** G6 no-go  
**Recorded:** 2026-07-29  
**Scope:** React shell inside the Flutter mobile WebView

This record separates browser evidence from claims that require the real
Flutter host. Static browser fixtures are useful, but they do not prove native
channel injection, caller provenance, cookies, App-Bound Domains, system Back,
physical safe areas, or service-worker readiness inside a shipped WebView.

## Candidate tuple

- React branch: `codex/react-shadcn-migration`
- Focused-shell implementation and continuity tests:
  `e6c05ab` (`feat(shell): land platform drawer and contextual chrome`)
- Web relay provenance, shortcut, viewport, and focused-host implementation:
  `6785617` (`feat(host): harden WebView shell contracts`), including
  `public/usernode-bridge.js` and its byte-identical
  `public/usernode-bridge/v1/bridge.js`
- React service-worker readiness and logout-isolation implementation:
  `2eca16f` (`feat(pwa): verify readiness and isolate sessions`) in
  `frontend/src/react-service-worker.ts`,
  `frontend/public/react-sw.js`, `frontend/@/lib/auth-api.ts`, and
  `frontend/vite.config.ts`; a local artifact derives a deterministic
  `sha256-*` revision from its emitted files and required root runtimes, while
  verified CI supplies the exact source SHA. The page, worker, and
  revision-scoped cache share that value
- Exact-artifact check/deploy chain:
  `db0ea79` (`ci(cutover): deploy exact verified shell artifacts`)
- Flutter host audited: `1e11a8a7998330e71894885369ec8f6297bea63e`
  from `origin/develop`
- Deployment path: **not locked**. Flutter still defaults to the legacy shell
  at `https://social-vibecoding.usernodelabs.org/`; the React candidate remains
  staged under `/react/`.

Any later G6 review must replace the branch name with the final tested web
candidate, Flutter build, verified-artifact manifest/checksum, and deployed
worker revisions. The implementation commits above are immutable, but they
have not yet been packaged or deployed as the locked physical-device tuple.

## Proven in the browser candidate

The focused-app tests preserve iframe JavaScript identity, a form value, and
iframe scroll position while the narrow platform drawer opens and closes.
They also cover the frame sandbox, source construction, unsafe inner-path
rejection, offline presentation, and Use/Improve/Close route actions.

Focused verification:

- platform navigation, focused host, and mount continuity: 14 passed,
  2 intentional desktop skips;
- Home/Explore and app-host route matrix: 40 passed,
  4 intentional production-review skips;
- Activity route matrix: 24 passed.

The static cutover checker also verifies `/react` history fallback and asset
base, the separately scoped React worker, iframe token refresh wiring, native
title signaling, bridge capability fixtures, and legacy-worker
exclusion/logout cleanup policy. It correctly remains `not-ready`.

### Web relay caller-provenance proof

The web-owned relay no longer treats the trusted top frame as evidence about
the child that initiated a request:

- discovery accepts only a direct child `WindowProxy` and binds that source to
  the exact `MessageEvent.origin` observed during the handshake;
- every later request must match both the discovered source and origin;
- a deny-by-default policy allows only `getBridgeInfo`, `getNodeAddress`,
  `getNodeStatus`, `getWalletState`, `sendTransaction`, and `signMessage`;
- `getBridgeInfo` is filtered before returning to the child, so it never
  advertises privileged native capabilities;
- profile/settings data and mutations, transaction-record history,
  `openNativeScreen`, permission/battery actions, ZK reset, logout, every
  homescreen-shortcut operation, malformed calls, and unknown future methods
  are rejected before `Usernode.postMessage`;
- permitted requests retain Flutter's existing `{ id, method, args }` wire
  format, and the direct top-frame path is unchanged;
- each discovered child is limited to eight pending native calls in total and
  one pending interactive `sendTransaction`/`signMessage` call;
- every relayed request has a 15-second timeout. Resolution, rejection,
  timeout, post failure, and origin change all release the pending slot, and
  an origin change rejects old outstanding calls before rediscovery.

Focused evidence:

- the focused root bridge/cache command passes 104/104 across the legacy Home
  shortcut, bridge, relay, service-worker classifier, and delayed-session
  boundary suites;
- the relay suite positively dispatches every advertised safe method and
  negatively checks 17 privileged methods plus one unknown-future method;
- it also proves the 8-total/1-interactive limits, timeout cleanup, and hosted
  bridge mirror;
- the frontend native-bridge contract passes 8/8;
- both hosted bridge copies are byte-identical and parse cleanly;
- frontend lint has 0 errors (13 known Fast Refresh warnings), TypeScript
  passes, and the static cutover contract reports 10 verified / 0 failed /
  1 `native-webview-e2e` blocker.

The 104-test command is intentionally focused; it is not a substitute for the
repository's complete legacy `npm test` gate.

### React service-worker and logout-isolation proof

The React shell now has an executable browser readiness contract instead of
equating `onPageFinished` with an offline-capable shell:

- the React-scoped worker registers at `/react/react-sw.js` with `/react/`
  scope with `updateViaCache: "none"`, explicitly requests an update, waits for
  `navigator.serviceWorker.ready`, waits for that exact worker to control the
  page, and requests a status acknowledgement;
- verified status includes the exact build revision, worker version, scope,
  revision-scoped cache name, last session-clear timestamp, and a complete
  boot inventory. Readiness requires a non-empty, de-duplicated inventory,
  matching count, `bootAssetsReady: true`, `missingBootAssets: []`, and no more
  than one predecessor cache. A stale controller at the same script path and
  public worker version cannot satisfy readiness unless that entire contract
  matches the page. The shell then publishes
  `usernode:react-shell-ready` and `data-react-shell-ready="true"`;
- the boot inventory is generated from the completed artifact and includes
  `/react/`, compiled boot assets, the portable shortcut runtime, and the
  required root bridge, Dev-host, and offline runtimes;
- first readiness means the complete boot inventory is cached. The production
  browser suite proves an immediate offline shell reload without a warming
  navigation; the worker maps every scoped navigation to the canonical shell
  document;
- activation retains exactly one predecessor cache. An N−1 tab claimed by the
  new worker may still resolve one old lazy chunk from that cache if neither
  the network nor current cache can satisfy it;
- authenticated API responses remain network-only and are absent from the
  React shell cache;
- when a React worker controls the page, web-session logout requires a strict
  `clear-react-session-cache` acknowledgement, verifies the matching worker
  status transition, and then deletes every legacy-owned `usernode-api-*`
  cache family directly through Cache Storage;
- an uncontrolled first load has no controlling worker to acknowledge. In that
  case direct deletion and re-enumeration of every `usernode-api-*` family is
  the authoritative cleanup proof;
- before deletion, logout advances an origin-wide session epoch shared with
  the legacy worker. A legacy response that began before the boundary cannot
  write into a user cache after logout, even from another tab;
- after the server session has ended, invalid acknowledgements, missing status
  transitions, failed cache deletions, or residual `usernode-api-*` families
  navigate to a signed-out `Finish signing out` quarantine. It suppresses all
  new login/registration/wallet-link entry points until cleanup succeeds;
- the cleanup marker is cross-tab observable and persistent where Web Storage
  is available. A restricted WebView without Web Storage fails closed using
  in-memory state for the current document;
- successful cleanup does not delete the revision-scoped React shell assets
  the worker owns; unrelated cache families also survive;
- this web-session cleanup remains separate from native wallet logout.

Focused browser evidence:

- the production-build React service-worker suite passes 6/6: an N−1 tab
  retains lazy-asset continuity; readiness validates the exact complete boot
  inventory; an immediate offline reload boots without cached API paths;
  session clearing is acknowledged without discarding the offline shell; real
  logout removes legacy `usernode-api-*` families while preserving the React
  shell and an unrelated cache; and cleanup failure is surfaced;
- focused Settings checks cover controlled and uncontrolled cleanup, invalid
  acknowledgements, quarantine/retry, and unavailable Web Storage;
- the root cache suites prove classifier/cache-family ownership plus a real
  delayed authenticated response that cannot cross the logout epoch;
- `.github/workflows/frontend-checks.yml` now triggers for both
  `public/sw.js` and `tests/pwa-sw-classify.test.js` changes and runs the root
  classification test in CI.

This proves the React browser contract, not the Flutter host outcome. The
candidate has not yet demonstrated readiness delivery, immediate offline reload,
reconnect recovery, or logout isolation inside physical iOS and Android
WebViews.

### Exact-artifact deployment proof

The deployment pipeline now preserves one tested React artifact from source to
production image:

- `Frontend checks` builds once with the exact main source SHA as
  `SV_REACT_SHELL_REVISION`, runs the production worker and frontend gates
  against that output, then packages `react-shell-<sha>`;
- the package carries a manifest binding `sourceSha` and
  `reactShellRevision` to that SHA plus a checksum for every React file;
- automatic deployment re-reads the current main ref and skips an older
  successful workflow run before any deploy mutation, preventing a queued
  success from rolling production backward;
- an eligible deploy checks out the same SHA, downloads only the artifact from
  that exact successful run, verifies its manifest and checksums, and installs
  it without rebuilding the frontend;
- a production Docker build validates the same manifest/checksums again and
  requires `GIT_SHA === SV_REACT_SHELL_REVISION`;
- manual deployment is an explicit exact-SHA replay and still requires a
  successful push-triggered check plus retained matching artifact.

This is pipeline-contract evidence, not evidence that the current working-tree
candidate has been packaged or deployed. The immutable/deployed candidate tuple
above therefore remains open.

### Shortcut, identity, viewport, and external-link proof

The React candidate now owns explicit, portable web contracts for the remaining
shell-host seams:

- shortcut requests target one canonical
  `/react/apps/<slug>/open` top-frame route, optionally carrying one validated
  relative inner path; credentials, executable origins, and unsafe inner paths
  fail closed;
- a versioned portable shortcut schema carries the stable app identity hash,
  design-system palette slot, mutable appearance hash, monogram, display name,
  and artwork reference. The appearance hash is an explicit native
  cache-invalidation key;
- the viewport permits zoom, declares `viewport-fit=cover` and
  `interactive-widget=resizes-content`, maps device insets to web-owned CSS
  slots, and suppresses a second bottom inset when `VisualViewport` indicates
  that the software keyboard is present;
- ordinary route content owns horizontal inset compensation and the active
  bottom inset; all four Sheet presentations and their close controls consume
  the relevant top, side, and keyboard-aware bottom slots;
- focused app and staging-preview routes explicitly opt out of the ordinary
  route inset. Their full-bleed chrome and frames remain the sole safe-area
  owner for those surfaces;
- the synthetic viewport contract covers non-zero `VisualViewport.offsetTop`,
  orientation settling, keyboard thresholds, coarse-pointer behavior, and the
  zoom path without treating pinch zoom as a software keyboard;
- a document-level external-link contract intercepts ordinary cross-origin
  HTTP(S) anchors, treats either the wrapper or the raw `window.Usernode`
  channel as evidence that it is running in the native host, uses
  `openExternal` when advertised, and preserves the trusted top-frame URL;
- ordinary browser mode retains authored anchor behavior. Native mode keeps
  same-origin routes inside the shell, but blocks credential-bearing URLs,
  non-web schemes, downloads, and named browsing-context targets rather than
  allowing them to navigate the trusted frame;
- missing capability and failed native opens produce a visible, accessible
  shell alert with retry and dismiss actions. Unsupported native link forms
  produce the same visible alert without offering a meaningless retry.

Focused browser evidence covers:

- the portable shortcut/schema/label/envelope contract, including shared
  adversarial fixtures and the packaged runtime;
- App Details capability gating, the exact native envelope, success, and
  failure presentation on desktop and mobile;
- ordinary-route, Sheet, viewport, keyboard, external-link, focused-host, and
  staging-preview contracts on desktop and mobile;
- modified-primary and middle-click suppression in native/probing mode while
  ordinary browser behavior remains authored.

These checks document the current web candidate; they are not a
shortcut-cutover or native-adoption claim.

This is web-contract evidence, not Flutter adoption. The audited Flutter
revision still launches homescreen entries into a raw-app WebView, does not
persist or compare the portable identity/appearance hashes, and retains its
own top `SafeArea`. Physical iOS and Android have not proven zoom, keyboard
behavior, system-browser delegation, or shortcut/widget launch results.

The executable preparation for those remaining claims is
[the G6 WebView physical-device runbook](g6-webview-device-proof.md).

## Host requirement matrix

| Requirement | Current status | Evidence or contradiction | Smallest next proof |
| --- | --- | --- | --- |
| Iframe mount identity across temporary navigation | Proven in browser candidate | `frontend/tests/focused-app-continuity.spec.ts`, committed in `e6c05ab` | Run in required CI against the immutable cutover candidate and retain the raw artifact |
| Safe-area ownership / no double inset | Web contract proven; Flutter adoption and physical-device proof pending | React gives ordinary routes horizontal/bottom ownership, covers every Sheet edge and close control, explicitly opts full-bleed focused/preview routes out of route padding, and removes the active bottom inset while the visual keyboard is present. Synthetic tests cover non-zero viewport offset and orientation settling. Flutter still owns the top inset with `SafeArea(bottom: false)`, and Android has no verified edge-to-edge result | Make the web the single inset owner in the pinned Flutter candidate, then record ordinary routes, every Sheet edge, focused full-bleed top/bottom, notch/gesture, rotation, and keyboard-visible states on physical iOS and Android |
| Bridge caller authentication / privilege isolation | Web relay proven; physical-device proof pending | The browser/Node contract binds direct-child source + origin, applies an explicit deny-by-default policy, filters capability discovery, and rejects privileged calls before native dispatch. Flutter still sees only the top frame, and the changed relay has not run inside an immutable iOS/Android WebView candidate | On both physical platforms, load a cross-origin fixture child, prove forbidden calls never reach the Flutter handler, prove every permitted capability still resolves, navigate the same frame to a new origin and prove rediscovery is required, then retain raw native logs |
| Shortcut/widget route | Web contract proven; Flutter adoption and physical-device proof pending | React generates one absolute `/react/apps/:slug/open` host target with an optional validated inner path. The audited native shortcut/widget consumer still opens a separate raw-app `DappWebViewScreen` | Adopt the versioned shortcut request in Flutter, then pin and launch a fixture on both platforms and retain the resulting top-frame URL |
| Shortcut/widget identity asset | Web contract proven; Flutter adoption and physical-device proof pending | The portable v1 schema separates stable identity from mutable appearance and supplies an appearance hash for cache invalidation. Android/iOS do not yet persist that hash or prove byte-equivalent artwork | Consume the identity payload natively, regenerate cached artwork when its appearance hash changes, and compare shell/Android/iOS hashes and screenshots |
| Viewport zoom | Web contract proven; physical-device proof pending | React now omits `maximum-scale` and `user-scalable`, uses `interactive-widget=resizes-content`, and tests viewport/keyboard state in mobile and desktop browsers | Record pinch zoom, OS text scaling, keyboard resize, and focus reachability in both physical WebViews |
| Browser and native Back | Missing | Flutter has static WebView-history-first logic but no cross-repo or device test for React nested routes, root Home, or legacy hashes | Record Home → app → nested route → app → Home on both platforms, including browser history and a legacy-hash handoff |
| Offline and service-worker readiness | React browser contract proven; physical-device proof pending | Readiness validates the exact revision/version/scope/cache tuple and complete artifact-derived boot inventory. The browser suite proves an immediate offline shell reload, while the worker maps scoped navigations to the canonical document and retains one N−1 cache for an already-open tab's lazy chunk. Authenticated APIs remain network-only. Logout advances a shared session epoch before cache deletion, validates a strict worker acknowledgement/status transition or an explicit uncontrolled path, and quarantines a signed-out client when cleanup is incomplete. The root runtime test proves a delayed legacy response cannot cross the epoch. Flutter still permanently passes its first-load gate on `onPageFinished`, later failures have no native recovery UI, and none of this has run in the immutable iOS/Android candidate | On the exact production artifact in both physical WebViews, capture exact readiness and the boot inventory, immediately reload a history route in airplane mode, prove N−1 old-tab continuity, reconnect, then prove session-epoch isolation, worker acknowledgement/status or the uncontrolled path, quarantine/retry, all legacy user-cache deletion, and preserved shell/unrelated cache ownership |
| App-Bound Domains | Static configuration only | The production registrable domain is configured and WKWebView opts in, but the selected React deployment path and runtime channel/worker behavior are unproven | Capture top-frame host, `Usernode` channel discovery, and React worker readiness on physical iOS |
| External links | Web contract proven; physical-device proof pending | React detects both wrapper and raw native channels, centrally delegates ordinary cross-origin HTTP(S) anchors through advertised `openExternal`, and keeps the trusted shell URL stable. Native credential, non-web, named-target, and download forms fail closed with accessible feedback; failed opens expose retry/dismiss. Actual WKWebView/Android system-browser and alert recovery behavior is unrecorded | Activate direct anchors, `target="_blank"`, explicit bridge calls, every rejected form, and a forced native-open failure on both devices; prove the system browser opens only for eligible links, the trusted WebView URL never changes, feedback is reachable, retry recovers, and the bridge remains available on return |

## Required order

1. Commit the web relay policy to the immutable candidate, then reproduce its
   positive and negative provenance matrix in physical iOS and Android
   WebViews with native handler logs.
2. Record the immutable React/Flutter/deployment candidate tuple, including a
   Flutter `DAPPS_TAB_URL` that targets the React shell.
3. Adopt the versioned shortcut route and identity payload in Flutter, including
   appearance-hash cache invalidation.
4. Remove native ownership of the React shell inset so the web is the single
   edge-to-edge owner.
5. Reproduce the browser worker proof in the shipped WebView: readiness/status,
   immediate offline history-route reload, N−1 tab continuity, reconnect,
   session-epoch isolation, quarantine/retry, and acknowledged logout cleanup
   on physical iOS and Android.
6. Execute the remaining two-device Back, keyboard, safe-area, App-Bound, and
   external-link matrix.
7. Attach raw CI and device evidence to the candidate revisions.

## Decision

G6 remains closed. Motion experiments and production shell cutover must not
start from browser-only confidence. The current static shell milestone remains
reviewable without claiming host readiness.
