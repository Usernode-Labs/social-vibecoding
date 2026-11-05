'use strict';

// A REQUEST'S PLAN, ON ITS PAGE, FOR EVERYONE (3 Nov 2026, #6207/#6210).
//
// Homeroom bot's plan for a complicated change used to be a card in its
// requester's chat with the bot, and its Build it only there. The plan is
// now public: the request's page draws it for anyone who can read the
// request, and any member may press Build it (Evan, 3 Nov 2026):
//
//   - the presser's weekly allowance pays for the build (the run's payer);
//   - the requester is told, in the request's thread, by a mention;
//   - the group's vote is still the gate on what ships;
//   - while a change to the plan has been asked for and the next plan is not
//     out yet (a newer look of the request is queued or running), Build it
//     says so and waits, rather than building the old plan.
//
// The requester's own press goes through the card in their chat when it is
// still open (homeroom-bot-dm.js decidePlanTap), so its card reads Built and
// the request's card moves under it as before.
//
//   GET  /api/apps/:slug/issues/:number/bot-plan         readPlan
//   POST /api/apps/:slug/issues/:number/bot-plan/build   buildPlan (members)
//
// (routes/request-specs.js; the plan is the request's other plan, beside the
// specs people post.)

const log = require('./logger');

const dm = () => require('./homeroom-bot-dm');
const bot = () => require('./homeroom-bot');

/** The newest complicated plan of a request, with what it waits for. */
async function newestPlan(pool, appId, issueNumber) {
  const { rows: [run] = [] } = await pool.query(
    `SELECT r.id, r.plan, r.awaiting_go_at, r.go_ahead_at, r.build_ok, r.build_session_id, r.proposal_session_id
       FROM homeroom_bot_runs r
      WHERE r.app_id = $1 AND r.issue_number = $2 AND r.mode = 'live'
        AND r.plan IS NOT NULL AND (r.plan->>'complicated')::boolean IS TRUE
        AND (r.awaiting_go_at IS NOT NULL OR r.go_ahead_at IS NOT NULL)
      ORDER BY r.id DESC LIMIT 1`,
    [appId, issueNumber],
  );
  return run || null;
}

/**
 * Whether a newer look of the request is queued or running since the plan
 * was put up: somebody asked for a change to it (a reply on the request),
 * and the next plan is on its way.
 */
