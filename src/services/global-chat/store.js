'use strict';

const crypto = require('node:crypto');
const secrets = require('../secrets');

const MAX_MESSAGE_CHARS = 12_000;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_RESULT_IDS = 50;
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;
const MAX_THREAD_SUMMARY_CHARS = 1_800;
const SUMMARY_MESSAGE_LIMIT = 120;
const TURN_STALE_MS = 10 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MESSAGE_ROLES = new Set(['user', 'assistant']);

class GlobalChatStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GlobalChatStoreError';
    this.code = code;
  }
}

function userId(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new GlobalChatStoreError('invalid_user', 'A valid user is required.');
  }
  return result;
}

function uuid(value, field = 'id') {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new GlobalChatStoreError('invalid_id', `${field} must be a UUID.`);
  }
  return value;
}

function boundedText(value, { optional = false } = {}) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string' || value.length > MAX_MESSAGE_CHARS
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new GlobalChatStoreError('invalid_message', 'Message text is invalid or too long.');
  }
  return value;
}

function jsonValue(value, field, maxBytes = MAX_PAYLOAD_BYTES) {
  let json;
  try { json = JSON.stringify(value ?? {}); } catch { json = null; }
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > maxBytes) {
    throw new GlobalChatStoreError('invalid_payload', `${field} is invalid or too large.`);
  }
  return json;
}

function sealJson(value, dataKey, field = 'payload') {
  if (!dataKey) throw new GlobalChatStoreError('encryption_unavailable', 'Transcript encryption is unavailable.');
  const json = jsonValue(value, field, 1024 * 1024);
  return { version: 1, ciphertext: secrets.encrypt(json, dataKey) };
}

function openJson(value, dataKey, field = 'payload') {
  if (!value || value.version !== 1 || typeof value.ciphertext !== 'string') {
    throw new GlobalChatStoreError('invalid_payload', `${field} cannot be read.`);
  }
  const json = secrets.decrypt(value.ciphertext, dataKey);
  if (!json) throw new GlobalChatStoreError('invalid_payload', `${field} cannot be read.`);
  try { return JSON.parse(json); } catch {
    throw new GlobalChatStoreError('invalid_payload', `${field} cannot be read.`);
  }
}

function iso(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function threadShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    summary: row.summary || null,
    summaryCursor: row.summary_cursor == null ? null : String(row.summary_cursor),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function messageShape(row) {
  return {
    id: String(row.id),
    threadId: row.thread_id,
    role: row.role,
    text: row.plain_text || '',
    payload: row.structured_payload || {},
    promptVersion: row.prompt_version || null,
    model: row.model_id || null,
    reasoningEffort: row.reasoning_effort || null,
    createdAt: iso(row.created_at),
  };
}

function summaryText(value, max = 320) {
  const normalized = String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1).trimEnd()}…`;
}

function compactSummary(existing, messages) {
  const parts = [];
  const prior = summaryText(existing, MAX_THREAD_SUMMARY_CHARS);
  if (prior) parts.push(prior);
  for (const message of messages || []) {
    const presentation = message?.structured_payload?.presentation || message?.payload?.presentation;
    const content = message?.role === 'assistant'
      ? summaryText(presentation?.message || message?.plain_text || message?.text)
      : summaryText(message?.plain_text || message?.text);
    if (!content) continue;
    parts.push(`${message.role === 'assistant' ? 'Assistant' : 'User'}: ${content}`);
  }
  const joined = parts.join(' | ');
  if (joined.length <= MAX_THREAD_SUMMARY_CHARS) return joined;
  return `…${joined.slice(-(MAX_THREAD_SUMMARY_CHARS - 1))}`;
}

async function threadForUser(pool, requestedUserId, threadId) {
  const { rows } = await pool.query(
    `SELECT id, summary, summary_cursor, created_at, updated_at
       FROM global_chat_threads
      WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`,
    [uuid(threadId, 'thread id'), userId(requestedUserId)],
  );
  return threadShape(rows[0]);
}

async function currentThread(pool, requestedUserId) {
  const { rows } = await pool.query(
    `SELECT id, summary, summary_cursor, created_at, updated_at
       FROM global_chat_threads
      WHERE user_id = $1 AND archived_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId(requestedUserId)],
  );
  return threadShape(rows[0]);
}

