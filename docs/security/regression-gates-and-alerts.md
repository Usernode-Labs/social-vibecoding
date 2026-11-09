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

The publisher maintains one `security-audit` GitHub issue per HIGH/CRITICAL
advisory, aggregating affected components. Unfixable findings and reviewed
exceptions remain visible. Each issue records first/last seen, evidence,
ownership and a remediation target: one day for CRITICAL, seven for HIGH,
or an earlier exception expiry. The first-seen date and target do not move
forward on daily updates. Escalation can shorten the target. Assess urgent
exposure as an incident; a deployment freeze is an explicit operator decision.

Set repository variable `SECURITY_ALERT_ASSIGNEE` to the GitHub username owning
triage. Without it, issues name repository maintainers and ask for assignment.
Existing assignees and investigation notes outside the managed block are kept.
There is no repeated comment notification on each scan. An existing CVE issue
reopens on recurrence; a severity downgrade alone is not proof of remediation.

Only complete successful reports for all five components, from the current
audit run, attempt and revision, can close an issue. Partial/unavailable scans can add
discoveries but never claim resolution. A stale main revision cannot publish.
PR jobs have read-only tokens; only the trusted main-branch audit publisher
has issue-write permission. No production credentials are used by these jobs.

For a local preview of issue updates without network calls or a write token:

```sh
node scripts/security-alerts.js /path/to/downloaded/audit-reports --dry-run
```

Complete reports, including lower severities, are retained as workflow artifacts
for 30 days. An assessment failure requires rerunning the audit; it is not an
empty vulnerability list.

Rerun all jobs, or dispatch a new audit, to obtain a complete fresh assessment.
Artifacts are scoped to the run attempt; retrying only the publisher cannot
reuse old clean reports to close a finding.
