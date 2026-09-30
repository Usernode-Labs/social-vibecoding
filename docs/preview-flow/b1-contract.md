# Native preview B1 contract

This opt-in experiment applies only to the native handoff path. Existing callers,
resource/retention locks and lock-loss behavior stay in place.

- **Resource identity.** One preparation attempt has its own UUID, checkout,
  database/role, image tag/build identity and internal runtime name. Names are
  never reused by another attempt. Reserve cleanup locators and an encrypted
  clone credential before I/O; record clone completion before attaching a
  runtime. A partial clone is abandoned, never adopted from existence alone.
  Runtime observations include Docker container ID or Kubernetes object UIDs.
- **Preparation.** Creating a healthy internal candidate changes neither the
  accepted preview tuple nor its stable route. Preparation uses create-only
  runtime operations. A failure can retire only that attempt's resources.
- **Activation authority.** A guarded action accepts the current candidate and
  records an activation identity, its stable URL and expected prior route.
  Preparation itself grants no activation permission. The route owner compares
  the recorded external version before changing the binding: Caddy ETag/If-Match
  for Docker, Ingress UID/resourceVersion for Kubernetes. No unconditional retry
  or alias handover. An unsettled activation blocks another native admission.
- **Desired and observed.** Desired means an activation was accepted; observed
  means the route adapter read back the matching candidate target. Only that
  correlated observation publishes the complete preview tuple. An accepted
  intent or a successful preparation is not evidence that traffic switched.
- **Lost acknowledgments.** Keep the desired intent and both possible serving
  resources. Recovery inspects the route first. The desired target settles the
  existing activation without repeating the mutation; the unchanged expected
  route permits the same conditional attempt. Another target/version blocks
  handover. A late observation cannot settle a successor's activation.
- **Cleanup.** Desired/observed binding and the legacy published tuple protect
  serving resources. Retire a candidate only under the retained session resource
  lock, after checking binding ownership and runtime identity. Delete Docker by
  immutable container ID and Kubernetes objects with their recorded/observed UID
  preconditions, then the unique clone. Do not delete a successor by name.
  Formerly published isolated attempts remain retained until consumer retirement
  is proven. At two retained published attempts, reject another preparation.

This is a domain-specific preparation/activation adapter, not a durable build
executor. Interrupted preparation is cleaned rather than resumed; uncertain
activation stays recoverable and protected. Long-lived check/shot consumers,
legacy route writers, edge reloads and full cancellation remain explicit limits
until demonstrated. No guarantee of uninterrupted existing connections is made.
A shared decision foundation and distinct second workflow are demonstrated by
[B2](../decision-runtime/b2-contract.md). The execution-backend comparison remains
a mandatory subsequent checkpoint.

Caddy's conditional configuration API is documented in the
[Caddy API reference](https://caddyserver.com/docs/api#concurrent-config-changes).

## Experiment boundary

Enable only for a controlled native-preview experiment with
`PREVIEW_NATIVE_ATTEMPTS_ENABLED=true`. Leave it unset for ordinary callers.
Disabling admission leaves recovery of accepted activations running. Legacy
action-API retries on an isolated binding are refused. The two-published-attempt
limit is a temporary safety boundary, not the final
retention policy. An unresolved desired binding also blocks another admission.
Changing a route's version externally can therefore require operator reconciliation;
this slice does not silently authorize a replacement intent.

Route readback establishes configuration acceptance, not Ingress-controller
convergence or an end-to-end traffic acknowledgment. Existing connections are
not drained by this protocol. Resource locks coordinate cooperating builders;
legacy teardown/recovery and operator route writes are not yet forced through
this authority. Caddyfile/blue-green reloads can discard the dynamic map override.
A deleted session with an uncertain binding remains retained for reconciliation.

Cleanup retires an unpublished candidate's runtime, clone, checkout and Docker
image tag. Kubernetes Build/Job retention still belongs to the existing retention
services; per-attempt registry/cache-tag garbage collection is not established.
That retention policy must be resolved before enabling this beyond the experiment.
Already accepted external creation commands can finish after process death;
there is no durable execution receipt proving their termination in this slice.
Completed isolated cleanup rows therefore remain discoverable tombstones, as
described below.

Run `node scripts/test-preview-flow.js` with `PREVIEW_FLOW_TEST_DATABASE_URL` set to a
**disposable** PostgreSQL database. The optional real-Caddy test is
`PREVIEW_CADDY_TEST_IMAGE=<local image or digest> node --test tests/preview-caddy-live.test.js`;
it creates and removes its own container and publishes no ports.

## Delayed creation after observed absence

An external create can finish after its caller dies and releases the resource
lock. Cleanup can observe absence, commit completion, and then see resources
appear later. B1 previously excluded completed rows from recovery, leaving those
resources without an owner. That was an introduced cleanup regression.

For **isolated unpublished attempts**, retain the immutable intent and revisit it
through the bounded, rotating cleanup queue. Session deletion and disabled
admission do not stop discovery. A completed pass records absence at that moment;
it does not prove external creation ended. A fresh `RequestPreviewCleanup` makes
a guarded decision, returns `CleanupPreview`, and atomically clears prior
completion with its receipt/trace. Retirement stays marked. A new
`PreviewCleanupCompleted` records the next absence observation. Version 4 captures
this policy; frozen versions 1/2/3 replay their original decisions. Retrying an
original action ID returns its original receipt, not new permission. Each fresh
isolated cleanup action has its own effect key; replay retains that key, while a
later observation does not reuse completed work's identity.

Every pass rechecks serving/consumer protection, the external binding, flow label
and physical runtime identity before removal. Docker uses immutable container IDs;
Kubernetes uses UID preconditions and confirmed object/Pod absence. Unique clone,
checkout and Docker-tag cleanup follow runtime cleanup. Changed ownership defers
deletion and preserves the record for retry or operator reconciliation. Published
predecessors stay protected. Late facts cannot restore a retired attempt's
preparation or activation authority.

Real PostgreSQL regressions first failed on both runtime lanes: external creation
was delayed until after cleanup committed absence, then completed after successor
activation or session deletion. Later recovery now removes the retired runtime,
clone, checkout and Docker tag while preserving the successor. Kubernetes tests
also create Secret, Service and Deployment after successive completed passes.
Tests cover authorization rollback, lost commit acknowledgment, failed completion
persistence and recovery; changed binding, flow owner and physical identity; and
31 completed tombstones with the oldest 25 busy or repeatedly failing. Later six
resources get a turn, and older obligations succeed when released. Runtime/route
transports are fixtures, not new live-cluster or Docker-daemon evidence.

This is **eventual reconciliation**, not creator-termination proof. Late resources
may exist until another successful pass. Recovery, its database and stored
namespace must remain available, and ownership checks must succeed. No timeout
or fixed number of absent scans permits forgetting an isolated intent. Tombstones
remain indefinitely, adding recurring scans and traces. Safe compaction and
external creation settlement remain rollout requirements; Kubernetes build/job
and registry/cache retention retain their existing owners/limits. Out-of-protocol
name reuse or late route writes are not fenced by this change.

The default-off experiment, published-attempt limit and existing locks remain.
No caller migration or generic executor was added in this correction. The later
[B2 checkpoint](../decision-runtime/b2-contract.md) extracts the reusable decision
foundation and demonstrates proposal review cancellation without copying
transaction, deduplication or tracing machinery. C0 must evaluate execution outside the web
process, fair recoverable scheduling, external creation settlement and safe
retention/compaction, with domain permission kept in actions/reducers.
