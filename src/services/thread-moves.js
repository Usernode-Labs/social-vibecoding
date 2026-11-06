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
const { planRecordSql } = require('./request-specs');

const WINDOW_MS = 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 50;
// A consent question never expires (#6421). Its deadline is only a
// placeholder: `sweep` never applies a row that has `for_session_id`.
const CONSENT_DEADLINE_DAYS = 3650;

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
function shape(move, extra = null) {
  const out = {
    id: Number(move.id),
    kind: move.kind,
    state: move.state,
    input: move.input || {},
    deadline: move.deadline,
    agreed: (move.agreed_by || []).map(Number),
    governanceId: move.governance_issue_id == null ? null : Number(move.governance_issue_id),
  };
  // #6421: a consent move names the change it gathers a request into. It is
  // a row of its own, asked once, answered by the request's other askers.
  const forChange = move.input && move.input.forChange;
  if (forChange) out.forChange = { id: Number(forChange.id) || null, number: Number(forChange.number) || null };
  if (extra) {
    out.askOf = extra.askOf || [];
    out.canAnswer = !!extra.canAnswer;
  }
  return out;
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
  const because = why === 'agreed' || why === 'consent' ? ', as everyone who asked agreed'
    : why === 'author' ? ', as its author asked for it'
      : ', as nobody objected';
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
  if (move.for_session_id != null) return { ok: false, status: 409, error: 'That one is answered with Yes or Keep separate.' };
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
  if (move.for_session_id != null) return { ok: false, status: 409, error: 'That one is answered with Yes or Keep separate.' };
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
async function openMoves(pool, { threadId, viewerId = null }) {
  const { rows } = await pool.query(
    `SELECT * FROM thread_moves WHERE thread_id = $1 AND state IN ('pending', 'voting') ORDER BY id`,
    [threadId]
  );
  const out = [];
  for (const move of rows) {
    if (move.for_session_id == null) { out.push(shape(move)); continue; }
    // #6421: who still has to answer, and whether the viewer is one of them.
    const author = Number(move.input && move.input.author) || null;
    const requesters = await requestersOf(pool, [Number(move.thread_id)]);
    const asked = requesters.filter((id) => id !== author);
    const agreed = (move.agreed_by || []).map(Number);
    const pending = asked.filter((id) => !agreed.includes(id));
    const names = pending.length
      ? (await pool.query('SELECT username FROM users WHERE id = ANY($1::int[]) ORDER BY username', [pending])).rows.map((r) => r.username)
      : [];
    out.push(shape(move, {
      askOf: names,
      canAnswer: viewerId != null && asked.includes(Number(viewerId)),
    }));
  }
  return out;
}

/**
 * #6421: the requesters of one request (its asker, and Homeroom bot's own
 * record of who asked it). Used for the person a bot-built change speaks for.
 */
async function requestersOfRequest(db, { threadId, number }) {
  const { rows } = await db.query(
    `SELECT r.created_by AS user_id FROM requests r
      WHERE r.thread_id = $1 AND r.number = $2 AND r.created_by IS NOT NULL
     UNION
     SELECT b.user_id FROM homeroom_bot_requesters b
       JOIN requests r ON r.app_id = b.app_id AND r.number = b.issue_number
      WHERE r.thread_id = $1 AND r.number = $2`,
    [Number(threadId), Number(number)]
  );
  return [...new Set(rows.map((r) => Number(r.user_id)))].filter(Number.isInteger);
}

const CHANGE_IN_PLAY = new Set(['active', 'paused', 'promoted', 'merging']);

/**
 * #6421 (threads that hold several requests, step 3): a change that closes
 * requests sitting in other threads gathers each of those threads into its
 * own. A thread moves at once when the change's author asked for every
 * request in it; otherwise each of the thread's other requesters is asked on
 * the request's page (consent below), and nothing moves until all say Yes.
 * Asked once per change and thread, whatever the answer.
 */
async function gather(pool, { deps = {}, batch = SWEEP_BATCH } = {}) {
  // A question the change no longer asks refuses itself: it closed, was
  // archived, or stopped linking the request. Nothing is said for it.
  const { rows: pending } = await pool.query(
    `SELECT m.*, cs.status AS change_status, cs.linked_issues
       FROM thread_moves m JOIN chat_sessions cs ON cs.id = m.for_session_id
      WHERE m.for_session_id IS NOT NULL AND m.state = 'pending'`
  );
  for (const move of pending) {
    const linked = (move.linked_issues || []).map(Number);
    const wanted = (move.input && Array.isArray(move.input.requests) ? move.input.requests : []).map(Number);
    if (!CHANGE_IN_PLAY.has(move.change_status) || !wanted.some((n) => linked.includes(n))) {
      await pool.query(
        `UPDATE thread_moves SET state = 'refused', decided_at = NOW() WHERE id = $1 AND state = 'pending'`,
        [move.id]
      );
    }
  }
  const { rows: changes } = await pool.query(
    `SELECT cs.id, cs.app_id, cs.pr_number, cs.thread_id, cs.user_id, cs.linked_issues
       FROM chat_sessions cs
      WHERE cs.is_headless = FALSE
        AND cs.status IN ('active', 'paused', 'promoted', 'merging')
        AND cs.thread_id IS NOT NULL
        AND cardinality(COALESCE(cs.linked_issues, '{}'::int[])) > 0
        AND NOT ${planRecordSql('cs')}
        AND ${threads.visibleChangeSql('cs', '0')}
      ORDER BY cs.id
      LIMIT $1`,
    [batch]
  );
  let opened = 0;
  for (const change of changes) {
    const target = await threads.threadById(pool, change.thread_id);
    if (!target || target.state !== 'open' || target.kind === 'decision') continue;
    const numbers = (change.linked_issues || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!numbers.length) continue;
    const { rows: reqs } = await pool.query(
      `SELECT r.number, r.thread_id FROM requests r
        WHERE r.app_id = $1 AND r.number = ANY($2::int[]) AND r.state = 'open'
          AND r.thread_id IS NOT NULL AND r.thread_id <> $3`,
      [change.app_id, numbers, Number(change.thread_id)]
    );
    const byThread = new Map();
    for (const r of reqs) {
      const id = Number(r.thread_id);
      if (!byThread.has(id)) byThread.set(id, []);
      byThread.get(id).push(Number(r.number));
    }
    // The person the change speaks for: its author; for a bot-built change,
    // whoever asked for the request whose thread it lives in.
    let author = change.user_id == null ? null : Number(change.user_id);
    if (author != null) {
      const { rows: [who] } = await pool.query('SELECT is_synthetic FROM users WHERE id = $1', [author]);
      if (who && who.is_synthetic && target.number != null) {
        const lead = await requestersOfRequest(pool, { threadId: target.id, number: target.number });
        if (lead.length) author = lead[0];
      }
    }
    for (const [threadId, reqNumbers] of byThread) {
      const source = await threads.threadById(pool, threadId);
      if (!source || source.state !== 'open' || source.kind === 'decision') continue;
      if (Number(source.id) === Number(target.id)) continue;
      const { rows: [askedBefore] } = await pool.query(
        'SELECT 1 FROM thread_moves WHERE thread_id = $1 AND for_session_id = $2 LIMIT 1',
        [Number(source.id), Number(change.id)]
      );
      if (askedBefore) continue;
      const requesters = await requestersOf(pool, [Number(source.id)]);
      const others = requesters.filter((id) => id !== author);
      const input = {
        into: Number(target.id),
        intoNumber: target.number == null ? null : Number(target.number),
        forChange: { id: Number(change.id), number: change.pr_number == null ? null : Number(change.pr_number) },
        requests: reqNumbers,
        author,
      };
      let move;
      try {
        ({ rows: [move] } = await pool.query(
          `INSERT INTO thread_moves (app_id, thread_id, kind, input, proposed_by, deadline, agreed_by, for_session_id)
           VALUES ($1, $2, 'merge', $3, $4, NOW() + make_interval(days => $5), $6::int[], $7) RETURNING *`,
          [change.app_id, source.id, JSON.stringify(input), author, CONSENT_DEADLINE_DAYS,
            others.length ? [] : requesters, Number(change.id)]
        ));
      } catch (err) {
        // Another move is open on that thread (thread_moves_one_open_idx):
        // try again on a later sweep.
        if (err.code === '23505') continue;
        throw err;
      }
      opened += 1;
      const changeNumber = input.forChange.number == null ? '?' : input.forChange.number;
      const which = reqNumbers.map((n) => `#${n}`).join(', ');
      if (!others.length) {
        // The author asked for everything in it: it moves now, and the
        // thread says why.
        let name = 'The change\'s author';
        if (author != null) {
          const { rows: [u] } = await pool.query('SELECT username FROM users WHERE id = $1', [author]);
          if (u) name = u.username;
        }
        await say(pool, { appId: change.app_id, thread: source, deps,
          text: `${name} asked for ${which} and Change #${changeNumber} closes it, so ${which} moved into this thread.` });
        try {
          await decide(pool, { move, appId: change.app_id, deps, why: 'author' });
        } catch (err) {
          log.warn('thread-moves', 'A change could not gather its request', { moveId: Number(move.id), err: err.message });
        }
      } else {
        const names = (await pool.query('SELECT username FROM users WHERE id = ANY($1::int[]) ORDER BY username', [others]))
          .rows.map((r) => r.username).join(', ');
        await say(pool, { appId: change.app_id, thread: source, deps,
          text: `Change #${changeNumber} closes ${which}. ${names}, move it into #${target.number}'s thread?` });
      }
    }
  }
  return opened;
}

/**
 * #6421: a request's other asker answers the change's question — Yes moves
 * that thread in, Keep separate leaves it linked where it is. Only an asker
 * of the moved thread other than the change's author may answer; one Keep
 * separate ends it, and it is not asked again.
 */
async function consent(pool, { app, user, moveId, answer, deps = {} }) {
  const act = answer === 'yes' ? 'yes' : answer === 'separate' ? 'separate' : null;
  if (!act) return { ok: false, status: 422, error: 'Answer Yes or Keep separate.' };
  const move = await moveFor(pool, { app, moveId });
  if (!move || move.for_session_id == null) return { ok: false, status: 404, error: 'No such move' };
  if (move.state !== 'pending') return { ok: false, status: 409, error: 'That move is decided.' };
  const author = Number(move.input && move.input.author) || null;
  const requesters = await requestersOf(pool, [Number(move.thread_id)]);
  const asked = requesters.filter((id) => id !== author);
  if (!asked.includes(Number(user.id))) return { ok: false, status: 403, error: 'Only someone who asked for that request can answer.' };
  const numbers = (move.input && Array.isArray(move.input.requests) ? move.input.requests : []).map(Number).filter((n) => n > 0);
  const which = numbers.map((n) => `#${n}`).join(', ');
  const forChange = (move.input && move.input.forChange) || {};
  const changeNumber = forChange.number == null ? '?' : forChange.number;
  const source = await threads.threadById(pool, move.thread_id);
  const target = await threads.threadById(pool, move.input.into);
  if (act === 'separate') {
    const { rows: [now] } = await pool.query(
      `UPDATE thread_moves SET state = 'refused', decided_at = NOW(), input = input || jsonb_build_object('kept', $2::int)
        WHERE id = $1 AND state = 'pending' RETURNING *`,
      [move.id, Number(user.id)]
    );
    if (!now) return { ok: false, status: 409, error: 'That move was just decided.' };
    const text = `${user.username} kept ${which} separate. Change #${changeNumber} still closes it.`;
    await say(pool, { appId: app.id, thread: source, deps, text });
    if (target && Number(target.id) !== Number(source && source.id)) {
      await say(pool, { appId: app.id, thread: target, deps, text });
    }
    return { ok: true, move: shape(now) };
  }
  const { rows: [now] } = await pool.query(
    `UPDATE thread_moves SET agreed_by = (SELECT ARRAY(SELECT DISTINCT unnest(agreed_by || $2::int)))
      WHERE id = $1 AND state = 'pending' RETURNING *`,
    [move.id, Number(user.id)]
  );
  if (!now) return { ok: false, status: 409, error: 'That move was just decided.' };
  const text = `${user.username} agreed to move ${which} into this thread, for Change #${changeNumber}.`;
  await say(pool, { appId: app.id, thread: source, deps, text });
  const agreed = (now.agreed_by || []).map(Number);
  if (asked.every((id) => agreed.includes(id))) {
    await decide(pool, { move: now, appId: app.id, deps, why: 'consent' });
  } else if (target && Number(target.id) !== Number(source && source.id)) {
    await say(pool, { appId: app.id, thread: target, deps, text });
  }
  const { rows: [after] } = await pool.query('SELECT * FROM thread_moves WHERE id = $1', [move.id]);
  return { ok: true, move: shape(after) };
}

/**
 * The clock job: moves whose 24 hours passed with nobody objecting happen,
 * and a move whose vote ended without applying it is refused.
 */
async function sweep(pool, { deps = {} } = {}) {
  // First, gather each visible change's other request threads (#6421).
  try {
    await gather(pool, { deps });
  } catch (err) {
    log.warn('thread-moves', 'Gathering a change\'s requests failed', { err: err.message });
  }
  const { rows: due } = await pool.query(
    `SELECT * FROM thread_moves WHERE state = 'pending' AND for_session_id IS NULL AND deadline <= NOW() ORDER BY deadline LIMIT $1`,
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
  fileBreakup, WINDOW_MS, propose, agree, object, openMoves, sweep, requestersOf, shape,
  gather, consent };
