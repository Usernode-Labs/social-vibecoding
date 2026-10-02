# Bounded CLI support assessment

Reviewed through accepted `cd0d708a37afb59b6b684adaca13e5d349971df9` and its
explicit canonical integration at `d9cf30cd73a0810be72b199f8b2a194f8c56b793`.
Read-only canonical fetch on 2 October returned
`74276a2fb7002da251e1b3975ae22b81dbc765e3`; the relevant capture, identity,
preview and CLI owners are unchanged. Newer unrelated main changes were not merged.
Admission remains default-off. This assessment does not authorize installation,
caller expansion, rollout, production access, push or deployment.

## Support conclusion

The bounded implementation has demonstrated complete preparation, separate
activation, durable checks/gate ownership and repeated use with safe predecessor
release. This is a tested **native CLI Kubernetes/kpack, fresh-store, recorded
image/schema/protocol contract**, not support for every platform caller or an
arbitrary installed environment. Docker and other callers retain their old owners.

Ordinary private-project screenshot permission is a **product gap**, not a missing
TLS/RBAC installation step. The shipped non-admin screenshot account is not a
member of ordinary private projects. Its valid app-scoped JWT does not confer
membership. The private edge rejects it; the read-only assertion admin's access
cannot stand in for a successful ordinary screenshot. The earlier explicitly
membered fixture proves authorized capture only. The current unmodified-membership
proof is recorded in the [HTTPS contract](https-private-capture-contract.md).
Required assertions/unit checks can still pass while optional screenshot artifacts
are unavailable. That verdict is preserved policy, not proof of capture success.
Ordinary private screenshots remain outside the supported capture promise and
are a separate product follow-up, not a blocker for merging the default-off pilot.
Do not infer screenshot success from admin assertions or fixture grants.
The [frozen final review](final-pilot-review.md) separates merge, enablement and
further-caller gates and records the introduced unit-inspection regression/fix.

The shipped sequence is concrete: authenticated CLI admission authorizes the session
author; [`visuals`](../../src/services/visuals.js) then looks up the separate seeded
`usernode-capture` account and calls `mintCaptureToken`.
[`seedCaptureUser`](../../src/db/migrate.js) provides platform access, not per-project
membership. [`/__caddy/access`](../../src/routes/internal.js) verifies the JWT and
calls [`isViewMember`](../../src/services/app-access.js), which requires membership
or admin status for a private app. The author’s authority is never transferred.
The child’s shipped auth exchange is reached only after that edge check passes.

## Intended owners and guarantees

| Boundary | Owner / demonstrated guarantee |
| --- | --- |
| Admission | Authenticated CLI route and CLI reducer. Exact uploaded head and complete preparation work commit together; lost replies return the same identity. |
| Preparation | Shared standalone execution worker and named source/clone/Build/runtime services. Verified database OID, Build UID/digest and runtime UIDs determine adoption; existence alone is insufficient. Preparation preserves serving. |
| Activation | Separately authorized preview action and durable CLI continuation. Desired/observed binding, conditional external writes and retained locks protect serving/successors. |
| Checks | Existing lifecycle, manifest and harvester. Original capture/unit Jobs, expected companion creation, inputs and destructive retirement progress remain recoverable. Unknown outcomes retain an explicit reconciliation owner. |
| Settlement | Shared decision runtime and settlement reducer. Run/revision receipt, verdict, app-wide history/graduation and required gate requests commit together. Caught mapping errors roll back earlier composition writes too. |
| Required gate delivery | Shared worker invokes existing merge/bot policy services, with explicit dependency bootstrap and deduplication. Missing prerequisites retain retry ownership. Policy no-op, invocation and actual merge are different outcomes. |
| Retirement | Existing preview retirement plus checks consumer lifecycle. Published predecessors release active runtime/database/check dependencies only after consumers finish; unresolved creators retain discoverable work. |

These are enforced boundaries, not just a naming convention. Domain actions,
guards, pure reducers and persistence mappings remain explicit; shared transaction,
aggregate locking, receipt/trace persistence, work claims and scheduling are reused.
The distinct review workflow demonstrates reuse without copied runtime machinery.
Shared aggregate coordination is required even when machines have separate names.

Sources: [decision runtime](../../src/services/decision-runtime/index.js),
[execution worker](../../src/services/execution/worker.js),
[CLI work](../../src/services/cli-preview-handoff/work.js),
[preparation](../../src/services/preview-flow/work.js),
[settlement](../../src/services/cli-preview-handoff/settlement.js),
[checks retirement](../../src/services/check-retirement.js).

## What the evidence establishes

| Evidence | Verified behavior | Boundary |
| --- | --- | --- |
| Focused disposable PostgreSQL | Atomicity, deduplication, aggregate coordination, traces, fair retry/discovery, settlement rollback/history coordination and retirement journals. | Failure injection is identified in individual contracts; it does not prove external service behavior. |
| Actual preparation and cleanup | Source → clone → kpack → candidate; interruption/lost replies adopt stable identities; clone retirement fences old access and delayed consumers. | Local builder/runtime and physically verified disposable PostgreSQL/Kubernetes/registry. |
| Packaged entry points | Actual Dockerfile default web CMD, separate worker `main`, migration and non-root containers; real HTTP admission/restarts through admission, candidate, activation and verdict commit. | Metadata/template/unit inputs, health proxy and loss barriers are fixture substitutions. Worker supervision and least-privilege RBAC are not proved. |
| HTTPS/identity | Real TLS with normal browser certificate verification, shipped forward-auth/staging exchange, Secure/HttpOnly cookies, assets and original-Job recovery. | Fixture TLS router and tiny identity surface, not production ingress or a complete self-app. Authorized-member success and ordinary non-member denial are separate cases. |
| Ordinary repeated use | Five revisions on one session, overlapping checks/supersession/restarts; exactly ten original Jobs; four predecessors' runtime/clone/check inputs released, fifth serving protected. | Creator tombstones and terminal Build/Job/registry artifacts remain. Five-revision matrix uses internal HTTP; separate HTTPS evidence is not silently attributed to it. |
| Gate delivery | Required work persists and invokes the policy boundary once after dependency recovery. | Real GitHub/merge/bot effects are substituted; actual external delivery is unproved. |

