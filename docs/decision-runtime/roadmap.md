# Lifecycle migration: current roadmap

2 October 2026. Accepted checkpoint `511e84e35`; canonical main
`d9cf30cd73a0810be72b199f8b2a194f8c56b793` integrated at `6730b0913`.
Read-only freshness check returned `74276a2fb7002da251e1b3975ae22b81dbc765e3`;
relevant identity/capture/preview/CLI owners are unchanged. No automatic main merge.
The native CLI Kubernetes/kpack cohort remains **default-off**. Progress means
guarantees demonstrated **and competing ownership removed**, not growing checkpoint
numbers. No production compatibility, installation or rollout is claimed.

## Completed guarantees

| Deliverable | Status / evidence |
| --- | --- |
| Reusable decision foundation | Validated actions, guards, pure reducers, data-only effects, aggregate coordination, atomic state/work/receipt/trace writes. Caught operation errors invalidate the whole transaction. A distinct review workflow proves reuse. |
| Reusable execution foundation | Separate worker, stable identities, bounded/fair claims/retries and discovery. The review workflow reuses scheduling/recovery without a second engine. Temporal adoption is deferred. |
| Complete recoverable preparation | Actual source → clone → kpack → Kubernetes candidate. Partial creation, interruption and lost replies adopt verified OIDs, Build UID/digest and runtime UIDs. Preparation preserves serving; activation has separate authority. |
| Durable CLI continuation/checks | Atomic head/admission and candidate-to-continuation handoff. Enrolled rebuild/restart paths join the same owner. Original browser/unit Jobs and destructive retirement steps recover; unknown creation/output retains reconciliation ownership. |
| Atomic gating settlement | Accepted run/revision receipt, verdict, app-wide history/graduation and required follow-ups commit together. Recovery neither recounts history nor overwrites committed verdicts with errors. Worker dependencies initialize explicitly; unavailable GitHub retains retry ownership. Policy calls are substituted evidence. |
| Ordinary repeated use | **Complete locally at `511e84e35`:** five revisions on one session, overlapping checks/supersession/restarts, four predecessors' active dependencies released, fifth serving and legacy sentinel protected. Original Jobs do not compete; unresolved creators remain discoverable. |
| New admission and retention consolidation | One complete preparation format; four capability flags/config shim and three partial handlers removed. Fresh experimental stores only. Twelve historical reducer copies/live dispatch removed after independently verified replay archive. Legacy protections remain. |
| Canonical/focused verification | Explicit pin integrated with newer approval/recovery behavior preserved. Writer inventory, focused PostgreSQL/SQL and disposable checks/retirement proof pass. Actual packaged default web CMD, standalone worker and migration run non-root. GitHub CI/Linux installation is not proved locally. |
| HTTPS/identity boundary | Real TLS, shipped forward-auth/session exchange, private assets and original-Job restart recovery proved for an explicitly authorized account. Ordinary private-project screenshot permission is assessed separately without a fixture grant. |

Exact evidence/substitutions: [support assessment](supported-cli-contract-review.md),
[packaged entry points](packaged-cli-entrypoints-contract.md),
[HTTPS/private capture](https-private-capture-contract.md),
[published predecessor release](published-predecessor-retirement-contract.md).
All test mutation paths require verified disposable destination ownership; a URL
or test flag is insufficient. See [PostgreSQL preflight](postgres-test-isolation.md).

## Separate completion gates

**Merge the default-off pilot:** review against the explicitly integrated canonical
pin, preserve shared paths used with admission off and legacy protections, pass
focused PostgreSQL/SQL/writer/replay and adapter checks, and disclose evidence
limits. No introduced blocking regression may remain. This is a code-review gate;
it does not require production installation, private screenshot permission, or
another workflow. See the [frozen final review](final-pilot-review.md).

**Enable this CLI cohort:** verify the supported installation and image/schema/
protocol tuple below, supervise the worker and retain recovery when admission is
disabled. Keep unknown outcomes visible with a reconciliation owner. Establish
operating capacity for retained locks, recurring cleanup and journals. Scope the
supported capture promise accurately: required assertions/unit gating is verified;
ordinary private screenshots remain a separate product follow-up. A merge does
not authorize enabling admission or production access.

