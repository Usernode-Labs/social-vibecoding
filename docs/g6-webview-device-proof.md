# G6 WebView physical-device proof

**Status:** **G6 NO-GO** — preparation only; no physical-device proof recorded  
**Scope:** React platform shell in the Flutter iOS and Android WebViews  
**Decision authority:** [Shell host cutover evidence](shell-host-cutover-evidence.md)

This runbook turns the remaining G6 host questions into one reproducible
two-device exercise. Simulator and desktop-browser results may debug the
fixture, but they do not close a row.

## Candidate lock

Do not install or test until every value below is immutable and the web
checkout is clean.

| Candidate field | Pinned value for this run |
| --- | --- |
| React top-frame URL | `https://social-vibecoding.usernodelabs.org/react/` exactly; no localhost, alternate port, redirect, or legacy-root substitution |
| React source/build | **Blocked:** implementation is pinned through `6785617` (host contracts), `2eca16f` (worker/session isolation), and `db0ea79` (exact-artifact deployment), but no verified artifact has been produced or deployed for a final candidate SHA. Replace this cell with that final Git SHA, verified-artifact manifest/checksum SHA-256, and deployed `/react/react-sw.js` SHA-256 before testing |
| React service worker | `/react/react-sw.js`, `/react/` scope; record the exact-SHA page revision and worker-reported `buildRevision`, `version`, `cacheName`, `cacheReady`, `bootAssets`, `bootAssetCount`, `bootAssetsReady`, `missingBootAssets`, and `retainedCaches`. Readiness requires the exact revision/scope/cache tuple, a non-empty complete inventory, `bootAssetsReady: true`, and no missing boot asset |
| Flutter source | `1e11a8a7998330e71894885369ec8f6297bea63e` from `origin/develop` |
| Flutter version | `0.3.3+1210`; build with `DAPPS_TAB_URL=https://social-vibecoding.usernodelabs.org/react/` |
| iOS App-Bound Domains | `usernodelabs.org`, `evanshapiro.dev`, `localhost` |
| Test identity | Non-production account plus a dedicated fixture app and cross-origin fixture child; record identifiers, never credentials |

The React build is intentionally a hard stop rather than a floating branch
reference. Production uses the exact source SHA as the shell revision; local
builds use a deterministic artifact digest. After deployment, save the tuple
as `candidate.json` and make the test harness fail if the page, worker, or app
reports another revision. A worker at the expected path with the expected
public version is still stale if its `buildRevision`, scope, cache name, or
complete boot inventory differs from the page's contract.

## Local readiness inventory

Read-only inventory on 2026-07-29:

- Flutter `3.41.4`, Android SDK `36.1.0`, and Xcode `26.4` are installed and
  healthy.
- iPhone 16 / iOS 26.0 simulator
  `69D97807-8D1E-4028-8BFD-54E1109049A7` is booted. It is useful for rehearsal
  only.
- Physical `Lukas' iPhone` / iOS 27.0 is visible to Xcode but offline. Unlock,
  cable-pair, and enable Developer Mode before the proof.
- Android has three AVD definitions (`Pixel6_API36`, `Pixel_6_API_34`,
  `Pixel_9a`) but no connected physical device. Attach an unlocked,
  developer-enabled Android device before the proof.
- Flutter host checkout:
  `/Users/lukasimrich/.codex/worktrees/5563/flutter-mobile-app` at the pinned
  revision. Its untracked `artifacts/` directory is not candidate source.

Re-run and retain the raw output before testing:

```sh
flutter doctor -v
flutter devices --machine
xcrun xctrace list devices
/Users/lukasimrich/Library/Android/sdk/platform-tools/adb devices -l
git -C /Users/lukasimrich/.codex/worktrees/5563/flutter-mobile-app status --short --branch
git -C /Users/lukasimrich/.codex/worktrees/5563/flutter-mobile-app rev-parse HEAD
git -C /Users/lukasimrich/Code/GitHub/worktrees/social-vibecoding-react-shadcn status --short --branch
git -C /Users/lukasimrich/Code/GitHub/worktrees/social-vibecoding-react-shadcn rev-parse HEAD
```

## Fixture and instrumentation

Use a non-production account and fixture app whose data may be reset. The
fixture must provide:

- a normal React nested route and a hosted child iframe;
- a child on a different origin that can perform bridge discovery, invoke all
  six allowed relay methods, attempt the 17 denied methods plus an unknown
  future method, exhaust the eight-request total and one-request interactive
  bounds, hold a request beyond the 15-second timeout, and navigate itself to a
  second origin;
- one form field near the bottom edge; ordinary and full-bleed route states;
  right, left, top, and bottom Sheets with close controls; and one external
  `https:` link exposed as a direct anchor, `target="_blank"`, and
  `openExternal` bridge action;
- credential-bearing HTTP(S), non-web, download, and named-target anchors, plus
  a controllable native-open failure, to prove fail-closed feedback and retry;
- a pinnable canonical identity payload with an appearance hash and stable
  artwork bytes.

