'use strict';

// Threads, stage 6 of #6019: moving work between threads. Any member may
// propose merging a thread into another about the same piece of work, or
// splitting an item out of one. Who decides (the plan's table):
//
//   - every requester of what it moves agrees: it happens at once (most
//     often the one proposing is the only requester);
//   - nobody objects for 24 hours: it happens then (the `thread-moves`
//     clock job, sweep below);
//   - anybody objects: it goes to the project's vote, as a governance row
//     of kind `thread_move` that the governance machine applies like any
//     other decision (applyKind), and refuses when the vote does.
//
// What a move does to the rows is src/workflow/rules/thread-moves.ts, which
// both the sweep and the machine call. Each step says so in the thread, as
// a line in its lead's discussion (a thread's own activity, never a
// channel's).

const log = require('./logger');
const threads = require('./threads');
const rules = require('../workflow/rules/thread-moves.ts');

const WINDOW_MS = 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 50;

// The anchor a thread's own lines go to: its lead request's discussion, or
// its lead change's.
async function leadAnchor(db, thread) {
  if (!thread || !(Number(thread.number) > 0)) return null;
  const { rows: [change] } = await db.query(
    'SELECT id FROM chat_sessions WHERE thread_id = $1 AND pr_number = $2 ORDER BY id DESC LIMIT 1',
    [thread.id, thread.number]
  );
  return change ? { type: 'session', ref: Number(change.id) } : { type: 'issue', ref: Number(thread.number) };
}

async function say(pool, { appId, thread, text, deps = {} }) {
  try {
    const anchor = await leadAnchor(pool, thread);
    if (!anchor) return;
    await (deps.ws || require('./ws')).sendSystemMessage(pool, appId, text, 'system', null, anchor);
  } catch (err) {
    log.warn('thread-moves', 'Could not say what a move did', { err: err.message });
  }
}

/** The people who asked for any request in `threadIds`: whose agreement a move needs. */
async function requestersOf(db, threadIds) {
  const { rows } = await db.query(
    `SELECT r.created_by AS user_id FROM requests r
      WHERE r.thread_id = ANY($1::bigint[]) AND r.created_by IS NOT NULL
     UNION
     SELECT i.created_by FROM issues i
      WHERE i.thread_id = ANY($1::bigint[]) AND i.kind = 'general' AND i.created_by IS NOT NULL
     UNION
     SELECT b.user_id FROM homeroom_bot_requesters b
       JOIN requests r ON r.app_id = b.app_id AND r.number = b.issue_number
      WHERE r.thread_id = ANY($1::bigint[])`,
    [threadIds.map(Number)]
  );
  return [...new Set(rows.map((r) => Number(r.user_id)))].filter(Number.isInteger);
}

/** A thread's lead item, which a split cannot take out: it is what the thread is. */
function isLead(thread, item) {
  const n = Number(thread.number);
  return n > 0 && ((item.type === 'request' && Number(item.number) === n) || (item.type === 'change' && Number(item.prNumber) === n));
}

// What a split may take: items of the thread, the lead excepted, and not
// all of what it holds.
async function splitItems(db, { thread, items }) {
  const page = await threads.threadPage(db, { thread });
  const held = page.items;
  const picked = [];
  for (const raw of Array.isArray(items) ? items.slice(0, 20) : []) {
    const type = raw && raw.type;
    const found = type === 'request'
      ? held.find((i) => i.type === 'request' && i.number === Number(raw.number))
      : held.find((i) => i.type === type && i.id === Number(raw.id));
    if (!found) return { error: 'One of those is not in this thread.' };
    const item = type === 'request' ? { type, number: found.number } : { type, id: found.id, prNumber: found.number };
    if (isLead(thread, item)) return { error: 'The thread\'s own lead stays: split the others out, or merge it elsewhere.' };
    picked.push(item.type === 'change' ? { type, id: item.id } : item);
  }
  if (!picked.length) return { error: 'Choose what to split out.' };
  if (picked.length >= held.length) return { error: 'That is everything in the thread.' };
  return { items: picked };
}

// Break-up (#6019 follow-up): a big request into at most this many smaller
// ones, each a title and what it is done when.
const MAX_PARTS = 6;

/** Pure: a break-up's parts, cleaned, or an error. */
function partsOf(parts) {
  const list = (Array.isArray(parts) ? parts : [])
    .map((p) => ({
      title: String(p?.title || '').trim().slice(0, 120),
      doneWhen: String(p?.doneWhen || '').trim().slice(0, 600),
    }))
    .filter((p) => p.title);
  if (list.length < 2) return { error: 'Break it into at least two smaller requests, each with a title.' };
  if (list.length > MAX_PARTS) return { error: `Break it into at most ${MAX_PARTS} smaller requests.` };
  return { parts: list };
}