**Migrate another caller:** inventory its writers/consumers and retained work;
prove cutover, restart and rollback before removing its competing owners. Docker
requires its own resource proof. The shared foundation and second-workflow reuse
are already demonstrated; neither another framework nor more workflows is a
requirement for merging this pilot.

## Remaining mandatory work beyond merging the pilot

| Deliverable | Kind | Completion evidence |
| --- | --- | --- |
| Supported installation | **Verification of installation prerequisites**, bounded corrections only if proof fails | Separate supervised worker/migration/web processes, least-privilege RBAC and clone privileges, public HTTPS/assets, identity keys, matching runtime configuration and available Job images. Disposable cluster-admin/TLS-router evidence does not prove a production installation. No production access is authorized. |
| Supported image/schema/protocol tuple | **Release verification** | Pin backend/schema/capture/unit digests and exercised transport/parser cases. No negotiated version handshake or arbitrary mixed-version guarantee. Actual GitHub delivery and GitHub CI require separate authorization/evidence. |
| Remaining preview/check writers | **Implementation + consolidation + verification**, after the CLI gate | Hosted/imported/manual/promotion/fleet/head-invalidation/teardown/recovery callers; prove Docker separately. Drain/adopt retained obligations and remove competing owners/allowlist entries before claiming cutover. |
| Correlated status and owner integration | **Implementation + verification**, full migration | Explain revision, owner, obligation and rejection; preserve distinct shots/governance/merge/release authority and required handoffs. |

The current assessment is a consolidated review, not another capability checkpoint.
The shared foundation and second-workflow reuse gates are already demonstrated.
Fresh-store retention/archive decisions are complete; unknown external developer
stores are unsupported until named inventory/reconciliation, not permanent formats.

## Completion gates and final owners

**First supported CLI slice:** the contained native CLI Kubernetes/kpack contract,
complete real preparation, durable checks/gates and repeated-use retirement proofs,
plus an explicitly verified installation/image tuple and stated capture permissions.
Ordinary private screenshots are excluded until their separate permission follow-up
is demonstrated; their absence does not invalidate required checks or block merging.
Recovery with admission off must retain one owner; no competing builder, detached
required continuation, restart recapture or best-effort required settlement remains.
Completing this gate does **not** authorize production rollout.

Admission belongs to the authenticated route and validated machine actions.
The shared decision runtime commits authority and required work. The standalone
worker owns preparation, conditional activation, checks continuation and required
gate delivery. Named services reconcile resources. Existing checks lifecycle/
manifest/harvester owns original Jobs and inputs; preview retirement releases
predecessors after verified consumer completion, keeping unresolved creators.

**Full migration:** the CLI gate plus remaining callers in both runtimes, one owner
per operation, correlated outcomes and cutover/restart/rollback verification.
Remove legacy writers only after their callers and retained obligations are handled.
This does not require rewriting every platform lifecycle.

## Separate product follow-up and optional hardening

Ordinary private-project screenshots need a permission-policy decision and a
bounded, verified grant mechanism before being promised. The valid screenshot
identity has no automatic private-project membership. This pre-existing product
gap is outside the frozen pilot review; do not conceal it with fixture membership
or admin screenshots. Existing denied-credential/privacy checks remain required.

Narrower locks, database-role enforcement beyond module/CI boundaries, stronger
optional media/notification delivery, source-fetch optimization, terminal artifact
GC and creator/receipt compaction are optional follow-ups. Current locks and
unknown-creation/consumer protections are essential safeguards until replacements
are proved. Terminal experimental Builds/Jobs and registry output/cache are retained;
active dependency release does not establish creator closure or artifact collection.

Temporal reconsideration conditions remain in the [backend comparison](c0-backend-comparison.md).
Broader turn/merge/release refactors follow this migration rather than extending its
acceptance criteria. The [retirement inventory](migration-retirement-inventory.md)
records exactly what is gone and what remains. No new workflow/framework or caller
migration is proposed before the current review.
