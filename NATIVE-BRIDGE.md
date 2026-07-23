# Usernode Native Bridge Contract

The Usernode Flutter app injects a `Usernode` JavaScript channel into every
page loaded in its dapp webview. `public/usernode-bridge.js` (canonical copy:
`public/usernode-bridge/v1/bridge.js`) wraps that channel in promise-returning
methods on `window.usernode`. This document is the versioned contract between
the app (producer, `flutter-mobile-app/lib/features/dapps/dapp_webview_screen.dart`)
and SV chrome (consumer) for the methods SV's own shell depends on.

Wire format: the page posts `{ id, method, args }` as JSON to the channel;
the app resolves via `window.__usernodeResolve(id, value, error)`. Unknown
methods are silently dropped by old app builds, so every bridge wrapper races
a timeout and degrades gracefully — never assume a method exists, feature-
detect with `getBridgeInfo`.

## Versioning

- `getBridgeInfo()` → `{ version: number, capabilities: string[] }`
- `version` bumps only on breaking changes. New methods are additive and
  appear in `capabilities`.
- Feature-detect with `capabilities.includes('<method>')`, not `version`.
- Current version: **3**.

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

Pushes an allowlisted native route. Allowed screens: `settings`, `profile`
(legacy — both now have web equivalents), plus the v3 deep-link additions
`benchmark`, `httpLogs`, and `terms`. Rejected for any other value, and
rejected entirely unless the top frame is the trusted SV origin (sub-apps
cannot drive native navigation). Escape hatch for chrome that stays native
while SV owns the rest of the UI.

### Profile & settings (v3 — profile-and-settings-to-web migration)

All v3 methods are trusted-SV-origin gated like `openNativeScreen`. They
power SV's `#profile` screen (`public/js/profile.js`) and the "Usernode
app" sections in SV's Settings modal (`public/js/settings.js`).

#### `getProfileInfo()` → `{ participantId }`

`participantId` is the leaderboard participant id (number), or `null` when
the user hasn't registered. SV's profile screen uses it to query the
leaderboard API (`/me/ranking`, `/me/breakdown`) through the SV server's
`/challenges-api` proxy.

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
  "termsAccepted": true,          // null while terms haven't loaded
  "authStatus": "authenticated",  // AuthStatus enum name
  "permissions": {
    "platform": "android",        // android | ios
    "exactAlarmGranted": true,
    "batteryOptDisabled": false,  // Android only, else null
    "deviceManufacturer": "samsung", // Android only, else null
    "iosKeepAliveActive": null    // iOS only, else null
  }
}
```

Permission probes and terms loading can take a few seconds on a fresh app
start; the bridge wrapper uses a longer (12s) timeout for this method.

#### Setters — each resolves the refreshed settings snapshot

| Method | Args | Effect |
|---|---|---|
| `setNodeSleepEnabled(enabled)` | `{ enabled: bool }` | toggles node sleep on inactivity |
| `setDebugMode(enabled)` | `{ enabled: bool }` | toggles the app's debug mode |
| `setFacematchStrict(enabled)` | `{ enabled: bool }` | toggles strict ZK-passport facematch |
| `setIosKeepAlive(enabled)` | `{ enabled: bool }` | starts/stops the iOS foreground keep-alive |
| `requestPermissions()` | — | native alarm-permission prompt; snapshot plus a `granted` bool |

#### Actions — resolve `true`

| Method | Effect |
|---|---|
| `resetZkChallenge()` | discards in-progress ZK identity registration (confirm web-side first) |
| `openBatterySettings()` | opens Android battery-optimization settings |
| `logout()` | logs out of the app account; the native auth flow takes over (confirm web-side first) |

## Trust model

- The native transaction confirm sheet remains the sole native chrome over
  SV content (Apple Pay model). Nothing in this contract bypasses it.
- `openNativeScreen` and the shortcut-management methods are gated to the
  configured SV origin on the native side.
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
