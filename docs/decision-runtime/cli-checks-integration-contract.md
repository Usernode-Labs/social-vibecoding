# C9: recover the enrolled CLI checks run

This file records the original browser checkpoint and subsequent corrections.
The [supported CLI contract review](supported-cli-contract-review.md) is the
current combined contract; historical checkpoint names do not imply permanent
handler or reducer support.

Scope is the same default-off Kubernetes/kpack CLI enrollment as C8. Activation
remains separately authorized. This checkpoint uses the existing preview lifecycle,
check-run manifest and harvester; it does not introduce another check executor.

**Completion.** The continuation completes only for its still-current flow/head,
after observed activation, a persisted terminal verdict or policy deferral, and
release of the recorded checks run. A run still named running by the lifecycle or
retained in `check_runs` for the current head prevents completion. Worker loss after verdict persistence
must finish that release rather than recapture. Completion means the checks
obligation settled, including an error/failing verdict; it does not mean merge-ready.

**Recovery for durable-marked runs.** Before starting checks, inspect again under
the existing lifecycle resource lock. A recorded run with a live heartbeat is joined by waiting. An orphan
is claimed and read by the existing harvester, retaining its run ID, Job UIDs and
logs. No new Job is admitted while that run is recoverable. A submitted but
absent capture Job retains its locator, including after supersession: absence
cannot establish creator closure. Unexplained Job disappearance retains uncertainty;
known interrupted retirement resumes from its persisted identities/progress (C11).
Confirmed failures retain their verdict policy; missing/deadline/unreadable output
uses the current explicit unknown-outcome reconciliation policy. An already-persisted
current verdict resumes retirement and then closes as completed, allowing a later
explicit recheck; actual supersession closes as cancelled. Missing manifests in
enrolled work retain a conservative locator and block rather than cancel/re-drive.
Unmarked historical manifests still select legacy harvest cleanup/settlement;
enrolled redrive rejoins the durable owner but does not upgrade their guarantees.
Their support needs the retention/reconciliation gate in the current review.
Legacy unenrolled callers retain their own recovery behavior. New enrolled launches
must persist both provisional and full manifests before creating Jobs; a failed write cannot silently
launch unrecoverable checks. Heartbeat expiry authorizes reading existing work,
not proof that an earlier external creation stopped. A failed enrolled launch or
settlement keeps its full manifest for harvest/retirement. Input Secrets carry the
run label before Job creation and are released only after consumers stop, with a
matching run/Job identity and Secret UID precondition. A conflicting owner blocks
retirement. Older inputs require a matching Job owner reference.

**Concurrency.** Lifecycle resource locks serialize new execution with recovery;
harvest claims and guarded pools fence settlement. Supersession changes the head
under the shared aggregate transaction. Old progress, verdict, screenshots and
history must fail the existing revision/run guards. A stale collector may clean
only its own run's Jobs; it cannot cancel successor Jobs or publish to its head.
Retrying the continuation joins the same durable work. Existing check policies,
graduation, unit-suite admission and merge gates remain.

**Other obligations.** Before/after shots have their own persisted session intent,
shots runs and `shots-gc` recovery, including unstarted planned intent. They are not
completed by a checks verdict. Auto-merge/release decisions retain their current
owners and gates. Runtime/clone/Build retirement remains discoverable through the
preview execution census. Expiring capture identities use existing expiry cleanup;
Job/input cleanup and lifecycle closure belong to checks retirement. Legacy capture
media/diagnostic writes after a verdict are best-effort and may be absent after loss;
this checkpoint does not give them a separate durable delivery guarantee.

**Evidence.** Use only a new disposable local kind/kubeconfig, PostgreSQL and test
registry verified before every parent/child mutation. Actual capture image/code,
Chromium assertions, Kubernetes Jobs/logs and PostgreSQL settlement must be exercised.
Kill the continuation while Jobs are running and after verdict persistence; verify
UID-preserving adoption, one execution, eventual continuation completion and stale
result rejection after supersession. Label source/manifest, transport, unit-suite
image or fixture app substitutions precisely. No production credentials, kubeconfig,
registry, infrastructure, push or deployment; local evidence is not production proof.

