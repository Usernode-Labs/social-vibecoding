# Dependency regressions and security alerts

Pull requests compare image dependencies with the same component at the exact
PR base commit. A fixable HIGH/CRITICAL finding newly introduced by the change
fails its check. An unchanged affected package/version is a warning. Existing
scoped, expiring exceptions still apply to gating.

## Merge enforcement and delivery

GitHub's protection for `main` must require the checks listed in
`security/required-merge-checks.json`, from the GitHub Actions app, with admin
enforcement and no bypass. This covers manual merges and Homeroom's pinned-head
merge API, including its vote override. Keep existing review requirements.
Strict up-to-date checks are not required: Homeroom already handles integration
with main, and this policy does not add a resync for every unrelated merge.

The `Security merge gate` job always runs on pull requests, including when a
dependency fails or is skipped. It succeeds only when the lockfile audit and all
five image checks succeed. Missing, running, failed or cancelled checks cannot
satisfy branch protection. When GitHub refuses a merge, Homeroom's existing merge
queue records the refusal and retries after four minutes; a force vote does not
bypass GitHub protection. An open proposal predating this job must sync with main
before it can satisfy the new required check.

Before merging the advisory release policy, require the six existing lockfile
and image checks. Once this workflow is on main, also require `Security merge
gate`, completing the checked-in list. Requiring the new job before its workflow
lands would prevent older PRs, including the separate esbuild repair, from merging.
Repo settings are separate from source control: verify the check names, GitHub
Actions source and admin enforcement in Settings > Branches > main. The checked-in
list is the final contract, not a claim that a workflow configures its own protection.

After merge to protected main, release scans use `SECURITY_AUDIT_ONLY=1`. The legacy
`feat/k8s` trigger and dispatches on other branches retain the blocking baseline
comparison; they do not have main's required pre-merge scans. Findings on main are warnings in
the job log and summary, with full reports retained, and do not stop delivery.
The independent daily audit below still opens native security requests. Scanner
execution errors, malformed reports, runtime validation failures and the existing
non-security release checks still fail: an unavailable assessment is never a
clean verdict. There is no blanket `continue-on-error` or scanner removal.

The scanner emits `assessment.json` beside its full SBOM/image reports:
`clean`, `existing_findings`, `regression`, `findings` (advisory), or `unavailable`. Failed scans or
comparisons are unavailable and require retry/review, never a clean verdict
or a fabricated new vulnerability. The normal runtime probes still gate.

PR-base inventories are built only when a candidate has a potentially blocking
finding. Every candidate is scanned with the current advisory database.
Inventories are freshly generated from the exact base, using Docker's normal
build-layer reuse. PR-written inventory caches are not restored across runs.
The job summary records baseline build duration; a clean candidate needs no
baseline build.

## Daily audit

`security-audit.yml` runs daily at 06:41 UTC and supports manual dispatch on
`main`. It snapshots release image digests once for platform, worker and capture,
and builds standalone/starter from the workflow's main commit. Reports identify
the immutable image, commit and run. This workflow is independent of release
approval; existing findings cannot stop unrelated releases.

The workflow uploads a compact `homeroom-security-audit-<run attempt>` artifact.
It has no issue-write permission or production credentials. Homeroom's existing
five-minute platform-signals observer reads only the latest trusted main-branch
audit, verifies its repository, commit, run and attempt, and files **private
requests in Homeroom** (#5048), which only full admins see: in the Workshop's
Private requests, never on the board or GitHub. This covers Homeroom's five
components only; other projects are outside this rollout.

Findings are grouped by the upgrade that fixes them, not by advisory: one
request per package, and packages that share an advisory are one upgrade
(Debian's `openssl` and `libssl3`, one Chromium release fixing a dozen
advisories in worker and capture). A request keeps its key while packages join
it, so its target date holds. It files when its highest severity is HIGH or
CRITICAL, and lists every affected component, version, fix and advisory.

When a fix is published, the bot gets a request of its own on the board, titled
like the private one, that says only what to upgrade: the packages, the
installed versions, the versions to move to and the components. No advisory,
severity or date is on it. The bot works on it through its existing queue,
subject to its slots, budget and hold rules, and the private request says
which request it is. Findings without a fix, and audit failures, notify the
full admins (a private bell row and push that name no finding). Unfixable
findings and reviewed exceptions remain visible in the private request.
Targets are one day for CRITICAL and seven for HIGH, shortened by an earlier
exception expiry; they never move forward during an episode. Assess urgent
exposure as an incident; a deployment freeze remains an explicit operator
decision.

The upgrade's merge closes the bot's request, not the private one: only the
audit can say the upgrade worked. If a complete audit still finds the problem
36 hours after the bot's request closed, the private request says so and the
full admins are told, once. If what needs upgrading changes (a newer fix, or
what an upgrade left), the bot gets a new request. An admin closing the
private request ends the episode and closes the bot's request with it.

Unchanged findings do not rewrite or requeue requests. Changes to dependency
versions, severity, fixes or affected components update the private request.
A newly available fix hands a previously unfixable upgrade to the bot. Recent
recurrence reopens the same private request, using the existing seven-day
signal window. Requests filed per advisory before this grouping are closed
with a note once the audit stops filing them; their targets carry over.

Only a complete, successful audit of all five components, at both current main
and Homeroom's recorded main revision, can confirm resolution. A severity downgrade
updates an existing request without closing it. Partial, failed or stale audits
retain known findings, including requests already waiting out the 30-minute quiet
window. They raise a separate audit-health request. Reports expire after 36 hours;
a missing first audit gets 36 hours' grace, and a running audit gets one hour.
An open proposal or recent human discussion still holds a request open.
A healthy daily audit can report findings from an earlier main commit; ordinary
main movement does not raise an audit-failure request, but holds CVE resolution
until a fresh audit matches it.

The chart enables only these two signal kinds with
`config.platformSignals.securityAudit: "on"` (`PLATFORM_SIGNALS_SECURITY_AUDIT`).
Other signal kinds remain in their existing mode. Global `PLATFORM_SIGNALS=off`,
the staging default, the kind allowlist and `PLATFORM_SIGNALS_BOT=off` retain their
meaning. No Discord routing change is included.

Complete reports, including lower severities, are retained as workflow artifacts
for 30 days. An assessment failure requires rerunning the audit; it is not an
empty vulnerability list.

The compact report accepts up to 10,000 typed findings per component, with an
unchanged 1 MiB limit on each assessment input and on the complete serialized
report and its downloaded archive. Findings are never truncated. The former
1,000-finding limit discarded the successful worker (3,399 findings) and capture
(1,575 findings) scans on November 10, 2026. Larger inventories still require a
bounded, valid report; exceeding either limit remains an unavailable assessment.
Debian's exact `TEMP-0000000-ABCDEF` advisory identifier format is accepted too;
these real scanner findings previously invalidated both components after the
count limit was lifted. They remain in the inventory with their original severity.

Rerun all jobs, or dispatch a new audit, to obtain a complete fresh assessment.
Artifacts are scoped to the run attempt; retrying only the aggregator cannot
reuse old clean reports to close a finding.
