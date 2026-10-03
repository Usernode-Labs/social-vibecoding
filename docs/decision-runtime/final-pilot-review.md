# Final review of the default-off CLI pilot

2 October 2026. Feature scope is frozen. The accepted review is followed by
strict unit-source correction `ed13ea6fa` and reconciliation with explicitly
pinned canonical `74276a2fb7002da251e1b3975ae22b81dbc765e3`.
No rollout, caller migration, framework expansion, production access, push or
deployment is authorized by this review.

**Recommendation: ready for review/merge as a default-off pilot, subject to the
normal PR checks. Enabling it is a separate installation gate; full migration is
not complete.** One introduced unit-requirement inspection gap is corrected below.
Private screenshot permission is a separate pre-existing product follow-up.

## What was reviewed

The authority path is route authentication/authorization → validated actions and
guards → pure reducers → transactional state/receipt/trace/work persistence.
Execution claims deliver named service operations; they do not grant lifecycle
permission. The bounded preparation, CLI continuation and settlement machines
share aggregate coordination. App-wide check history also locks the app row.
Operation errors poison composed transactions even when callers catch them.

Resource checks remain distinct from database authority: attempt-specific names,
clone markers/OIDs, Build UID/recipe/digest, persisted runtime specification/UIDs,
health and conditional stable binding are checked before adoption/publication.
Claim expiration is not cancellation. Retirement preserves consumers, serving
bindings and successors, and retains unresolved creation after dependency release.
Required gating commits durably; optional artifacts do not decide its completeness.

The admission flag is **not** a switch for the entire diff. Shared native handoff
publication/failure/cleanup, return-to-development decisions, Docker staging
serialization, checks adapters and additive schema also change with CLI admission
off. These were reviewed as merge requirements, including publication rejection,
receipt failure, successor preservation, legacy policy and resource-lock behavior.
The enrolled cohort excludes competing builders even after admission is disabled.

Sources: [decision runtime](../../src/services/decision-runtime/index.js),
[execution](../../src/services/execution/store.js),
[preparation](../../src/services/preview-flow/work.js),
[activation](../../src/services/preview-flow/activation.js),
[retirement](../../src/services/preview-flow/cleanup.js),
[CLI handoff](../../src/services/cli-preview-handoff/work.js),
[settlement](../../src/services/cli-preview-handoff/settlement.js),
[checks retirement](../../src/services/check-retirement.js).

## Findings and their disposition

| Classification | Finding | Disposition |
| --- | --- | --- |
| **Introduced regression — fixed** | New unit-suite requirement inspection classified unavailable/unverified source as `not-required`. The legacy helper's `null` includes inaccessible-source 404 and non-inline responses, so it cannot establish absence. | Enrolled inspection verifies the exact commit and complete root tree. A present package must match its blob SHA/bytes and contain valid metadata before deciding whether a test script is absent. Lookup/verification errors throw before dispatch; existing lifecycle handling retains the provisional run and reconciliation owner. Restart cannot launch replacement Jobs or publish a verdict. Intentional deferral/disable, placeholder-script policy and legacy nullable skipping remain. No admitted manifest is rewritten. |
| **Pre-existing product gap — separate follow-up** | The shipped non-admin screenshot identity lacks ordinary private-project membership; a valid app JWT does not grant it. | Preserve denial and document unavailable optional private screenshots. No permission change, fixture grant or admin substitution. Required assertions/unit verdicts remain separate. |
| **Pre-existing product/legacy gap** | Global harvest's oldest-50 scan and other legacy timers do not share the bounded worker's scheduling guarantees. Legacy/direct SQL writers still exist. | Retain safeguards and the explicit writer inventory. The enrolled continuation has its own targeted recovery; this pilot does not promise fairness or action-only authority for every platform path. |
| **Installation prerequisites** | Supervised standalone worker, migrations, clone privileges, namespace/RBAC, identity keys, trusted public HTTPS/assets, reachable registry/kpack and matching Job images/configuration. | Verify before enabling. Disposable cluster-admin/local TLS routing is evidence of behavior, not proof of a supported installation. |
| **Installation/release prerequisites** | Tested backend/schema/capture/unit tuple; actual external GitHub delivery and Linux/GitHub CI remain unproved locally. | Run normal PR CI and separately verify installation/delivery with authorization. Preserve original Job images for recovery; no arbitrary mixed-version promise. |

No other introduced blocking regression was found in this review. That is a
bounded review conclusion, not proof against every possible external failure.
The unit correction is covered through the actual GitHub and unit helpers with
only Octokit responses substituted, including inaccessible-source 404, genuine
file absence, unreadable listed files and invalid source/metadata. Real PostgreSQL
lifecycle/manifest recovery also passes. GitHub availability and dispatch are
injected there; neither test establishes actual GitHub or Kubernetes integration.

## Three different gates

1. **Merge default-off.** Keep `PREVIEW_CLI_HANDOFF_ENABLED` off by default and the
   standalone worker separately enabled. Pass focused transaction/adapter tests,
   SQL/schema validation, writer inventory and independent archived replay.
   Preserve legacy protections and fresh-experimental-store startup checks.
   The branch is reviewed against the named pin; no production installation or
   private screenshot remedy is needed to merge it.
2. **Enable the existing cohort.** Verify and record the installation/image tuple,
   worker restart/supervision and required policy-service delivery. Confirm capacity
   for retained locks, recurring cleanup, work journals and traces, and an owner
   for explicit blocked outcomes. Turning admission off stops new enrollment; it
   must not stop recovery or permit a legacy fallback. Unknown provisional launches
   can require operator reconciliation even after prerequisites return. Private
   screenshots remain outside the promise until their separate remedy is proved.