async function createThread(pool, requestedUserId, { replace = false } = {}) {
  const owner = userId(requestedUserId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (replace) {
      await client.query(
        `UPDATE global_chat_threads
            SET archived_at = NOW(), active_turn_id = NULL, active_turn_started_at = NULL
          WHERE user_id = $1 AND archived_at IS NULL`,
        [owner],
      );
    }
    const id = crypto.randomUUID();
    const inserted = await client.query(
      `INSERT INTO global_chat_threads (id, user_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING id, summary, summary_cursor, created_at, updated_at`,
      [id, owner],
    );
    let row = inserted.rows[0];
    if (!row) {
      const existing = await client.query(
        `SELECT id, summary, summary_cursor, created_at, updated_at
           FROM global_chat_threads
          WHERE user_id = $1 AND archived_at IS NULL
          ORDER BY created_at DESC LIMIT 1`,
        [owner],
      );
      row = existing.rows[0];
    }
    await client.query('COMMIT');
    if (!row) throw new GlobalChatStoreError('thread_unavailable', 'Could not create a Global Chat thread.');
    return threadShape(row);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function ensureThread(pool, requestedUserId) {
  return (await currentThread(pool, requestedUserId)) || createThread(pool, requestedUserId);
}

async function deleteThread(pool, requestedUserId, threadId) {
  const result = await pool.query(
    `DELETE FROM global_chat_threads WHERE id = $1 AND user_id = $2`,
    [uuid(threadId, 'thread id'), userId(requestedUserId)],
  );
  return result.rowCount === 1;
}

function cursor(value) {
  if (value == null || value === '') return null;
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text)) {
    throw new GlobalChatStoreError('invalid_cursor', 'Message cursor is invalid.');
  }
  return text;
}

async function listMessages(pool, {
  userId: requestedUserId,
  threadId,
  before = null,
  limit = DEFAULT_PAGE_SIZE,
}) {
  const size = Math.max(1, Math.min(MAX_PAGE_SIZE, Number(limit) || DEFAULT_PAGE_SIZE));
  const { rows } = await pool.query(
    `SELECT m.id, m.thread_id, m.role, m.plain_text, m.structured_payload,
            m.prompt_version, m.model_id, m.reasoning_effort, m.created_at
       FROM global_chat_messages m
       JOIN global_chat_threads t ON t.id = m.thread_id
      WHERE t.id = $1 AND t.user_id = $2
        AND ($3::bigint IS NULL OR m.id < $3::bigint)
      ORDER BY m.id DESC
      LIMIT $4`,
    [uuid(threadId, 'thread id'), userId(requestedUserId), cursor(before), size + 1],
  );
  const hasMore = rows.length > size;
  const page = rows.slice(0, size).reverse().map(messageShape);
  return {
    messages: page,
    hasMore,
    before: hasMore && page.length ? page[0].id : null,
  };
}

// Keep the model prompt bounded without allowing a browser-authored summary
// into system metadata. Once more than the live transcript window exists,
// fold the immediately preceding messages into a short one-line recap. The
// oldest tail may be discarded on a first compaction of a very long thread;
// recent context is deliberately preferred and every subsequent turn advances
// the cursor incrementally.
async function compactThread(pool, {
  userId: requestedUserId,
  threadId,
  before,
}) {
  const owner = userId(requestedUserId);
  const ownedThreadId = uuid(threadId, 'thread id');
  const beforeCursor = cursor(before);
  if (!beforeCursor) throw new GlobalChatStoreError('invalid_cursor', 'Summary boundary is required.');
  const current = await threadForUser(pool, owner, ownedThreadId);
  if (!current) throw new GlobalChatStoreError('thread_not_found', 'That Global Chat thread is unavailable.');
  const { rows } = await pool.query(
    `SELECT m.id, m.role, m.plain_text, m.structured_payload
       FROM global_chat_messages m
      WHERE m.thread_id = $1 AND m.id < $2::bigint
        AND ($3::bigint IS NULL OR m.id > $3::bigint)
      ORDER BY m.id DESC
      LIMIT $4`,
    [ownedThreadId, beforeCursor, current.summaryCursor, SUMMARY_MESSAGE_LIMIT],
  );
  if (!rows.length) return current;
  const chronological = rows.reverse();
  const summary = compactSummary(current.summary, chronological);
  const summaryCursor = String(chronological.at(-1).id);
  const updated = await pool.query(
    `UPDATE global_chat_threads
        SET summary = $3, summary_cursor = $4::bigint, updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND archived_at IS NULL
        AND (summary_cursor IS NULL OR summary_cursor < $4::bigint)
      RETURNING id, summary, summary_cursor, created_at, updated_at`,
    [ownedThreadId, owner, summary, summaryCursor],
  );
  return threadShape(updated.rows[0]) || threadForUser(pool, owner, ownedThreadId);
}

