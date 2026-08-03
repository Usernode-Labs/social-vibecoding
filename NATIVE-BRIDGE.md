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

- `getBridgeInfo()` → `{ version: number, capabilities: string[] }`
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

Two additive security/session capabilities extend v4 without changing its
version:

- `privilegedBridgeCapability`: privileged top-frame methods require a
  native-issued capability scoped to the current trusted navigation.
- `sessionBoundAuthStatus`: auth snapshots include `participantId` and
  identity `epoch`, and node starts can be bound to both values.

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

### Chrome data (v2 — the app-as-SV-chrome surface)

#### `getBridgeInfo()` → `{ version, capabilities }`

Instant, side-effect free. The bridge wrapper resolves
`{ version: 0, capabilities: [] }` on old builds / outside the app, so
callers can always `await` it and gate UI on capabilities.

#### `getNodeStatus()` → snapshot object

```json
{
  "status": "synced",          // synced | syncing | connecting | offline
  "localBestHeight": 12480,    // our tip (null while unknown)
  "networkBestHeight": 12483,  // max across peers (null while unknown)
  "connectedPeers": 3,
  "totalPeers": 8
}
```

`status` is the chrome-level pill state (small hysteresis applied on the
native side so 1s-poll flapping between synced/syncing doesn't strobe).

**Push events:** the app also dispatches a `usernode:node-status`
`CustomEvent` on `window` with the same snapshot as `detail`:

- once per page load (after `onPageFinished`), and
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
  "lastUpdatedMs": 1714672193412
}
```

Fields other than `address` are `null` while the native wallet provider
hasn't produced a value yet (fresh app start, node still syncing). The app
answers within ~10s worst-case; the bridge wrapper adds its own timeout.

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
minimal native diagnostics screen), `benchmark`, and `httpLogs` — the
debugging UIs over native-only data that survive the thin-shell migration.
The former `settings`, `profile`, and `terms` screens were deleted with
their web replacements and are rejected like any other value. Rejected
entirely unless the top frame is the trusted SV origin (sub-apps cannot
drive native navigation).

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
| `logout()` | performs the bounded hard native logout (node stop/drain plus identity and credential cleanup); confirm web-side first, then clear the web session |

### Platform login + node lifecycle (v4 — thin-shell migration)

All v4 methods are trusted-SV-origin gated. Login/onboarding is
platform-owned: the SV shell signs the user in on the web, exchanges the
session for a mobile bearer token (`POST /api/v4/mobile/auth/from-session`),
hands the credential to the app, and then drives the node. Orchestration
lives in `public/js/native-chrome.js` (`runLoginHandoff`,
`handleWebLogout`). The exchange runs for every live web session, including
when native already reports `ready`, so same-user bearer rotation is never
skipped. Its returned `user.id` must still match the current web participant
before the token crosses the bridge. Overlapping session signals coalesce;
if the web participant changes during an exchange, the latest session is
exchanged once the active run settles.

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
on `window` with the same shape as `detail` — once per page load and on
every identity-phase transition. SV listens and requests `startNode` when
the phase reaches `ready`.

## Trust model

- The native transaction confirm sheet remains the sole native chrome over
  SV content (Apple Pay model). Nothing in this contract bypasses it.
- Privileged native methods are gated to the configured SV top-frame origin.
  On each trusted main-frame navigation, the top-frame bridge privately asks
  for `getPrivilegedBridgeCapability` and keeps the returned opaque string in
  its closure. The capability is revoked on navigation and is never exposed
  as a public `window.usernode` property.
- The parent bridge refuses both capability bootstrap and privileged relays
  from child frames. Non-privileged dapp reads and transaction methods keep
  their existing relay behavior.
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
