# Experimental support and offline replay

2 October 2026.
Accepted product base `c01dc0687`. The user explicitly supports **fresh experimental
stores only**. Historical development checkpoints are not permanent live-runtime
compatibility. This decision excludes production data and legacy callers from pruning.

## Contract before removal

Inventory bounded local fixture journals/manifests and trace exports before deleting
experimental recovery dispatch. Verify live disposable ownership before connecting;
a missing or inaccessible store is unknown, not an empty store. Identify and reconcile
unfinished work or external-resource/cleanup obligations in any retained experimental
store. Retired physical fixtures need no invented permanent recovery requirement.
Unlisted developer stores/backups are unsupported until explicitly inventoried and
reconciled; do not run the fresh-only worker against them.

Archive historical reducers (preview v1–v9, CLI v1–v2, review v1),
plus the accepted revision’s current reducer snapshots (preview v10, CLI v3, review v2), exact transitive
code/dependency bytes, original golden-test sources and exported test decision traces.
Checksums and producing revision must survive Git squash. Replay must work from a
copied archive directory with no checkout, dependency installation, database,
credentials or network. Verify original golden cases and identify synthetic version
coverage separately. CLI v2's live enabling-condition dependency must be frozen in
that archive, not imported from future runtime code.

Only after verification remove obsolete experimental handlers and reducer dispatch.
Keep live reducers, current replay, validated actions/receipt retry shapes, persisted
operation mappings, synchronous candidate/native paths and shared resource/retention
locks. Keep legacy production manifest/placement compatibility unless its own inventory
and replacement proof authorizes removal. The current complete preparation and required
retirement/continuation/gate/review owners remain. Do not weaken their failure tests.

## Evidence

The supported retained-store list is **empty**: only new experimental stores are
supported. Bounded local inventory found 19 Kubernetes fixture journals marked
`torn-down` and nine PostgreSQL fixture manifests. Read-only inventory of the
explicit local Docker daemon found only the new PostgreSQL fixture created for
this correction. Earlier tmpfs databases, kind nodes and registries no longer
exist. No historical store is retained for recovery, and no unresolved physical
fixture obligation was identified. No old database or production destination was
connected. Other developer stores/backups remain unknown and unsupported; this
is not a claim of a global inventory.

The [offline archive](../../archives/experimental-replay-c01dc0687/README.md)
contains exact dependency bytes, original test/source snapshots, nine original
golden assertions, 139 exported test traces and five labeled synthetic witnesses.
The producing suites passed 134 tests with zero skips before deletion. All 153
cases replayed in a separate directory without checkout dependencies or credentials.
A checksum-corruption regression rejects a changed archive. These are test exports;
no production/external trace export was recovered or silently discarded.

Removed: three partial work kinds/registry entries and their recovery-selection,
one-shot adoption/start branches and two unused completion flags; twelve historical reducer source
files and live replay dispatch; exclusive `preparedClone`/`onRuntimeStarting`
staging hooks; historical-format test admission and its unused worker child.
Current-format tests now exercise their continuing guarantees. Current reducer
policies/versions and validated action retry shapes remain unchanged.

Standalone startup now checks for removed work kinds **including succeeded work**
and historical decision versions, refusing the store before claiming anything.
It does not delete, relabel or reconcile records. If such a store is presented,
export traces and inventory work/resource/cleanup obligations under its original
recovery code before replacing it. Offline replay cannot retire resources.
Production/legacy policies, synchronous candidate handling, current tombstones,
manifest/placement compatibility and lifecycle/retention locks remain.

Focused PostgreSQL and actual-resource verification is recorded in the ledger.
Public HTTPS/private identity proof is a separate outstanding gate; this removal
does not establish that compatibility or authorize rollout.
