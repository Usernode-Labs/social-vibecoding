'use strict';

// #3736: activity cards in a person's DM with the Homeroom bot.
//
// Like a live activity on a phone: when the bot starts a piece of work for
// somebody, ONE card appears in their DM at that point in the conversation
// and follows that work in place (the step it is at, how long it has taken,
// where to open it) until it ends: a proposal up for a vote, a question
// asked, a hand-off to the group, a build that failed. The person can go on
// writing below it. The activity tray pinned above the transcript
// (homeroom-bot-tray.js) stays what it is: everything at once, and history.
//
// THE CARD IS A MESSAGE. The bot sends it when it starts reading a request
// of theirs (homeroom-bot.js runTriage, beside its "looking into it" post on
// the request, and skipped where that post is), so it sits in the
// transcript where the work began. Its words say what it is about, for the
// inbox preview, the bell and anything that does not draw the card; its
// structured part (`metadata.homeroomBot`, kind 'activity') names the
// request, which the client draws the card from
// (frontend/src/features/messages/bot-activity.tsx). It is recorded in
// homeroom_bot_dm_messages like the bot's other news about a request, so a
// reply quoting it is about that request, as a reply to any of them is.
//
// ONE PER PIECE OF WORK. A piece of work is one look at a request, from the
// queue row it was claimed from to what came of it, and that row is its
// key: a look the platform hands back and starts again (a fault, a restart)
// keeps its card, and the next look at the same request (after an answer,
// say) gets a card of its own, further down. The bot's follow-ups on a
// proposal already up for a vote start none (they return before the
// "looking" post): they answer what the group said on the proposal, and the
// card before them already ended at "proposal up".
//
// WHAT IT SAYS IS READ, NEVER WRITTEN. Nothing updates a card as the work
// moves on; `cardsFor` reads each card's state from the platform's own
// records whenever it is asked:
//
//   - its OUTCOME is the first live run on the request after the card began
//     (and before the next card on the same request began): its verdict, and
//     for a build, the proposal it opened or the build that did not finish;
//   - with no outcome yet it is in progress, and how far along is
//     `progressFor`'s (homeroom-bot-progress.js), the derivation the bot
//     answers "how far along are you?" with: step N of M, what it is doing;
//   - with neither, nothing about it is in progress any more: it stopped.
//
// LIVE: the client reads it again on the events the tray reads on: the
// bot's news landing in the DM, and `homeroom_bot_work_changed` when the
// loop starts or ends work for this person.
//
// ONE PERSON'S, ALWAYS. Every row is read by the signed-in person's own id:
// the route takes no user, conversation or message parameter. An app they
// can no longer view is left out, whatever the records say.

const log = require('./logger');
const appAccess = require('./app-access');

const KIND = 'activity';
// The most cards one read answers for, newest first. An older card keeps
// what its message says.
const MAX_CARDS = 30;

// A proposal people can open (the same states as homeroom-bot-tray.js).
const OPENABLE_PROPOSAL = new Set(['promoted', 'merging', 'merged']);

// What a card's piece of work came to. The client words each one.
const OUTCOMES = Object.freeze([
  'question', 'proposed', 'live', 'closed', 'blocked', 'build_failed',
  'person', 'empty', 'failed', 'held', 'stopped', 'answer', 'revise',
]);

function dmModule(deps) { return deps.dm || require('./homeroom-bot-dm'); }
function settingsModule(deps) { return deps.botSvc || require('./homeroom-bot'); }
function progressModule(deps) { return deps.progress || require('./homeroom-bot-progress'); }

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function issueHref(slug, issueNumber) {
  return `#app/${encodeURIComponent(slug)}/dev/issues/${Number(issueNumber)}`;
}

function proposalHref(slug, sessionId) {
  return `#app/${encodeURIComponent(slug)}/dev/proposals/${Number(sessionId)}`;
}

// ── Starting a card ──

