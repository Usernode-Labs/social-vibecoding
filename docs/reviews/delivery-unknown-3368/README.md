# "Merged · delivery unknown" on apps (issue #3368)

Investigation of the delivery-unknown state some apps show on merged
proposals. The conclusion up front: **the message is the intended, honest
fallback, not a bug.** The state is a delivery-verification feature (#3335)
that landed one day before this report, and the apps showing it are those
whose running production container carries no revision marker the
verification can read.

## What the state means

`src/services/proposal-delivery.js` derives each merged proposal's delivery
state from the revision actually running in production:

- `deployed` — the observed production revision equals the merge commit, or
  the merge commit is an ancestor of it (`annotateChild` → `stateOf`, via
  the mirror's `isAncestor` check).
- `pending` — a rebuild retry is in flight (`appDeployStatus.read` reports
  `deploying`), or the running revision is confirmed *older* than the merge
  (the running SHA is an ancestor of the merge SHA).
- `failed` — the last recorded rebuild failure (`apps.last_failure`) is for
  the same merge commit (`failureSha`).
- `unknown` — no running revision could be observed, so the relationship
  between the merge and production cannot be proven either way.

The frontend renders that state in `public/js/app-view.js`
(`statusPillState`): a merged child proposal whose `deployment_state` is not
`deployed`, `pending`, `deploying` or `stalled` reads
**Merged · delivery unknown** with a neutral tone and the tooltip "The
running production revision could not be confirmed." The Done-column cue
(`_doneDeploymentStatus`) reads "Production delivery could not be
confirmed."

The observation itself comes from
`applicationRuntime.inspect` → `kubernetes.inspectApplication`, which reads
the deployment's pod-template labels. The label that makes verification
possible is `social.usernode.io/source-revision`, and only one code path
sets it: the production-rebuild path in `src/services/staging.js`
(`rebuildProduction`), which stamps the merge SHA it is building.

## Why the apps in the screenshot show it

The two apps visible in the report screenshot are **snait** (PR #41, "home
screen icon") and **Arkham.intel** (PR #39, "Round feedback & progress").
Both were created before or around #3335's introduction of the revision
label, and neither has necessarily had a labelled rebuild since. Their
merged PRs are therefore unverifiable: the production container serving
them carries no readable `source-revision` label. Three cause classes
produce that, and the code confirms each:

1. **The first deploy after app creation does not stamp the marker.**
   `src/services/app-creator.js` `finalizeDeployInner` builds and runs the
   first production container but passes no `labels:` option to
   `applicationRuntime.deploy`, so the container that a young app runs on
   has no revision label. (The app row's `main_sha` is set, but the
   verification deliberately reads the *observed* runtime, not the
   database.) Any app that has not had a labelled rebuild since creation
   observes no revision and answers `unknown` for every merged row.
2. **Respawn paths strip the marker.** When the watchdog
   (`src/services/app-heal.js`) or the admin bulk rollover
   (`src/services/app-rollover.js`) restores a container by re-running its
   existing image, that goes through `src/services/app-respawn.js`
   `runExistingImage`, whose `applicationRuntime.deploy` call also passes
   no `labels:` option. The replacement container is created without the
   label, so the next verification on that app reads unknown until a full
   rebuild replaces it. (A secondary wrinkle: the rollover's own failure
   records are written with `sha: null`, so they never key the "failed"
   classification and those rows also fall through to unknown.)
3. **The container is genuinely gone or unreachable.** Deletion, a failed
   deployment, or an observation error all collapse to the same `unknown`
   — deliberately: `tests/proposal-delivery.test.js` pins that "missing,
   unready and uncertain runtime evidence never claims delivery" (null
   observation, `rolloutReady: false`, mirror failure, and a non-commit SHA
   each produce `unknown`), and `tests/merged-pagination.test.js` pins the
   honest fallback for child apps whose running revision is `null`.

Because both screenshot apps predate the label's introduction, either cause
1 or cause 2 (or simply "no rebuild since #3335 landed") explains each of
them; without live runtime access from this worker the exact one cannot be
distinguished, and the report does not assert between them. A repo-backed
app in either situation self-corrects the moment a labelled rebuild runs —
any merge, manual redeploy, or drift-poller rebuild goes through
`rebuildProduction` and stamps the label.

## Why the fallback is correct, not a bug

`stateOf` answers `unknown` rather than guessing because a GitHub merge can
succeed while the production rebuild that follows it fails. Claiming
delivery without observing the running revision would be wrong in exactly
that case — the user would see a green "delivered" state on an app that is
still serving the previous revision, or is down entirely. The tests pin
this on purpose: the "missing, unready and uncertain runtime evidence never
claims delivery" test asserts each of those conditions produces `unknown`,
and the frontend test (`tests/dev-status-pill.test.js`) pins that the
unknown state renders the honest "Merged · delivery unknown" label with a
neutral tone rather than a progress or error tone.

## Cause classification and what would change it

Each cause maps to a distinct fix. These are recommended follow-ups only —
nothing here changes app behaviour, and the "Merged · delivery unknown"
label itself should stay exactly as it is.

1. **Stamp the label on the creation and respawn deploy paths.**
   `app-creator.js` `finalizeDeployInner` and `app-respawn.js`
   `runExistingImage` both already know the revision the image was built
   from (`apps.main_sha`, present on the app row in both paths). Passing
   the same `labels: { 'social.usernode.io/source-revision': mainSha }`
   that `staging.js` `rebuildProduction` passes would eliminate the two
   most common causes of the unknown state: the "young app" case (no
   rebuild since creation) and the "healed app" case (watchdog/rollover
   re-ran the image without the label). The label mechanism is the pattern
   to copy (`staging.js` around the rebuild's `applicationRuntime.deploy`
   call).
2. **Harden the `last_failure` sha parse.** The parse in
   `proposal-delivery.js` `failureSha` returns null for anything that does
   not JSON-parse into a `{ sha: <40-hex> }` shape. Records written by
   older code (or by paths that did not set a sha) therefore never key the
   "failed" classification, and a merged row on such an app falls through
   to `unknown` for one request window instead. A small migration or
   tolerant parse for legacy shapes would make those rows read `failed`
   (or clear them) rather than unknown.
3. **Genuine deletion or an unreachable runtime should stay unknown.** The
   intent of the honest fallback is precisely not to hide that a container
   is gone, and the code achieves that deliberately. No change is
   recommended for this class.

## Tests

None are added. The behaviour is already pinned by
`tests/proposal-delivery.test.js`,
`tests/merged-pagination.test.js` and
`tests/dev-status-pill.test.js`; this change adds a document only, so
there is no new code to pin. Running
`npm run test:changed -- --base <base-sha>` on the submitted revision
confirms no suite reads the new path (a new `docs/reviews/` directory is
not named by any suite and is not covered by the fast whole-tree guards).