async function insertMessage(pool, {
  userId: requestedUserId,
  threadId,
  role,
  text = '',
  payload = {},
  promptVersion = null,
  model = null,
  reasoningEffort = null,
}) {
  if (!MESSAGE_ROLES.has(role)) throw new GlobalChatStoreError('invalid_message', 'Invalid message role.');
  const { rows } = await pool.query(
    `INSERT INTO global_chat_messages
       (thread_id, role, plain_text, structured_payload, prompt_version, model_id, reasoning_effort)
     SELECT t.id, $3, $4, $5::jsonb, $6, $7, $8
       FROM global_chat_threads t
      WHERE t.id = $1 AND t.user_id = $2 AND t.archived_at IS NULL
     RETURNING id, thread_id, role, plain_text, structured_payload,
               prompt_version, model_id, reasoning_effort, created_at`,
    [
      uuid(threadId, 'thread id'),
      userId(requestedUserId),
      role,
      boundedText(text, { optional: true }),
      jsonValue(payload, 'message payload'),
      promptVersion,
      model,
      reasoningEffort,
    ],
  );
  if (!rows[0]) throw new GlobalChatStoreError('thread_not_found', 'That Global Chat thread is unavailable.');
  await pool.query(
    'UPDATE global_chat_threads SET updated_at = NOW() WHERE id = $1 AND user_id = $2',
    [threadId, requestedUserId],
  );
  return messageShape(rows[0]);
}

async function claimTurn(pool, {
  userId: requestedUserId,
  threadId,
  turnId = crypto.randomUUID(),
  now = new Date(),
}) {
  const started = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(started.valueOf())) throw new GlobalChatStoreError('invalid_turn', 'Invalid turn time.');
  const staleBefore = new Date(started.valueOf() - TURN_STALE_MS);
  const { rows } = await pool.query(
    `UPDATE global_chat_threads
        SET active_turn_id = $3, active_turn_started_at = $4, updated_at = $4
      WHERE id = $1 AND user_id = $2 AND archived_at IS NULL
        AND (active_turn_id IS NULL OR active_turn_started_at < $5)
      RETURNING active_turn_id`,
    [uuid(threadId, 'thread id'), userId(requestedUserId), uuid(turnId, 'turn id'), started, staleBefore],
  );
  if (!rows.length) throw new GlobalChatStoreError('turn_in_progress', 'Another Global Chat turn is already running.');
  return turnId;
}

async function releaseTurn(pool, { userId: requestedUserId, threadId, turnId }) {
  const result = await pool.query(
    `UPDATE global_chat_threads
        SET active_turn_id = NULL, active_turn_started_at = NULL, updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND active_turn_id = $3`,
    [uuid(threadId, 'thread id'), userId(requestedUserId), uuid(turnId, 'turn id')],
  );
  return result.rowCount === 1;
}

async function turnState(pool, { userId: requestedUserId, threadId }) {
  const { rows } = await pool.query(
    `SELECT active_turn_id, active_turn_started_at
       FROM global_chat_threads
      WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`,
    [uuid(threadId, 'thread id'), userId(requestedUserId)],
  );
  if (!rows[0]) throw new GlobalChatStoreError('thread_not_found', 'That Global Chat thread is unavailable.');
  return {
    active: !!rows[0].active_turn_id,
    turnId: rows[0].active_turn_id || null,
    startedAt: iso(rows[0].active_turn_started_at),
  };
}

