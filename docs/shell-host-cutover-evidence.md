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
- Flutter host audited: `1e11a8a7998330e71894885369ec8f6297bea63e`
  from `origin/develop`
- Deployment path: **not locked**. Flutter still defaults to the legacy shell
  at `https://social-vibecoding.usernodelabs.org/`; the React candidate remains
  staged under `/react/`.

Any later G6 review must replace the branch name with immutable web, Flutter,
and deployed build revisions.

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

## Host requirement matrix

| Requirement | Current status | Evidence or contradiction | Smallest next proof |
| --- | --- | --- | --- |
| Iframe mount identity across temporary navigation | Proven in browser candidate | `frontend/tests/focused-app-continuity.spec.ts`, committed in `e6c05ab` | Run in required CI against the immutable cutover candidate and retain the raw artifact |
| Safe-area ownership / no double inset | Contradicted | Flutter owns the top inset with `SafeArea(bottom: false)`; React declares `viewport-fit=cover` but consumes no `env(safe-area-inset-*)`; Android has no edge-to-edge contract | Make the web the single inset owner, then record top, bottom, notch, and keyboard-visible states on physical iOS and Android |
| Bridge caller authentication / privilege isolation | **Hard blocker; contradicted** | Flutter authorizes privileged calls from the trusted top-frame URL. The web relay forwards child-frame methods other than shortcut-named calls, so a child can traverse the trusted parent into privileged settings, reset, screen, or logout methods | Add caller provenance and an explicit capability policy; prove a cross-origin child is rejected before native dispatch while permitted child capabilities still work |
| Shortcut/widget route | Contradicted | Native pinned shortcuts reopen a separate raw-app `DappWebViewScreen`, not `/react/apps/:slug/open` | Pin a fixture on both platforms and assert the resulting top-frame URL is the canonical React focused route |
| Shortcut/widget identity asset | Missing | No executable contract ties React `AppIdentity` to Android shortcut and iOS widget assets | Define one canonical identity payload and compare its asset identity or hash across shell, Android, and iOS |
| Viewport zoom | Contradicted | React ships `maximum-scale=1.0,user-scalable=no`; no physical-device proof exists | Resolve the viewport policy, then record pinch zoom and text scaling on both platforms |
| Browser and native Back | Missing | Flutter has static WebView-history-first logic but no cross-repo or device test for React nested routes, root Home, or legacy hashes | Record Home → app → nested route → app → Home on both platforms, including browser history and a legacy-hash handoff |
| Offline and service-worker readiness | Missing / unsafe | Flutter permanently passes its first-load gate on `onPageFinished`, not `navigator.serviceWorker.ready`; later failures have no native recovery UI; the root-worker cutover strategy is undecided | On the exact production build, record worker URL/version/scope/readiness, airplane-mode deep-link reload, reconnect, and logout cache isolation on both platforms |
| App-Bound Domains | Static configuration only | The production registrable domain is configured and WKWebView opts in, but the selected React deployment path and runtime channel/worker behavior are unproven | Capture top-frame host, `Usernode` channel discovery, and React worker readiness on physical iOS |
| External links | Contradicted end to end | Native `openExternal` validates HTTP(S), but the WebView has no universal navigation interception and React still has ordinary external anchors | Activate direct anchors, `target="_blank"`, and bridge calls on both devices; prove the system browser opens and the trusted WebView URL does not change |

## Required order

1. Fix and negatively test bridge caller authentication.
2. Record the immutable React/Flutter/deployment candidate tuple, including a
   Flutter `DAPPS_TAB_URL` that targets the React shell.
3. Align shortcut/widget routing and canonical app identity.
4. Establish web-owned edge-to-edge insets and an accessible viewport.
5. Execute the two-device Back, keyboard, safe-area, offline, App-Bound, and
   external-link matrix.
6. Attach raw CI and device evidence to the candidate revisions.

## Decision

G6 remains closed. Motion experiments and production shell cutover must not
start from browser-only confidence. The current static shell milestone remains
reviewable without claiming host readiness.
