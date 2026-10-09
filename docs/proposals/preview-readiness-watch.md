# Observe Deployment readiness promptly

When a preview runtime becomes fully ready just after a Deployment read, the current waiter sleeps for one second before noticing it. Add a Kubernetes Deployment watch as a wake-up signal, with the existing polling path retained for reliability. This proposal targets that observer only.

## Base and scope

- Project: Homeroom (`usernode-2d5619`), canonical repository `Usernode-Labs/social-vibecoding`.
- Authenticated deployed revision and canonical main on 9 October 2026: `ffeee2ec6592c034ff499fa651a3258d0a367cc7`.
- Permanent request: `codex-mgr-t003-preview-readiness-watch-20261009`; no originating issues.
- Preserve startup, readiness and liveness probes, rollout/configuration fences, quotas and backend reconciliation, URL persistence and the subsequent HTTPS edge root GET. Do not change any lifecycle gate.

## Implementation contract

Read the Deployment first and start one name-filtered collection watch at that exact resourceVersion. Treat the resourceVersion as opaque. A matching current Deployment event with the complete readiness predicate wakes the waiter early; an authoritative GET confirms readiness before returning. This prevents stale or queued watch events from publishing a preview. Retain one-second authoritative polling and terminal-Pod diagnosis, including best-effort handling of rejected Pod-list requests and current image/environment filtering.

Pin the Deployment UID from the write where available, otherwise from the first GET. A deleted or recreated Deployment cannot satisfy the original rollout. Retain the generation fence, desired replicas greater than zero, exact updated and total replica counts, ready and available counts, and deletion checks.

The watch uses the existing KubeConfig authentication, TLS and proxy configuration. Own its cancellation before connection setup: authentication finishing after cancellation must not open a socket. Close requests, response streams, parsing state and agents on readiness, deadline, terminal error or fallback. Fall back permanently for this wait on watch startup failure, malformed/error events, 410 expiry, authorization failure, disconnect or closure; do not reconnect in a loop. Polling remains available even if watch permission is absent. Do not broaden cluster permissions merely for the optimization.

## Validation

Exercise actual waiter code with deterministic fake Kubernetes APIs and actual local HTTP streaming transport: initial-read/watch race, opaque resourceVersion, current UID and generation, stale/backlogged events, full readiness predicate, deletion/recreation, zero replicas, disconnect, 410, authorization failure, delayed startup/cancellation, deadline and resource cleanup. Explicitly reject Pod-list API promises in polling, watch and failed-watch paths; terminal configuration errors must still reject. Run targeted repository suites using `npm run test:changed -- --base ffeee2ec6592c034ff499fa651a3258d0a367cc7`.

## Evidence and limits

The earlier local Node-child fixture observed median readiness observation of 1.011 s with polling versus 0.029 s with a local watch, over eight alternating pairs. That motivates the mechanism; it measured neither Kubernetes nor deployed previews. CPU reduction was not demonstrated. Do not subtract the local difference from the historical 11.374 s remote deploy/health span or claim faster application startup or end-to-end savings. This implementation retains polling traffic and adds a watch connection; its aim is observation latency, not proven CPU savings.

Readiness and status content remain identical. The intended improvement is earlier completion of the existing spinning-up phase when watch events are available; visual evidence must be assessed against an actually reached running proposal flow, not invented from backend file placement. Submit staging and checks on this same native proposal. Do not open voting until requested.

## Implemented behavior and verification

The watch permits one early confirmation only. If an event is misleading, its GET cannot bypass the readiness predicate and observation continues on the ordinary polling schedule. There is no repeated wake-up or reconnect loop. Kubernetes client-node 1.4.0's installed Watch returns its AbortController only after its HTTP fetch receives headers; the native transport instead creates an abort handle before authentication and request startup. It uses the pinned client's `KubeConfig.applyToHTTPSOptions` for credentials, TLS and proxy agents, with no new dependency or permission expansion.

The visual declaration is `impact: none`: this changes an internal observer's scheduling, preserving the existing displayed loading/status states, content and transition order. It does not add or change a screen, count, error message or control. A deleted/recreated Deployment waits for the same existing timeout outcome rather than satisfying the original rollout with a different resource. No guaranteed visible timing or CPU improvement is claimed.

- Required changed-file mapping: 245 suites, 3,640 tests; 3,609 passed and 31 skipped because their PostgreSQL fixture was unavailable; no failures.
- Final focused observer and rollout suites: 27 tests passed, including real pinned KubeConfig bearer credentials, CONNECT proxy, TLS option propagation, split UTF8 JSON and transport error/closure cleanup.
- Supported local runtime: official Node 22.23.3 Linux x64, downloaded into `/tmp` from `https://nodejs.org/dist/latest-v22.x/`; archive SHA-256 `df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de`, verified against that release's SHASUMS256.txt. Production Dockerfiles use Node 22. Lockfile-pinned dependencies were installed in the isolated checkout.
- An earlier Node 23.1.0 mapped run failed on the base's new workflow TypeScript syntax, which that old runtime cannot strip. Reused root dependencies initially lacked `pngjs`; the verification above uses this checkout's exact lockfile and supported runtime. No product/runtime configuration was changed to accommodate the local machine.
- No new timing benchmark was performed; the historical local fixture remains motivation only. Real Kubernetes watch privileges and deployed/end-to-end latency remain unmeasured until this version is deployed where watch is permitted.
