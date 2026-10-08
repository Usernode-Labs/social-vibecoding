'use strict';

// One-time patch uploads for connector work orders (#4264).
//
// submit_work takes a patch as a STRING the coding agent has to reproduce,
// character for character, inside a tool argument. In one session patches of
// 63 KB and 134 KB were retyped that way; in another (#4176) a single slip
// made the patch fail to apply and cost a whole round. The native proposal
// flow never had the problem: proposal_push_commit hands back a host command
// that uploads the local commit, and the platform rebuilds the exact tree.
//
// This is the same idea for a connector work order. prepare_work mints a
// credential bound to the ONE task it issued and prints, inside the work
// order, a curl command that pipes `git format-patch` straight to the route
// in routes/external-agent-patch-upload.js. The bytes are stored against the
// task, and submit_work takes the upload's id instead of `patch`; from there
// it is the inline patch path exactly, the same apply at the same recorded
// base and the same pull request.
//
// THE CREDENTIAL. The upload route has to work from a coding agent's sandbox,
// which holds no Homeroom session, so the token is the whole of its
// authentication. That is bounded on every side:
//
//   * 32 random bytes (256 bits), so it cannot be guessed; only its SHA-256
//     is stored, and it is compared in constant time;
//   * it is printed in the work order returned to the task's owner and
//     nowhere else: no structured field, no log line (log-redaction.js masks
//     the `svpu_` shape anyway);
//   * it is bound to one task: presented for any other task it matches
//     nothing;
//   * it does one thing: store a patch for that task. Submitting the upload
//     still takes the owner's own connector, and names the upload by id, so
//     a token that leaked cannot get anything submitted. The most it can do
//     is replace the stored upload, which changes its id, so the owner's
//     submission is then refused rather than sending bytes they did not send;
//   * it lapses after 24 hours, or sooner when the task expires, and stops
//     working the moment the task is submitted or closed.
//
// THE SANDBOX CAVEAT. Many hosted sandboxes cannot reach the Homeroom website
// at all (the work order says so), and for them this command simply fails. It
// is offered for the agents that CAN reach it, an agent on the user's own
// machine above all; the inline `patch` stays the way in for everyone else.

const crypto = require('crypto');
const log = require('./logger');
const { MAX_UPLOADED_PATCH_BYTES } = require('./external-agent-patch');

const TOKEN_PREFIX = 'svpu_';
const TOKEN_RE = /^svpu_[A-Za-z0-9_-]{43}$/;
const TOKEN_TTL_HOURS = 24;
// A work order can be rendered again for the same task (prepare_work asked
// twice for one request returns the job it already has), and each rendering
// carries its own command so a work order already pasted keeps working. This
// bounds how many are live for one task at once; the oldest goes first.
const MAX_LIVE_TOKENS_PER_TASK = 5;

// The path the work order prints; routes/external-agent-patch-upload.js
// answers on '/api/external-tasks/:taskId/patch'.
function uploadPath(taskId) {
  return `/api/external-tasks/${Number(taskId)}/patch`;
}

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function makeToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