async function startToolRun(pool, {
  userId: requestedUserId,
  threadId,
  messageId = null,
  capabilityId,
  input,
  dataKey,
}) {
  const id = crypto.randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO global_chat_tool_runs
       (id, thread_id, message_id, capability_id, normalized_input)
     SELECT $1, t.id, $4, $5, $6::jsonb
       FROM global_chat_threads t
      WHERE t.id = $2 AND t.user_id = $3 AND t.archived_at IS NULL
     RETURNING id`,
    [
      id,
      uuid(threadId, 'thread id'),
      userId(requestedUserId),
      messageId,
      String(capabilityId),
      JSON.stringify(sealJson(input, dataKey, 'tool input')),
    ],
  );
  if (!rows.length) throw new GlobalChatStoreError('thread_not_found', 'That Global Chat thread is unavailable.');
  return id;
}

async function finishToolRun(pool, {
  userId: requestedUserId,
  toolRunId,
  modelResult = null,
  authoritativeResult = null,
  renderer = null,
  classicPath = null,
  status = 'completed',
  durationMs = null,
  dataKey,
}) {
  if (!['completed', 'failed'].includes(status)) {
    throw new GlobalChatStoreError('invalid_tool_run', 'Invalid tool-run status.');
  }
  const duration = durationMs == null ? null : Math.max(0, Math.round(Number(durationMs) || 0));
  const result = await pool.query(
    `UPDATE global_chat_tool_runs r
        SET bounded_model_result = $3::jsonb,
            authoritative_result = $4::jsonb,
            renderer = $5,
            classic_path = $6,
            status = $7,
            duration_ms = $8,
            completed_at = NOW()
       FROM global_chat_threads t
      WHERE r.id = $1 AND r.thread_id = t.id AND t.user_id = $2
        AND r.status = 'pending'
      RETURNING r.id`,
    [
      uuid(toolRunId, 'tool run id'),
      userId(requestedUserId),
      modelResult == null ? null : jsonValue(modelResult, 'model result'),
      authoritativeResult == null
        ? null
        : JSON.stringify(sealJson(authoritativeResult, dataKey, 'authoritative result')),
      renderer,
      classicPath,
      status,
      duration,
    ],
  );
  return result.rowCount === 1;
}

async function loadToolResults(pool, {
  userId: requestedUserId,
  threadId,
  resultIds,
  dataKey,
}) {
  if (!Array.isArray(resultIds) || resultIds.length > MAX_RESULT_IDS) {
    throw new GlobalChatStoreError('invalid_result_ids', 'Too many result ids.');
  }
  const ids = [...new Set(resultIds.map((id) => uuid(id, 'result id')))];
  if (!ids.length) return [];
  const { rows } = await pool.query(
    `SELECT r.id, r.capability_id, r.bounded_model_result, r.authoritative_result,
            r.renderer, r.classic_path, r.status, r.created_at, r.completed_at
       FROM global_chat_tool_runs r
       JOIN global_chat_threads t ON t.id = r.thread_id
      WHERE r.thread_id = $1 AND t.user_id = $2 AND r.id = ANY($3::uuid[])
      ORDER BY r.created_at ASC`,
    [uuid(threadId, 'thread id'), userId(requestedUserId), ids],
  );
  return rows.map((row) => ({
    id: row.id,
    capabilityId: row.capability_id,
    modelResult: row.bounded_model_result,
    authoritativeResult: row.authoritative_result == null
      ? null
      : openJson(row.authoritative_result, dataKey, 'authoritative result'),
    renderer: row.renderer,
    classicPath: row.classic_path,
    status: row.status,
    createdAt: iso(row.created_at),
    completedAt: iso(row.completed_at),
  }));
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_MESSAGE_CHARS,
  MAX_PAGE_SIZE,
  MAX_PAYLOAD_BYTES,
  MAX_THREAD_SUMMARY_CHARS,
  SUMMARY_MESSAGE_LIMIT,
  TURN_STALE_MS,
  GlobalChatStoreError,
  claimTurn,
  compactSummary,
  compactThread,
  createThread,
  currentThread,
  deleteThread,
  ensureThread,
  finishToolRun,
  insertMessage,
  listMessages,
  loadToolResults,
  messageShape,
  openJson,
  releaseTurn,
  sealJson,
  startToolRun,
  threadForUser,
  threadShape,
  turnState,
};
