'use strict';

// The verified-identity rule's one-time rollout (evan, 2026-10-06): the boot
// after the change that brought the rule in switches it on in production,
// with new members who have not verified on a smaller AI allowance.
//
// In one transaction, once, marked by `identity_rule_rollout`:
//
//   1. each verified tier's weekly cap (phone, GitHub and X, zkPassport)
//      takes the unverified cap as it stands, where an admin has not set
//      one, so nobody verified or let in before the switch gets less;
//   2. the unverified cap drops to UNVERIFIED_WEEKLY_CENTS ($20), never
//      raised: a deployment already below it keeps its own figure;
//   3. the rule switches on now (`identity_rule_since`, schema.sql), so
//      every member let in before this boot is exempt from it (the phone
//      tier's allowance and their public votes), and only somebody let in
//      afterwards who has not verified gets the $20 and is asked to verify.
//
// Production only. Tests, local development and staging previews boot a
// fresh database in which every account is made after the boot, so the
// rule would hold every one of them to it; there it stays off until an
// admin switches it on (Admin, Limits). Every value here is an ordinary
// Limits setting afterwards, changed there like any other: the marker
// keeps the boot from putting them back.

const log = require('./logger');
const limits = require('./limits');

const MARKER = 'identity_rule_rollout';
const UNVERIFIED_WEEKLY_CENTS = 2000;

function applies(env = process.env) {
  return env.NODE_ENV === 'production' && env.USERNODE_ENV !== 'staging';
}

async function applyIdentityRollout(pool, { env = process.env, now = new Date() } = {}) {
  if (!applies(env)) return { applied: false, reason: 'not_production' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The marker's own insert is the lock: a second replica booting at the
    // same moment waits on it, then finds it taken and changes nothing.
    const { rows: marked } = await client.query(
      `INSERT INTO platform_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING RETURNING key`,
      [MARKER, now.toISOString()]
    );
    if (!marked.length) {
      await client.query('ROLLBACK');
      return { applied: false, reason: 'done_before' };
    }
    const { rows: base } = await client.query(
      'SELECT value FROM platform_settings WHERE key = $1', [limits.KEY_WEEKLY]);
    const parsed = Number.parseInt(base[0]?.value, 10);
    const current = Number.isFinite(parsed) && parsed >= 0 ? parsed : limits.DEFAULT_WEEKLY_LIMIT_CENTS;
    for (const key of [limits.KEY_WEEKLY_PHONE, limits.KEY_WEEKLY_SOCIAL, limits.KEY_WEEKLY_ZK]) {
      await client.query(
        `INSERT INTO platform_settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO NOTHING`,
        [key, String(current)]
      );
    }
    const unverified = Math.min(current, UNVERIFIED_WEEKLY_CENTS);
    await client.query(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [limits.KEY_WEEKLY, String(unverified)]
    );
    await client.query(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO NOTHING`,
      [limits.KEY_IDENTITY_RULE_SINCE, now.toISOString()]
    );
    await client.query('COMMIT');
    limits.invalidate(limits.KEY_WEEKLY, limits.KEY_WEEKLY_PHONE, limits.KEY_WEEKLY_SOCIAL,
      limits.KEY_WEEKLY_ZK, limits.KEY_IDENTITY_RULE_SINCE);
    log.info('limits', 'Verified-identity rule rolled out', { verifiedCents: current, unverifiedCents: unverified });
    return { applied: true, verifiedCents: current, unverifiedCents: unverified };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* the connection is going anyway */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { applyIdentityRollout, applies, MARKER, UNVERIFIED_WEEKLY_CENTS };
