# C10: companion unit-suite ownership

Scope: the same default-off enrolled Kubernetes/kpack CLI checks continuation.
Reuse its lifecycle lock, manifest, harvester, guarded settlement and graduation
policy. No new executor, caller migration or rollout.

Before dispatching either check Job, persist `unitSuite` version 1 in the full
manifest. `not-required` names the admission reason (disabled, unavailable GitHub
source, no runnable script, or policy deferral). Metadata lookup failure is an
error before dispatch, not proof that no suite exists. `submitted` means the
required unit Job may be creating, running or complete; it is written before
external creation. Its stable identity is the session/run/kind Job name. An
acknowledged creation records `observed` with the exact Job name and UID. Never
persist clone credentials in this decision record.

A required or unknown companion that is absent keeps its manifest and cleanup
obligation. Recovery does not omit its result, complete the continuation, redrive
either check, or infer creator closure from heartbeat expiry/absence. Once it
appears, harvest the same Job's exit status/log through existing unit outcome
shaping and current graduation. A conflicting observed UID blocks adoption and
cleanup. The same rule applies after supersession: wait for discoverable creation,
then stop/release only that old run; do not publish its result to the successor.

Ordinary observed Job failure produces the existing advisory/blocking unit row.
Infrastructure errors or uncertain creation in the enrolled live path propagate
as an explicit checks error and retain the manifest; they cannot masquerade as a
completed unit test. Keep its input Secret while external consumption is uncertain.
Retirement confirms stopped consumers and uses run ownership plus UID preconditions
to release inputs. A current terminal verdict still waits for companion retirement;
an interrupted still-pending run can harvest both results. An explicit recheck
owns recovery from a recorded live infrastructure-error verdict after retirement.

Older C9 durable manifests without a companion decision are unknown, not
`not-required`; absence keeps their locator for reconciliation. Legacy unenrolled
manifests retain their historical policy. A Job that never appears (or disappears
before its result/consumer closure is established) needs operator reconciliation.
This slice does not add a durable external submission-closure protocol or guarantee
all outputs survive Job TTL. Missing work stays discoverable; no automatic duplicate
creation is authorized.

Evidence must use a newly created disposable local fixture with dedicated verified
kubeconfig/cluster, PostgreSQL and registry. Demonstrate actual unit Job/Secret,
real git/npm test execution, same-UID recovery and input cleanup, plus delayed
creation after absence and after supersession. Label fixture source/transport and
fault injections separately from actual Kubernetes/SQL/execution observations.
Preserve serving previews and successor obligations. No production access, push,
deployment, default kubeconfig modification or wider rollout.

## Demonstrated local evidence

`tests/cli-preview-unit-integration.test.js` exercises the enrolled continuation
with actual PostgreSQL, Kubernetes unit/browser Jobs, input Secrets and Git/npm
execution. It demonstrates SIGKILL before the unit creation reply, same-UID
harvest/completion, retention while a submitted unit Job is absent, later creation
using its retained input, and retirement of creation arriving after supersession.
The expected two-test unit row is stored on current runs; obsolete output changes
neither verdict nor media/history. Input cleanup follows actual consumer retirement.
Successor preparation remains queued, the activated candidate stays healthy and
the original serving sentinel stays healthy. Focused tests additionally reject
conflicting observed UIDs and preserve existing advisory/blocking graduation.

Fixture substitutions are explicit: the application preparation still uses the
pinned public health app through actual staging/clone/kpack/runtime services. The
unit Job instead clones a tiny pinned bare fixture repository embedded in a
non-root dedicated image; its actual existing runner performs Git fetch, `npm ci`
and `npm test`, including an assertion on input-Secret delivery. Package/diff/check
metadata, unit clone URL/revision transport, private HTTP origin, unauthenticated
users, warm/notification transport, CPU/memory limits, startup delay, SIGKILL,
delayed POST delivery and timestamps accelerated only after verified worker exit
are test inputs/injections. No successful Job, log, unit outcome, clone, Build,
runtime or database persistence is substituted. This is unit execution/recovery
proof, not arbitrary repositories/full worker image/production compatibility.

Unacknowledged adoption uses the existing managed-by/session/run labels and Job
name-prefix lookup; this slice does not persist/verify a complete unit Job desired
specification. An acknowledged name/UID is enforced. No external submission-closure
or output-retention protocol is added. A companion that never appears, or whose
output/consumer closure becomes uncertain after disappearance, remains discoverable
and requires reconciliation. A recorded live infrastructure-error verdict is not
automatically rejudged after cleanup; an explicit recheck owns that policy.