function isCanonicalToken(value) {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

// `Authorization: Bearer svpu_…`, exactly. Anything else is not one of ours.
function tokenFromHeader(header) {
  const m = /^Bearer (svpu_[A-Za-z0-9_-]{43})$/.exec(String(header || '').trim());
  return m ? m[1] : null;
}

function taskIdOf(value) {
  const id = /^\d{1,18}$/.test(String(value || '')) ? Number(value) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Expired credentials a day past their expiry, and uploads whose task is no
// longer open. Cheap: both tables hold a handful of rows per live work order.
// The day's grace is what lets a late upload be told "expired" rather than
// "not recognised". Never fatal; the next call sweeps again.
async function sweep(pool) {
  try {
    await pool.query(
      `DELETE FROM external_agent_upload_tokens
        WHERE expires_at < NOW() - INTERVAL '1 day'`
    );
    await pool.query(
      `DELETE FROM external_agent_patch_uploads u
        USING external_agent_tasks t
        WHERE t.id = u.task_id
          AND (t.status <> 'open' OR t.expires_at < NOW())`
    );
  } catch (err) {
    log.warn('patch-upload', 'sweep failed (continuing)', { err: err.message });
  }
}

// Mint the credential for one task. Only an OPEN task of this user's that
// opens NEW work qualifies: an update submits a branch on this base, so an
// upload would have nowhere to go. Returns null when nothing was minted,
// which the caller treats as "print the work order without the command".
async function issueUploadCredential(pool, { taskId, userId, origin }) {
  const id = taskIdOf(taskId);
  let base;
  try {
    base = new URL(String(origin || '')).origin;
  } catch {
    base = null;
  }
  if (!id || !userId || !base || base === 'null') return null;
  await sweep(pool);
  const token = makeToken();
  const { rows } = await pool.query(
    `INSERT INTO external_agent_upload_tokens (task_id, token_hash, expires_at)
     SELECT t.id, $3, LEAST(NOW() + make_interval(hours => $4::int), t.expires_at)
       FROM external_agent_tasks t
      WHERE t.id = $1 AND t.user_id = $2 AND t.status = 'open'
        AND t.target_session_id IS NULL AND t.expires_at > NOW()
     RETURNING id, expires_at`,
    [id, userId, hashToken(token), TOKEN_TTL_HOURS]
  );
  const row = rows && rows[0];
  if (!row || !row.id) return null;
  await pool.query(
    `DELETE FROM external_agent_upload_tokens
      WHERE task_id = $1
        AND id NOT IN (
          SELECT id FROM external_agent_upload_tokens
           WHERE task_id = $1
           ORDER BY id DESC
           LIMIT $2)`,
    [id, MAX_LIVE_TOKENS_PER_TASK]
  );
  return {
    token,
    url: `${base}${uploadPath(id)}`,
    expiresAt: new Date(row.expires_at),
    maxBytes: MAX_UPLOADED_PATCH_BYTES,
  };
}

// Which credential, if any, this token is for THIS task. Every live row of the
// task is compared, in constant time and without stopping at a match, so the
// answer's timing says nothing about which row (or how much of a hash) fit.
// A token minted for another task matches nothing here.
//
// The refusals are told apart only for the holder of a matching token: to
// anybody else, an unknown task and a wrong token are the same answer.
async function authenticateUpload(pool, { taskId, token }) {
  const id = taskIdOf(taskId);
  if (!id || !isCanonicalToken(token)) {
    return fail('invalid_upload_token', 'That upload token is not valid for this task.', { status: 401 });
  }
  const { rows } = await pool.query(
    `SELECT k.id, k.token_hash, k.expires_at > NOW() AS live,
            t.user_id, t.status AS task_status, t.expires_at > NOW() AS task_live
       FROM external_agent_upload_tokens k
       JOIN external_agent_tasks t ON t.id = k.task_id
      WHERE k.task_id = $1`,
    [id]
  );
  const presented = Buffer.from(hashToken(token), 'hex');
  let match = null;
  for (const row of rows) {
    const stored = Buffer.from(String(row.token_hash || ''), 'hex');
    const same = stored.length === presented.length && crypto.timingSafeEqual(stored, presented);
    if (same && !match) match = row;
  }
  if (!match) {
    return fail('invalid_upload_token', 'That upload token is not valid for this task.', { status: 401 });
  }
  if (match.task_status !== 'open') {
    return fail(
      'task_closed',
      'This piece of work was already submitted or closed, so there is nothing to upload to.',
      { status: 409 }
    );
  }
  if (!match.live || !match.task_live) {
    return fail(
      'upload_token_expired',
      'This upload command has expired. Send the patch inline as `patch` in submit_work instead.',
      { status: 401 }
    );
  }
  return { ok: true, taskId: id, tokenId: Number(match.id), userId: Number(match.user_id) };
}

// A body that is plainly not a patch is refused here rather than at submit,
// where it would cost the agent a round. Mostly this is the agent that forgot
// to commit: `git format-patch` then prints nothing at all.
function checkPatchBody(body) {
  if (!Buffer.isBuffer(body) || !body.length || !body.toString('latin1').trim()) {
    return fail(
      'patch_empty',
      'Nothing was uploaded: the patch is empty. Commit your work first, then run the upload command again.',
      { status: 400 }
    );
  }
  if (body.length > MAX_UPLOADED_PATCH_BYTES) {
    return fail(
      'patch_too_large',
      `That patch is ${Math.round(body.length / 1024)} KB, over the ${Math.round(MAX_UPLOADED_PATCH_BYTES / 1024)} KB `
      + 'an upload can be. Push the branch to your fork instead and submit it with `branch`.',
      { status: 413, limitBytes: MAX_UPLOADED_PATCH_BYTES }
    );
  }
  const text = body.toString('latin1');
  if (!/^diff --git /m.test(text) && !/^\+\+\+ /m.test(text)) {
    return fail(
      'not_a_patch',
      'That does not look like a patch. Pipe the output of `git format-patch <base>..HEAD --stdout` into the '
      + 'upload command.',
      { status: 400 }
    );
  }
  return null;
}

// Store the patch for the task, replacing any earlier upload. The id changes
// on every upload, so a submission naming an older one is refused.
async function storeUpload(pool, { taskId, tokenId, body }) {
  const refused = checkPatchBody(body);
  if (refused) return refused;
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const { rows } = await pool.query(
    `INSERT INTO external_agent_patch_uploads (task_id, token_id, patch, bytes, sha256)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (task_id) DO UPDATE
       SET id = DEFAULT, token_id = EXCLUDED.token_id, patch = EXCLUDED.patch,
           bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256, uploaded_at = NOW()
     RETURNING id`,
    [taskId, tokenId, body, body.length, sha256]
  );
  const uploadId = rows && rows[0] ? Number(rows[0].id) : null;
  if (!uploadId) return fail('platform_unavailable', 'Homeroom could not store that patch. Try again shortly.', { status: 503 });
  return { ok: true, uploadId, taskId, bytes: body.length, sha256 };
}

// The upload a submission names, for the task it names, of the user making
// it. Every refusal says what to do instead.
async function loadUploadForSubmit(pool, { userId, taskId, uploadId }) {
  const id = Number(uploadId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return fail('invalid_request', 'patchUploadId must be the `uploadId` the upload command printed.');
  }
  const { rows } = await pool.query(
    `SELECT u.id, u.task_id, u.patch, u.bytes, u.sha256
       FROM external_agent_patch_uploads u
       JOIN external_agent_tasks t ON t.id = u.task_id
      WHERE u.id = $1 AND t.user_id = $2`,
    [id, userId]
  );
  const row = rows && rows[0];
  if (!row) {
    return fail(
      'patch_upload_not_found',
      `There is no upload ${id} for this task. If you uploaded more than once, only the newest upload counts: `
      + 'run the upload command from the work order again and submit the `uploadId` it prints, or send the '
      + 'patch inline as `patch`.'
    );
  }
  if (Number(row.task_id) !== Number(taskId)) {
    return fail(
      'patch_upload_wrong_task',
      `Upload ${id} was made for task ${Number(row.task_id)}, not task ${Number(taskId)}. Submit each patch with `
      + 'the taskId of the work order whose upload command sent it.'
    );
  }
  const patch = Buffer.isBuffer(row.patch) ? row.patch : Buffer.from(row.patch || '');
  return { ok: true, uploadId: id, patch, bytes: Number(row.bytes) || patch.length, sha256: row.sha256 };
}

// After a submission that used the upload: the patch and every credential for
// the task are done with. Never fatal; the sweep removes anything left over.
async function consumeUploads(pool, taskId) {
  try {
    await pool.query('DELETE FROM external_agent_patch_uploads WHERE task_id = $1', [taskId]);
    await pool.query('DELETE FROM external_agent_upload_tokens WHERE task_id = $1', [taskId]);
  } catch (err) {
    log.warn('patch-upload', 'cleanup after submit failed (continuing)', { taskId, err: err.message });
  }
}

module.exports = {
  TOKEN_PREFIX,
  TOKEN_TTL_HOURS,
  MAX_LIVE_TOKENS_PER_TASK,
  MAX_UPLOADED_PATCH_BYTES,
  uploadPath,
  makeToken,
  isCanonicalToken,
  hashToken,
  tokenFromHeader,
  taskIdOf,
  sweep,
  issueUploadCredential,
  authenticateUpload,
  checkPatchBody,
  storeUpload,
  loadUploadForSubmit,
  consumeUploads,
};
