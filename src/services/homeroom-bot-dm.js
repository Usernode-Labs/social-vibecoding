'use strict';

// #3624: the Homeroom bot, in a DM.
//
// The bot already reads a request, asks one question when something real
// is missing, writes a spec, builds it and opens a proposal
// (homeroom-bot.js, homeroom-bot-live.js). It says all of that on the
// request itself: a GitHub comment and the request's Homeroom thread. This
// module brings the same news to the person the request is FOR, in their
// direct conversation with the bot, so somebody who is not a developer can
// build without opening the agent chat:
//
//   - a question the bot asks arrives in the DM with suggested answers to
//     tap (and the composer for anything else);
//   - an answer given in the DM is posted on the request's discussion, as
//     the person's own message, which is what wakes the bot to look again.
//     The DM says so under every question: the request stays the public
//     record, and nobody in the group is left out of a decision;
//   - "building", "ready to vote on" and "live" reach the DM too;
//   - a project created with a description is built by the bot: it files
//     the description as the project's first-version request once the
//     project is running, and the loop above takes it from there. (Anybody
//     else's description is filed the same way, as the project's first
//     request, and left to the group: the bot is not involved.)
//
// Who it talks to is a list an admin keeps (`homeroom_bot_dm_users`), so it
// can be tried one person at a time. What each person's requests may cost
// the platform in a week is capped (`homeroom_bot_user_weekly_cents`, $50
// to start), apart from their own allowance for agents.
//
// Never a reason anything else fails: every entry point here is called
// best-effort, after the request, the post or the merge it follows.

const log = require('./logger');
const conversations = require('./conversations');

const BOT_USERNAME = 'homeroom_bot';
const META = conversations.BOT_METADATA_KEY;

// The kinds of post that ask the requester something: their DM message
// carries suggested answers, and a reply without a quote answers the
// newest one still open.
const QUESTION_KINDS = new Set(['question', 'followup_ask']);
// The most a project description may hold. Long enough for a real brief,
// short enough to be one request body.
const MAX_BRIEF_CHARS = 4000;
const MIN_BRIEF_CHARS = 10;
// How often a person who is not on the list hears why the bot does not
// answer: once a day is enough.
const NOT_ENABLED_KEY_HOURS = 24;
// A first version that could not be filed is tried again on the next
// sweep, this many times.
const MAX_FILE_ATTEMPTS = 3;
// How often somebody writing to the bot with nothing open hears its help.
const HELP_EVERY_MS = 10 * 60 * 1000;

// A staging copy never files a GitHub issue: like the bot's own live posts
// (homeroom-bot-live.js isLiveFor), that is an irreversible side effect of
// a preview.
function isStaging() {
  return process.env.USERNODE_ENV === 'staging';
}