/** Pure: a card's words, for whatever does not draw the card itself. */
function cardText({ appName, issueNumber, issueTitle, firstVersion }, dm) {
  const line = dm.requestLine({ appName, issueNumber, issueTitle, firstVersion });
  return `${line}\n\nI'm working on ${firstVersion ? 'the first version' : 'this'} now. `
    + 'This card updates as I go.';
}

/**
 * The bot started a piece of work on one of `requester`'s requests: their
 * card, in their DM with it, when they are somebody it talks to there.
 * `jobKey` is the queue row the work was claimed from. Never throws: a card
 * that could not be sent costs the work nothing. Resolves what sendDm did,
 * or null.
 */
async function startCard(pool, { app, issueNumber, requester, bot, jobKey, settings = null, deps = {} }) {
  try {
    const n = Number(issueNumber);
    if (!app?.id || !bot?.id || !requester?.userId || !Number.isInteger(n) || n <= 0 || !jobKey) return null;
    const dm = dmModule(deps);
    const s = settings || await settingsModule(deps).readSettings(pool);
    if (!dm.isDmUser(s, requester.username)) return null;
    const context = {
      appName: app.name || app.slug,
      issueNumber: n,
      issueTitle: requester.issueTitle || null,
      firstVersion: !!requester.firstVersion,
    };
    const sent = await dm.sendDm(pool, {
      bot,
      userId: requester.userId,
      content: cardText(context, dm),
      metadata: {
        kind: KIND,
        appSlug: app.slug,
        appName: context.appName,
        issueNumber: n,
        ...(context.issueTitle ? { issueTitle: context.issueTitle } : {}),
        ...(context.firstVersion ? { firstVersion: true } : {}),
        // A reply to it is about the request, as a reply to the bot's other
        // news about one is: posted on its discussion (homeroom-bot-dm.js).
        mirrors: true,
      },
      idempotencyKey: `hrbot-activity-${jobKey}`,
      // #3707: news about a request they started in the DM points back at it.
      replyToId: await dm.requestStart(pool, { userId: requester.userId, appId: app.id, issueNumber: n }),
    });
    if (!sent?.messageId || sent.duplicate) return sent || null;
    await pool.query(
      `INSERT INTO homeroom_bot_dm_messages (message_id, user_id, conversation_id, app_id, issue_number, kind)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (message_id) DO NOTHING`,
      [sent.messageId, requester.userId, sent.conversationId, app.id, n, KIND],
    );
    log.info('homeroom-bot-activity', 'Started an activity card', { app: app.slug, issueNumber: n, userId: requester.userId });
    return sent;
  } catch (err) {
    log.warn('homeroom-bot-activity', 'Could not start an activity card', {
      app: app?.slug, issueNumber, userId: requester?.userId, err: err.message,
    });
    return null;
  }
}

// ── Reading the cards ──

/**
 * Pure: what one card's piece of work came to, from the first live run
 * after it began (the run_* columns of cardRows), or null while it is
 * still going: no run yet, or a build not finished.
 */
function outcomeOf(row) {
  if (!row.run_id) return null;
  // Held back by a cap: nothing was said or built, and a later look (a card
  // of its own) takes it up when there is room.
  if (row.cap_suppressed) return 'held';
  switch (row.verdict) {
    case 'ready':
      if (row.proposal_session_id) {
        if (row.proposal_status === 'merged') return 'live';
        if (row.proposal_status === 'closed') return 'closed';
        return 'proposed';
      }
      if (row.build_ok === true) return 'proposed';
      if (row.build_ok === false) {
        return /^blocked:/.test(String(row.build_error || '')) ? 'blocked' : 'build_failed';
      }
      return null;
    case 'question': case 'person': case 'empty': case 'failed': case 'answer': case 'revise':
      return row.verdict;
    default:
      return 'failed';
  }
}

/** Pure: when a finished card's work ended, where the records say. */
function endedAt(row, outcome) {
  if (['proposed', 'live', 'closed'].includes(outcome)) return iso(row.proposal_at);
  if (['blocked', 'build_failed', 'stopped'].includes(outcome)) return null;
  return iso(row.run_at);
}