Capture native bridge receipt/dispatch/rejection, current top-frame URL,
navigation decisions, worker readiness/error events, worker status replies,
online/offline changes, and logout cache acknowledgements with timestamps.
Logs must redact cookies, iframe tokens, signatures, wallet addresses, and
message arguments.

## Execution matrix

Run every numbered flow first on physical iOS, then from a fresh install/profile
on physical Android. Record `pass`, `fail`, or `blocked`; never infer one
platform from the other.

### 1. Cold launch and bridge timing

1. Start a screen recording and native log capture before cold launch.
2. Launch the pinned Flutter build into the exact React URL.
3. Record `onPageFinished`, React worker readiness, `Usernode` discovery, and
   first successful `getBridgeInfo()` in timestamp order.
4. Confirm the shell never declares ready from `onPageFinished` alone, never
   shows a blank frame, accepts only the exact worker
   revision/version/scope/cache tuple with its complete boot inventory present,
   and exposes only the candidate bridge version and capabilities.

Retain the native log, web console, worker status payload, screenshot of the
ready shell, and an ordered timing table.

### 2. Child provenance and capability policy

1. Load the cross-origin fixture as a direct child and complete discovery.
2. Invoke every advertised safe child capability; prove each resolves through
   the unchanged `{ id, method, args }` Flutter wire.
3. Attempt every denied method, a malformed request, and one unknown method.
   Prove each is rejected in the web relay and that no matching native handler
   log exists.
4. Hold eight non-interactive calls, then attempt a ninth; hold one
   `sendTransaction` or `signMessage`, then attempt a second interactive call.
   Prove both overflow calls fail before native dispatch.
5. Let one request exceed 15 seconds. Prove it is rejected, removed from the
   relay's pending map, and frees its caller slot for the next request.
6. Navigate the same iframe to the second origin while a request is pending.
   Prove the old call is rejected and a later permitted call fails until the
   new origin completes discovery.
7. Retry a permitted method after rediscovery and confirm it succeeds.
8. Confirm direct top-frame bridge calls still follow their advertised
   capability contract.

Retain the redacted child transcript, relay log, native log, and a correlation
table keyed by request ID.

### 3. Safe areas, keyboard, and zoom

1. Test portrait with gesture navigation and a notched/dynamic-island iPhone;
   capture an ordinary route, the shell top, focused app bottom, drawer, every
   Sheet edge and close control, dialog, and toast.
2. Focus the bottom-edge field, type, dismiss, and refocus. Controls and error
   text must remain reachable; the WebView/iframe must not remount.
3. Rotate with a Sheet open, then repeat the bottom-field flow. Confirm inset
   ownership settles after the visual viewport moves and the Sheet close
   control remains reachable.
4. Increase OS text size, pinch zoom web content, and repeat with reduced
   motion enabled.
5. Confirm exactly one owner for each top and bottom inset: ordinary routes
   own their route compensation, full-bleed app/preview surfaces opt out and
   own their own insets, and the keyboard suppresses only the active bottom
   inset. Require no clipped chrome, double padding, or content under the home
   indicator/Android gesture area.

Retain before/keyboard/zoom screenshots, a short recording, OS display
settings, viewport dimensions, safe-area values, and iframe identity before
and after.

### 4. Back and history

1. Traverse Home → app detail → focused app → Dev → nested session.
2. Open and close the platform drawer and confirm it does not consume history
   or remount the iframe.
3. Use system Back repeatedly. Each action must move exactly one meaningful
   web-history step; the root action exits/pops once without a loop.
4. Enter a supported legacy hash and confirm its handoff lands on the canonical
   React route; Back must return predictably.
5. Repeat after an inner hosted-app path change.

Retain a route/URL timeline, native Back logs, recording, and iframe identity
markers.

### 5. Shortcut route and identity

1. From app detail, add the fixture shortcut/widget using the native flow.
2. Record the shell `AppIdentity` appearance hash/artwork hash and the payload
   accepted by each OS.
3. Launch from the Android pinned shortcut and the iOS widget entry.
4. Require the top frame to resolve to
   `/react/apps/<fixture-slug>/open`; a raw child-app WebView or legacy route is
   a failure.
5. Compare shell, Android, and iOS identity hashes or captured artwork.

Retain shortcut/widget payloads, hashes, launch-intent/deep-link logs, final
top-frame URLs, and OS screenshots.

### 6. External links

1. Activate the direct anchor, `target="_blank"`, and bridge action. Each
   eligible HTTP(S) form must open the system browser, preserve the trusted
   React top-frame URL, and leave the bridge usable when returning.
2. Repeat eligible links with modifier-primary and middle-click activation
   while native capability discovery is pending and after it resolves. Native
   mode must suppress a second WebView/browsing-context navigation and
   delegate once; ordinary browser mode must retain authored behavior.
3. Activate credential-bearing HTTP(S), non-HTTP(S), download, and named-target
   anchors. Each must remain in the trusted frame and show the accessible
   unsupported-link alert; no system browser or second browsing context may
   open. Dismiss the alert and confirm focus remains usable.