function clip(value, max) {
  const text = String(value == null ? '' : value).trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function lower(value) {
  return String(value || '').replace(/^@/, '').trim().toLowerCase();
}

// ── Who it talks to ──────────────────────────────────────────────────────

function settingsModule() {
  // Lazy: homeroom-bot.js requires this module from readSettings.
  return require('./homeroom-bot');
}

/**
 * Whether the bot talks to this username in a DM, by the settings alone.
 * Being on the list is the whole gate: the bot's Mode decides whether it
 * works at all (its loop idles while Off), not who it talks to, so a
 * project described while it is off waits for it, and says so.
 */
function isDmUser(settings, username) {
  if (!settings) return false;
  const list = Array.isArray(settings.dmUsers) ? settings.dmUsers : [];
  return !!username && list.includes(lower(username));
}

/** Whether this signed-in person builds through the bot's DM (the create dialog asks). */
async function isEnabledFor(pool, user) {
  if (!user || user.isSynthetic) return false;
  const settings = await settingsModule().readSettings(pool);
  return isDmUser(settings, user.username);
}

async function botAccount(pool) {
  const { rows } = await pool.query(
    'SELECT id, username FROM users WHERE username = $1 AND is_synthetic = TRUE',
    [BOT_USERNAME],
  );
  return rows[0] || null;
}

/**
 * The slugs of the projects the bot is building for somebody still on the
 * list. A first request the bot does not build (its creator was not on the
 * list when they made it) never makes a project live.
 */
async function firstVersionAppSlugs(pool, settings) {
  const users = Array.isArray(settings?.dmUsers) ? settings.dmUsers : [];
  if (!users.length) return [];
  const { rows } = await pool.query(
    `SELECT a.slug
       FROM homeroom_bot_first_versions f
       JOIN apps a ON a.id = f.app_id
       JOIN users u ON u.id = f.user_id
      WHERE f.bot_builds AND LOWER(u.username) = ANY($1::text[])`,
    [users],
  );
  return rows.map((r) => r.slug).filter((s) => typeof s === 'string');
}

// ── Sending ──────────────────────────────────────────────────────────────

// What routes/conversations.js does after a send, done here because the
// service pushes nothing (the welcome DM does the same).
async function pushLive(pool, result, conversationId, { opened = false } = {}) {
  const ws = require('./ws');
  const notificationSvc = require('./notifications');
  for (const row of result.notifications || []) await notificationSvc.hydrateAndPush(pool, row);
  if (opened) ws.pushConversationEvent(result.memberIds, { type: 'conversation_membership_changed', conversationId });
  ws.pushConversationEvent(result.memberIds, {
    type: 'conversation_message_created',
    conversationId,
    messageId: result.message?.id ?? result.messageId,
    threadRootId: null,
  });
}

/**
 * One message from the bot to a person, in their DM with it (opened if it
 * is not yet). `metadata` is the message's structured part, shown to the
 * reader as `metadata.homeroomBot`. Resolves { conversationId, messageId,
 * duplicate } or null when the person blocked the bot or left the chat.
 */
async function sendDm(pool, { bot, userId, content, metadata = null, idempotencyKey = null }) {
  if (!bot?.id || !userId) return null;
  const opened = await conversations.ensureAdmittedDirect(pool, bot.id, userId);
  if (!opened) return null;
  const input = { content: clip(content, conversations.MAX_MESSAGE_LENGTH || 8000) };
  const key = conversations.normalizeIdempotencyKey(idempotencyKey);
  if (key) input.idempotency_key = key;
  const result = await conversations.sendMessage(pool, { id: bot.id }, opened.conversationId, input, {
    metadata: metadata ? { [META]: metadata } : null,
  });
  if (!result || result.error) {
    log.warn('homeroom-bot-dm', 'DM refused', { userId, error: result?.error || 'refused' });
    return null;
  }
  if (!result.duplicate) {
    try {
      await pushLive(pool, result, opened.conversationId, { opened: opened.created });
    } catch (err) {
      // The message and its bell row are in; a missed live refresh catches
      // up on the next load.
      log.warn('homeroom-bot-dm', 'Live fan-out failed', { userId, err: err.message });
    }
  }
  return {
    conversationId: opened.conversationId,
    messageId: result.messageId ?? result.message?.id ?? null,
    duplicate: !!result.duplicate,
  };
}

// ── Who a request is for ─────────────────────────────────────────────────

/**
 * The person a request is for, recorded the first time the live loop looks
 * at it: whoever filed it (homeroom-bot-live.js issuePoster), or for a
 * first version the creator it was filed for. Resolves { userId, username,
 * firstVersion, issueTitle } or null when nobody on Homeroom filed it.
 */
async function recordRequester(pool, { app, repo, issueNumber, issue = null }) {
  const title = issue?.title ? clip(issue.title, 300) : null;
  const { rows: found } = await pool.query(
    `SELECT q.user_id, q.first_version, q.issue_title, u.username
       FROM homeroom_bot_requesters q JOIN users u ON u.id = q.user_id
      WHERE q.app_id = $1 AND q.issue_number = $2`,
    [app.id, issueNumber],
  );
  if (found.length) {
    const row = found[0];
    if (title && title !== row.issue_title) {
      await pool.query(
        'UPDATE homeroom_bot_requesters SET issue_title = $3 WHERE app_id = $1 AND issue_number = $2',
        [app.id, issueNumber, title],
      ).catch(() => {});
    }
    return { userId: row.user_id, username: row.username, firstVersion: !!row.first_version, issueTitle: title || row.issue_title };
  }
  const live = require('./homeroom-bot-live');
  const poster = await live.issuePoster(pool, { app, repo, issueNumber, issue });
  if (!poster) return null;
  const { rows } = await pool.query(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title)
     SELECT $1, $2, u.id, $4 FROM users u
      WHERE LOWER(u.username) = LOWER($3) AND u.is_synthetic = FALSE
     ON CONFLICT (app_id, issue_number) DO UPDATE SET issue_title = COALESCE(EXCLUDED.issue_title, homeroom_bot_requesters.issue_title)
     RETURNING user_id, first_version, issue_title`,
    [app.id, issueNumber, poster, title],
  );
  if (!rows.length) return null;
  return { userId: rows[0].user_id, username: poster, firstVersion: !!rows[0].first_version, issueTitle: rows[0].issue_title };
}

async function requesterOf(pool, appId, issueNumber) {
  const { rows } = await pool.query(
    `SELECT q.user_id, q.first_version, q.issue_title, u.username
       FROM homeroom_bot_requesters q JOIN users u ON u.id = q.user_id
      WHERE q.app_id = $1 AND q.issue_number = $2`,
    [appId, issueNumber],
  );
  const row = rows[0];
  return row ? { userId: row.user_id, username: row.username, firstVersion: !!row.first_version, issueTitle: row.issue_title } : null;
}

// ── The weekly allowance ─────────────────────────────────────────────────

/**
 * What one person's requests have cost the bot this week, in cents: its
 * triage, spec, build and follow-up turns on every request recorded as
 * theirs. The week is the platform's (date_trunc('week'), as limits.js).
 */
async function weeklySpentCents(pool, userId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(COALESCE(r.cost_usd, 0) + COALESCE(r.build_cost_usd, 0)), 0)::float8 AS usd
       FROM homeroom_bot_runs r
       JOIN homeroom_bot_requesters q ON q.app_id = r.app_id AND q.issue_number = r.issue_number
      WHERE q.user_id = $1 AND r.created_at >= date_trunc('week', NOW())`,
    [userId],
  );
  return Math.round((Number(rows[0]?.usd) || 0) * 100);
}

