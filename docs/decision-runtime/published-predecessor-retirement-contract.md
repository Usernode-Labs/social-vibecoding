# Published predecessor retirement: contained CLI cohort

The existing preview retirement work owns this operation. Admission remains
default-off. Legacy published previews remain protected; there is no new cleanup
executor and no caller migration.

A published attempt is eligible only when its immutable bounded preparation work
and durable CLI continuation identify the same session, flow and revision. Every
continuation for that flow must have finished successfully, including an obsolete
continuation. Consumer reservation and manifest admission are one atomic SQL statement. A
reserved consumer without a release receipt blocks retirement even if its
manifest is unexpectedly absent. Any remaining session check manifest blocks
retirement, even if it is superseded, blocked or has already persisted a verdict. Checks retirement
records its released Job/input identities on the preview resource before removing
the manifest. The existing lifecycle lock serializes this decision with check
admission and retirement. No future checks may start on an obsolete flow.

SQL serving projection, desired/observed activation and the actual external
binding independently protect the serving attempt and its successor. Publication
alone no longer permanently retains an enrolled predecessor once its consumers
have released it. Unknown or legacy consumers retain the old protection.

| Dependency | Required release evidence |
| --- | --- |
| Capture/unit inputs | Existing retirement journal verifies Job UID, stopped consumers and input UID deletion; explicit unit exemption is preserved. Unconfirmed creation keeps its manifest. |
| Candidate runtime | No serving binding, matching recipe/UIDs, foreground Deployment deletion and no remaining runtime Pods before Service/Secret removal. |
| Database clone | Runtime consumers stopped; existing owned retired-role marker, NOLOGIN and forced database removal reconcile existing connections and lost replies. |
| Checkout/local image | Only this attempt's recorded locators, after runtime and clone release. |
| kpack Build and registry output | Terminal verified Build is retained by the existing experimental image retirement operation. Registry output/cache collection is not claimed by this slice. |

Persist dependency release separately from creator closure. Released attempts no
longer consume the two-live-published-attempt admission budget, but their resource
locators and recurring retirement work remain discoverable. Absence, elapsed time
and expired claims do not prove that a delayed creator has ended. A later matching
resource is reconciled with the same ownership checks; a different UID or recipe
blocks deletion. The retired database role continues to fence delayed consumers.

Acceptance requires real disposable PostgreSQL/Kubernetes evidence for at least
five distinct successive revisions on one session, including checks overlapping
new admission, supersession and restart. Prove actual predecessor runtime/clone/
input release, unchanged serving resources during preparation, successor
preservation, and admission after two published attempts. Report injected
metadata, transport and loss barriers separately from real resource observations.


The release receipt contains the original run/revision, admission exemptions and
verified retirement journal; no credentials or logs. Required gate delivery is
independent: it consumes the settled verdict, not the old runtime or clone.
Terminal experimental Build objects, logs and registry output/cache are retained.
The global Build sweeper selects the legacy runtime owner label and does not
collect these experimental Builds. No automatic artifact collection is claimed. This operation releases active runtime/database/check
inputs; it does not claim artifact garbage collection or cleanup-record compaction.

Preview decisions use v11 for fresh stores. The verified offline archive already
contains the exact v10 policy and replay dependencies. No supported v10 store is
retained; prior physical fixtures were retired. Existing production and legacy
protection is unchanged. Unknown developer stores still require inventory and
reconciliation under their original recovery code before replacement.


## Demonstrated local evidence

Fresh fixture `8914086e-697c-407c-a430-2b37b12a4f3f`: the actual packaged web
admitted five ascending pinned revisions on session 1. Real source checkout,
template clones, kpack Builds, candidate runtime resources and capture/unit Jobs
ran together. Each candidate COMMIT was followed by real worker loss and adoption
of the same database OID, Build UID/digest and Secret/Service/Deployment UIDs.
The first capture had a real pending consumer when revision two was admitted;
its original Jobs survived loss, and the existing harvester retired the obsolete
run. Exactly ten check Jobs were created, with no competing executions.

Four predecessors' Deployments, Services, Secrets, runtime Pods, databases and
check input Secrets were actually absent after retirement. Their retired roles
remained NOLOGIN with the original OID markers. The fifth stayed healthy and
bound; its UID tuple and database remained intact. The original legacy serving
sentinel also stayed healthy. Four recurring cleanup obligations remained queued
or executing; observed release did not erase creator locators. All 307 preview
decisions replayed, and 26 recorded source checksums matched the tested files.

| Source revision | Adopted database OID | Result after successor |
| --- | --- | --- |
| `011ccd891271965260102db0dbaaa7690ffa0b96` | 22462 | Released; overlapping checks superseded and retired. |
| `9a6a678e6741a779c21eda77923157bd94a3e81a` | 22588 | Released. |
| `f3de85e731fbd00592b2cd3123cb0fc0e74511c4` | 22723 | Released. |
| `08857d3958b518904bf21ddef0f2e34b2433eb90` | 22857 | Released. |
| `59de32fd44f50ba06926a43d90b567e33aa39236` | 23003 | Healthy serving candidate retained. |

The tested packaged image was
`sha256:73fa46b1f9909b482ec8186f219e2b0c4f3478c20904c578a9f8b12a90b511ed`.
Private fixture evidence retains full Build/runtime/check UIDs, digests, role
fences, decision traces and source hashes. Reproduce with a new fixture using
`setup`, `setup-unit-checks`, `test-predecessors`, then ownership-verified `teardown`
in `scripts/kpack-local-fixture.js`.

Substitutions: uploaded-head metadata, GitHub ancestry/content responses, seeded
template data and CLI identity, a tiny dedicated Git/npm unit source, internal
HTTP capture transport, local Service health proxy, and interruption/overlap
barriers. Source preparation, successful clone/build/runtime/check observations,
UID checks and destructive cleanup were real. This matrix does not repeat the
separate accepted public-TLS/private-identity proof, exercise real GitHub policy
side effects, or establish production RBAC/ingress compatibility. Active-session
gate delivery completed as the intentional not-in-review policy no-op.

Remaining limits: session locks serialize cleanup with checks; unknown session
consumers conservatively defer a predecessor. Admission can wait/refuse while two
published dependencies remain unreleased. Terminal Build/Job logs and registry
artifacts are retained, as are unresolved creator and retired-role tombstones.
No time-based creator closure, artifact GC, historical-store migration or rollout
is added. The first supported CLI gate still needs its named private-permission
and installation/RBAC/protocol verification; the full caller migration is separate.
