# C11: recoverable checks retirement

Scope: the existing enrolled CLI checks continuation, manifest, lifecycle and
harvester. No new executor or rollout. Legacy callers keep their protections.

Before any retirement mutation, persist the exact namespace, Job name/UID and
input Secret name/UID in `check_runs.manifest.retirement`. Persist deletion intent
before deleting a running Job, consumer-stop confirmation before releasing its
input, and input-deletion intent before deleting the Secret. Journal writes are
strict, compare the prior journal and require the current manifest owner. A lost
database reply is reconciled by rereading that journal, not repeating admission.

Resume known retirement by inspecting the recorded identities. Job DELETE uses
foreground propagation and a UID precondition. It is not consumer-stop proof:
confirm Job absence and no live consumer Pods, or a terminal retained Job and
only terminal Pods. Completed Jobs remain available for logs under the existing
TTL policy. Input deletion also uses its recorded UID. Changed Job/input identity
or uncertain API observations block release; they never authorize deleting a
successor. Recheck consumers on resumed cleanup, including after an earlier
stop confirmation. Secret absence after recorded deletion intent is a recoverable
lost acknowledgment, not a reason to create anything.

Each expected Job needs a recorded retirement identity or an explicit admission
exemption. Missing submitted/unknown creation remains discoverable even when
other observed Jobs have been retired. Observed absence alone never closes that
creation. The current single-submission contract does not retry creation after
observing a Job; it does not provide a general external creator-closure protocol.

Harvester settlement and enrolled live error cleanup use the same retirement
service. A current verdict/error is persisted before destructive retirement;
superseded runs perform cleanup only. Cleanup errors cannot rewrite an already
persisted verdict. Live enrolled adapters retain input cleanup
for this owner. Recovery after verdict persistence resumes retirement instead of
asking the deleted Job for its output. Only after every expected resource is
released may lifecycle settlement and manifest removal complete the continuation.
Loss between these final steps is idempotently recoverable with the old run ID;
no successor lifecycle or session verdict is overwritten.

Actual evidence requires a freshly provisioned disposable fixture and fail-closed
parent/child preflight. Exercise interruption and lost replies after Job deletion,
consumer-stop persistence and input deletion, through both harvest and live-error
cleanup. Verify eventual manifest/lifecycle closure, retained late-creation
obligations and successor/serving resource preservation. Report fault injections
separately from actual PostgreSQL and Kubernetes evidence.

## Persisted phases and owners

| Per-Job phase | Meaning on restart |
| --- | --- |
| `identified` | Exact Job/input identities observed and stored; no deletion authorized yet. Unexplained Job absence blocks cleanup. |
| `deleting-job` | Foreground deletion was authorized for this UID; inspect remaining Job/Pods before releasing input. |
| `stopped` | Consumer-stop observation committed; reconfirm it before releasing input. |
| `deleting-input` | Input deletion authorized for this UID; absence can reconcile a lost reply. |
| `released` | That Job's input obligation released; other expected Jobs still need their own receipt or exemption. |

`check-retirement.retire` reads the existing manifest and checks completion against
its capture/unit admission. `check-runs.recordRetirement` strictly journals by
session/run, owner and prior progress. `kubernetes.retireCheckResources` discovers
and verifies identities, performs UID-fenced I/O and reports progress. Both
`preview-lifecycle.run` and `check-harvest.adopt` call this service. Recovery creates
neither a Job nor an input and does not infer a no-unit exemption.

Foreground propagation is supplied in the DELETE body (and SDK query), not just
as a query parameter. The local fixture exposed orphaning with the query-only
request. Existing consumer checks blocked release until this was corrected.
Kubernetes remains the owner of Job-controller dependent-Pod garbage collection;
this is not a general external creator-closure protocol or proof of every possible
cluster/controller failure. An unexplained Job disappearance, missing expected
creation, conflicting identity or uncertain inspection keeps the manifest. No
output-retention guarantee beyond the existing Job TTL is added. Legacy global
harvest scheduling/fairness and shared locks remain. The sixty-second stop-poll
deadline does not bound an individually hung API request; existing worker
supervision/legacy harvester process recovery still owns that failure.

## Evidence scope

The C11 fixture matrix uses actual PostgreSQL writes, Job/Pod/Secret creation and
deletion, and actual serving-runtime health checks. It kills a child owning the
existing lifecycle/harvester or throws after a real API/SQL acknowledgment, then
resumes in a separate process. Both paths exercise all three boundaries. The
retirement matrix supplies admitted manifests, a terminal error verdict for the
harvest-only cases, and small consumer commands in the verified immutable unit
image; it is not an additional end-to-end application preparation proof. Its
one-second termination grace is fixture timing; the first successful matrix also
used the normal thirty-second grace. No successful resource or stop observation
is fabricated. The separate C9/C10 fixture integration exercises actual staging,
clone, kpack, activation, browser and Git/npm unit execution together and labels
its own source/transport substitutions. Neither proves production compatibility.
