'use strict';

// The cross-account protected-data probe (#4678, category `private-data`): does
// the arena target let one account read another account's protected data?
//
// Three steps, in order, and a finding is recorded ONLY when all three agree:
//
//   1. Authorized positive control. As owner A, read owner A's OWN protected
//      resource. This must succeed and return A's own secret. If it does not,
//      the probe cannot distinguish "well protected" from "read path broken",
//      so it records `unsupported` and never a finding.
//   2. Cross-account attempt. As owner A, read owner B's protected resource.
//      A refusal (non-2xx, or a 2xx that does NOT contain B's secret) is the
//      correct behaviour and records `passed`.
//   3. Independent verification. A candidate leak (A received B's secret) is
//      handed to a verifier that re-derives the conclusion from the raw
//      evidence — the body really contains B's secret, not A's; B's own
//      control proves the secret is genuinely B's; and the read reproduces —
//      WITHOUT trusting the attacker step's own claim. Only a verified leak
//      becomes `variant-confirmed` and a recorded finding.
//
// Every request goes through the broker (pinned origin, counted, fenced). Probe,
// verification and finding writes go through runs.withLease. No model call and
// no secret handling live here.

const crypto = require('node:crypto');
const runsModule = require('./runs');

class ProbeError extends Error {
  constructor(code) {
    super(`Security bot probe: ${code}`);
    this.name = 'SecurityBotProbeError';
    this.code = code;
  }
}

const CATEGORY = 'private-data';
const PROBE_KEY = 'cross-account-protected-read';

async function readBody(response) {
  if (!response) return '';
  if (typeof response.text === 'function') {
    try { return (await response.text()) || ''; } catch { return ''; }
  }
  if (typeof response.body === 'string') return response.body;
  return '';
}

function ok(status) { return typeof status === 'number' && status >= 200 && status < 300; }

// A read of one owner's protected resource as a given identity.
async function read(broker, resourcePathFor, owner, asIdentityRef) {
  const response = await broker.request(resourcePathFor(owner), { identityRef: asIdentityRef });
  const body = await readBody(response);
  return { status: response?.status, body };
}

// The default INDEPENDENT verifier. It is handed the raw evidence and the known
// synthetic secrets and re-derives the verdict itself, rather than believing
// the attacker step. A real campaign may pass a stronger verifier; the contract
// is the same: it must confirm the leak from evidence it re-gathers.
function defaultVerifier({ fixtures }) {
  return async ({ attack, controlB, reread }) => {
    const bSecret = fixtures.ownerB.secret;
    const aSecret = fixtures.ownerA.secret;
    // B's own control must prove the secret is genuinely B's and readable by B.
    if (!ok(controlB.status) || !controlB.body.includes(bSecret)) return false;
    // The cross-account body must contain B's secret and must not merely be A's
    // own data mistaken for a leak.
    if (!ok(attack.status) || !attack.body.includes(bSecret)) return false;
    if (attack.body === aSecret) return false;
    // The leak must reproduce on an independent re-read.
    if (!ok(reread.status) || !reread.body.includes(bSecret)) return false;
    return true;
  };
}

async function recordProbe(pool, lease, { outcome, detail, runs }) {
  return runs.withLease(pool, lease, async (client, run) => {
    const { rows: [probe] } = await client.query(
      `INSERT INTO security_bot_probes (run_id, category, probe_key, variant, outcome, detail)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (run_id, category, probe_key)
         DO UPDATE SET outcome = EXCLUDED.outcome, variant = EXCLUDED.variant, detail = EXCLUDED.detail
       RETURNING *`,
      [run.id, CATEGORY, PROBE_KEY, outcome === 'variant-confirmed', outcome, JSON.stringify(detail || {})],
    );
    return probe;
  });
}

