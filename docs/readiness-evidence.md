# Platform readiness evidence and knowledge transfer

This repository can produce bounded, repository-level evidence for a readiness
review. It cannot decide whether an environment or release is ready. The issue
owner must supply the release scope, environment acceptance criteria, session
logistics, and sign-off authority before making that decision.

## Safe repository evidence

From a clean checkout of the commit under review:

```sh
npm ci
npm run readiness:evidence -- \
  --target proposed-release-label \
  --output artifacts/readiness-evidence.json
```

The runner invokes the existing `npm test` contract exactly once. It applies a
15-minute timeout by default, does not retry failures, and exits nonzero for a
failed, timed-out, or unavailable check. The JSON report records the commit,
target label, timestamps, result, exit state, and a sanitized 32 KiB output
tail. It does not serialize environment variables, account data, or absolute
repository paths. Artifacts are created with private permissions and an
existing output file is never overwritten.

Use `--timeout-ms` only to accommodate a known CI performance envelope; values
remain bounded between 1 second and 30 minutes. Run `--help` for the complete
interface.

A `passed` result means only that the checked commit passed the repository test
contract on that machine. It is not evidence that staging or production is
healthy, that migrations are safe, that product scenarios passed, or that a
release owner approved deployment.

## Decisions required from the issue owner

Complete these before scheduling or running an environment session:

- Exact commit/release, target environment, and in-scope components.
- Named session owner, required attendees, time zone, date, duration, and
  sign-off authority.
- Test accounts and least-privilege roles; synthetic data set and cleanup
  owner; prohibition on copying production secrets or personal data.
- Scenario-level preconditions, expected results, pass/fail rules, and the
  policy for blocked, flaky, or partially executed scenarios.
- Allowed state-changing operations, maintenance window, backup verification,
  rollback trigger, rollback operator, and stop conditions.
- Approved location and access policy for the checklist, report, notes, and any
  recording. Do not record credentials, personal data, or secret-bearing
  terminals.

## Session checklist

### Before

- Pin and record the exact commit; confirm the working tree is clean.
- Run the repository evidence command and attach its JSON artifact.
- Confirm environment health through the environment's approved monitoring,
  not through this runner.
- Assign an owner and expected result to every scenario.
- Verify test accounts, synthetic data, cleanup, backup, rollback, and stop
  conditions without displaying credentials.
- Label optional or destructive checks explicitly and obtain operator approval.

### During

- Record start/end time, executor, environment label, scenario result, and an
  evidence link. Keep secrets and personal data out of notes and captures.
- Mark an unexpected retry as a separate attempt; do not replace the original
  result. Stop on the agreed destructive-data, security, or rollback trigger.
- Log blocked and skipped scenarios distinctly from passes.

### Knowledge transfer

- Walk through deployment health checks, rollback triggers, backup/restore
  ownership, incident escalation, and where evidence is retained.
- Have the receiving operator explain the procedure back and identify the next
  safe action for one failed scenario. Record open questions and owners.
- Do not infer attendance or understanding from a recording alone.

### After

- Reconcile all scenarios as passed, failed, blocked, or skipped.
- Confirm synthetic-data cleanup and environment restoration with the assigned
  operator.
- Publish the redacted evidence index in the owner-approved location.
- Record an explicit go/no-go decision, decision maker, exceptions, and expiry;
  do not derive that decision solely from this repository report.

## Checks intentionally excluded

The evidence runner never calls deployment, rollback, migration, database,
container, archive, load, or remote-service tooling. In particular, do not add
these to the default command:

- `scripts/rollback.sh`
- `scripts/capacity-probe.sh`
- `scripts/pull-remote-db.sh` or `scripts/push-remote-db.sh`
- `scripts/topochain-load.js` or database-backed validation commands
- archive snapshot fetch/package commands
- `make up`, deployment workflows, or staging browser/account checks

Those operations require a named environment owner, explicit scope, credentials
and data policy, bounded timeouts, cleanup/rollback criteria, and a separately
approved runbook. Their results may be linked from a readiness report, but they
must remain independent of the safe repository evidence command.