See [packaged proof](packaged-cli-entrypoints-contract.md),
[HTTPS evidence](https-private-capture-contract.md),
[published predecessor release](published-predecessor-retirement-contract.md) and
[atomic settlement](idempotent-check-settlement-contract.md) for exact identities,
injected dependencies and failure sequences. No successful clone, Build or runtime
observation is substituted in the actual-resource preparation proofs.

## Ownership and code actually removed

- Selected CLI synchronous preparation and alternate rebuild/restart builders are
  replaced by atomic admission and the persisted owner. Enrolled work cannot fall
  back to a competing builder. Candidate completion replaces a detached web promise
  with a durable continuation.
- Enrolled restart recapture, best-effort gating settlement and detached required
  merge/bot kicks are replaced by original-Job recovery, atomic settlement and
  durable gate delivery. Checks retirement persists evidence before dropping its
  manifest; the manifest is no longer its only consumer-release locator.
- Blanket published-predecessor retention and admission accounting that counted
  creator tombstones forever are replaced by consumer evidence and separately
  persisted dependency release. The two-attempt budget counts unreleased dependencies.
- Four preparation capability flags/config shim, three partial work handlers and
  their exclusive one-shot branches are removed. New durable admission has one
  complete format. Twelve historical reducer source copies/live replay dispatch
  are removed after independent archive verification.

No new cleanup executor was added. No global legacy timer, lock, safeguard or
production compatibility branch was removed. The [retirement inventory](migration-retirement-inventory.md)
names retained mechanisms and their removal gates; replaced cohort ownership is
not evidence that other callers are ready for cutover.

## Retained stores and replay

The explicit support decision is **fresh experimental stores only**. No historical
experimental store is supported implicitly. Known disposable fixtures were retired
with ownership verification; other developer stores/backups are unknown and
unsupported, not presumed reconciled. Startup refuses removed work kinds and
historical traces before claiming work. Keep records for named inventory and
reconciliation if an unsupported store is discovered; do not relabel its work or
forget external cleanup obligations.

The [offline archive](../../archives/experimental-replay-c01dc0687/README.md) preserves
exact reducers/dependencies, original golden sources and exported test traces.
Its 153 cases replay without npm, a checkout, credentials or a database. They are
test exports, not production exports. Current live reducer versions are preview
**11**, CLI **3**, review **2**, settlement **1**. Work contract versions and
operation-spec versions are separate axes. Exact preview v10 policy is already
archived; a development checkpoint does not automatically earn a live compatibility
branch. Existing action retry shapes, unmarked legacy manifests and unknown old
verdict/history safeguards remain for their existing callers/data.

## Guarantees that remain bounded

Durable work is **at least once**; decision receipts do not make arbitrary external
requests exactly once. Adoption requires verified identities/specifications.
Expired claims and observed absence do not establish that external creation ended.
Unresolved creator obligations stay discoverable even after dependencies are released.
Long-held session/retention/lifecycle locks remain where stable/shared resources or
legacy callers still need them. Conservative unknown-consumer blocking is intentional.

Action/module boundaries and the writer audit enforce this cohort's authority;
there is no separate PostgreSQL role preventing every legacy/direct SQL writer.
Fair shared execution/discovery is proved for enrolled work, not every old platform
timer. Optional screenshots/media/notifications are distinct from durable required
gates; terminal artifacts and receipt/creator compaction are not collected here.
These limits neither justify removing safeguards nor require another framework.

## Remaining requirements, without adding capabilities

1. **Private screenshot permission — separate product follow-up, out of scope.** The current
   shipped identity has no ordinary private-project permission. A bounded remedy
   must define who authorizes which run/origin and revoke/reconcile it safely;
   blanket membership/admin screenshots would change privacy policy. Preserve the
   negative proof until a narrowly authorized replacement is demonstrated.
2. **Installation prerequisites — verification before any supported installation.**
   Separately launch/supervise the worker; run migrations before admission; provide
   explicit identity keys and matching capture runtime config; verify namespace,
   clone and least-privilege RBAC permissions; install public HTTPS/asset routing and
   trusted certificates. Local cluster-admin fixture access does not establish these.
3. **Supported tuple — release verification.** Keep the tested backend/schema,
   digest-pinned capture/unit images and parser/Secret-stdin protocol together.
   Keep original Job images available for recovery. There is no negotiated version
   handshake and no arbitrary mixed-version compatibility promise. GitHub CI/Linux
   installation and actual GitHub delivery require separate authorization/evidence.

Narrower locks, stronger optional media/notification delivery, artifact GC,
creator-tombstone compaction and Temporal reconsideration are optional follow-ups.
Unknown creation and live consumer protection are essential correctness safeguards,
not optional hardening. Their conservative retention remains explicit.

**Review recommendation:** merge the contained/default-off slice after the frozen
review's checks pass; verify installation before enabling it. Keep private
screenshots outside the promise until their separate permission remedy is proved. The shared
foundation and second-workflow checkpoints are complete; full caller migration,
production installation and rollout are not. No additional machine or framework
is needed to conclude this assessment.
