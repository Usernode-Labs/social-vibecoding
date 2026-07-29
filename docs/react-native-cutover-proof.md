# React native cutover proof

**Status:** release checklist; it records evidence requirements and does not
approve replacing the legacy root shell.

The React shell currently runs below `/react/`. It has browser fixture proof
for its typed native adapter, but that proof is not a substitute for Flutter
WebView behavior. The release owner records every result below against the
exact candidate tuple:

| Field | Required value |
| --- | --- |
| React deploy | Git SHA and Vite asset manifest/bundle identifier |
| Web service worker | worker URL, `SW_VERSION`, scope, and cache-prefix migration decision |
| Android candidate | Flutter SHA, version/build number, Android System WebView version, device model/OS |
| iOS candidate | Flutter SHA, version/build number, iOS version/device, `WKAppBoundDomains` list |
| Bridge | `getBridgeInfo()` version and capability list captured from the candidate app |
| Test account/data | non-production account and fixture app slug; no production secrets in artifacts |

## Automated preflight

Run from `frontend/` and attach raw output to the release record:

```sh
npm run check:cutover-contract
npm run test:native-bridge-contract
npm run build
npm run check:bundle
```

The fixture suite proves only these web-consumer behaviors: desktop has no
bridge, an old native build is capability-gated without calling an unsupported
method, the known v3 read-only snapshot shape renders, and malformed discovery
fails closed. It does not prove channel injection, native method dispatch,
timing, or platform security enforcement.

`npm run check:cutover-ready` must remain failing until the service-worker and
physical-WebView blockers in `docs/react-migration.md` are closed with their
own executable evidence. Do not downgrade that command or label a fixture run
as native E2E.

## Service-worker cutover decision

Before React becomes the root shell, the release owner must choose and review
one strategy:

1. Ship a versioned root-scoped worker whose precache contains the exact React
   manifest assets, or
2. keep React's worker scoped to `/react/` during the staged rollout and prove
   the later root-worker cache migration separately.

For either strategy, retain the current policy: network-first shell and API
GETs; no caching/interception for writes, SSE, auth mutations, or
`/api/iframe-token`; per-user API cache clearing on logout; and explicit cache
prefix/version cleanup. A successful install is insufficient: prove an offline
reload after one signed-in online load, then prove logout removes the cached
authenticated response before another user can load the shell.

## Physical device matrix

Perform these flows on both Android and iOS, recording a short screen capture,
WebView console/network export where available, and pass/fail plus observed
bridge capabilities. A browser emulation does not close a row.

| Flow | Expected evidence |
| --- | --- |
| Cold signed-in launch | React becomes visible; no blank screen; session cookie works; bridge discovery completes or shows its explicit unavailable state. |
| Native bridge read | `getBridgeInfo`, node and wallet snapshot render only when capabilities advertise them; an old build shows update/unavailable without a bridge exception. |
| Back/history | React navigation, legacy hash handoff, and native back produce the expected previous screen without a loop. |
| Keyboard/safe area | Focus a field on a narrow screen; controls remain reachable above the keyboard and system insets do not obscure navigation. |
| Hosted iframe | Valid app opens with the preserved sandbox; iframe token refresh succeeds; no token is cached or visible after logout. |
| Offline/recovery | After the stated warm-up, turn off connectivity, reload, observe the explicit offline route; restore connectivity and retry successfully. |
| External URL | A non-App-Bound URL delegates through `openExternal`; the WebView does not navigate away from the trusted host. |
| iOS domain policy | Confirm the actual host is present in `WKAppBoundDomains`; service worker and `Usernode` channel behavior match the selected hosting strategy. |

## Stop conditions

Do not cut over if any flow produces a blank screen, leaks another user's API
cache, loses a trusted-frame boundary, invokes a bridge method absent from the
advertised capability list, or differs by platform without an approved
fallback. File the evidence against the candidate tuple, retain `/react/` and
the legacy root, and fix or explicitly defer the failed contract.