3. **Migrate another caller.** Inventory its writers, policies, consumers and
   retained obligations; prove resource/admission/recovery behavior and remove its
   competing owner. Verify Docker separately. Do not remove a global safeguard
   because the CLI cohort replaced its own use. No additional machine or generic
   execution framework is required merely to close this review.

Essential correctness is atomic admission/settlement, recoverable required work,
permission and physical ownership checks, and safe serving/successor/consumer
retirement. Optional media delivery, narrower locks, artifact GC, creator/receipt
compaction and additional database-role enforcement are follow-ups, not new
acceptance requirements for this merge.

## Maintainability and ownership removed

The shared runtime is small and the domain mappings remain explicit. The cost is
at the boundary with legacy code: staging and visuals still carry both contracts,
and long-lived locks/fail-stop supervision are still necessary. Do not unify
similar-looking checks that protect different boundaries. This branch is large;
review authority/persistence first, then service recovery, caller exclusions and
failure evidence. Contracts should remain the current index; chronological proof
documents describe their particular checkpoint and substitutions.

Recurring creator tombstones, terminal Builds/Jobs, registry artifacts and journals
accumulate. They need capacity/operating review before enablement; forgetting them
by age or observed absence is not a safe simplification. Database and module/CI
boundaries do not prohibit every legacy SQL write. External delivery is at least
once, with operation-specific adoption/fencing, not blanket exactly-once execution.

Actually replaced for enrolled CLI: synchronous preparation and alternate rebuild
owners; detached candidate-to-checks continuation; restart recapture; best-effort
required verdict/history settlement and detached gate kicks; manifest-only cleanup
location; blanket published-predecessor retention/tombstones consuming the attempt
budget. Four capability flags/config shim, three partial handlers and twelve
historical live reducer copies/dispatch were removed. Shared native handoff's old
`discardHandoffStaging`/leaked-public-pointer ownership is replaced by persisted
resource obligations consumed under the resource guard.

No global legacy timer, lock, production compatibility branch or cleanup executor
was removed. This final review adds no owner: it fixes enrolled source inspection
and consolidates readiness documentation. See the
[retirement inventory](migration-retirement-inventory.md) for exact removal gates.

## Verification and canonical boundary

Current-review results are recorded in the local ledger. Actual-resource evidence
remains the accepted complete preparation, checks/retirement, packaged HTTP/HTTPS
and five-revision proofs linked from the [support assessment](supported-cli-contract-review.md).
Those proofs are not silently represented as rerun on this review's correction.
No successful clone/Build/runtime observation was substituted in their preparation
proofs; fixture transport, metadata, fault injection and GitHub policy substitutions
remain explicit in their contracts.

| Earlier frozen-review verification (before this source correction/reconciliation) | Result |
| --- | --- |
| Owned disposable PostgreSQL focused runner, after correction | 1,011 passed; zero failures/skips. Includes the new provisional-unit recovery regression. |
| Mapped correction/doc adapter suites | 2,293 passed; four explicit actual-resource opt-in skips; zero failures. |
| Additional default-off/legacy adapters | 189 passed; zero failures/skips. |
| Final unit-suite cases including explicit feature-disable policy | 38 passed; zero failures/skips. |
| SQL/schema on the owned disposable database | 3,256 unique statements / 4,159 static variants validated. |
| Writer inventory / independent historical archive | 16 recorded legacy statements; 153 offline replay cases pass. |

Counts overlap; they are not a combined test total. Skips are not integration
evidence. No actual Kubernetes fixture was provisioned in this review.

Current correction/reconciliation is `ed13ea6fa` followed by local merge
`6cab97bb7c882b0767872707bb6be52a7df22970`, containing exact canonical
`74276a2fb7002da251e1b3975ae22b81dbc765e3`. Newer issue-comment identity,
bot discussion/scheduling/typing and shots-worker hold/retirement behavior remain;
pilot dependency initialization and required-policy error propagation survive the
merge. No admission, work, reducer or external resource identity changes.

| Reconciled local verification | Result |
| --- | --- |
| Actual-helper/unit/CI regressions | 59 passed; substituted Octokit transport, no real GitHub call. |
| Owned disposable PostgreSQL focused runner | 1,030 passed; zero failures/skips. |
| Affected mapping, after regenerating ignored shell outputs | 16,737 passed; 13 explicit fixture/platform skips; one unchanged canonical macOS launcher test fails. |
| Canonical launcher with inherited test loopback preload | All 12 passed. Normal invocation's holder uses IPv4 while its child launcher can bind IPv6 on macOS; the test and launcher are identical to pinned main. No product change. |
| Canonical DM suite alone / mapped rerun | All 19 passed alone; the earlier broad-run typing-order failure did not recur. Relevant code/test are identical to pinned main. |
| SQL/schema on owned disposable database | 3,268 unique statements / 4,171 static variants validated. |
| Writer inventory / independent archive | 16 recorded legacy statements; 153 offline replay cases pass. |

The first broad run also used stale generated shell outputs; `npm run ensure:shell`
regenerated them, and the rerun resolves those failures. Generated outputs are
ignored and uncommitted. Local verification is not a claim that GitHub/Linux CI
passes: the canonical launcher limitation remains visible. Database ownership is
verified before mutations and teardown. Accepted actual-resource proofs retain
their named producing revisions, fixture metadata and injections; they were not
rerun on this helper correction. No production access, push or deployment.
