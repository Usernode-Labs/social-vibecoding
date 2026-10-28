# Platform preview data

Platform previews import a reviewed subset of production data. This is an
interim measure before replacing production copies with synthetic fixtures.
Authored apps retain their existing cloning convention.

## What crosses the boundary

`src/services/platform-preview-data-policy.json` contains only the six retained
tables. Every column has an explicit decision: `keep`, or a trusted SQL value
used to reset it. **All unlisted tables are empty by default.** A checksum update
cannot approve another table or a new column on a retained table.

- Users retain stable IDs. Ordinary handles become `preview-user-<id>`;
  only the exact reserved `usernode-capture` and `usernode-capture-admin`
  handles survive. Profiles, contacts, credentials, preferences, relationships
  and production roles are reset. Capture roles are synthetic.
- Apps retain only the canonical self-hosted platform's structural identity.
  Its production manifests, logs, runtime references, credentials and other
  payloads are reset. Only its community ID survives, without creator data.
- Public model compatibility retains its reviewed projection; operator notes
  are cleared.
- Public UI translations and the notification-kind registry keep their
  explicitly listed public columns.

All other production table contents are omitted, including conversations,
private projects, issues, reports/share tokens, files, workflows, usage and
operational history. Existing staging migrations supply synthetic examples.
Some fixture screens and counts consequently differ from production. Normal
reviewers use synthetic handles and member permissions; capture/shot personas
provide the admin fixtures.

The deployed orchestrator builds each platform copy's schema from **its own**
`src/db/schema.sql`. It imports data only from the six reviewed tables, then
sanitizes and verifies it before returning credentials or starting candidate
code. Production routine bodies, comments, types, indexes and triggers are
never imported. Private fields temporarily present during the trusted data
load are inaccessible to candidate code; PUBLIC connect is revoked before
loading. Redaction runs as the copy's restricted owner and resets sequences.

`src/services/platform-preview-schema.json` stores a compact checksum of the
complete schema catalog, replacing a second copy of its definitions. Named
legacy tables/sequences have separate fingerprints and remain omitted; two
exact known column variants are normalized for compatibility. Unsupported
relations, RLS and large objects are always refused. An unknown schema, table,
column, constraint or sequence definition changes the checksum and refuses the
copy. Source and copied-schema provenance remain distinct. Compatibility
fingerprints do not grant permission to export data.

Production runs PostgreSQL 17 and previews run 18. The catalog excludes 18's
validated, inheritable `NOT NULL` constraint entries because each column's
nullability is already recorded through `pg_attribute.attnotnull`. `NOT VALID`
and `NO INHERIT` forms remain in the inventory. Nullability changes and all other
constraint definitions still change the fingerprint. CI and runtime use the
same strict verification; there are no runtime-only fingerprint exceptions.

A digest of the policy, trusted schema and exporter implementation versions
shared templates, frozen paired sources and runtime labels. Docker runtimes
also need an HMAC receipt signed with the production-only edge key, bound to
the app, actual container name and injected database URL. Image-provided
labels cannot attest sanitization or even a temporary runtime's app scope.
The receipt exposes neither the key nor the URL. Missing/obsolete
provenance forces a fresh template or refuses reuse. Proposed code cannot
approve its own input data by changing comments, manifests or its policy copy.
Candidate migrations may change the sanitized database after boot normally.

Platform preview identities cannot use the production token-only directory
API. The parent iframe directory relay also refuses platform previews,
including previews opened from Messages. Both production cookie-directory
routes also require the current parent-bridge protocol header, so an old parent
tab cannot keep relaying production rows after deployment. The header is a
public protocol version, not a credential; session and same-origin checks still
provide authority. Other apps retain directory access through current parent
pages. Older parent pages must reload first.
This is database-export and directory isolation; it does not replace network,
logging or the separate policies for reviewer-owned bridge capabilities.

## Maintaining the policy

`npm run lint:sql` validates the policy against its existing complete-schema
shadow database. This adds catalog queries, without another database startup
or a production-data scan. The initial local run took about 0.12 seconds.
The image workflow also gates releases on a focused PostgreSQL 17/18 catalog
regression. It loads only the trusted schema into disposable databases, checks
that both versions produce the reviewed catalog, and refuses real nullability,
constraint and default changes. It does not repeat the full unit suite.

When changing the schema:

1. Review the DDL/migration change. Run `npm run lint:sql`; a mismatch reports
   the new compatibility fingerprint. Update the expected checksum only for
   the reviewed schema, preserving named legacy exceptions as needed.
2. If the table is retained, explicitly add/reset every new column in the
   small export policy. The guard checks this independently: updating the
   checksum alone still fails for a column without a data decision.
3. Keep new datasets omitted unless there is a reviewed need to export them.
   Retaining a table requires explicit column decisions and review of its
   writers/publication rules, especially JSON/free text and mixed-visibility
   rows. Schema checks cannot detect a semantic decision to start storing
   private content in an existing public column.

Do not bless an observed production checksum without matching it to reviewed
code/migrations. Unknown production drift must be investigated before copies
resume. Platform identity constants and the parent relay's canonical-host guard
must change together on a rename. Bump the bridge protocol version in both the
parent and cookie-directory routes when changing the relay's security scope.

The PostgreSQL regression runs when `TEST_DATABASE_URL` or the unit runner's
`SQL_CHECK_CONNECTION_URL` is set. Use a disposable local PostgreSQL 17 server
with `psql`, `pg_dump` and `pg_restore` installed. Parallel clone suites
share an empty `usernode` maintenance database, provisioned once by CI setup.
The regression exercises direct/template/paired sources, private markers,
schema carriers, hidden/colliding handles,
stale/forged provenance, schema drift and real migration/fixture boot. Setting
`TEST_PREVIEW_DATABASE_URL` additionally tests separate preview placement. Use
PostgreSQL 18 for that server and version-18 `psql`, `pg_dump` and `pg_restore`
clients to exercise the production-to-preview version boundary. The focused
`tests/platform-preview-schema-compatibility.test.js` needs only Node and `pg`,
and checks both catalogs when those two URLs are set.

## Cutover and future policy changes

Old orchestrators do not understand this policy. A rolling release alone does
not close that interval: an old in-flight builder can recreate an unsafe
preview or overwrite a Service selector after a retirement pass.

1. Pause new preview/check/shot work and drain or stop **all old web and
   workflow processes and their outstanding builders**. Do not allow old work
   to continue deploying while completing this cutover.
2. Deploy the new build. Before listening or starting workflow work, it retires
   platform runtimes with obsolete policy. Kubernetes Services select only the
   accepted policy generation. Any old ReplicaSet/Pod causes retirement of its
   entire owning Deployment, including during a rolling replacement.
3. From the new platform environment, run
   `node scripts/retire-platform-previews.js` after old writers are gone. It is
   repeatable and exits unsuccessfully until obsolete controllers and Pods are
   gone. It ignores session status, active checks and missing session pointers.
   On Docker, ordinary platform previews and temporary shots/evidence containers
   require verified runtime receipts. Unproven legacy temporary containers are
   retired conservatively, including authored-app shots whose former app cannot
   be authenticated. Current authored-app shots receive signed app scope without
   changing their existing database-copy policy. Rotating the edge key also
   invalidates existing Docker receipts; those disposable runtimes rebuild.
4. Resolve any orphan controller/Pod or unreachable node, then rerun the check.
   Normal foreground deletion must complete. Forced API deletion is not proof
   that a process on a disconnected node stopped; isolate/shut down that node
   when necessary. Inventory/removal failures must not be treated as success.
5. Build a fresh platform preview and paired shots; verify sign-in and fixtures,
   then resume work. Refresh the parent shell for reviewer controls; legacy
   parent directory calls are refused until reload. Old preview links rebuild
   on demand. Old databases are unreachable from retired runtimes and remain
   subject to existing orphan GC;
   old templates/frozen sources cannot bypass provenance checks.

A newest-build-only security clock repeats retirement each minute. It does not
use the ordinary stale-preview path, which intentionally preserves serving
previews while replacements build. A failed replacement cannot restore a
previous policy generation. Future policy changes use the same cutover rule.
Conductors check before starting work; web startup reads the clock's recent
matching result. The bounded-age startup and rollout rules are documented in
[Web and conductor processes](../plans/web-and-conductor.md).

The runtime uses its existing list Deployment/ReplicaSet/Pod, get/update
Service and foreground delete Deployment permissions. It does not need list
Service, delete ReplicaSet or delete Pod privileges. A true orphan that its
owning Deployment cannot retire is an operator action and a failed barrier.