## Demonstrated local evidence and remaining limits

`tests/cli-preview-checks-integration.test.js` executes actual source preparation,
clone, kpack Build, candidate runtime and separately authorized Ingress activation,
then the repository's real Chromium capture image and browser assertion Job.
SIGKILL before returning the actual Job creation reply preserves its UID; a fresh
worker harvests its output and stores actual PNG bytes. SIGKILL after the terminal
verdict COMMIT preserves the verdict and Job, closes lifecycle/input ownership,
and completes the durable continuation. A subsequent explicit same-head recheck
works. Actual collected old output cannot change verdict, media or history after
supersession, and the successor's required preparation remains queued. Scoped
retirement preserves the currently serving candidate and original serving sentinel.
An injected required-manifest failure creates no additional Job.

Fixture substitutions: GitHub diff/manifest/package metadata, a pinned public
health app and seeded clone template, unauthenticated capture users, internal HTTP
Service DNS instead of public HTTPS, no-op edge warm/notification transport,
1 CPU/1 GiB Job limits, startup delay and accelerated claim/orphan timestamps only
after verified child exit. Source checkout, database clone, Build/runtime observations,
Chromium execution, Job logs, images and SQL settlement are real. The sample's
favicon may cause a real failing verdict; acceptance verifies the actual terminal
policy outcome rather than forcing passing. Its page has no scroll, so optional
video/GIF frames can fail while PNG evidence is produced.

No runnable `npm test` exists in the C9 fixture. The companion decision and
actual unit Job proof are extended by [C10](unit-companion-contract.md); C9 alone
did not demonstrate them. Private-user JWT access, full platform/content review, enabled before/after shots,
public ingress traffic and production compatibility are not demonstrated. Legacy
post-verdict media/diagnostic delivery remains best-effort. Notification delivery
is at least once. Existing global harvest scheduling and its oldest-50 selection
remain; enrolled continuation inspection targets its session directly. Lifecycle
locks and the legacy harvest/recovery owners stay in place.

There is no persisted proof that an unacknowledged external creation ended. If a
submitted capture never appears, its manifest remains discoverable but requires
operator reconciliation rather than automatic duplicate creation; the same-head
continuation now exposes a durable blocked reason and reconciliation owner, as
defined in [unknown-check-outcomes-contract.md](unknown-check-outcomes-contract.md). This is containment of uncertainty, not a complete
external execution protocol or a production-ready liveness guarantee. Retired
missing capture locators likewise remain for later reconciliation. Older C8
manifests lacking the durable marker retain their historical harvest redrive,
cleanup and settlement branches; enrolled dispatch rejoins its durable owner.
Those retained formats need reconciliation before claiming the current guarantees.
CLI reducer v2 adds the closure guard; v1 replay is frozen only for retained traces,
subject to the plan's retention audit. Work payload/kind remains v1 and no new
workflow, rollout or caller migration is introduced.


C11 extends input and manifest ownership through destructive retirement. See
`checks-retirement-contract.md`: terminal execution does not independently delete
its input, verdict settlement does not clear the manifest, and both live errors
and harvest use the same journalled retirement owner. Cleanup errors cannot
rewrite an already persisted verdict. Known deletion can be resumed without the
Job output; genuinely unconfirmed creation/output stays discoverable. No new
executor, timer, rollout or production compatibility claim.


The unknown-outcome correction preserves work kind/payload v1, moves the live CLI
reducer to v3, and freezes v2 for retained trace replay. The original harvester
owns inspection and recoverable retirement. CLI status exposes `checksRecovery`
and guidance to join/reconcile that run rather than replace it. Missing manifests
for running pending checks receive conservative locators; incomplete/reconstructed
launches cannot infer creator closure. Exact-run discovery bypasses older retained
manifests for continuation progress; the legacy global scheduling limit remains.