async function planChanging(pool, appId, issueNumber, since) {
  if (!since) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM homeroom_bot_queue
      WHERE app_id = $1 AND issue_number = $2
        AND (started_at IS NOT NULL OR enqueued_at > $3)
      LIMIT 1`,
    [appId, issueNumber, since],
  );
  return rows.length > 0;
}

/** Pure: the card's lines, the plan's own when it carries them (#6220), else its bullets. */
function cardOf(plan) {
  const card = plan && typeof plan.card === 'object' && plan.card ? plan.card : null;
  const lines = Array.isArray(card?.lines)
    ? card.lines.filter((l) => l && typeof l.text === 'string' && l.text.trim())
      .map((l) => ({ n: Number.isInteger(l.n) && l.n > 0 ? l.n : null, text: String(l.text).trim() }))
    : [];
  if (lines.length) return { summary: typeof card.summary === 'string' ? card.summary.trim() : '', lines };
  const bullets = Array.isArray(plan?.bullets) ? plan.bullets.filter((b) => typeof b === 'string' && b.trim()) : [];
  return { summary: '', lines: bullets.map((text) => ({ n: null, text: text.trim() })) };
}

/** Pure: the plan's choices as the card offers them. */
// A plan's question is { question, answers }, its suggested answer first
// (homeroom-bot.js planQuestion).
function choicesOf(plan) {
  return (Array.isArray(plan?.questions) ? plan.questions : []).slice(0, 2).map((q) => ({
    question: String(q?.question || ''),
    answers: (Array.isArray(q?.answers) ? q.answers : []).filter((o) => typeof o === 'string' && o.trim()).slice(0, 4),
  })).filter((q) => q.question && q.answers.length);
}

/**
 * The plan on a request, as its page draws it for `viewer` (a signed-in
 * user, or null): { plan: null } when there is none, else { plan: { runId,
 * state, title, summary, lines, choices, spec, requester, mine, changing } }.
 * `state` is 'waiting' (for Build it) or 'building' (gone ahead with).
 */
async function readPlan(pool, { app, issueNumber, viewer = null }) {
  const run = await newestPlan(pool, app.id, issueNumber);
  if (!run) return { plan: null };
  const waiting = !!run.awaiting_go_at && run.build_ok == null && !run.build_session_id;
  const state = waiting ? 'waiting' : run.go_ahead_at ? 'building' : null;
  if (!state) return { plan: null };
  const requester = await dm().requesterOf(pool, app.id, issueNumber).catch(() => null);
  const changing = waiting ? await planChanging(pool, app.id, issueNumber, run.awaiting_go_at).catch(() => false) : false;
  let title = null;
  const spec = run.plan?.spec && Number(run.plan.spec.sessionId) > 0
    ? { sessionId: Number(run.plan.spec.sessionId), version: Number(run.plan.spec.version) || null } : null;
  if (spec?.version) {
    const { rows: [row] = [] } = await pool.query(
      'SELECT left(content, 2000) AS head, length(content) AS chars FROM chat_session_specs WHERE session_id = $1 AND version = $2',
      [spec.sessionId, spec.version],
    ).catch(() => ({ rows: [] }));
    if (row) { title = require('./request-specs').specTitle(row.head) || null; spec.chars = Number(row.chars) || null; }
  }
  // The bot's post of this plan on the request, which Change something
  // quotes in the reply box: a reply quoting it is a change to the plan.
  const { rows: [post] = [] } = await pool.query(
    `SELECT thread_message_id FROM homeroom_bot_posts
      WHERE run_id = $1 AND kind = 'spec' AND thread_message_id IS NOT NULL
      ORDER BY id DESC LIMIT 1`,
    [run.id],
  ).catch(() => ({ rows: [] }));
  const card = cardOf(run.plan);
  return {
    plan: {
      runId: Number(run.id),
      state,
      title,
      summary: card.summary,
      lines: card.lines,
      choices: waiting ? choicesOf(run.plan) : [],
      spec,
      postId: Number(post?.thread_message_id) || null,
      requester: requester?.username || null,
      mine: !!viewer && !!requester && Number(requester.userId) === Number(viewer.id),
      changing,
    },
  };
}

/**
 * Build it, pressed on the request's page by `user`, a member (the route's
 * gate). Resolves { ok: true } or { ok: false, status, error }:
 * `plan_gone` (no plan waits), `plan_changing` (a change to it is on its
 * way), `allowance` (the presser's building time this week is used up).
 */
async function buildPlan(pool, { app, issueNumber, user, runId = null, answers = [], deps = {} }) {
  const run = await newestPlan(pool, app.id, issueNumber);
  const waiting = run && !!run.awaiting_go_at && run.build_ok == null && !run.build_session_id;
  if (!waiting || (runId && Number(runId) !== Number(run.id))) return { ok: false, status: 409, error: 'plan_gone' };
  if (await planChanging(pool, app.id, issueNumber, run.awaiting_go_at)) return { ok: false, status: 409, error: 'plan_changing' };
  const dmSvc = deps.dm || dm();
  const botSvc = deps.botSvc || bot();
  const picks = (Array.isArray(answers) ? answers : []).slice(0, 2).map((a) => (typeof a === 'string' ? a : null));
  const requester = await dmSvc.requesterOf(pool, app.id, issueNumber).catch(() => null);
  const mine = !!requester && Number(requester.userId) === Number(user.id);
  if (mine) {
    // Their own card, when it is still open: decided once, everywhere.
    const { rows: [action] = [] } = await pool.query(
      `SELECT a.* FROM homeroom_bot_dm_messages d
         JOIN homeroom_bot_dm_actions a ON a.message_id = d.message_id
        WHERE d.run_id = $1 AND d.kind = 'plan' AND d.user_id = $2 AND a.kind = 'build_plan' AND a.status = 'open'
        ORDER BY d.message_id DESC LIMIT 1`,
      [run.id, user.id],
    );
    if (action) {
      const went = await dmSvc.decidePlanTap(pool, { user, action, choice: 'build', answers: picks, deps });
      return went.ok ? { ok: true } : { ok: false, status: went.status || 409, error: went.error || 'plan_gone' };
    }
  } else {
    // Anybody else's press is paid from their own week.
    const settings = await botSvc.readSettings(pool);
    if (await dmSvc.overWeeklyAllowance(pool, settings, user.id)) return { ok: false, status: 409, error: 'allowance' };
    await pool.query('UPDATE homeroom_bot_runs SET payer_user_id = $2, charged = TRUE WHERE id = $1', [run.id, user.id]);
  }
  const went = await botSvc.goAhead(pool, { runId: Number(run.id), answers: picks });
  if (!went.ok) return { ok: false, status: 409, error: 'plan_gone' };
  await dmSvc.markPlanBuilt(pool, Number(run.id), { chosen: went.chosen, ws: deps.ws || null }).catch(() => {});
  if (!mine && requester?.username) await tellRequester(pool, { app, issueNumber, user, requester, deps });
  try { require('./bot-work-changed').noteWorkChanged(requester?.userId || user.id, deps); } catch { /* the tray re-reads on its own */ }
  log.info('homeroom-bot-public-plan', 'Build it, pressed on the request\'s page', {
    app: app.slug, issueNumber, runId: Number(run.id), byRequester: mine,
  });
  return { ok: true };
}

/**
 * Somebody else pressed Build it on the requester's plan: said in the
 * request's own thread (never the project's channel), naming them, so their
 * bell rings as for any mention. Never throws.
 */
async function tellRequester(pool, { app, issueNumber, user, requester, deps = {} }) {
  const text = `@${user.username} pressed Build it on @${requester.username}'s plan. Homeroom bot is building it now, and it goes to a vote when it is ready.`;
  try {
    const ws = deps.wsSvc || require('./ws');
    await ws.sendSystemMessage(pool, app.id, text, 'system', { homeroomBotBuildIt: true }, { type: 'issue', ref: Number(issueNumber) });
    await require('./notifications').notifyIssueMentions(pool, { appId: app.id, issueNumber, authorId: user.id, text: `@${requester.username}` });
  } catch (err) {
    log.warn('homeroom-bot-public-plan', 'Built a plan, but could not tell its requester', { app: app.slug, issueNumber, err: err.message });
  }
}

module.exports = { readPlan, buildPlan, cardOf, choicesOf };