/** Pure: where a card's links go. Its request always; its proposal once people can open it. */
function linksOf(row) {
  return {
    request: issueHref(row.slug, row.issue_number),
    proposal: row.proposal_session_id && OPENABLE_PROPOSAL.has(row.proposal_status)
      ? proposalHref(row.slug, row.proposal_session_id) : null,
  };
}

/**
 * Pure: one card, from its row and (while it has no outcome) the person's
 * progress entry for its request, or null when there is none.
 */
function cardOf(row, entry) {
  const base = {
    messageId: Number(row.message_id),
    startedAt: iso(row.created_at),
    links: linksOf(row),
  };
  let outcome = outcomeOf(row);
  // A newer card on the same request began without this one coming to
  // anything recorded, or nothing about it is in progress any more.
  if (!outcome && (row.next_at || !entry)) outcome = 'stopped';
  if (outcome) return { ...base, state: 'done', outcome, endedAt: endedAt(row, outcome) };
  return {
    ...base,
    state: 'working',
    stage: entry.stage || null,
    step: Number.isInteger(entry.step) ? entry.step : null,
    of: Number.isInteger(entry.of) ? entry.of : null,
    stepName: entry.stepName || null,
    doing: entry.doing || null,
    stepSince: entry.since || null,
    ...(Number.isFinite(entry.stepTimeLimitMinutes) ? { stepLimitMinutes: entry.stepTimeLimitMinutes } : {}),
    ...(entry.waitingOn ? { waitingOn: entry.waitingOn } : {}),
  };
}

/** The person's newest cards, each with the first live run after it began. */
async function cardRows(pool, userId, limit = MAX_CARDS) {
  const { rows } = await pool.query(
    `SELECT d.message_id, d.app_id, d.issue_number, d.created_at, a.slug, a.name,
            nxt.created_at AS next_at,
            run.id AS run_id, run.verdict, run.build_ok, run.build_error, run.cap_suppressed,
            run.created_at AS run_at, run.proposal_session_id,
            cs.status AS proposal_status, COALESCE(cs.promoted_at, cs.created_at) AS proposal_at
       FROM homeroom_bot_dm_messages d
       JOIN apps a ON a.id = d.app_id
       LEFT JOIN LATERAL (
         SELECT n.created_at FROM homeroom_bot_dm_messages n
          WHERE n.user_id = d.user_id AND n.app_id = d.app_id AND n.issue_number = d.issue_number
            AND n.kind = 'activity' AND n.message_id > d.message_id
          ORDER BY n.message_id LIMIT 1
       ) nxt ON TRUE
       LEFT JOIN LATERAL (
         SELECT r.id, r.verdict, r.build_ok, r.build_error, r.cap_suppressed, r.created_at, r.proposal_session_id
           FROM homeroom_bot_runs r
          WHERE r.app_id = d.app_id AND r.issue_number = d.issue_number AND r.mode = 'live'
            AND r.created_at >= d.created_at
            AND (nxt.created_at IS NULL OR r.created_at < nxt.created_at)
          ORDER BY r.id LIMIT 1
       ) run ON TRUE
       LEFT JOIN chat_sessions cs ON cs.id = run.proposal_session_id
      WHERE d.user_id = $1 AND d.kind = 'activity'
      ORDER BY d.message_id DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

/** The slugs among `slugs` this person can still view. */
async function viewableSlugs(pool, user, slugs) {
  if (!slugs.length) return new Set();
  // The columns checkAppAccess reads (app-access.js ACCESS_COLUMNS), written
  // out so the query stays static SQL.
  const { rows } = await pool.query(
    `SELECT id, slug, created_by, self_hosted, collab_visibility, view_visibility, moderation_suspended_at
       FROM apps WHERE slug = ANY($1::text[])`,
    [slugs],
  );
  const allowed = new Set();
  for (const app of rows) {
    if (await appAccess.checkAppAccess(pool, app, user, 'view')) allowed.add(app.slug);
  }
  return allowed;
}

/**
 * The state of `user`'s activity cards, newest first: { cards }. Each is
 * { messageId, startedAt, links, state: 'working', step, of, stepName,
 * doing, ... } or { ..., state: 'done', outcome, endedAt }. Never anybody
 * else's: see the note at the top.
 */
async function cardsFor(pool, { user, settings = null, config = null, deps = {}, now = new Date() }) {
  const userId = Number(user?.id);
  if (!Number.isInteger(userId) || userId <= 0) return { cards: [] };
  const rows = await cardRows(pool, userId);
  if (!rows.length) return { cards: [] };
  const allowed = await viewableSlugs(pool, user, [...new Set(rows.map((row) => row.slug))]);
  const shown = rows.filter((row) => allowed.has(row.slug));
  // How far along: read once, and only when a card is still going.
  const progress = new Map();
  if (shown.some((row) => !outcomeOf(row) && !row.next_at)) {
    const s = settings || await settingsModule(deps).readSettings(pool);
    const p = await progressModule(deps).progressFor(pool, {
      userId, settings: s, config,
      deps: { botSvc: deps.botSvc, creationPhase: deps.creationPhase, domain: null },
      now,
    });
    for (const entry of p.rightNow || []) {
      if (entry.project && entry.number) progress.set(`${entry.project}#${entry.number}`, entry);
    }
  }
  return {
    cards: shown.map((row) => cardOf(row, progress.get(`${row.slug}#${Number(row.issue_number)}`) || null)),
  };
}

