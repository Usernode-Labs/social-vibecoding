'use strict';

// Reuse the existing security clock's durable result. Web startup reads only;
// conductors keep their pre-work retirement and refresh the proof on the clock.
const crypto = require('node:crypto');
const policy = require('./platform-preview-data-policy');
const roles = require('./process-role');

const JOB = 'preview-data-policy';
const MAX_AGE_MS = 3 * 60_000;
const WAIT_MS = 180_000;
function scope(config) {
  const secret = config?.edgeJwtSecret || process.env.EDGE_JWT_SECRET;
  if (typeof secret !== 'string' || !secret) throw policy.refuse('runtime receipt key is unavailable');
  return crypto.createHmac('sha256', secret).update(JSON.stringify([
    'homeroom:preview-retirement:v1', policy.DIGEST,
    require('./application-runtime').mode(config), config?.kubernetes?.appNamespace || process.env.APP_NAMESPACE || 'social-apps',
    String(process.env.GIT_SHA || '').trim().slice(0, 40),
  ])).digest('hex');
}

async function check(config, pool, bootResult = null, { boot = false } = {}) {
  if (!roles.runsWorkflow(roles.processRole())) throw new Error('Preview retirement requires a conductor');
  if (process.env.USERNODE_ENV === 'staging') return { skipped: 'staging' };
  const { rows: [time] } = await pool.query(
    `SELECT clock_timestamp()::text AS since,
       (SELECT data->'last'->>'at' FROM wf_instances WHERE machine = 'clock' AND key = $1) AS last_at`,
    [`clock:${JOB}`]);
  if (!time?.since) throw policy.refuse('cannot establish preview retirement barrier');
  // The boot scan can become the clock's first normal result. Its immutable
  // result is passed in at startup; the clock records when it has been used.
  // Once any later clock result (including a failure) is recorded, rescan.
  const bootAt = Date.parse(bootResult?.checkedAt), now = Date.parse(time.since), lastAt = Date.parse(time.last_at);
  if (Number.isFinite(bootAt) && bootAt <= now && now - bootAt <= MAX_AGE_MS
      && (!Number.isFinite(lastAt) || bootAt > lastAt)) {
    try { if (bootResult.scope === scope(config)) return bootResult; } catch { /* still retire below */ }
  }
  const result = await require('./platform-preview-retirement').retire(config, pool);
  // A missing receipt key must prevent a readiness proof, never retirement.
  let proofScope;
  try { proofScope = scope(config); }
  catch (error) {
    if (!boot) throw error;
    require('./logger').warn('preview-policy', 'Preview retirement completed without readiness proof', { message: error.message });
    return result;
  }
  return { ...result, scope: proofScope, checkedAt: time.since };
}

// The clock's run, after check: a retirement deletes runtimes out of band,
// and the preview machine still says they serve. A run going against one
// fails every page; a re-run checked nothing (28 Oct 2026, 743 checks at
// once). So the platform's previews it took are reported lost
// (staging-recovery lookForLostPreviews), the ones being checked among them,
// and the machine rebuilds each. Also after a boot scan the clock records.
// Never fails the run, whose result is the web's readiness proof: the
// preview-runtimes clock and a person's re-run look again.
async function tellRetired(config, pool, result, { signal = null } = {}) {
  if (!(Number(result?.retired) > 0)) return result;
  try {
    const { rows } = await pool.query('SELECT id FROM apps WHERE slug = $1 AND self_hosted IS TRUE', [policy.PLATFORM_SLUG]);
    if (rows.length !== 1) return result;
    const { lost } = await require('./staging-recovery').lookForLostPreviews(config, { signal, appId: rows[0].id });
    return { ...result, lost };
  } catch (error) {
    require('./logger').warn('preview-policy', 'Could not tell the preview machine what retirement removed', { message: error.message });
    return result;
  }
}

async function beforeServe(config, pool, { timeoutMs = WAIT_MS, pollMs = 500,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (process.env.USERNODE_ENV === 'staging') return { skipped: 'staging' };
  if (roles.runsWorkflow(roles.processRole())) {
    return check(config, pool, null, { boot: true });
  }
  const expected = scope(config);
  const deadline = now() + timeoutMs;
  for (;;) {
    // Database time on both ends avoids clock skew between web and conductor.
    // Recent proof survives a short conductor outage or a web restart.
    // Another policy/config/key, an expired proof or a failed latest run
    // cannot open this barrier. No privileged fallback exists on the web.
    const { rows: [row] } = await pool.query(
      `SELECT data->'last'->'result' AS result FROM wf_instances
       WHERE machine = 'clock' AND key = $1 AND data->'last'->>'ok' = 'true'
         AND data->'last'->'result'->>'scope' = $2
         AND (data->'last'->'result'->>'checkedAt')::timestamptz >= clock_timestamp() - make_interval(secs => $3)
         AND (data->'last'->'result'->>'checkedAt')::timestamptz <= clock_timestamp()`,
      [`clock:${JOB}`, expected, MAX_AGE_MS / 1000]);
    if (row) return row.result;
    if (now() >= deadline) throw policy.refuse('conductor has not confirmed preview retirement');
    await sleep(Math.min(pollMs, deadline - now()));
  }
}

module.exports = { JOB, MAX_AGE_MS, WAIT_MS, check, tellRetired, beforeServe };
