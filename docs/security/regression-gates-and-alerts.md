# Dependency regressions and security alerts

Pull requests compare image dependencies with the same component at the exact
PR base commit. A fixable HIGH/CRITICAL finding newly introduced by the change
fails its check. An unchanged affected package/version is a warning. Releases
keep comparing against immutable recorded release images. Existing scoped,
expiring exceptions still apply to gating.

The scanner emits `assessment.json` beside its full SBOM/image reports:
`clean`, `existing_findings`, `regression`, or `unavailable`. Failed scans or
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
audit, verifies its repository, commit, run and attempt, and files **native
requests in Homeroom**, not GitHub issues. This covers Homeroom's five components
only; other projects are outside this rollout.

One request per HIGH/CRITICAL advisory groups all affected components. Findings
with a published fix enter the existing Homeroom bot queue, subject to its slots,
budget and hold rules. Findings without a fix, and audit failures, wait for a
person. Unfixable findings and reviewed exceptions remain visible. Targets are
one day for CRITICAL and seven for HIGH, shortened by an earlier exception expiry;
they never move forward during an episode. Assess urgent exposure as an incident;
a deployment freeze remains an explicit operator decision.

Unchanged findings do not rewrite or requeue requests. Changes to dependency
versions, severity, fixes or affected components update the request. A newly
available fix can hand a previously unfixable request to the bot. Recent recurrence
reopens the same request, using the existing seven-day signal window.

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

Rerun all jobs, or dispatch a new audit, to obtain a complete fresh assessment.
Artifacts are scoped to the run attempt; retrying only the aggregator cannot
reuse old clean reports to close a finding.
