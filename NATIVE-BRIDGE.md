# Usernode Native Bridge Contract

The Usernode Flutter app injects a `Usernode` JavaScript channel into every
page loaded in its dapp webview. `public/usernode-bridge.js` (canonical copy:
`public/usernode-bridge/v1/bridge.js`) wraps that channel in promise-returning
methods on `window.usernode`. This document is the versioned contract between
the app (producer — the Flutter shell, which lives in its **own repository**,
`lib/features/dapps/dapp_webview_screen.dart` there) and SV chrome (consumer,
this repo) for the methods SV's own shell depends on.

Wire format: the page posts
`{ id, method, args, privilegedCapability? }` as JSON to the channel; the app
resolves via `window.__usernodeResolve(id, value, error)`. The optional field
is used only when the app advertises `privilegedBridgeCapability`; older app
builds keep receiving the original `{ id, method, args }` shape. Unknown
methods are silently dropped by old app builds, so every bridge wrapper races
a timeout and degrades gracefully — never assume a method exists,
feature-detect with `getBridgeInfo`.

## Versioning

- `getBridgeInfo()` → `{ version: number, capabilities: string[],
  appVersion?: string, buildNumber?: string }`
- `version` bumps only on breaking changes. New methods are additive and
  appear in `capabilities`.
- Feature-detect with `capabilities.includes('<method>')`, not `version`.
- Current version: **4**.
- **The two sides of this contract live in different repositories** — the
  producer in the Flutter shell repo, the consumer here. Adding or changing
  a bridge method is therefore a coordinated two-repo change, and the two
  halves ship independently: assume for a while that some installed builds
  have the old surface and some have the new one. That is exactly what
  `capabilities` is for — never assume a method exists because this document
  lists it.

Six additive security/session capabilities extend v4 without changing its
version:

- `privilegedBridgeCapability`: privileged top-frame methods require a
  native-issued capability scoped to the current trusted JavaScript realm.
- `privilegedBridgeReady`: after installing native-event listeners, the trusted
  shell explicitly identifies that exact realm as ready for one atomic state
  replay. A cached older coordinator falls back on its first authorized bridge
  call, so the web and app releases remain independently deployable.
- `beginSessionHandoff`: closes native wallet dispatch before a web-session
  exchange, including raw Android child-frame channel messages.
- `enterAnonymousSession`: reopens native wallet dispatch after the shell has
  confirmed that no web participant is signed in.
- `sessionBoundAuthStatus`: auth snapshots include `participantId` and
  identity `epoch`, and node starts can be bound to both values.
- `privilegedErrorCodes`: every privileged refusal carries a stable
  machine-readable `code` alongside its human message, so the page never has
  to pattern-match English. Optional in both directions — see "Privileged
  refusal codes" below.

One additive **widget** capability extends v4 the same way:

- `homeScreenShortcutDarkIcon`: the shell stores a SECOND icon per
  homescreen shortcut and the iOS widget selects between them per system
  appearance. Advertise it only once that is true end to end — SV reads
  it as "sending a dark icon has a visible effect" and re-sends every
  pinned canvas tile the first time it appears. See the homescreen
  shortcuts section below for the contract it unlocks.

One additive **notification** capability extends v4 the same way:

