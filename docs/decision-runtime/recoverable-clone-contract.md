# Recoverable candidate template clone

**Current admission:** only complete `native-preview-kubernetes-prepare` is newly
admitted under the default-off CLI switch. Earlier capability flags and partial
formats described below are historical recovery/evidence contracts, not new
admission choices. Retained formats remain supported; see the
[consolidated admission contract](bounded-preview-contract.md#current-admission-contract-2-october-2026).

1 October 2026. Contract written before implementation. This is one preview
operation, within experimental admission; it is not general workflow execution.

## Identity and authority

New, explicitly opted-in preparation uses a separate work kind, retaining its
stable work/flow/attempt identities across execution claims. A clone operation
is named by the resource-attempt UUID; its database and owner-role names are
derived from that attempt, never the stable serving preview. The operation
records its identity in an external PostgreSQL role comment before copying.
Credentials remain encrypted in the platform resource reservation.

`RequestCandidateClone` authorizes work only for the current preparing flow,
matching head/generation and reserved isolated resources, before retirement.
`CandidateClonePrepared` reports completion through the same decision runtime;
it grants no activation permission. The execution claim alone authorizes neither
creation nor publication. Existing resource/session guards remain held.

Named service operations inspect, prepare and remove this clone. Preparation uses
the staging template only: PostgreSQL commits `CREATE DATABASE ... TEMPLATE`
atomically. There is no automatic fallback to a logical dump/restore, whose
partial-copy state needs a separate contract. Template generation may change
before copying begins; an already copied database is never overwritten or copied
again. Source/schema conventions and administrative privileges remain unchanged.

## Inspection and recovery

Inspection obtains the external operation guard before examining catalogs:

- **Absent:** neither target database nor owner role exists. A current authorized
  operation may create them. A role with this operation's marker but no database
  is **incomplete**, and may continue its atomic template copy if no earlier
  database OID was recorded. A previously recorded database that disappears is
  uncertain and must retire; it cannot be recreated under that identity.
- **Incomplete:** this operation owns the role/database but finalization has no
  committed completion marker. The database's existence establishes a committed
  atomic template copy, not completed ownership/redaction. After excluding a
  still-running finalizer, a restarted worker continues finalization in one
  target-database transaction. Ownership reassignment, private-table truncation,
  private-column scrubbing, grants and completion marker commit together.
- **Complete:** the completion marker matches the operation, resource names and
  physical database OID. Recovery adopts it without rerunning redaction or
  creation; a lost platform acknowledgment is repaired with the original action
  identity. A marker is evidence from this trusted adapter, not an independent
  proof that arbitrary administrators have not modified the database afterward.
- **Uncertain:** busy guards, transport/catalog errors, unmarked or conflicting
  resources, changed physical identity, or an active finalizer. Busy/transient
  observation defers execution; it is never absence. Conflicting ownership retires
  the attempt through its domain owner and leaves deletion blocked rather than
  guessing. A retired external marker forbids continuing or recreating that clone.

Interruption before/during copy retries only after its external guard is available.
An interrupted finalization transaction rolls back; a committed one is adopted.
Preparation after the clone still uses the existing combined source/build/runtime
adapter once. Interruption after that later phase starts still retires an
incomplete candidate; this contract does not make those phases resumable.

## External work and cleanup ownership

The clone operation uses a session advisory guard in the maintenance database
through copy/finalization. Every finalizer also holds a target-database transaction
advisory guard: if process death releases the maintenance connection while a
target statement is still running, recovery/cleanup cannot pass the target guard.
No lease expiry or observed absence proves an earlier external operation ended.
Connection errors stop further commands; statements are server bounded and all
connections/transactions are awaited and closed, never detached on JS timeout.
All participants must use the same external server and maintenance database
(`usernode` in the adapter). Connections are bounded at 5s, statement execution
at 120s and database lock waits at 1s; advisory guards use nonblocking acquisition.
Source-template refresh retains its existing implementation and bounds. These
limits do not promise a total network-failure bound or prove endpoint identity.

Cleanup retains its existing domain, serving-binding and consumer checks. For
these operations it additionally acquires both guards, marks the external role
retired and disables login, drops only the matching isolated database, and keeps
the retired role as a tombstone. Even cleanup observing absence installs that
retired marker, so a delayed invocation cannot recreate the resource afterward.
A conflicting role/database blocks deletion. A successor has different names;
stale cleanup cannot select its resources or alter its serving binding.

Platform cleanup tombstones and existing guards remain. External role tombstones
have no expiry in this slice; safe compaction, backend portability and malicious
out-of-band writers remain deferred. This is not a cross-cluster fencing protocol.

## Compatibility and evidence

Already admitted `native-preview-prepare` work retains its existing opaque-adapter
semantics. New recoverable work is admitted only with a separate explicit opt-in;
workers keep both handlers regardless of later admission-flag changes. Existing
routes/defaults and synchronous preparation remain unchanged. No old work is
reinterpreted, and an unmarked legacy clone cannot be adopted by this operation.

Required integration evidence uses a disposable local PostgreSQL cluster, actual
database/role creation and actual ownership/redaction. It interrupts a child
process after atomic copy and during finalization, loses external/platform
acknowledgments, then recovers the same operation. It also exercises active-server
work, retired absent resources and isolated successors. Runtime build/serving
adapters may be injected; those assertions must be identified separately from
real PostgreSQL clone evidence. No Docker/Kubernetes deployment proof is claimed.

## Implementation and demonstrated evidence

- [`clone-operation.js`](../../src/services/preview-flow/clone-operation.js)
  provides `inspect`, `prepare` and `remove`. Role creation/initial identity commit
  together. Before finalization the role also records the copied database's OID;
  both role and database receipts reject physical replacement. Missing previously
  recorded resources retire safely. Retirement after a lost drop acknowledgment
  consumes the same marker and retains the role tombstone.
- [`work.js`](../../src/services/preview-flow/work.js) admits
  `native-preview-template-prepare`, version 1, only with
  `nativePreviewRecoverableClone: true` in addition to both existing admission
  gates. It shares admission, claims, retries, aggregate coordination and traces.
  The original work kind remains registered. A fixed clone-completion action ID
  repairs lost platform acknowledgments; the runtime-start checkpoint remains
  conservative. Healthy-runtime adoption also verifies clone completion.
- [`candidate-reducer.js`](../../src/services/preview-flow/candidate-reducer.js)
  owns clone permission/completion guards. Reducer version 7 adds these actions;
  version 6 is frozen for historical trace replay. The explicit persistence
  mapping records clone readiness with its receipt and trace atomically.
- [`staging.js`](../../src/services/staging.js) inspects/reuses a prepared clone;
  an uncertain clone blocks deployment without fallback or overwriting it.
  [`cleanup.js`](../../src/services/preview-flow/cleanup.js) consumes the named
  removal operation after its existing domain/runtime/binding protections.

The required regression job now includes
[`recoverable-preview-clone.test.js`](../../tests/recoverable-preview-clone.test.js).
It kills a child after copy, after ownership changes, after redaction before commit,
and after finalization commit. It also interrupts a guarded creator before copy,
when cleanup must defer despite database absence. Recovery retains the database OID; interrupted
changes roll back, credentials work, and adoption does not repeat truncation.
Acknowledgment loss is injected after actual external/decision commits, rather
than induced by a network proxy. Another test runs an actual target query and
transaction after closing its maintenance connection: cleanup/recovery defer,
unrelated preparation progresses, and the original operation remains resumable.

These tests create actual PostgreSQL databases/roles and run the production
ownership/redaction helpers. Template selection is injected to choose a seeded
template; source-template refresh is not covered. Shared-worker recovery uses
real admission, claims and decision journals, with an injected runtime builder.
Its child is an actual execution worker: SIGKILL releases its retained guards;
the test advances its lease deadline to exercise real claim recovery promptly.
The restarted worker repairs a lost decision acknowledgment and connects with
the originally reserved credential. The runtime's build/deployment is injected.
Domain cleanup tests use real clone deletion and PostgreSQL successor resources,
with injected Docker/Kubernetes removal and binding observations. Staging adapter
tests are entirely injected. This establishes clone recovery and coordination,
not real runtime activation, pod termination, network failover or deployment.

This slice replaces whole-attempt abandonment **only while the new clone step is
recoverable and later runtime preparation has not started**. It adds no timers or
executor machinery and removes no old guards, legacy paths or production owners.
Template refresh still uses its existing owner; live worker deployment, direct
copy/source/build recovery, consumer retirement and tombstone compaction remain
subsequent work. One redaction transaction holds locks and needs capacity for the
clone's data; no unbounded-template-size or total network-outage bound is claimed.