// ── The staging demo ──

// The staging bot DM fixture's two cards (staging-messages.js), by the key
// each was sent with: one being built now, one that ended in a proposal. A
// staging copy never runs the bot, so without them no card could be seen
// there. No project stands behind them, so they link nowhere.
const DEMO_CARD_KEYS = Object.freeze({
  working: 'staging-hrbot-activity-working',
  done: 'staging-hrbot-activity-done',
});

/** Pure: the demo cards' state, for the fixture's message ids. Times are relative to `now`. */
function demoState({ working = null, done = null }, now = Date.now()) {
  const ago = (minutes) => new Date(now - minutes * 60 * 1000).toISOString();
  const links = { request: null, proposal: null };
  const cards = [];
  if (working) {
    cards.push({
      messageId: working, startedAt: ago(9), links, state: 'working', stage: 'building',
      step: 3, of: 6, stepName: 'Build it', doing: 'building it', stepSince: ago(4), stepLimitMinutes: 30,
    });
  }
  if (done) {
    cards.push({ messageId: done, startedAt: ago(60 * 26 + 23), links, state: 'done', outcome: 'proposed', endedAt: ago(60 * 26) });
  }
  return { cards };
}

/** The demo cards in `user`'s own bot DM fixture, by the keys they were sent with. */
async function demoCards(pool, user, now = Date.now()) {
  if (!user?.id) return { cards: [] };
  const { rows } = await pool.query(
    `SELECT m.id, m.idempotency_key FROM conversation_messages m
       JOIN users b ON b.id = m.sender_id AND b.username = 'homeroom_bot' AND b.is_synthetic = TRUE
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1 AND cm.status = 'member'
      WHERE m.idempotency_key = ANY($2::text[])`,
    [user.id, Object.values(DEMO_CARD_KEYS)],
  );
  const id = (key) => Number(rows.find((row) => row.idempotency_key === key)?.id) || null;
  return demoState({ working: id(DEMO_CARD_KEYS.working), done: id(DEMO_CARD_KEYS.done) }, now);
}

module.exports = {
  KIND,
  OUTCOMES,
  MAX_CARDS,
  DEMO_CARD_KEYS,
  cardText,
  startCard,
  outcomeOf,
  endedAt,
  linksOf,
  cardOf,
  cardsFor,
  demoState,
  demoCards,
};