/**
 * Propose a move of `thread` (in `app`): `{ kind: 'merge', into }` (another
 * thread's number), `{ kind: 'split', items }`, or `{ kind: 'breakup',
 * request, parts }` (a request of the thread into smaller ones in it).
 * Resolves { ok, move } or { ok: false, status, error }.
 */
async function propose(pool, { app, user, thread, kind, into = null, items = null, request = null, parts = null, deps = {} }) {
  if (!thread || Number(thread.app_id) !== Number(app.id)) return { ok: false, status: 404, error: 'Thread not found' };
  if (thread.state !== 'open' || thread.merged_into) return { ok: false, status: 409, error: 'That thread is closed.' };
  if (thread.kind === 'decision') return { ok: false, status: 409, error: 'A decision is decided by its own vote, and stays its own thread.' };
  let input;
  let touched = [Number(thread.id)];
  let words;
  if (kind === 'merge') {
    const target = await threads.threadForNumber(pool, { appId: app.id, number: Number(into) });
    if (!target) return { ok: false, status: 404, error: `${app.name || app.slug} has no request or change #${into}.` };
    if (Number(target.id) === Number(thread.id)) return { ok: false, status: 409, error: 'That is this thread.' };
    if (target.kind === 'decision' || target.state !== 'open') {
      return { ok: false, status: 409, error: 'That thread is closed, or is a decision of its own.' };
    }
    input = { into: Number(target.id), intoNumber: Number(target.number) || null };
    touched = [Number(thread.id), Number(target.id)];
    words = `merge this thread into #${target.number}`;
  } else if (kind === 'split') {
    const picked = await splitItems(pool, { thread, items });
    if (picked.error) return { ok: false, status: 422, error: picked.error };
    input = { items: picked.items };
    words = `split ${picked.items.map((i) => (i.type === 'request' ? `#${i.number}` : i.type)).join(', ')} out of this thread`;
  } else if (kind === 'breakup') {
    const big = Number(request) || Number(thread.number);
    const { rows: [req] } = await pool.query(
      `SELECT number, state, part_of FROM requests WHERE app_id = $1 AND number = $2 AND thread_id = $3`,
      [app.id, big, thread.id]
    );
    if (!req || req.state !== 'open') return { ok: false, status: 409, error: `#${big} is not an open request in this thread.` };
    if (req.part_of) return { ok: false, status: 409, error: `#${big} is already a part of #${req.part_of}.` };
    const cleaned = partsOf(parts);
    if (cleaned.error) return { ok: false, status: 422, error: cleaned.error };
    input = { request: big, parts: cleaned.parts };
    words = `break #${big} up into ${cleaned.parts.length} smaller requests`;
  } else {
    return { ok: false, status: 422, error: 'A move is a merge, a split or a break-up.' };
  }
  const requesters = await requestersOf(pool, touched);
  const agreed = requesters.includes(Number(user.id)) ? [Number(user.id)] : [];
  let move;
  try {
    ({ rows: [move] } = await pool.query(
      `INSERT INTO thread_moves (app_id, thread_id, kind, input, proposed_by, deadline, agreed_by)
       VALUES ($1, $2, $3, $4, $5, NOW() + make_interval(secs => $6), $7::int[]) RETURNING *`,
      [app.id, thread.id, kind, JSON.stringify(input), user.id, WINDOW_MS / 1000, agreed]
    ));
  } catch (err) {
    if (err.code === '23505') return { ok: false, status: 409, error: 'A move of this thread is already waiting.' };
    throw err;
  }
  await say(pool, { appId: app.id, thread, deps,
    text: `${user.username} proposed to ${words}. It happens in 24 hours unless someone objects.` });
  // Everybody whose agreement it needs agreed already: it happens now.
  if (requesters.every((id) => agreed.includes(id))) {
    await decide(pool, { move, thread, appId: app.id, deps, why: 'agreed' });
    ({ rows: [move] } = await pool.query('SELECT * FROM thread_moves WHERE id = $1', [move.id]));
  }
  return { ok: true, move: shape(move) };
}

/** A move as the thread page draws it. */
function shape(move) {
  return {
    id: Number(move.id),
    kind: move.kind,
    state: move.state,
    input: move.input || {},
    deadline: move.deadline,
    agreed: (move.agreed_by || []).map(Number),
    governanceId: move.governance_issue_id == null ? null : Number(move.governance_issue_id),
  };
}

async function moveFor(pool, { app, moveId }) {
  const { rows: [move] } = await pool.query('SELECT * FROM thread_moves WHERE id = $1 AND app_id = $2', [Number(moveId), app.id]);
  return move || null;
}