- `setSocialBadgeCount`: the shell applies a web-published unread total to
  the OS app-icon badge (issue #1445). Advertise it only on builds where
  the call has a visible effect end to end — SV feature-detects it
  separately from the four social-push methods, so builds without it keep
  full push support and simply never see the call. See "Homescreen icon
  badge" below for the producer contract it unlocks.

## Methods

### Wallet / transactions (pre-existing, v1)

| Method | Args | Resolves |
|---|---|---|
| `getNodeAddress()` | — | `"ut1..."` current account address |
| `sendTransaction(dest, amount, memo, opts)` | see bridge.js | `{ queued, tx }` after the native confirm sheet |
| `signMessage(message)` | `{ message }` | signature string |
| `txObserved` | fire-and-forget inclusion ack | — |
| `openExternal` | `{ url }` (http/https only) | `true` when the system browser opened |

### Homescreen shortcuts (pre-existing, v1)

`getHomeScreenShortcutSupport`, `addHomeScreenShortcut`,
`getHomeScreenShortcuts`, `removeHomeScreenShortcut`,
`reorderHomeScreenShortcuts` — see the comments in `usernode-bridge.js`.

#### Per-appearance icons (additive; `homeScreenShortcutDarkIcon`)

`addHomeScreenShortcut` takes
`{ name, url, icon_url, icon_url_dark?, silent? }`:

- `icon_url` — required-in-practice primary asset. When a pair is sent it
  is the **light**-appearance asset.
- `icon_url_dark` — **optional** dark-appearance asset. Absent, null or
  empty means "single icon", i.e. exactly the pre-existing behaviour. A
  re-add without it **clears** the dark slot (a re-add of the same URL is
  an in-place refresh — that is what `silent: true` is for).
- Either field may be an `https` URL **or** a `data:image/png;base64,…`
  URI. SV sends data URIs for its canvas-rendered emoji/letter tiles, so
  both fields must go through the same fetch/decode path.
- `version` stays **4**: this is purely additive, and shells that don't
  know the field ignore it like any other unknown key in `args`.

`getHomeScreenShortcuts()` items carry `{ id, name, url, pinnedAtMs }`
plus two icon-presence flags: `has_icon` (SV treats `false` as "the PNG
never landed" and silently re-sends) and `has_icon_dark` (same, for the
second asset). Report `has_icon_dark: true` only once the dark asset is
actually stored; SV tests it with a strict `=== false`, so a build that
omits the key entirely is safe.

**`has_icon_dark` is a load-bearing statement of fact, not a hint.** SV
treats the registry read-back as the authority on what this build can
store, because the capability list cannot be trusted to be complete: a
shell may store the dark asset in a release earlier than the one that
advertises the string, and a degraded `getBridgeInfo` reports no
capabilities at all while saying nothing about storage. So when the
capability answer is anything other than a conclusive yes, SV sends **one**
pair for a single canvas-tile entry, re-reads the registry and believes
`has_icon_dark`:

- `=== true` → this build stores pairs. SV records the verdict against
  `{ appVersion, buildNumber }` and sends pairs from then on.
- anything else → this build does not. SV records that verdict the same
  way and **immediately re-sends that one tile as a single face for the
  current appearance**, so the probe never leaves a light tile stranded on
  a dark homescreen.

Two obligations follow for the shell. A build that stores the asset must
report `has_icon_dark: true` for it — reporting `false` (or omitting the
key) after storing a pair tells SV the opposite of the truth and costs
that build the feature. And a build that accepts `icon_url_dark` while
discarding it must keep reporting `has_icon_dark: false`, which is what
lets SV correct the tile in the same pass.

The verdict is **bound to the installed version pair** and discarded as
soon as it changes: an app update is exactly when a shell gains or loses
this ability, so a verdict that outlived the build it was measured on
would be a latched negative in a slower disguise. When `getBridgeInfo`
cannot supply `appVersion`, no verdict is trusted and SV re-confirms
(one silent send per page load).

**Appearance selection is a render-time decision.** SV re-fetches the
registry and re-evaluates every entry when the app returns to the
foreground, but it cannot repaint while closed. A shell that advertises
the capability (or reports `has_icon_dark: true`) must therefore select
between the two stored assets on `colorScheme` **at widget render time**,
not at store time. Picking a face when the shortcut is added and keeping
it produces precisely the bug this contract exists to fix, while now
reporting the flag that makes SV stop compensating for it.

**Why this exists, and why the flag must not be advertised early.** A
stored PNG cannot restyle itself, and SV cannot repaint one while the app
is closed — which is exactly when the system flips light/dark (#948).
Without the capability, SV bakes the single face matching the current
system appearance and re-sends it when it notices a flip, so the
correction always waits for the next app open. With it, SV sends both
faces and the widget flips natively with SV closed. A shell that accepts
and stores `icon_url_dark` but does not select on `colorScheme` must NOT
advertise the capability: SV would send an asset nobody renders and would
have given up the repaint-on-flip fallback for nothing.

### Homescreen icon badge (additive; `setSocialBadgeCount`)

#### `setSocialBadgeCount({ count })` → resolves when applied

Privileged top-frame action (issue #1445), same per-realm capability and
session-admission rules as the four social-push methods. SV calls it from
the trusted Social shell every time the signed-in account's unread
notification total changes — on every bell repaint, after mark-read, and
with `count: 0` on sign-out — so the OS app-icon badge tracks what the
user would see inside the app.

Producer requirements for a build that advertises the capability:

- **Apply `count` to the OS app-icon badge**: on iOS via
  `UNUserNotificationCenter` badge count; on Android via the launcher
  badge, cancelling the shell's own tray notifications when the count
  reaches 0 so the notification dot clears with it.
- **`count` is authoritative and the call idempotent** — a non-negative
  integer, last write wins. Re-applying the current value must be a
  no-op, not a flicker.
- **Persist nothing beyond the OS surface**: the value is derived state
  SV republishes on session admission and page restore; the shell must
  not replay a stale stored count over a newer one.
- **Clear the badge on logout / session end**, matching SV's own
  `count: 0` publish, so a signed-out device is never left badged.
- **Advertise `setSocialBadgeCount` only where the call has a visible
  effect.** SV feature-detects it separately from the social-push
  capability set (a degraded `getBridgeInfo` is re-probed, never latched
  as unsupported), and builds without it lose nothing: the badge still
  appears via the `aps.badge` / `notificationCount` fields the platform
  stamps into every push, and clears on the next app open once a
  capable build is installed.

The FCM payload side of the same feature needs no shell code at all:
iOS applies `aps.badge` and Android launchers read
`notification.notificationCount` while the app is closed. This method
exists for the live half — updating and clearing the badge while the
user is inside the app.

### Chrome data (v2 — the app-as-SV-chrome surface)

#### `getBridgeInfo()` → `{ version, capabilities, appVersion?, buildNumber? }`

Instant, side-effect free. The bridge wrapper resolves
`{ version: 0, capabilities: [] }` on old builds / outside the app, so
callers can always `await` it and gate UI on capabilities.

`appVersion` and `buildNumber` identify the installed Flutter binary (for
example `0.4.0` and `1223`). They are public release identifiers on the
unprivileged probe so a Social Vibecoding staging build can display the app
hosting its WebView without receiving access to native settings or account
state. App builds predating these optional fields omit them; production SV
falls back to the same pair under `getSettingsState().buildInfo` while those
older builds remain installed.

**A probe that FAILS inside the app resolves that same empty shape plus
`degraded: true`** (the wrapper's own marker — native never sends it).
Reading `capabilities` needs no change; **a caller that CACHES or LATCHES
a negative conclusion from a probe MUST check `degraded` and re-probe
instead.** `version: 0` from inside the app means "don't know", not "this
build has no capabilities": treating a 4s timeout as the latter is how one
cold-start hiccup disabled every privileged call for a whole document and
made Settings → Usernode app unloadable until the app was force-closed
(issue #978). The two in-repo consumers of this rule are the bridge's own
privileged-capability negotiation and `NativeChrome.getInfo()`, which
shares its in-flight promise but never memoises a degraded answer.

#### Why a read came back empty — `getLastNativeReadError(method)`

Every chrome read **resolves a safe fallback rather than rejecting**, so
callers can `await` and render "unavailable" (see the note at the top of
this section). That deliberately loses the reason, so the wrapper parks it
beside the read: `usernode.getLastNativeReadError("getSettingsState")`
returns the most recent FAILED read of that method, or `null` when its
last read succeeded or it was never called.

```json
{ "method": "getSettingsState", "kind": "timeout",
  "message": "getSettingsState did not respond within 12000ms",
  "at": 1780000000000 }
```

`kind` is one of:

| `kind` | Meaning |
|---|---|
| `timeout` | the app did not answer inside the wrapper's budget for that method |
| `rejected` | the app answered with an error (`message` is native's own text) |
| `no-transport` | no channel to the app from this frame at all |
| `not-native` | called outside the app (or on a build without the method) |
| `probe-inconclusive` | the privileged handshake could not be negotiated because `getBridgeInfo` itself came back degraded |
| `privileged-unavailable` | the app refused (or never answered) this realm's privileged handshake, so a privileged method could not be called at all — see "Privileged refusal codes" below |
| `page-changed` | the originating page entered navigation/BFCache before its native reply arrived |

The record carries a method name plus native's own error string only — the
privileged capability lives in a closure and never reaches an error
message — and each frame keeps its own map, so a frame can only read
failures of calls it made itself. `NativeChrome.lastReadError(method)`
forwards to it for SV chrome; SV's Settings screen renders the mapped
reason instead of a bare "could not load".

Privileged **actions** (setters, `openNativeScreen`, the session methods)
still reject rather than resolving a fallback — that part is unchanged —
but they now leave the same record behind, so a refused action is as
diagnosable as a failed read.

#### Privileged refusal codes

When the app refuses a privileged call, the human message is written for a
person and may be reworded at any time. Consumers must not pattern-match
English to decide what happened, so the app may send a stable machine-readable
code alongside it.

**Transport — a 4th argument to `__usernodeResolve`, additive in both
directions.** The page already resolves a request with
`window.__usernodeResolve(id, value, error)` where `error` is a **string**
that the wrapper turns into `new Error(error)`. A build that has a code
passes one more argument:

```js
window.__usernodeResolve(id, null,
  "Privileged bridge is unavailable for this main frame",
  { code: "privileged_frame_unauthorized" });
```

Both halves of this stay compatible on purpose:

- **Old app, new page.** Three arguments arrive, `errorInfo` is `undefined`,
  and the page behaves byte-for-byte as it does today — no code is invented.
- **New app, old page.** Older installed wrappers ignore extra arguments.
- `error` **must stay a string.** Moving the code into that slot would make
  every installed build render `[object Object]` to the user.
- A missing, empty, non-string or malformed `code` is ignored, never trusted.

The wrapper puts a valid code on the rejected error as
`err.usernodeCode`, tags it `err.usernodeKind = "privileged-unavailable"`
and `err.usernodePrivileged = true`, and classifies it:

| `code` | Classified state | What the user is told |
|---|---|---|
| `privileged_frame_unauthorized` | `blocked-frame` | the app is refusing this screen's secure connection |
| `privileged_unsupported_version` | `unsupported` | this app build predates the connection this screen uses |
| `privileged_bootstrap_timeout` | `unattached` | the app never answered the connection request |

An **unrecognised** code still classifies (as `blocked-frame`) rather than
falling through — a code the page has never seen is still positive evidence
that the app refused deliberately. With **no** code at all, the page falls
back to matching native's prose, which is why the classification keeps
working against every build shipped so far.

A build that always sends a code should advertise `privilegedErrorCodes` in
`capabilities`. Nothing on the SV side depends on that capability or on the
codes landing at all — this is a paired change owned by the Flutter repo, and
the consumer half shipped first, degrading to prose matching.

**Codes carry no secrets.** A code is a fixed identifier from the table
above, never a token, path, account identifier or free-form detail: the page
renders it and offers it as copyable text.

#### `getBridgeDiagnostics()` → connection snapshot (synchronous)

Everything the current frame knows about its own bridge, copied, with no
`await`:

```json
{ "isNative": true, "isTopFrame": true, "inIframe": false,
  "usesIframeRelay": false, "hasNativeChannel": true,
  "origin": "https://social.usernode.com",
  "bridgeVersion": 4, "capabilities": ["..."],
  "appVersion": "0.4.0", "buildNumber": "1223",
  "privileged": { "state": "blocked-frame",
                  "code": "privileged_frame_unauthorized",
                  "kind": "privileged-unavailable",
                  "message": "…native's own text…",
                  "at": 1780000000000, "attempts": 3 },
  "lastErrors": { "getSettingsState": { "method": "…", "kind": "…",
                                        "message": "…", "at": 0 } },
  "collectedAt": 1780000000000 }
```

`privileged.state` is one of `ready`, `blocked-frame`, `unsupported`,
`inconclusive`, `unattached`, `unknown`. `bridgeVersion`, `capabilities`,
`appVersion` and `buildNumber` come from the last **conclusive**
`getBridgeInfo` — which is unprivileged, and therefore still answers on a
device whose privileged handshake is refused. That is what makes such a
device diagnosable at all.

It carries **no capability token** (the token lives in a closure and never
reaches a message) and no user data, and each frame reads only its own
records. In a child frame the privileged record is reported as
`blocked-frame` / `no-transport` regardless of what that frame last tried,
so an embedded dapp learns nothing about the top frame.

SV renders it as Settings → Usernode app → "Usernode app — connection", with
**Try again** and **Copy diagnostics**.

#### `getNodeStatus()` → snapshot object

```json
{
  "status": "synced",          // synced | syncing | connecting | offline
  "chain": "testnet",
  "localBestHeight": 12480,       // our tip (null while unknown)
  "localBestTimestampMs": 1780000000000,
  "networkBestHeight": 12483,     // block-sync target (null while unknown)
  "readyPeers": 3,
  "connectedPeers": 3,            // compatibility alias for readyPeers
  "totalPeers": 8,
  "syncStalled": false,
  "clockDriftMs": 42,
  "walletDataHydrating": false
}
```

`status` is the chrome-level pill state (small hysteresis applied on the
native side so 1s-poll flapping between synced/syncing doesn't strobe).
`readyPeers` counts peers whose P2P connection has reached the ready state.
`syncStalled` becomes true while syncing after no local-tip, fetch, or apply
progress for three block intervals (with a 60-second minimum). The timestamp
and clock drift are milliseconds; subtracting `clockDriftMs` from the device
clock produces the node clock used for the displayed best-tip age.

**Push events:** the app also dispatches a `usernode:node-status`
`CustomEvent` on `window` with the same snapshot as `detail`:

- once after the shell explicitly confirms its native-event listeners are
  ready, and
- on every pill-state transition.

So chrome renders from the event stream and only calls `getNodeStatus()`
for an initial value; no polling needed.

#### `getWalletState()` → wallet snapshot

```json
{
  "address": "ut1...",
  "balance": "1284",        // base units, string (BigInt-safe)
  "tokenAmount": 1284.0,    // display units, number
  "tokenSymbol": "UT",
  "lastUpdatedMs": 1714672193412,
  "staking": {
    "delegate": null,
    "delegated_since": null
  }
}
```

Fields other than `address` are `null` while the native wallet provider
hasn't produced a value yet (fresh app start, node still syncing). The app
answers within ~10s worst-case; the bridge wrapper adds its own timeout.

`staking` is `null` while wallet setup or backend reconciliation is not yet
available. Within a staking snapshot, `delegate` alone is authoritative:
`null` means phone block production is active, while a non-null address means
delegation is active. `delegated_since` is optional display metadata and must
never be used to infer whether delegation is enabled.

#### `manageStaking()` → `{ delegate, delegated_since }`

Bridge v4 capability: `manageStaking`. This privileged top-frame method takes
no arguments, opens the native delegation screen, and resolves with the latest
staking snapshot after that screen closes, including when the user makes no
change. Native owns the fixed delegation target, confirmation, backend
synchronization, persistence and node reconfiguration. Social Vibecoding must
not submit a target address or requested delegation state itself.

#### `getTransactionRecords()` → `{ items: [...] }`

The webview's persisted dapp-transaction receipts (what the native receipts
sheet shows), newest first, capped at 100:

```json
{
  "items": [{
    "id": "...",                // tx id
    "sentAt": 1714672193412,    // epoch ms
    "from": "ut1...", "to": "ut1...",
    "amount": "5",              // base units, string
    "memo": "{...}",
    "status": "queued",         // queued | denied | error
    "confirmedAt": 1714672253412,       // present once seen on-chain
    "inclusionLatencyMs": 60000,
    "blockHeight": 12480,
    "onChainStatus": "confirmed"
  }]
}
```

Records are scoped per webview URL on the native side; the SV shell sees
the receipts of transactions sent from SV (including relayed child-app
sends, which run through the shell's bridge).

#### `openNativeScreen({ screen })` → `true`

Pushes an allowlisted native route. Allowed screens: `diagnostics` (the
minimal native diagnostics screen), `benchmark`, `httpLogs`, and `zkIdentity`
— the debugging UIs and hardware-backed identity flow that survive the
thin-shell migration. The former `settings`, `profile`, and `terms` screens
were deleted with their web replacements and are rejected like any other
value. Rejected entirely unless the top frame is the trusted SV origin
(sub-apps cannot drive native navigation).

The additive `zkIdentityFlow` capability means
`openNativeScreen('zkIdentity')` is dispatchable. SV gates its ZK identity
entry action on that feature capability so older app builds never expose a
dead button.

#### `captureScreenshot()` → `{ contentType, base64 }`

Additive bridge-v4 capability: `captureScreenshot`. Captures the currently
visible Usernode app window on Android or iOS and returns a JPEG as base64.
The native encoder bounds the image to the feedback endpoint's 4 MB limit.
SV hides its feedback dialog before calling so the returned pixels show the
underlying screen, then restores the unchanged draft and presents a preview.

This is a privileged trusted-top-frame action. Child dapps cannot request a
capture of surrounding app chrome. Callers must feature-detect the capability;
older app builds continue to use the feedback dialog's Photos/file fallback.

### Profile & settings (v3 — profile-and-settings-to-web migration)

All v3 methods are trusted-SV-origin gated like `openNativeScreen`. They
power SV's `#profile` screen (`public/js/profile.js`) and the "Usernode
app" sections in SV's Settings modal (`public/js/settings.js`).

#### `getProfileInfo()` → `{ participantId }` (legacy)

**Legacy — like `openNativeScreen`'s `settings` / `profile` screens, kept
only so older shell builds keep working. Nothing in SV calls it any more;
do not add new callers.**

`participantId` is the leaderboard participant id (number), or `null` when
the user hasn't registered. Since the topochain merge, participant ids ARE
platform user ids and SV's `#profile` screen no longer consults this
method for data — the in-process `/challenges-api` routes
(`src/routes/topochain/mobile.js`) scope `/me/*` to the platform session
server-side.

Its last remaining use was capability detection: the drawer's Profile row
was revealed only when the bridge reported this method, which meant the
screen was unreachable in an ordinary browser even though it worked
perfectly there. That gate is gone — the row now ships visible to
everyone, and the screen renders a "Sign in to see your profile" prompt
when there is no session.

#### `getSettingsState()` → settings snapshot

```json
{
  "buildInfo": {
    "appVersion": "1.4.2", "buildNumber": "87",
    "nodeVersion": "0.9.1", "commitHash": "a1b2c3d", "branch": "develop"
  },
  "nodeSleepEnabled": true,
  "debugMode": false,
  "facematchStrict": true,
  "authStatus": "authenticated",  // AuthStatus enum name
  "permissions": {
    "platform": "android",        // android | ios
    "exactAlarmGranted": true,
    "batteryOptDisabled": false,  // Android only, else null
    "deviceManufacturer": "samsung" // Android only, else null
  }
}
```

v4 removed `termsAccepted` (terms moved to the session-authed
`/challenges-api/terms/*` web routes) and `iosKeepAliveActive` (the iOS
foreground keep-alive service was deleted; iOS block production is off).

Permission probes can take a few seconds on a fresh app start; the bridge
wrapper uses a longer (12s) timeout for this method.

Like every chrome read it resolves `null` rather than rejecting on failure,
and the reason is available from
`getLastNativeReadError("getSettingsState")` (see above). SV's Settings →
Usernode app section renders that reason with a retry, and keeps the blocks
that don't need this snapshot (activity notifications, block production,
terms, FAQ, the native diagnostics screens) on screen, so a failed read is
recoverable rather than a dead end.

#### Setters — each resolves the refreshed settings snapshot

| Method | Args | Effect |
|---|---|---|
| `setNodeSleepEnabled(enabled)` | `{ enabled: bool }` | toggles node sleep on inactivity |
| `setDebugMode(enabled)` | `{ enabled: bool }` | toggles the app's debug mode |
| `setFacematchStrict(enabled)` | `{ enabled: bool }` | toggles strict ZK-passport facematch |
| `requestPermissions()` | — | native alarm-permission prompt; snapshot plus a `granted` bool |

`setIosKeepAlive` was removed in v4 with the iOS keep-alive service.

#### Actions — resolve `true`

| Method | Effect |
|---|---|
| `resetZkChallenge()` | discards in-progress ZK identity registration (confirm web-side first) |
| `openBatterySettings()` | opens Android battery-optimization settings |
| `openNotificationSettings()` | opens the OS notification settings page for the app. The only way back from a **determined-denied** iOS notification permission: once the user has answered the OS prompt, `requestPermissions()` resolves immediately and presents no dialog, so a screen offering only "request" is a tap that does nothing forever. Capability-gated, and fails fast (probe timeout, not the 120 s permission timeout) — an *inconclusive* probe still calls through, per issue #978. |
| `logout()` | performs the bounded hard native logout (node stop/drain plus identity and credential cleanup); clear the web session and cache first, then invoke this as the terminal operation |

### Platform login + node lifecycle (v4 — thin-shell migration)

All v4 methods are trusted-SV-origin gated. Login/onboarding is
platform-owned: the SV shell signs the user in on the web, exchanges the
session for a mobile bearer token (`POST /api/v4/mobile/auth/from-session`),
hands the credential to the app, and then drives the node. Orchestration
lives in `public/js/native-chrome.js` (`runLoginHandoff`,
`prepareWebLogout`, and `commitNativeLogout`). The exchange runs for every
live web session, including when native already reports `ready`, so same-user
bearer rotation is never skipped. Its returned `user.id` must still match the
current web participant before the token crosses the bridge. Overlapping
session signals coalesce; if the web participant changes during an exchange,
the latest session is exchanged once the active run settles.

The shell closes its local top-frame/iframe wallet gate synchronously with
`sv:session`. Builds advertising `beginSessionHandoff` also close native
wallet dispatch before `/from-session`, so Android child frames cannot bypass
the JavaScript wrapper with a raw channel message. A verified current-user
handoff reopens both gates; failures stay closed. Pre-v4 builds reopen the
local gate after their older bridge version confirms that no handoff exists.

**Sign-out never depends on the app answering.** `prepareWebLogout()` closes
every admission gate synchronously and then **resolves a report** —
`{ nativeTerminal, latch, reason, code }`, where `latch` is `acknowledged`,
`unsupported`, `unavailable` or `inconclusive` — instead of rejecting. It
used to reject, which aborted SV's sign-out *before* `POST /api/auth/logout`:
a device whose privileged handshake was refused kept its web session with no
way out of the app at all. A refused latch now means SV asks the user and
then clears the web session anyway, attempts `usernode.logout()` best-effort
inside a short budget, and says so on the login screen if the app kept its
own session. The fail-closed wallet gate is unchanged — the fallback loosens
the exit, never the gate.

#### `beginSessionHandoff()` → `{ blocked: true }`

Privileged preflight for builds that advertise it. Closes session-scoped
native wallet reads, signing, and transaction dispatch in this WebView until
`completeLogin` admits the current participant. Participant replacement keeps
the old WebView closed while its runtime is replaced.

#### `enterAnonymousSession()` → `{ admitted: true }`

Privileged acknowledgement used after the shell confirms an anonymous web
session. The shell keeps its local wallet relay closed until native admits
wallet access, so a failed or stale acknowledgement remains fail-closed.

#### `completeLogin({ token, user })` → auth status snapshot or restart signal

Imports the platform credential into the native identity: the app stores
the bearer token, provisions/imports the custodial wallet
(`POST /api/v4/mobile/wallet/provision`), and settles the identity at
`ready`. Idempotent for the same user, including bearer-token rotation.
Wallet provisioning can take a while on a fresh install — the bridge wrapper
allows up to 120s.

With `sessionBoundAuthStatus`, a settled response is
`{ phase, address, participantId, epoch, reconciliationStatus }`, where
`reconciliationStatus` reports `idle | reconciling | transient | refreshing |
settled | failed`. A cross-participant login first performs the native
hard-logout boundary and resolves `{ restarting: true }`; the current document
must stop there while the native runtime restarts.

#### `startNode({ address?, participantId?, epoch? })` → node status snapshot

Starts the native node bound to the given wallet address. The native side
validates the address belongs to the current (ready) identity and rejects
otherwise; omitting `address` starts with the identity's active account.
Builds advertising `sessionBoundAuthStatus` also require the supplied
participant and epoch to match the current identity. Older v4 builds ignore
the additive binding fields and retain the address-only compatibility path.
No native auto-start exists anymore — SV requests every node start.

Block production is a released capability (onboarding flow alignment):
the node always runs, syncs, and signs wallet transactions, but only
configures a block-producer key when the platform has released the user
(`bp_released` on `GET /api/v4/mobile/me` and
`POST /api/v4/mobile/wallet/provision`, persisted natively per account).
Users ask via the SV settings "Block production" section
(`POST /challenges-api/bp/request`); admins release from the admin panel's
Waitlist tab. No bridge payload change — the contract stays at v4.

#### `stopNode()` → `{ stopped: true }`

Stops the node. Idempotent and available for explicit lifecycle control;
normal web logout calls the single hard native `logout()` boundary instead.

#### `getAuthStatus()` → `{ phase, address, participantId?, epoch?, reconciliationStatus? }`

Poll-style twin of the push events below. `phase` is the identity phase
(`unknown | transitioning | unauthenticated | guest | reconciling |
ready`); `address` is the active wallet address once `ready`. Builds with
`sessionBoundAuthStatus` also include the current participant and identity
epoch.

**Push events:** the app dispatches a `usernode:auth-status` `CustomEvent`
on `window` with the same shape as `detail` — once after the shell's explicit
listener-readiness handshake and on every identity-phase transition. SV
listens and requests `startNode` when the phase reaches `ready`.

## Trust model

- The native transaction confirm sheet remains the sole native chrome over
  SV content (Apple Pay model). Nothing in this contract bypasses it.
- Privileged native methods are gated to the configured SV top-frame origin.
  The top-frame bridge privately asks for `getPrivilegedBridgeCapability` and
  keeps the returned opaque string in its closure. Native binds it to the
  executing JavaScript realm rather than to WebView lifecycle callbacks:
  same-document History API changes retain it, a replacement document gets a
  different capability, and BFCache restoration revives only its original
  realm. The capability is never exposed as a public `window.usernode`
  property.
- Privileged replies and native-to-page events are delivered only when that
  exact realm is still executing. Social calls `markPrivilegedBridgeReady`
  after all native-event listeners exist; native then dispatches the existing
  auth/node/push events together in one realm-guarded JavaScript evaluation
  before acknowledging readiness. A failed replay is retryable rather than
  silently consuming state.
  `onPageStarted`/`onPageFinished` are intentionally not authority or listener
  readiness signals because their ordering differs across WebView platforms.
- The parent bridge refuses both capability bootstraps and privileged relays
  from child frames. Non-privileged dapp reads and transaction methods keep
  their existing relay behavior only while the current web/native session
  handoff is admitted.
- Loopback origins are not privileged by default. Flutter development builds
  can opt in with `--dart-define=ENABLE_LOCAL_PRIVILEGED_BRIDGE=true`; the
  switch is additionally gated by Flutter debug mode and cannot enable
  loopback privileges in a release build.
- `openExternal` accepts http/https only.

## Offline / App-Bound Domains

The app's iOS webview opts into App-Bound Domains
(`WKAppBoundDomains` = `usernodelabs.org`, `evanshapiro.dev`, `localhost`),
which unlocks service workers — SV's PWA offline mode works inside the app.
Consequences:

- The webview cannot navigate to non-bound domains; external links must go
  through `openExternal`.
- The `Usernode` channel only exists on bound domains.

Android webviews support service workers without configuration.
