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
A shared decision foundation, a distinct second workflow and the execution-backend
comparison remain mandatory subsequent checkpoints.

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

Run `node scripts/test-preview-flow.js` with `PREVIEW_FLOW_TEST_DATABASE_URL` set to a
**disposable** PostgreSQL database. The optional real-Caddy test is
`PREVIEW_CADDY_TEST_IMAGE=<local image or digest> node --test tests/preview-caddy-live.test.js`;
it creates and removes its own container and publishes no ports.