/**
 * A break-up that was applied (workflow/rules/thread-moves.ts) files its
 * parts here, once: each a request in the same thread, numbered from the
 * app's one sequence, by whoever proposed the move, `part_of` the big
 * request (which closes with the last of them, services/requests.js
 * close). Locked and marked (`input.filed`) in one transaction, so two
 * processes file it once. Resolves the numbers filed, or null when it was
 * filed already or is not one.
 */
async function fileBreakup(pool, moveId) {
  const appNumbers = require('./app-numbers');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [move] } = await client.query(
      `SELECT * FROM thread_moves WHERE id = $1 AND kind = 'breakup' AND state = 'applied'
          AND NOT (input ? 'filed') FOR UPDATE SKIP LOCKED`,
      [Number(moveId)]
    );
    if (!move) { await client.query('ROLLBACK'); return null; }
    const big = Number(move.input.request);
    const filed = [];
    for (const part of (move.input.parts || []).slice(0, MAX_PARTS)) {
      const title = String(part?.title || '').trim().slice(0, 512);
      if (!title) continue;
      const number = await appNumbers.next(Number(move.app_id), { db: client });
      const doneWhen = String(part?.doneWhen || '').trim();
      await client.query(
        `INSERT INTO requests (app_id, number, title, body, created_by, source, thread_id, part_of)
         VALUES ($1, $2, $3, $4, $5, 'homeroom', $6, $7)`,
        [Number(move.app_id), number, title, doneWhen ? `Done when: ${doneWhen}\n\nPart of #${big}.` : `Part of #${big}.`,
          move.proposed_by == null ? null : Number(move.proposed_by), Number(move.thread_id), big]
      );
      filed.push(number);
    }
    await client.query(
      `UPDATE thread_moves SET input = input || jsonb_build_object('filed', $2::jsonb) WHERE id = $1`,
      [move.id, JSON.stringify(filed)]
    );
    await client.query('COMMIT');
    return filed;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Apply it, in a transaction of its own, and say so.
