'use strict';

// #5118: account deletion reaches into app databases. Every app is
// third-party code with its own database, so the platform cannot erase an
// app's rows itself; it asks the app, server to server, through a documented
// contract ("Your people's data" in src/prompts/app-conventions.md):
//
//   POST <app origin>/usernode/user-deletion   erase or anonymise one person
//   GET  <app origin>/usernode/user-export     return one person's rows
//
// Each request carries a platform token in `x-usernode-platform-token`:
// RS256 under the app-identity key, audience `usernode:app:<id>`, `pur`
// 'user-deletion' or 'user-export' (services/platform-jwt.js). It is a header
// of its own on purpose: a verifier that reads `x-usernode-token` and forgets
// to check `pur` still never sees it as a signed-in person.
//
// Deletion rides the account-deletion receipt: deleteAccount() queues one
// durable `app_data` task per app the person touched, inside its own
// transaction, and the cleanup sweep (account-deletion-cleanup.js) sends each
// request and retries it. An app that does not implement the endpoint is
// recorded on the receipt (state 'review', `app_unsupported`) so an operator
// can follow up; it is never retried blindly.

const applicationRuntime = require('./application-runtime');
const platformJwt = require('./platform-jwt');

const DELETION_PATH = '/usernode/user-deletion';
const EXPORT_PATH = '/usernode/user-export';
const TOKEN_HEADER = 'x-usernode-platform-token';
const REQUEST_TIMEOUT_MS = 15_000;
// Attempts before an unreachable app is handed to review instead of retried.
// With the cleanup's doubling delay (capped at a day) that is about a week.
const MAX_ATTEMPTS = 12;

// Every app the person has a footprint in, by the platform's own records:
// membership, building, administering, opening it (engaged-use time), using
// its AI or files, pinning it, and creating it. The platform's own app
// (self_hosted) is not asked: its data is the platform's, which
// deleteAccount() already erases. Runs inside deleteAccount()'s transaction,
// before the purge empties the membership rows it reads.
async function touchedAppIds(db, userId) {
  const { rows } = await db.query(
    `SELECT a.id FROM apps a WHERE a.self_hosted IS NOT TRUE AND a.id IN (
        SELECT app_id FROM app_collaborators WHERE user_id = $1
        UNION SELECT app_id FROM app_admins WHERE user_id = $1
        UNION SELECT app_id FROM app_activity WHERE user_id = $1
        UNION SELECT app_id FROM app_usage_intervals WHERE user_id = $1
        UNION SELECT app_id FROM app_llm_usage WHERE user_id = $1
        UNION SELECT app_id FROM app_llm_grants WHERE user_id = $1
        UNION SELECT app_id FROM app_permission_grants WHERE user_id = $1
        UNION SELECT app_id FROM app_files WHERE user_id = $1
        UNION SELECT app_id FROM app_favorites WHERE user_id = $1
        UNION SELECT x.id FROM apps x JOIN community_members m ON m.community_id = x.community_id
               WHERE m.user_id = $1
        UNION SELECT id FROM apps WHERE created_by = $1)
      ORDER BY a.id`,
    [userId]
  );
  return rows.map((r) => Number(r.id));
}

// The task's target is `<appId>` or `<appId>:<wallet address>`. The address
// is the other key apps find a person's rows by, and the users row has lost
// it by the time the request is sent. The sweep rewrites a completed task's
// target to an opaque marker, so the address is kept only until the app
// confirms.
function encodeTarget(appId, usernodePubkey) {
  return usernodePubkey ? `${appId}:${usernodePubkey}` : String(appId);
}

function decodeTarget(target) {
  const [head, ...rest] = String(target).split(':');
  const appId = Number(head);
  if (!Number.isSafeInteger(appId) || appId <= 0) throw new Error('invalid_target');
  return { appId, usernodePubkey: rest.length ? rest.join(':') : null };
}

// A failure the sweep should record for review rather than retry.
class SettleForReview extends Error {
  constructor(code) { super(code); this.reviewCode = code; }
}

function classify(status) {
  if (status >= 200 && status < 300) return 'ok';
  // No handler: the scaffold's sign-in gate answers an unknown POST 401, a
  // plain server 404 or 405.
  if ([401, 404, 405, 501].includes(status)) return 'unsupported';
  // The scaffold's handler refuses a token it cannot verify with 403.
  if (status === 403) return 'refused';
  if (status === 408 || status === 429 || status >= 500) return 'retry';
  return 'rejected';
}

// Sends one erasure request. Resolves when the app confirmed (or the app is
// gone, its database with it). Throws SettleForReview for an answer no retry
// will change, and a plain Error for one worth retrying.
async function requestDeletion(pool, config, task, { fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const { appId, usernodePubkey } = decodeTarget(task.target);
  // A staging copy of the platform holds a copy of production's people and
  // may reach production's apps: it never asks one to erase anything.
  if (env.USERNODE_ENV === 'staging') throw new SettleForReview('staging_copy');
  const { rows: deletions } = await pool.query('SELECT user_id FROM account_deletions WHERE id = $1', [task.deletion_id]);
  if (!deletions.length) throw new SettleForReview('receipt_missing');
  const userId = Number(deletions[0].user_id);
  const { rows: apps } = await pool.query(
    'SELECT id, slug, runtime_kind, runtime_name, self_hosted FROM apps WHERE id = $1', [appId]);
  // A deleted app's database was dropped with it (services/app-teardown.js).
  if (!apps.length || apps[0].self_hosted) return { outcome: 'gone' };
  const origin = applicationRuntime.appOrigin(config, applicationRuntime.productionRef(config, apps[0]));
  if (!origin) throw new Error('app_unreachable');
  const token = platformJwt.signAppUserDataToken({
    appId, userId, usernodePubkey, purpose: platformJwt.PUR_USER_DELETION,
  });
  let response;
  try {
    response = await fetchImpl(origin + DELETION_PATH, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: token },
      body: JSON.stringify({ userId, usernodePubkey: usernodePubkey || null }),
    });
  } catch {
    throw new Error('app_unreachable');
  }
  await response.body?.cancel?.().catch(() => {});
  const verdict = classify(response.status);
  if (verdict === 'ok') return { outcome: 'erased' };
  if (verdict === 'unsupported') throw new SettleForReview('app_unsupported');
  if (verdict === 'refused') throw new SettleForReview('app_refused');
  if (verdict === 'rejected') throw new SettleForReview('app_rejected');
  throw new Error('app_unavailable');
}

module.exports = {
  DELETION_PATH,
  EXPORT_PATH,
  TOKEN_HEADER,
  MAX_ATTEMPTS,
  SettleForReview,
  touchedAppIds,
  encodeTarget,
  decodeTarget,
  classify,
  requestDeletion,
};
