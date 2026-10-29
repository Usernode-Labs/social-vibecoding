'use strict';

// Threads, stage 5 of #6019: private threads. A person's chat with Homeroom
// bot (the AI tab, its main stream Main) is private, and any thread they
// start in it is a private thread: a draft of a request, a reply for a
// public thread, an idea with no project yet. Nothing in it is public until
// they choose one of two doors, each their own tap:
//
//   File it  files its words as a request on a project they pick, under
//            their name, as the bot's own File it does (homeroom-bot-mayor.js
//            fileRequest), and the request has its thread from then on;
//   Post it  posts its words in an existing thread (a request's or a
//            change's, by number) as their own message, exactly as a reply
//            typed there is (ws.handleMessage, with its gates: posting is for
//            the project's members).
//
// The row in `private_threads` says where the thread went, once, so a second
// tap answers what the first did. The bot says it in the thread too.

const log = require('./logger');
const threads = require('./threads');

const MAX_TEXT = 3500;
const MAX_TITLE = 120;

function clip(text, max) {
  const s = String(text || '').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function words(text) {
  return String(text || '').split(/\s+/).filter(Boolean).length;
}

/** The request page or change page a number opens, in-app. */
function hrefFor(app, number, kind) {
  return `#app/${encodeURIComponent(app.slug)}/dev/${kind === 'change' ? 'changes' : 'issues'}/${Number(number)}`;
}

/**
 * The person's own message that starts a thread in their chat with the bot,
 * or null when `rootId` is anything else: another chat's, somebody else's,
 * a reply inside a thread, or deleted.
 */
async function ownRoot(pool, { user, bot, rootId }) {
  const id = Number(rootId);
  if (!user?.id || !bot?.id || !Number.isInteger(id) || id <= 0) return null;
  const { rows: [root] } = await pool.query(
    `SELECT m.id, m.conversation_id, m.content
       FROM conversation_messages m
       JOIN conversations c ON c.id = m.conversation_id AND c.kind = 'direct'
      WHERE m.id = $1 AND m.sender_id = $2 AND m.deleted_at IS NULL AND m.thread_root_id IS NULL
        AND EXISTS (SELECT 1 FROM conversation_members b
                     WHERE b.conversation_id = m.conversation_id AND b.user_id = $3)`,
    [id, user.id, bot.id]
  );
  return root || null;
}

/** Where a private thread went: { state, number, href } or the open state. */
async function stateOf(pool, { user, rootId }) {
  const { rows: [row] } = await pool.query(
    `SELECT p.state, p.result_ref, p.kind, a.slug, a.name
       FROM private_threads p LEFT JOIN apps a ON a.id = p.app_id
      WHERE p.root_message_id = $1 AND p.user_id = $2`,
    [Number(rootId), user.id]
  );
  if (!row) return { state: 'open' };
  const app = row.slug ? { slug: row.slug, name: row.name || row.slug } : null;
  return {
    state: row.state,
    number: row.result_ref == null ? null : Number(row.result_ref),
    app,
    href: app && row.result_ref != null ? hrefFor(app, row.result_ref, row.kind === 'draft_reply' ? 'thread' : 'request') : null,
  };
}

async function record(pool, { user, root, app, threadId, kind, state, ref }) {
  await pool.query(
    `INSERT INTO private_threads (user_id, conversation_id, root_message_id, app_id, target_thread_id, kind, state, result_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (root_message_id) DO UPDATE
       SET app_id = EXCLUDED.app_id, target_thread_id = EXCLUDED.target_thread_id, kind = EXCLUDED.kind,
           state = EXCLUDED.state, result_ref = EXCLUDED.result_ref, updated_at = NOW()`,
    [user.id, root.conversation_id, root.id, app.id, threadId || null, kind, state, ref]
  );
}

// The gates both doors share: the thread is theirs and still open, and the
// project is one they may take part in. Resolves { root, app, bot } or a
// refusal { ok: false, status, error, code? }.
async function opened(pool, { user, rootId, project, deps }) {
  const dm = deps.dm || require('./homeroom-bot-dm');
  const mayor = deps.mayor || require('./homeroom-bot-mayor');
  const bot = deps.bot || await dm.botAccount(pool);
  const root = await ownRoot(pool, { user, bot, rootId });
  if (!root) return { ok: false, status: 404, error: 'No such thread' };
  const was = await stateOf(pool, { user, rootId: root.id });
  if (was.state !== 'open') return { ok: false, status: 409, error: 'already_done', ...was };
  const app = project ? await mayor.findApp(pool, String(project)) : null;
  if (!app || !(await mayor.canView(pool, app, user))) return { ok: false, status: 404, error: 'No such project' };
  if (!(await mayor.canFile(pool, app, user))) {
    return {
      ok: false, status: 403, error: 'join_required', code: 'join_required',
      app: { slug: app.slug, name: app.name || app.slug },
    };
  }
  return { ok: true, root, app, bot, dm, mayor };
}

/**
 * File it: the thread's words as a new request on `project`, titled
 * `title` (its first line when none). Resolves { ok, state, number, href }
 * or a refusal.
 */
async function fileIt(pool, config, { user, rootId, project, title = null, text = null, deps = {} }) {
  const gate = await opened(pool, { user, rootId, project, deps });
  if (!gate.ok) return gate;
  const { root, app, bot, dm, mayor } = gate;
  const body = clip(text || root.content, MAX_TEXT);
  const named = clip(title || body.split('\n')[0], MAX_TITLE);
  if (words(body) < 2 || !named) {
    return { ok: false, status: 422, error: 'Say what the request is in a few words first.' };
  }
  const settings = await (deps.homeroomBot || require('./homeroom-bot')).readSettings(pool);
  const filed = await mayor.fileRequest(pool, config, {
    user, app, title: named, details: body, settings, deps, askedText: body,
    footer: `Filed from a private draft in ${user.username}'s chat with Homeroom bot.`,
    fileKey: `private-thread:${root.id}`,
  });
  const number = Number(filed.issueNumber);
  const thread = await threads.threadForNumber(pool, { appId: app.id, number });
  await record(pool, { user, root, app, threadId: thread?.id, kind: 'draft_request', state: 'filed', ref: number });
  const name = app.name || app.slug;
  await dm.sendDm(pool, {
    bot, userId: user.id, threadRootId: root.id, idempotencyKey: `private-thread-filed-${root.id}`,
    content: `Filed it as request #${number} on ${name}, under your name.`,
    objects: [{ type: 'issue', appId: Number(app.id), issueNumber: number }],
  }).catch((err) => log.warn('private-threads', 'Could not say a draft was filed', { err: err.message }));
  log.info('private-threads', 'Filed a private draft as a request', { app: app.slug, issueNumber: number, userId: user.id });
  return { ok: true, state: 'filed', number, app: { slug: app.slug, name }, href: hrefFor(app, number, 'request') };
}

/**
 * Post it: the thread's words in the existing thread `number` names on
 * `project` (a request's discussion, or a change's), as their own message.
 * Resolves { ok, state, number, href } or a refusal.
 */
async function postIt(pool, { user, rootId, project, number, text = null, deps = {} }) {
  const gate = await opened(pool, { user, rootId, project, deps });
  if (!gate.ok) return gate;
  const { root, app, bot, dm } = gate;
  const n = Number(number);
  const thread = Number.isSafeInteger(n) && n > 0 ? await threads.threadForNumber(pool, { appId: app.id, number: n }) : null;
  if (!thread) return { ok: false, status: 404, error: `${app.name || app.slug} has no request or change #${number}.` };
  const body = clip(text || root.content, MAX_TEXT);
  if (!body) return { ok: false, status: 422, error: 'There is nothing to post.' };
  // What the number is: a request's discussion is anchored to its number, a
  // change's to its session.
  const { rows: [change] } = await pool.query(
    `SELECT id FROM chat_sessions WHERE app_id = $1 AND pr_number = $2 ORDER BY id DESC LIMIT 1`,
    [app.id, n]
  );
  const anchor = change ? { type: 'session', ref: Number(change.id) } : { type: 'issue', ref: n };
  const ws = deps.ws || require('./ws');
  const posted = await ws.handleMessage(
    pool,
    { user: { id: user.id, username: user.username }, appId: app.id, appSlug: app.slug, postedVia: null, viaBotDm: true },
    { type: 'chat', content: `${body}\n\n(Posted from a private draft in a chat with Homeroom bot.)`, thread: anchor },
  ).catch((err) => ({ ok: false, code: err.message }));
  if (!posted?.ok) {
    if (posted?.code === 'join_required' || posted?.code === 'not_collaborator') {
      return { ok: false, status: 403, error: 'join_required', code: 'join_required', app: { slug: app.slug, name: app.name || app.slug } };
    }
    log.warn('private-threads', 'Could not post a private draft', { app: app.slug, number: n, code: posted?.code || null });
    return { ok: false, status: 502, error: 'It could not be posted just now. Try again in a minute.' };
  }
  await record(pool, { user, root, app, threadId: thread.id, kind: 'draft_reply', state: 'posted', ref: n });
  const name = app.name || app.slug;
  const what = change ? `change #${n}` : `request #${n}`;
  await dm.sendDm(pool, {
    bot, userId: user.id, threadRootId: root.id, idempotencyKey: `private-thread-posted-${root.id}`,
    content: `Posted it on ${name} ${what}, as you.`,
    objects: [change ? { type: 'proposal', appId: Number(app.id), sessionId: Number(change.id) } : { type: 'issue', appId: Number(app.id), issueNumber: n }],
  }).catch((err) => log.warn('private-threads', 'Could not say a draft was posted', { err: err.message }));
  return { ok: true, state: 'posted', number: n, app: { slug: app.slug, name }, href: hrefFor(app, n, change ? 'change' : 'request') };
}

module.exports = { ownRoot, stateOf, fileIt, postIt, MAX_TEXT, MAX_TITLE };