async function decide(pool, { move, thread = null, appId, deps = {}, why }) {
  const client = await pool.connect();
  let result = null;
  try {
    await client.query('BEGIN');
    result = await rules.applyMove(client, move.id);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (result == null) return null;
  const into = await threads.threadById(pool, result);
  const because = why === 'agreed' ? ', as everyone who asked agreed' : ', as nobody objected';
  let text;
  if (move.kind === 'breakup') {
    const filed = (await fileBreakup(pool, move.id)) || [];
    text = `Broken up into ${filed.map((n) => `#${n}`).join(', ')}${because}. #${move.input.request} closes with the last of them.`;
  } else {
    text = move.kind === 'merge'
      ? `Merged into #${into?.number ?? '?'}${because}.`
      : `Split out into #${into?.number ?? '?'}${because}.`;
  }
  await say(pool, { appId, thread: thread || (await threads.threadById(pool, move.thread_id)), deps, text });
  if (into && move.kind !== 'breakup') await say(pool, { appId, thread: into, deps, text });
  log.info('thread-moves', 'Applied a thread move', { moveId: Number(move.id), kind: move.kind, why });
  return result;
}

/** A requester agrees; when all of them have, it happens now. */
async function agree(pool, { app, user, moveId, deps = {} }) {
  const move = await moveFor(pool, { app, moveId });
  if (!move) return { ok: false, status: 404, error: 'No such move' };
  if (move.state !== 'pending') return { ok: false, status: 409, error: 'That move is decided, or is up for a vote.' };
  const touched = move.kind === 'merge' ? [move.thread_id, move.input.into] : [move.thread_id];
  const requesters = await requestersOf(pool, touched);
  if (!requesters.includes(Number(user.id))) return { ok: false, status: 403, error: 'Only someone who asked for what it moves can agree to it.' };
  const { rows: [now] } = await pool.query(
    `UPDATE thread_moves SET agreed_by = (SELECT ARRAY(SELECT DISTINCT unnest(agreed_by || $2::int)))
      WHERE id = $1 AND state = 'pending' RETURNING *`,
    [move.id, Number(user.id)]
  );
  if (now && requesters.every((id) => (now.agreed_by || []).map(Number).includes(id))) {
    await decide(pool, { move: now, appId: app.id, deps, why: 'agreed' });
  }
  const { rows: [after] } = await pool.query('SELECT * FROM thread_moves WHERE id = $1', [move.id]);
  return { ok: true, move: shape(after) };
}

/**
 * Anybody objects: the move goes to the project's vote, a governance row of
 * kind `thread_move` filed into the governance machine.
 */
async function object(pool, { app, user, moveId, reason = null, deps = {} }) {
  const move = await moveFor(pool, { app, moveId });
  if (!move) return { ok: false, status: 404, error: 'No such move' };
  if (move.state !== 'pending') return { ok: false, status: 409, error: 'That move is decided, or is up for a vote already.' };
  const thread = await threads.threadById(pool, move.thread_id);
  const what = move.kind === 'merge'
    ? `Merge #${thread?.number ?? '?'} into #${move.input.intoNumber ?? '?'}`
    : move.kind === 'breakup'
    ? `Break #${move.input.request ?? '?'} up into ${(move.input.parts || []).length} smaller requests`
    : `Split ${(move.input.items || []).map((i) => (i.type === 'request' ? `#${i.number}` : i.type)).join(', ')} out of #${thread?.number ?? '?'}`;
  const payload = { moveId: Number(move.id), kind: move.kind, threadNumber: thread?.number ?? null, intoNumber: move.input.intoNumber ?? null };
  const { rows: [claimed] } = await pool.query(
    `UPDATE thread_moves SET state = 'voting', objected_by = $2 WHERE id = $1 AND state = 'pending' RETURNING id`,
    [move.id, user.id]
  );
  if (!claimed) return { ok: false, status: 409, error: 'That move was just decided.' };
  const { rows: [row] } = await pool.query(
    `INSERT INTO issues (app_id, github_issue_number, title, description, kind, payload, created_by)
     VALUES ($1, NULL, $2, $3, 'thread_move', $4, $5) RETURNING id`,
    [app.id, what.slice(0, 512), reason ? String(reason).slice(0, 600) : null, JSON.stringify(payload), user.id]
  );
  await pool.query('UPDATE thread_moves SET governance_issue_id = $2 WHERE id = $1', [move.id, row.id]);
  try {
    await (deps.workflow || require('../workflow/platform.ts')).fileProposal(Number(row.id), app.id);
  } catch (err) {
    // The next vote, or the boot backfill, files it (routes/issues.js).
    log.warn('thread-moves', 'Filing the move\'s vote failed', { issueId: row.id, err: err.message });
  }
  await say(pool, { appId: app.id, thread, deps, text: `${user.username} objected, so it goes to a vote.` });
  const { rows: [after] } = await pool.query('SELECT * FROM thread_moves WHERE id = $1', [move.id]);
  return { ok: true, move: shape(after) };
}

/** The open moves of a thread, for its page. */
async function openMoves(pool, { threadId }) {
  const { rows } = await pool.query(
    `SELECT * FROM thread_moves WHERE thread_id = $1 AND state IN ('pending', 'voting') ORDER BY id`,
    [threadId]
  );
  return rows.map(shape);
}

/**
 * The clock job: moves whose 24 hours passed with nobody objecting happen,
 * and a move whose vote ended without applying it is refused.
 */
async function sweep(pool, { deps = {} } = {}) {
  const { rows: due } = await pool.query(
    `SELECT * FROM thread_moves WHERE state = 'pending' AND deadline <= NOW() ORDER BY deadline LIMIT $1`,
    [SWEEP_BATCH]
  );
  let applied = 0;
  for (const move of due) {
    try {
      if (await decide(pool, { move, appId: move.app_id, deps, why: 'quiet' }) != null) applied += 1;
    } catch (err) {
      log.warn('thread-moves', 'A due move could not be applied', { moveId: Number(move.id), err: err.message });
    }
  }
  // A break-up the project's vote applied (the governance machine) files its
  // parts here, on the next sweep.
  const { rows: unfiled } = await pool.query(
    `SELECT id, app_id, thread_id, input FROM thread_moves
      WHERE kind = 'breakup' AND state = 'applied' AND NOT (input ? 'filed') ORDER BY id LIMIT $1`,
    [SWEEP_BATCH]
  );
  for (const move of unfiled) {
    try {
      const filed = await fileBreakup(pool, move.id);
      if (filed && filed.length) {
        await say(pool, { appId: move.app_id, thread: await threads.threadById(pool, move.thread_id), deps,
          text: `Broken up into ${filed.map((n) => `#${n}`).join(', ')}, as the vote decided. #${move.input.request} closes with the last of them.` });
      }
    } catch (err) {
      log.warn('thread-moves', 'A break-up\'s parts could not be filed', { moveId: Number(move.id), err: err.message });
    }
  }
  const { rowCount: refused } = await pool.query(
    `UPDATE thread_moves m SET state = 'refused', decided_at = NOW()
       FROM issues i
      WHERE m.state = 'voting' AND i.id = m.governance_issue_id AND i.status <> 'open'
        AND i.payload->>'appliedAt' IS NULL`
  );
  return { applied, refused: refused || 0 };
}

module.exports = {
  MAX_PARTS,
  partsOf,
  fileBreakup, WINDOW_MS, propose, agree, object, openMoves, sweep, requestersOf, shape };
