# C6: release a retired candidate database

Contract before implementation, 1 October 2026. Continue from accepted C5
`324ace0b46a6e36f94b59665615325af220ff456`. One experimental Kubernetes candidate
path; no caller migration, production change or additional fencing/execution engine.

## Existing mechanism and boundary

Reuse `clone-operation.remove`: attempt-derived database/role names, operation
markers, matching owner/database OIDs, nonblocking maintenance and target guards,
transactional retired-role marker plus `NOLOGIN`, then `DROP DATABASE ... FORCE`.
`prepare` refuses a retired marker even when the database is absent. Keep the role
permanently in this slice. Successors and serving previews have distinct resources.

`NOLOGIN` prevents new logins; it does not terminate existing sessions. A failed or
unacknowledged drop is **not** evidence of database release. Existing connections
may continue until PostgreSQL successfully removes the database. Confirm absence,
matching retired role identity and `rolcanlogin = false` before returning a release
receipt. Errors, active finalizers, changed ownership/OIDs and drop blockers defer
release. Retry the same operation after interruption/lost replies; never recreate
or drop an unrecognized successor. PostgreSQL documents FORCE limitations for
prepared transactions, replication slots/subscriptions and remaining connections:
[DROP DATABASE](https://www.postgresql.org/docs/15/sql-dropdatabase.html).

## Separate database and runtime conclusions

Domain-authorized cleanup retains SQL/serving-binding, terminal Build and resource
locks/checks. Runtime retirement inspects exact desired resources/UIDs, uses
conditional foreground deletion and confirms current resource/Pod absence. That
permits the existing clone retirement service to fence and release the database;
it does **not** establish that every Kubernetes creator or delayed Pod has ended.

Late Pods with the old database URL cannot reconnect after confirmed release.
Attempt role tombstones prevent clone recreation by compliant workers. Preserve
runtime locators, original desired data/UIDs and a recurring shared-executor cleanup
obligation without expiry. Report database release and runtime observed absence
separately in execution receipts; do not mark overall cleanup complete because of
an empty list or elapsed time. Later resources are still inspected and reconciled
with ownership checks, even after the database is gone and across worker restarts.
Conflicting external identities keep the obligation unresolved rather than deleting
unknown objects. Stable-preview activation remains separately authorized.

## Required proof and limits

Fresh disposable local kind, PostgreSQL and dedicated registry; full identity and
destination preflight in parent and child processes before mutations. Demonstrate
actual owner connections/transactions, delayed Kubernetes Pods, lost retirement and
drop replies, SIGKILL/reclaim, refusal of clone recreation, cleanup rediscovery, and
unchanged successor/serving database identities/data plus runtime identities/HTTP
and stored serving projection. Test a real drop blocker: a retired role alone
must not be reported as successful release. Distinguish injected loss/timing and
Build/template selection from actual SQL/resources/traffic.

The guarantee covers ordinary per-attempt application credentials and the existing
trusted clone protocol on the same PostgreSQL endpoint. It does not fence arbitrary
administrators, role-membership changes, shared/admin credentials, database endpoint
replacement or unsupported retention/compaction. No finite bound on all Kubernetes
creation or network outage is asserted. Existing long-held protections, shared
transactions/traces and fair executor remain. Overall migration is incomplete.

## Demonstrated C6 checkpoint

Six actual-resource cases pass without skips: SIGKILL after retirement commit and
after forced drop, reply loss after each of those actual operations, a real
prepared-transaction blocker followed by retry, and a missing clone identity
deferred before external deletion then restored. Both SIGKILL cases include an
actual delayed Pod denied access after release. Healthy candidate/successor/serving
HTTP executes SQL against their own actual clone; OIDs, data, runtime UIDs/spec and
the seven-field serving projection are checked. Earlier owner connections work
before retirement, remain usable in the NOLOGIN-before-drop window, then fail after
confirmed forced removal. The retired role OID survives recovery. Release receipts
remain in the shared execution journal; the late Pod leaves a queued obligation.

Focused real-PG tests additionally inject post-drop LOGIN re-enablement or role
replacement and reject a release receipt. These are guard tests, not a guarantee
against arbitrary administrators. Build observations are injected pinned outputs;
source-template selection chooses seeded test data, while clone copy/finalization,
role fencing, SQL queries, Kubernetes resources/controller GC and HTTP are actual.
Lost acknowledgments/delay are injected at named service boundaries. SIGKILL and
shared-worker reclaim are actual. No continuing API-server request was proved.

**Mechanism replaced:** C5's unconditional database retention after Deployment
submission. **Mechanisms retained:** creation tombstones/locators, role markers,
recurring shared cleanup, all ownership/activation protections, legacy callers,
locks and timers. Late standalone Pods/foreign UIDs can keep cleanup unresolved;
this slice does not introduce orphan-Pod deletion or a retention deadline. Database
release remains safe independently of that closure. Already admitted work keeps
its kind/input and uses the same retirement fence; no reducer version, action,
schema or admission flag is added.

The next checkpoint is one complete actual preparation path, followed by a bounded
caller cutover removing its duplicate preparation/recovery ownership. The
[migration retirement inventory](migration-retirement-inventory.md) is an explicit
acceptance gate. Do not expand to more workflows first.