async function recordFinding(pool, lease, { summary, evidenceRef, runs }) {
  return runs.withLease(pool, lease, async (client, run) => {
    const fingerprint = crypto.createHash('sha256')
      .update(`${CATEGORY}:${PROBE_KEY}`).digest('hex');
    const { rows: [finding] } = await client.query(
      `INSERT INTO security_bot_findings
         (category, probe_key, severity, status, fingerprint, summary, evidence_ref, first_run_id, verified_by)
       VALUES ($1, $2, 'high', 'verified', $3, $4, $5, $6, 'independent-verifier')
       ON CONFLICT (fingerprint) WHERE status <> 'resolved'
         DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [CATEGORY, PROBE_KEY, fingerprint, summary, evidenceRef || null, run.id],
    );
    await client.query(
      `INSERT INTO security_bot_finding_occurrences (finding_id, run_id, context)
       VALUES ($1, $2, $3::jsonb) ON CONFLICT (finding_id, run_id) DO NOTHING`,
      [finding.id, run.id, JSON.stringify({ probe_key: PROBE_KEY })],
    );
    return finding;
  });
}

/**
 * Run the cross-account protected-data probe.
 *
 *   broker          a configured broker (pinned to the arena origin).
 *   fixtures        { ownerA, ownerB } from arena.buildSyntheticFixtures.
 *   resourcePathFor (owner) => relative path to that owner's protected resource.
 *   verify          optional independent verifier; defaults to defaultVerifier.
 *
 * Returns { outcome, finding? }. Persists a probe row, and a finding only when
 * a leak is independently verified.
 */
async function runCrossAccountProbe(pool, lease, {
  broker, fixtures, resourcePathFor, verify, runs = runsModule,
} = {}) {
  if (!broker || typeof broker.request !== 'function') throw new ProbeError('broker_required');
  if (!fixtures?.ownerA || !fixtures?.ownerB) throw new ProbeError('fixtures_required');
  if (typeof resourcePathFor !== 'function') throw new ProbeError('resource_path_required');
  const verifier = typeof verify === 'function' ? verify : defaultVerifier({ fixtures });

  // Step 1: authorized positive control — A reads A's own resource.
  const controlA = await read(broker, resourcePathFor, fixtures.ownerA, fixtures.ownerA.identityRef);
  if (!ok(controlA.status) || !controlA.body.includes(fixtures.ownerA.secret)) {
    await recordProbe(pool, lease, {
      outcome: 'unsupported',
      detail: { reason: 'positive_control_failed', controlStatus: controlA.status },
      runs,
    });
    return { outcome: 'unsupported' };
  }

  // Step 2: cross-account attempt — A reads B's resource.
  const attack = await read(broker, resourcePathFor, fixtures.ownerB, fixtures.ownerA.identityRef);
  const leaked = ok(attack.status) && attack.body.includes(fixtures.ownerB.secret);
  if (!leaked) {
    await recordProbe(pool, lease, {
      outcome: 'passed',
      detail: { attackStatus: attack.status },
      runs,
    });
    return { outcome: 'passed' };
  }

  // Step 3: independent verification before anything is called a finding.
  const controlB = await read(broker, resourcePathFor, fixtures.ownerB, fixtures.ownerB.identityRef);
  const reread = await read(broker, resourcePathFor, fixtures.ownerB, fixtures.ownerA.identityRef);
  const confirmed = await verifier({ attack, controlA, controlB, reread });
  if (!confirmed) {
    await recordProbe(pool, lease, {
      outcome: 'failed',
      detail: { reason: 'unverified_candidate', attackStatus: attack.status },
      runs,
    });
    return { outcome: 'failed' };
  }

  const evidenceRef = crypto.createHash('sha256')
    .update(`${lease.runId}:${PROBE_KEY}:${attack.status}`).digest('hex').slice(0, 32);
  await recordProbe(pool, lease, {
    outcome: 'variant-confirmed',
    detail: { verified: true, attackStatus: attack.status, evidenceRef },
    runs,
  });
  const finding = await recordFinding(pool, lease, {
    summary: 'An account could read another account’s protected data in the arena.',
    evidenceRef,
    runs,
  });
  return { outcome: 'variant-confirmed', finding };
}

module.exports = {
  ProbeError, CATEGORY, PROBE_KEY, defaultVerifier, runCrossAccountProbe,
};