4. Force one advertised `openExternal` call to fail. Require the accessible
   failure alert, activate its retry action, then confirm a successful system
   browser open removes the alert without changing the trusted top-frame URL.
5. Repeat one eligible and one rejected case with only the raw
   `window.Usernode` channel present before the wrapper is ready. They must
   still follow the native policy rather than ordinary browser navigation.

Retain before/after top-frame URLs, navigation-delegate/native logs, and the
system-browser and recovery-alert recording.

### 7. Service worker, offline, reconnect, and logout

1. Sign in, wait for the acknowledged React readiness event, and save the
   worker status payload. Confirm the exact revision/version/scope/cache tuple,
   `bootAssetsReady: true`, a non-empty de-duplicated `bootAssets` inventory
   whose count matches, and `missingBootAssets: []`. The inventory must include
   the canonical route document, the compiled boot assets, shortcut runtime,
   bridge, Dev host, and offline runtime.
2. Inspect cache keys immediately after first readiness. No `/api/` request,
   iframe token, stream, or authenticated response may appear.
3. Enable airplane mode immediately, without a warming navigation, and reload
   a React history route. The shell must boot from its canonical cached
   document and present explicit unavailable states for network-only data.
4. While an N−1 tab is open, activate the N worker and take the network
   offline. Prove the claimed old tab can still load an N−1 lazy chunk from the
   single retained predecessor cache. Prove that no second predecessor is
   retained.
5. Restore connectivity and retry without reinstalling or losing route
   context.
6. Open a second legacy-shell tab and delay one authenticated response across
   logout. Log out in React while its worker controls the page. Capture the
   origin-wide session-epoch advance, validate the strict
   `clear-react-session-cache` acknowledgement, then capture the worker
   status transition and verify its clear timestamp matches the
   acknowledgement. Verify that every `usernode-api-*` cache family is gone,
   while the revision-scoped React shell cache and an unrelated sentinel cache
   survive. Release the delayed legacy response and prove its pre-logout epoch
   cannot repopulate any user cache.
7. Without clearing OS app data, sign in as a second fixture user. No first-user
   content, API payload, child token, or route-private state may appear.
8. Rehearse the uncontrolled-first-load path in a fresh profile before a
   worker controls the page. Confirm logout uses direct deletion and
   re-enumeration as its proof, with no invented worker acknowledgement.
9. Inject or reproduce one invalid acknowledgement and one failed cache
   deletion after the server has ended the session. Both must navigate to the
   signed-out `Finish signing out` quarantine, suppress every login/register/
   wallet-link entry point, persist or fail closed in memory when Web Storage
   is unavailable, and require a successful cleanup retry before another
   authentication attempt.
10. Separately fail the server logout request. It must remain an explicit
    logout error rather than being described as a completed signed-out
    session.

Retain readiness/status payloads, cache-key inventories before and after
logout, network/worker logs, recording, and second-user screenshots.

### 8. iOS App-Bound Domains

On physical iOS, record the built `WKAppBoundDomains`, actual top-frame host,
worker script/scope, and `Usernode` channel availability. The React worker and
bridge must operate on the pinned host. A non-bound navigation must not retain
privileged channel access and must be delegated externally when intended.

Retain the built-app plist extract, Web Inspector evidence, native logs, and
the final host/channel matrix.

## Raw artifact package

Store artifacts outside source first, then attach an immutable archive to the
candidate review:

```text
g6-webview-proof/
  candidate.json
  checksums.txt
  preflight/
    flutter-doctor.txt
    devices.json
    ios-app-bound-domains.json
  ios/
    device.json
    screen-recording.mov
    screenshots/
    native.log
    web-console.log
    worker-status.json
    cache-inventory.json
    route-timeline.json
    bridge-correlation.json
  android/
    device.json
    screen-recording.mp4
    screenshots/
    logcat.txt
    web-console.log
    worker-status.json
    cache-inventory.json
    route-timeline.json
    bridge-correlation.json
  matrix.md
```

`checksums.txt` must cover the React asset manifest, worker, Flutter
IPA/APK/AAB, fixture assets, and the final archive. Keep raw logs; a written
summary without them is not proof.

## Stop conditions

Stop and leave G6 closed for any candidate or artifact/build-revision
mismatch, incomplete boot inventory, blank frame, premature readiness,
cross-origin privileged dispatch, unbounded relay work, leaked timeout slot,
capability mismatch, double inset, unsafe ordinary-route or Sheet edge,
inaccessible keyboard state, disabled zoom, Back loop, raw-child shortcut
route, identity mismatch, in-WebView external navigation, missing link-failure
feedback, failed retry recovery, cached API data, immediate offline boot
failure, broken N−1 tab continuity, reconnect failure, invalid logout
acknowledgement, a delayed response crossing the session epoch, missing
signed-out quarantine, unreported or residual cache-deletion failure, stale
post-logout data, or App-Bound/bridge inconsistency.

After a failure, retain the artifacts, record the smallest violated contract,
and test a new immutable candidate from the beginning. Do not patch a device
or production database in place.
