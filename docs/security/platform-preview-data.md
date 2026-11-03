# Platform preview data

A platform preview's database starts **empty**. Nothing is copied from
production: no table, row, catalog, template or migration history. The
preview's own boot builds its schema and seeds its fixtures, exactly as a
fresh install does (`src/db/migrate.js`, about three seconds). Authored apps
keep their existing cloning convention (copy, then redact).

## What a platform preview starts with

The trusted orchestrator (`src/services/db-manager.js`) gives a platform
preview an empty database from `template0` on the preview server, owned by a
login role of its own, with PUBLIC connect revoked and a preview's connection
ceiling (`createEmptyPlatformDatabase`). Every path that makes one does the
same: an ordinary preview (direct or "via template"), and both sides of a
shots pair, whose prepared source is itself an empty, connectionless
database. Every way of copying the platform's own database (the direct copy,
the redacted template and its refresh, a clone from a template) refuses it
(`refusePlatformCopy`). So no scrub rule, export policy or schema
fingerprint can leak or block anything, and a migration needs no review of
what previews may copy.

The boot then makes, from the preview's own code and configuration:

- the platform's own app row, with production's app id (`USERNODE_APP_ID`,
  which every preview is given): the sign-in tokens it accepts are bound to
  that id (`seedSelfApp`);
- the two screenshot personas at their fixed ids
  (`src/services/preview-personas.js`), with their
  fixture roles and platform access (`seedCaptureUser`,
  `seedCaptureAdminUser`). The platform signs persona tokens for its own
  previews with those ids (`visuals.mintCaptureToken`, `previewIdentity`);
- the staging fixtures, as before;
- the translation cache, imported once from production's public export,
  `GET /api/languages/cache` (`seedStagingTranslations`,
  `language-cache.exportEntries`). It is the same public text the shell's
  packs serve, with the English each translation was made from, so a
  message the proposal rewords is not shown in its old translation. When
  production cannot be reached, English stands in.

The model-compatibility catalog holds only the row the baseline migration
seeds (the default Codex model, verified), so previews show that one
"verified" mark and no others. Notification kinds are seeded by code.

All 752 declared checks passed against an empty boot of this code on
3 November 2026, built from `Dockerfile.kubernetes` with a platform
preview's environment, so none relied on a copied row.

## Code that predates empty previews

A preview runs its proposal's own code, and shots run both revisions'. Code
that can boot from an empty database carries `src/db/preview-boot.json`
(`startsEmpty`), which the platform reads before building
(`platform-preview-data-policy.js` `startsEmpty`). A platform preview of code
without it is refused ("Update it with main to preview it",
`services/staging.js`), and so is a shots pair either revision of which lacks
it (`shots_preview_needs_update`, `services/shots-environment.js`): started
anyway, its seeds would put the personas at other ids, so checks and shots
would run signed out, and no reviewer could sign in. That support shipped a
release before the switch, so that changes opened after it carry the marker.
Keep the file while the support holds.

A change's recorded base (an imported pull request's, or a local agent's
hand-off) never moves, even once the change is updated with main. When that
base lacks the marker, the shots' before side is where the change's head
meets main instead (`shots-orchestrator.js` `recordedBaseCannotBoot`), as
for a change with no recorded base. A shots eval replays a merged change's
exact revisions, so a platform change merged before the marker cannot be
replayed: its trial is refused with the same reason.

## Who is signed in

A reviewer opens a preview with the platform's signed identity: their
production id and the synthetic handle `preview-user-<id>`
(`previewIdentity`). The preview makes their row on first sign-in, as a
member with platform access and no password anyone can use
(`middleware/auth.js` `createPreviewReviewer`), and moves its users sequence
past the id. Before any seed, the preview moves that sequence to
1,000,000,000 (`reservePreviewReviewerIds`), so no fixture ever sits on a
production id a reviewer signs in with. Only that handle, for that very id, is accepted, so no
production handle ever lands in a preview; the personas are never made this
way, only seeded. Other production handles may be undiscoverable or
historically contain email addresses, and the alias keeps the production
account directory from being enumerable.

Platform preview identities cannot use the production token-only directory
API. The parent iframe directory relay also refuses platform previews,
including previews opened from Messages. Both production cookie-directory
routes also require the current parent-bridge protocol header, so an old parent
tab cannot keep relaying production rows after deployment. The header is a
public protocol version, not a credential; session and same-origin checks still
provide authority. Other apps retain directory access through current parent
pages. Older parent pages must reload first.
This is database and directory isolation; it does not replace network,
logging or the separate policies for reviewer-owned bridge capabilities.

## Stamps and receipts

`platform-preview-data-policy.js` `DIGEST` hashes the code that makes and
retires a platform preview's database (that module, `db-manager.js`,
`application-runtime.js`, `platform-preview-retirement.js`). Every database
made for a platform preview carries it, and a platform deploy without it is
refused (`application-runtime.deploy`). Kubernetes runtimes carry it as a
label their Services select on. Docker inherits image labels, so Docker
runtimes also need an HMAC receipt signed with the production-only edge key,
bound to the app, actual container name and injected database URL. Image
labels cannot attest a database or even a temporary runtime's app scope. The
receipt exposes neither the key nor the URL. Proposed code cannot approve its
own database by changing comments, manifests or its copy of this module.

## Cutover and future policy changes

A change to that code changes the digest, and every serving platform preview
with another one is retired and built again. Old orchestrators do not
understand a new policy, and a rolling release alone does not close that
interval: an old in-flight builder can recreate a preview under the old
policy or overwrite a Service selector after a retirement pass.

1. Pause new preview/check/shot work and drain or stop **all old web and
   workflow processes and their outstanding builders** when the old policy
   must not serve even briefly. Otherwise retirement removes what they build.
2. Deploy the new build. Before listening or starting workflow work, it retires
   platform runtimes with an obsolete policy. Kubernetes Services select only
   the accepted policy generation. Any old ReplicaSet/Pod causes retirement of
   its entire owning Deployment, including during a rolling replacement.
   Retirement also drops, once per conductor process, the warm templates
   platform previews were once copied from (`dropStagingTemplates`), best
   effort: nothing serves from them.
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
   then resume work. Old preview links rebuild on demand. Old databases are
   unreachable from retired runtimes and remain subject to existing orphan GC.

A newest-build-only security clock repeats retirement each minute. It does not
use the ordinary stale-preview path, which intentionally preserves serving
previews while replacements build. A failed replacement cannot restore a
previous policy generation. Conductors check before starting work; web
startup reads the clock's recent matching result. The bounded-age startup and
rollout rules are documented in
[Web and conductor processes](../plans/web-and-conductor.md).

The runtime uses its existing list Deployment/ReplicaSet/Pod, get/update
Service and foreground delete Deployment permissions. It does not need list
Service, delete ReplicaSet or delete Pod privileges. A true orphan that its
owning Deployment cannot retire is an operator action and a failed barrier.

## Tests

`tests/platform-preview-data-policy-postgres.test.js` runs when
`TEST_DATABASE_URL` or the unit runner's `SQL_CHECK_CONNECTION_URL` is set
(with `psql` installed); `TEST_PREVIEW_DATABASE_URL` adds a separate preview
server. It checks that every path makes an empty, stamped database and no
template, that every copy path refuses the platform's database, and boots an
empty clone through the real `migrate` to check the platform's app id, the
personas and that no source row exists.
`tests/preview-reviewer-signin-postgres.test.js` covers first sign-in, and
`tests/preview-translations-postgres.test.js` the translation export and
import.