/** Whether this person's requests have used their week's allowance. 0 means no cap. */
async function overWeeklyAllowance(pool, settings, userId) {
  const cap = Number(settings?.userWeeklyCents);
  if (!userId || !Number.isFinite(cap) || cap <= 0) return false;
  return (await weeklySpentCents(pool, userId)) >= cap;
}

function dollars(cents) {
  return `$${(Math.max(0, Number(cents) || 0) / 100).toFixed(2).replace(/\.00$/, '')}`;
}

function weekKey(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** Said once a week, to somebody on the list, when their allowance holds a request back. */
async function noteOverAllowance(pool, { settings, requester, app, issueNumber, bot }) {
  if (!requester || !isDmUser(settings, requester.username)) return null;
  return sendDm(pool, {
    bot,
    userId: requester.userId,
    idempotencyKey: `hrbot-allowance-${requester.userId}-${weekKey()}`,
    content: `You've used this week's ${dollars(settings.userWeeklyCents)} Homeroom bot allowance, so I'm holding `
      + `${app.name || app.slug} request #${issueNumber} for now. I'll pick it up again when the week resets on Monday.`,
    metadata: { kind: 'allowance', appSlug: app.slug, appName: app.name || app.slug, issueNumber },
  });
}

// ── The request's news, in the DM ────────────────────────────────────────

function requestLine({ appName, issueNumber, issueTitle, firstVersion }) {
  if (firstVersion) return `**${appName}**, its first version`;
  return `**${appName}** · request #${issueNumber}${issueTitle ? `: ${clip(issueTitle, 140)}` : ''}`;
}

/**
 * The DM text for one of the bot's posts on a request, from the structured
 * `dm` its caller passed (homeroom-bot.js): plain words, no code. Returns
 * null for a kind the DM does not carry.
 */
function dmText(kind, dm, context) {
  const line = requestLine(context);
  const it = context.firstVersion ? 'the first version' : 'this';
  switch (kind) {
    case 'question':
      return `${line}\n\nI have a question before I build ${it}:\n\n${clip(dm.question, 2000)}`;
    case 'followup_ask':
      return `${line}\n\nI have a question before I change the proposal:\n\n${clip(dm.question, 2000)}`;
    case 'spec':
      return `${line}\n\nI'm building ${it} now. I'll message you here when it's ready to try.`;
    case 'proposal':
      return `${line}\n\nIt's built. Open the proposal to try the preview and vote on it: ${dm.link}\n\n`
        + 'It goes live once it is approved.';
    case 'followup_revise':
      return `${line}\n\nI changed the proposal after the latest replies: ${clip(dm.summary, 600)}`
        + `${dm.link ? `\n\nTake another look: ${dm.link}` : ''}`;
    case 'blocked':
      return `${line}\n\nI looked into this and can't build it as it's written: ${clip(dm.reason, 600)}\n\n`
        + 'Reply to this message with more detail and I\'ll look again.';
    case 'build_failed':
      return `${line}\n\nI tried to build ${it} but couldn't finish (${clip(dm.reason, 300) || 'unknown reason'}). `
        + 'A person can pick it up from here.';
    case 'person':
    case 'followup_person':
      return `${line}\n\nThis needs a person to decide, so I've left it for the group: ${clip(dm.reason, 600)}`;
    case 'empty':
      return `${line}\n\nI couldn't find anything to build in this yet. Reply to this message with what you'd like `
        + 'changed and I\'ll look again.';
    default:
      return null;
  }
}

/**
 * Close the questions still open on a request: a newer post about it (a
 * new question, the proposal, a hand-off) means the old ones are not what
 * the bot is waiting on any more. Their chips go away.
 */
async function closeOpenQuestions(pool, { userId, appId, issueNumber, ws = null }) {
  const { rows } = await pool.query(
    `UPDATE homeroom_bot_dm_messages SET question_status = 'closed'
      WHERE user_id = $1 AND app_id = $2 AND issue_number = $3 AND question_status = 'open'
      RETURNING message_id, conversation_id`,
    [userId, appId, issueNumber],
  );
  for (const row of rows) await setQuestionState(pool, row.message_id, { status: 'closed' }, { ws, conversationId: row.conversation_id, userId });
  return rows.length;
}

/**
 * The requester of a request when the bot tells them its news in a DM:
 * { userId, username }, or null. The bot's post on the request then leaves
 * them untagged (homeroom-bot-live.js post), so the same news does not ring
 * twice.
 */
async function dmRecipient(pool, appId, issueNumber) {
  const settings = await settingsModule().readSettings(pool);
  if (!settings.dmUsers?.length) return null;
  const requester = await requesterOf(pool, appId, issueNumber);
  return requester && isDmUser(settings, requester.username)
    ? { userId: requester.userId, username: requester.username }
    : null;
}

/** Update a DM question's state in the message itself, so the reader's chips follow. */
async function setQuestionState(pool, messageId, patch, { ws = null, conversationId = null, userId = null } = {}) {
  const { rows } = await pool.query(
    'SELECT metadata, conversation_id, sender_id FROM conversation_messages WHERE id = $1',
    [messageId],
  );
  if (!rows.length) return;
  const metadata = rows[0].metadata && typeof rows[0].metadata === 'object' ? rows[0].metadata : {};
  const bot = metadata[META] && typeof metadata[META] === 'object' ? metadata[META] : {};
  await conversations.setMessageMetadata(pool, messageId, { ...metadata, [META]: { ...bot, ...patch } });
  const io = ws || require('./ws');
  const members = [rows[0].sender_id, userId].filter(Boolean);
  io.pushConversationEvent(members, {
    type: 'conversation_message_updated', conversationId: conversationId || rows[0].conversation_id, messageId, threadRootId: null,
  });
}

/**
 * Called by the bot's post on a request (homeroom-bot-live.js `post`) when
 * the post carries `dm`: the same news, in the requester's DM, when they
 * are somebody the bot talks to there. Resolves what was sent, or null.
 */
async function relayIssuePost({ pool, ws = null, app, issueNumber, kind, runId = null, postId = null, bot, dm }) {
  if (!dm || !bot?.id) return null;
  const settings = await settingsModule().readSettings(pool);
  const requester = await requesterOf(pool, app.id, issueNumber);
  if (!requester || !isDmUser(settings, requester.username)) return null;
  const context = {
    appName: app.name || app.slug,
    appSlug: app.slug,
    issueNumber,
    issueTitle: requester.issueTitle,
    firstVersion: requester.firstVersion,
  };
  const content = dmText(kind, dm, context);
  if (!content) return null;
  const asks = QUESTION_KINDS.has(kind);
  const answers = asks ? (Array.isArray(dm.answers) ? dm.answers : []).filter((a) => typeof a === 'string' && a.trim()) : [];
  const metadata = {
    kind,
    appSlug: app.slug,
    appName: context.appName,
    issueNumber,
    ...(context.issueTitle ? { issueTitle: context.issueTitle } : {}),
    ...(context.firstVersion ? { firstVersion: true } : {}),
    // A reply to this message is posted on the request, publicly.
    mirrors: true,
    ...(asks ? { question: clip(dm.question, 2000), answers, status: 'open' } : {}),
    ...(dm.link ? { link: dm.link } : {}),
  };
  const sent = await sendDm(pool, {
    bot,
    userId: requester.userId,
    content,
    metadata,
    idempotencyKey: postId ? `hrbot-post-${postId}` : null,
  });
  if (!sent?.messageId) return null;
  // The same post relayed again (a retry) was already sent and recorded.
  if (sent.duplicate) return sent;
  // Whatever this post says, it is the request's news now: an older
  // question about it is not waiting for an answer any more.
  await closeOpenQuestions(pool, { userId: requester.userId, appId: app.id, issueNumber, ws });
  await pool.query(
    `INSERT INTO homeroom_bot_dm_messages
       (message_id, user_id, conversation_id, app_id, issue_number, kind, run_id, question_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (message_id) DO NOTHING`,
    [sent.messageId, requester.userId, sent.conversationId, app.id, issueNumber, kind, runId, asks ? 'open' : null],
  );
  log.info('homeroom-bot-dm', 'Told the requester in their DM', {
    app: app.slug, issueNumber, kind, userId: requester.userId, question: asks,
  });
  return sent;
}

/** A proposal the bot built is merged: its requester hears it is live. */
async function noteProposalMerged(pool, session) {
  if (!session?.id) return null;
  const { rows } = await pool.query(
    `SELECT r.app_id, r.issue_number, a.slug, a.name
       FROM homeroom_bot_runs r JOIN apps a ON a.id = r.app_id
      WHERE r.proposal_session_id = $1
      ORDER BY r.id DESC LIMIT 1`,
    [session.id],
  );
  if (!rows.length) return null;
  const run = rows[0];
  const settings = await settingsModule().readSettings(pool);
  const requester = await requesterOf(pool, run.app_id, run.issue_number);
  if (!requester || !isDmUser(settings, requester.username)) return null;
  const bot = await botAccount(pool);
  if (!bot) return null;
  await closeOpenQuestions(pool, { userId: requester.userId, appId: run.app_id, issueNumber: run.issue_number });
  const context = {
    appName: run.name || run.slug, issueNumber: run.issue_number,
    issueTitle: requester.issueTitle, firstVersion: requester.firstVersion,
  };
  return sendDm(pool, {
    bot,
    userId: requester.userId,
    idempotencyKey: `hrbot-merged-${session.id}`,
    content: `${requestLine(context)}\n\nIt was approved and is live now.`,
    metadata: { kind: 'merged', appSlug: run.slug, appName: context.appName, issueNumber: run.issue_number },
  });
}

// ── A person writing to the bot ──────────────────────────────────────────

const HELP_TEXT = [
  'I build things for you on Homeroom. Create a project and describe what it should do, or post a request on a',
  'project, and I\'ll take it from there. When I have a question I\'ll ask it here: tap one of my suggested',
  'answers or write your own.',
].join(' ');

const NOT_ENABLED_TEXT = 'I\'m not taking requests in messages yet. For now, post a request on a project\'s page '
  + 'and I\'ll answer it there.';

/** Whether this conversation is the person's direct conversation with the bot. */
async function isBotDirect(pool, conversationId, botId, userId) {
  const [low, high] = conversations.normalizePair(botId, userId);
  const { rows } = await pool.query(
    `SELECT 1 FROM conversation_direct_pairs
      WHERE conversation_id = $1 AND user_low_id = $2 AND user_high_id = $3`,
    [conversationId, low, high],
  );
  return rows.length > 0;
}

/**
 * Which request a person's message is about: the bot message it quotes,
 * when it quotes one about a request, else the newest question still open.
 */
async function targetFor(pool, userId, message) {
  const quoted = message?.reply?.id;
  if (quoted) {
    const { rows } = await pool.query(
      `SELECT message_id, conversation_id, app_id, issue_number, kind, question_status
         FROM homeroom_bot_dm_messages WHERE message_id = $1 AND user_id = $2`,
      [quoted, userId],
    );
    if (rows.length) return rows[0];
  }
  const { rows } = await pool.query(
    `SELECT message_id, conversation_id, app_id, issue_number, kind, question_status
       FROM homeroom_bot_dm_messages
      WHERE user_id = $1 AND question_status = 'open'
      ORDER BY created_at DESC, message_id DESC
      LIMIT 1`,
    [userId],
  );
  return rows[0] || null;
}

/** The text a DM answer is posted on the request with. */
function mirroredText(content, { question = false } = {}) {
  return `${clip(content, 3500)}\n\n(${question ? 'Answered' : 'Sent'} in a chat with Homeroom bot.)`;
}

/**
 * Called after a person's message lands in a conversation
 * (routes/conversations.js). When it is their DM with the bot: an answer to
 * a question, or a reply about a request, is posted on that request's
 * discussion as their message (which wakes the bot), and the bot says
 * where it went. Anything else gets the bot's short help.
 */
async function noteUserMessage(pool, config, { user, conversationId, message, deps = {} }) {
  if (!user?.id || !message?.id || user.isSynthetic) return null;
  const bot = deps.bot || await botAccount(pool);
  if (!bot || bot.id === user.id) return null;
  if (!(await isBotDirect(pool, conversationId, bot.id, user.id))) return null;
  const settings = await settingsModule().readSettings(pool);
  if (!isDmUser(settings, user.username)) {
    const hour = Math.floor(Date.now() / (NOT_ENABLED_KEY_HOURS * 3600 * 1000));
    return sendDm(pool, { bot, userId: user.id, content: NOT_ENABLED_TEXT, idempotencyKey: `hrbot-notyet-${user.id}-${hour}` });
  }
  const target = await targetFor(pool, user.id, message);
  if (!target) {
    // Once in a while, not after every message.
    const window = Math.floor(Date.now() / HELP_EVERY_MS);
    return sendDm(pool, { bot, userId: user.id, content: HELP_TEXT, idempotencyKey: `hrbot-help-${user.id}-${window}` });
  }
  const { rows: apps } = await pool.query('SELECT id, slug, name FROM apps WHERE id = $1', [target.app_id]);
  const app = apps[0];
  if (!app) return null;
  const line = `${app.name || app.slug} request #${target.issue_number}`;
  const text = String(message.content || '').trim();
  if (!text) {
    return sendDm(pool, {
      bot, userId: user.id, idempotencyKey: `hrbot-ack-${message.id}`,
      content: `I can only pass words on to ${line} for now. Write your answer as a message.`,
    });
  }
  const question = target.question_status === 'open';
  const ws = deps.ws || require('./ws');
  const posted = await ws.handleMessage(
    pool,
    { user, appId: app.id, appSlug: app.slug, postedVia: null },
    { type: 'chat', content: mirroredText(text, { question }), thread: { type: 'issue', ref: Number(target.issue_number) } },
  ).catch((err) => ({ ok: false, code: err.message }));
  if (!posted?.ok) {
    log.warn('homeroom-bot-dm', 'Could not post a DM answer on its request', {
      app: app.slug, issueNumber: target.issue_number, userId: user.id, code: posted?.code || null,
    });
    const why = posted?.code === 'not_collaborator' || posted?.code === 'join_required'
      ? `you need to be a member of ${app.name || app.slug} to take part in its requests`
      : 'something went wrong on my side';
    return sendDm(pool, {
      bot, userId: user.id, idempotencyKey: `hrbot-ack-${message.id}`,
      content: `I couldn't post that on ${line}: ${why}. Nothing was sent.`,
    });
  }
  if (question) {
    await pool.query(
      `UPDATE homeroom_bot_dm_messages
          SET question_status = 'answered', answered_at = NOW(), answer_message_id = $2
        WHERE message_id = $1`,
      [target.message_id, message.id],
    );
    await setQuestionState(pool, target.message_id, { status: 'answered', answer: clip(text, 300) }, {
      ws, conversationId: target.conversation_id, userId: user.id,
    });
  }
  log.info('homeroom-bot-dm', 'Posted a DM reply on its request', {
    app: app.slug, issueNumber: target.issue_number, userId: user.id, question,
  });
  return sendDm(pool, {
    bot, userId: user.id, idempotencyKey: `hrbot-ack-${message.id}`,
    content: question
      ? `Thanks. I posted your answer on ${line}'s public discussion and I'm looking at it again now.`
      : `I posted that on ${line}'s public discussion. I'll look at it again now.`,
    metadata: { kind: 'ack', appSlug: app.slug, appName: app.name || app.slug, issueNumber: Number(target.issue_number) },
  });
}

// ── A project built from its description ─────────────────────────────────

/** A description fit to build from, or null. */
function normalizeBrief(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (text.length < MIN_BRIEF_CHARS) return null;
  return text.slice(0, MAX_BRIEF_CHARS);
}

/**
 * A project was just created with a description (routes/apps.js): what the
 * create dialog asks as "What should it do?". Recorded, so it is filed as
 * the project's first request once the project is running, under its
 * creator's name. When the creator is somebody the bot talks to in a DM,
 * the bot builds that first version and the person is told in their DM;
 * for anybody else the request is filed and left to the group, with no DM.
 * Resolves { conversationId } when the bot builds it and said so, else null.
 */
async function startFirstVersion(pool, config, { app, user, brief }) {
  const text = normalizeBrief(brief);
  if (!text || !app?.id || !user?.id) return null;
  const settings = await settingsModule().readSettings(pool);
  const bot = isDmUser(settings, user.username) ? await settingsModule().ensureBotUser(pool, config) : null;
  await pool.query(
    `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, bot_builds)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (app_id) DO NOTHING`,
    [app.id, user.id, text, !!bot],
  );
  if (!bot) {
    log.info('homeroom-bot-dm', 'Project will file its description as its first request', { app: app.slug, userId: user.id });
    return null;
  }
  const name = app.name || app.slug;
  const sent = await sendDm(pool, {
    bot,
    userId: user.id,
    idempotencyKey: `hrbot-create-${app.id}`,
    content: `**${name}**\n\nThanks! I'm setting up ${name} now. Once it's ready I'll build its first version from your `
      + 'description and send it to you here to try. If anything is unclear, I\'ll ask you here first.'
      + (settings.mode === 'off' ? '\n\nI\'m switched off right now, so this waits until I\'m back on.' : ''),
    metadata: { kind: 'first_version_started', appSlug: app.slug, appName: name },
  });
  log.info('homeroom-bot-dm', 'Project will be built from its description', { app: app.slug, userId: user.id });
  return sent ? { conversationId: sent.conversationId } : null;
}

/**
 * File one project's first request, once the project is running: a GitHub
 * issue under the creator's name and the platform's issue row. When the bot
 * builds it, the creator is recorded as its requester (so the bot's news
 * reaches their DM) and the bot is woken for it; otherwise nothing of the
 * bot's is touched. Claimed by a status flip, so two Pods (or the creation
 * hook and the sweep) file it once.
 */
async function fileFirstVersion(pool, config, appId, deps = {}) {
  if (isStaging() && !deps.allowStaging) return null;
  const { rows: claimed } = await pool.query(
    `UPDATE homeroom_bot_first_versions f
        SET status = 'filing', attempts = f.attempts + 1
       FROM apps a
      WHERE f.app_id = $1 AND a.id = f.app_id AND f.status = 'waiting'
        AND a.status = 'running' AND a.repo_url IS NOT NULL
      RETURNING f.app_id, f.user_id, f.brief, f.attempts, f.bot_builds, a.slug, a.name, a.repo_url`,
    [appId],
  );
  const row = claimed[0];
  if (!row) return null;
  const github = deps.github || require('./github');
  const ws = deps.ws || require('./ws');
  const { rows: people } = await pool.query('SELECT username FROM users WHERE id = $1', [row.user_id]);
  const username = people[0]?.username || 'unknown';
  const name = row.name || row.slug;
  const botBuilds = row.bot_builds !== false;
  const title = clip(`First version of ${name}`, 200);
  const body = [
    `**Source:** Homeroom user (${username})`,
    '',
    row.brief,
    '',
    '---',
    botBuilds
      ? `${username} described this when they created the project. Homeroom bot is building its first version from it.`
      : `${username} described this when they created the project.`,
  ].join('\n');
  try {
    const parsed = (typeof github.parseGithubUrl === 'function' && github.parseGithubUrl(row.repo_url))
      || (() => {
        const m = String(row.repo_url).match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
        return m ? { owner: m[1], repo: m[2] } : null;
      })();
    if (!parsed || !github.isEnabled()) throw new Error('github_unavailable');
    const created = await github.createIssue(parsed.owner, parsed.repo, {
      title, body: typeof github.safeMention === 'function' ? github.safeMention(body) : body,
    });
    const issueNumber = Number(created?.number);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error('invalid issue number');
    try { github.noteIssueCreated?.(parsed.owner, parsed.repo, created); } catch {}
    const { rows: issueRows } = await pool.query(
      `INSERT INTO issues (app_id, github_issue_number, title, description, kind, payload, created_by)
       VALUES ($1, $2, $3, $4, 'general', '{}', $5) RETURNING id`,
      [row.app_id, issueNumber, title, body, row.user_id],
    );
    if (botBuilds) {
      await pool.query(
        `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, first_version)
         VALUES ($1, $2, $3, $4, TRUE)
         ON CONFLICT (app_id, issue_number) DO UPDATE SET user_id = EXCLUDED.user_id, first_version = TRUE`,
        [row.app_id, issueNumber, row.user_id, title],
      );
    }
    await pool.query(
      `UPDATE homeroom_bot_first_versions SET status = 'filed', issue_number = $2, filed_at = NOW(), error = NULL
        WHERE app_id = $1`,
      [row.app_id, issueNumber],
    );
    await ws.sendSystemMessage(pool, row.app_id, `${username} created issue: "${title}" (#${issueNumber})`,
      'system', null, { type: 'issue', ref: issueNumber }).catch(() => {});
    ws.pushIssueUpdate({ action: 'created', appSlug: row.slug, appId: row.app_id, issueId: issueRows[0]?.id, kind: 'general' });
    if (botBuilds) settingsModule().noteIssueActivity({ appId: row.app_id, issueNumber, reason: 'created' });
    log.info('homeroom-bot-dm', 'Filed a first version', { app: row.slug, issueNumber, userId: row.user_id, botBuilds });
    return { issueNumber };
  } catch (err) {
    const final = row.attempts >= MAX_FILE_ATTEMPTS;
    await pool.query(
      `UPDATE homeroom_bot_first_versions SET status = $2, error = $3 WHERE app_id = $1`,
      [row.app_id, final ? 'failed' : 'waiting', clip(err.message, 300)],
    ).catch(() => {});
    log.warn('homeroom-bot-dm', 'Could not file a first version', { app: row.slug, err: err.message, final });
    if (final && botBuilds) {
      const bot = await botAccount(pool);
      if (bot) {
        await sendDm(pool, {
          bot, userId: row.user_id, idempotencyKey: `hrbot-filefail-${row.app_id}`,
          content: `**${name}**\n\nI couldn't start building ${name}'s first version. You can still post a request on `
            + 'its page, or start a change from there yourself.',
        }).catch(() => null);
      }
    }
    return null;
  }
}

/**
 * Every project waiting for its first request whose project is running now,
 * the bot's or not. The bot's loop runs it before its refresh, and the
 * leader runs it on its own timer (server.js), so a request the creation
 * hook missed is filed whether or not the bot is on.
 */
async function sweepFirstVersions(pool, config, deps = {}) {
  if (isStaging() && !deps.allowStaging) return 0;
  // A filing a restart interrupted is tried again, within its attempts.
  await pool.query(
    `UPDATE homeroom_bot_first_versions SET status = 'waiting'
      WHERE status = 'filing' AND attempts < $1 AND created_at < NOW() - INTERVAL '30 minutes'`,
    [MAX_FILE_ATTEMPTS],
  );
  const { rows } = await pool.query(
    `SELECT f.app_id FROM homeroom_bot_first_versions f JOIN apps a ON a.id = f.app_id
      WHERE f.status = 'waiting' AND a.status = 'running' AND a.repo_url IS NOT NULL
      ORDER BY f.created_at
      LIMIT 20`,
  );
  let filed = 0;
  for (const r of rows) {
    if (await fileFirstVersion(pool, config, r.app_id, deps).catch(() => null)) filed += 1;
  }
  return filed;
}

/** The create dialog's suggested one-line description, from the longer one. */
async function suggestShortDescription({ name, brief, max = 90, deps = {} }) {
  const text = normalizeBrief(brief);
  if (!text) return null;
  const llm = deps.llm || require('./llm');
  try {
    const out = await llm.generateShortDescription({ name, brief: text, max });
    if (out?.description) return { description: clip(out.description, max).slice(0, max), usage: out.usage, model: out.model };
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Short description suggestion failed; using the first sentence', { err: err.message });
  }
  return { description: firstSentence(text, max), usage: null, model: null };
}

/** The description's first sentence, cut at a word to fit `max`. */
function firstSentence(text, max = 90) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const sentence = (flat.match(/^.+?[.!?](?=\s|$)/) || [flat])[0].replace(/[.!?]+$/, '');
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > 20 ? cut.slice(0, at) : cut).replace(/[,;:\s]+$/, '')}…`;
}

module.exports = {
  BOT_USERNAME,
  QUESTION_KINDS,
  MAX_BRIEF_CHARS,
  MIN_BRIEF_CHARS,
  HELP_TEXT,
  NOT_ENABLED_TEXT,
  isDmUser,
  isEnabledFor,
  botAccount,
  firstVersionAppSlugs,
  sendDm,
  recordRequester,
  requesterOf,
  weeklySpentCents,
  overWeeklyAllowance,
  noteOverAllowance,
  weekKey,
  dmText,
  dmRecipient,
  requestLine,
  closeOpenQuestions,
  setQuestionState,
  relayIssuePost,
  noteProposalMerged,
  isBotDirect,
  targetFor,
  mirroredText,
  noteUserMessage,
  normalizeBrief,
  startFirstVersion,
  fileFirstVersion,
  sweepFirstVersions,
  suggestShortDescription,
  firstSentence,
};
