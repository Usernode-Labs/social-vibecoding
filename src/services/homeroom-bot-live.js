'use strict';

// #3146: the Homeroom bot, live — on the apps named in the
// `homeroom_bot_live_apps` setting, and nowhere else.
//
// Slice 1 (homeroom-bot.js) triages every open request and records a verdict
// that nobody sees. On a live app the verdict is ACTED on:
//
//   the first look  one "looking at this" post per issue, ever
//   question        the question, with the default the bot would assume
//   person          a short note saying a person needs to decide, and why
//   empty           a short note saying there is nothing to build, and why;
//                   the issue is never closed by the bot
//   held            a verdict a live cap held back: one line saying why,
//                   posted once while the issue stays held (#3152)
//   follow-up       a reply after it proposed, on the issue or in the
//                   proposal's own discussion: answered, asked about, or
//                   made on the proposal's branch (#3264, see
//                   homeroom-bot-followup.js)
//   ready           one GLM build turn in a dev session of the bot's own,
//                   then the SAME /promote handler a person's Propose button
//                   runs — pull request, staging, checks, vote — and a post
//                   on the issue that links the proposal
//
// Every post goes where the platform's "Generate proposal" already posts: a
// GitHub comment on the issue, and a system message in the issue's Homeroom
// discussion thread. Every post is recorded in homeroom_bot_posts.
//
// ── The loop this must never start ───────────────────────────────────────
//
// A post is issue activity, and issue activity re-queues the issue. Two
// halves keep the bot from answering itself:
//   - its Homeroom posts are SYSTEM messages, which the queue's thread-
//     activity query (msg_type = 'message') has always ignored;
//   - its GitHub comment moves the issue's updated_at, so the run records
//     the comment's own created_at as what it has seen (advanceSeen). It
//     does that only when nobody else posted while it worked: a person's
//     reply mid-turn must still re-queue the issue, even at the price of
//     one more look.
//
// ── Why /promote runs in-process ─────────────────────────────────────────
//
// The bot is a synthetic user, and the auth middleware never gives a
// synthetic user a session, so it cannot call /promote over HTTP the way
// the connector does. It builds its own instance of the votes router, which
// constructs nothing but routes, and dispatches the request into it. There
// stays exactly one implementation of "put a change up for a vote".

const log = require('./logger');

// A staging copy of the platform starts from production's settings, live
// list included. Posting on real GitHub issues and pushing real branches
// from it would be an irreversible side effect of a preview, so on staging a
// live app is triaged exactly as a shadow one.
function isStaging() {
  return process.env.USERNODE_ENV === 'staging';
}

/** Whether the bot acts for real on this app, in this process. */
function isLiveFor(settings, app) {
  if (!settings || settings.mode === 'off' || isStaging()) return false;
  const live = Array.isArray(settings.liveApps) ? settings.liveApps : [];
  return !!app && live.includes(app.slug);
}

const MAX_QUOTED_CHARS = 1500;

function clipText(value, max = MAX_QUOTED_CHARS) {
  const text = String(value || '').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ── What it says ─────────────────────────────────────────────────────────

const REPLY_HINT = 'Reply here (or on the GitHub issue) and it will look again.';

function lookingText() {
  return 'Homeroom bot is looking at this request. It will reply here with a question if '
    + 'something is unclear, a note if a person needs to decide, or a proposal if it can build it.';
}

function questionText({ question, questionDefault }) {
  const lines = [
    'Homeroom bot has a question before it can build this:',
    '',
    clipText(question) || '(no question text)',
  ];
  if (questionDefault) lines.push('', `If nobody answers, it would go with: ${clipText(questionDefault, 500)}`);
  lines.push('', REPLY_HINT);
  return lines.join('\n');
}

function personText({ reason }) {
  return `Homeroom bot thinks a person needs to decide this one: ${clipText(reason) || 'no reason given.'}`;
}

function emptyText({ reason }) {
  return [
    `Homeroom bot couldn't find anything to build in this request: ${clipText(reason) || 'no reason given.'}`,
    '',
    'If there is more to it, add the details here (or on the GitHub issue) and it will look again.',
  ].join('\n');
}

function proposalText({ link, prNumber }) {
  const pr = prNumber ? ` (PR #${prNumber})` : '';
  return `Homeroom bot built this and opened a proposal for the group to vote on${pr}: ${link}`;
}

function buildFailedText(reason) {
  return `Homeroom bot tried to build this but couldn't finish: ${clipText(reason, 400) || 'unknown reason'}. `
    + 'A person could pick it up from here.';
}

// #3152: a verdict a live cap held. One line, so the person who filed the
// issue is not left with silence, and a promise the refresh keeps: a held
// issue is queued again as soon as the cap that held it has room.
function heldText({ cap, verdict, limit }) {
  if (cap === 'proposals_per_app') {
    return `Homeroom bot would build this, but it already has ${limit} proposals open on this app. `
      + 'It will come back to this issue when one of them is merged or closed.';
  }
  const what = verdict === 'question' ? 'a question about' : 'a note on';
  return `Homeroom bot has ${what} this request, but it has already posted ${limit} questions and notes `
    + 'on this app in the last day. It will come back to this issue once some of those are a day old.';
}

function heldKind(cap) {
  return `held_${cap}`;
}

/** The kind of the bot's newest post on this issue, or null. */
async function lastPostKind(pool, appId, issueNumber) {
  const { rows } = await pool.query(
    `SELECT kind FROM homeroom_bot_posts
      WHERE app_id = $1 AND issue_number = $2
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [appId, issueNumber],
  );
  return rows[0]?.kind || null;
}

function proposalLink(domain, appSlug, sessionId) {
  return `https://${domain}/#app/${encodeURIComponent(appSlug)}/dev/proposals/${Number(sessionId)}`;
}

// ── Who filed the issue ──────────────────────────────────────────────────
//
// An issue filed from Homeroom is authored on GitHub by the platform's bot
// account, so GitHub notifies nobody when the Homeroom bot answers it, and a
// system message in the issue's thread notifies nobody either. The answers
// that ask something of the person who filed it name them in the thread and
// put a mention in their notifications (see post).
//
// Found the way the issues route names an issue's creator
// (routes/issues.js): the platform's own issue row, then the feedback
// report, then the body's "**Source:**" line; for an issue opened on
// GitHub, the Homeroom account linked to its author's GitHub login.

// The kinds of post that ask something of the person who filed the issue.
// Not "looking" (a notice, before anything is known) and not a held note
// (nothing for them to do; the bot comes back on its own).
const POSTER_KINDS = new Set(['question', 'person', 'empty', 'proposal', 'build_failed']);

function tagsPoster(kind) {
  return POSTER_KINDS.has(kind);
}

/** The Homeroom username of whoever filed the issue, or null. */
async function issuePoster(pool, { app, repo, issueNumber, issue, botLogin = null }) {
  const { rows } = await pool.query(
    `SELECT username FROM (
       SELECT u.username, 0 AS source_rank
         FROM issues i JOIN users u ON u.id = i.created_by
        WHERE i.app_id = $1 AND i.github_issue_number = $2
       UNION ALL
       SELECT u.username, 1 AS source_rank
         FROM feedback_reports fr JOIN users u ON u.id = fr.user_id
        WHERE fr.issue_owner = $3 AND fr.issue_repo = $4 AND fr.issue_number = $2
     ) creators
     ORDER BY source_rank
     LIMIT 1`,
    [app.id, issueNumber, repo.owner, repo.repo],
  );
  if (rows[0]?.username) return rows[0].username;
  // Required lazily: the route module loads the route layer, and it
  // requires the bot lazily in turn.
  const fromSource = require('../routes/issues').creatorFromSourceLine(issue?.body);
  // The legacy bare "usernode admin" line names nobody.
  if (fromSource && fromSource !== 'admin') return fromSource;
  const login = issue?.user || null;
  if (!login || login.endsWith('[bot]') || login === 'usernode-bot'
      || (botLogin && login.toLowerCase() === String(botLogin).toLowerCase())) {
    return null;
  }
  const { rows: linked } = await pool.query(
    'SELECT username FROM users WHERE LOWER(github_login) = LOWER($1) LIMIT 1',
    [login],
  );
  return linked[0]?.username || null;
}

// ── Posting ──────────────────────────────────────────────────────────────

/**
 * Post one message to both places, and record it.
 *
 * The row is written FIRST: for `looking` the partial unique index makes the
 * insert the claim, so two passes cannot both announce the same issue, and
 * a post that fails half-way still leaves a record of what was attempted.
 * Both sends are best-effort, like "Generate proposal"'s: a failed post
 * never changes the verdict or the build. Returns null when `looking` was
 * already claimed, else what landed.
 */
async function post({
  pool, github, ws, app, repo, issueNumber, kind, runId = null, text,
  msgType = 'system', metadata = null, mention = null, senderId = null, notifications = null,
  proposalSessionId = null,
}) {
  const { rows } = await pool.query(
    `INSERT INTO homeroom_bot_posts (app_id, issue_number, run_id, kind)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (app_id, issue_number) WHERE kind = 'looking' DO NOTHING
     RETURNING id`,
    [app.id, issueNumber, runId, kind],
  );
  if (!rows.length) return null;
  const postId = rows[0].id;
  let comment = null;
  let message = null;
  try {
    comment = await github.createIssueComment(repo.owner, repo.repo, issueNumber, text);
  } catch (err) {
    log.warn('homeroom-bot', 'GitHub comment failed (continuing)', { app: app.slug, issueNumber, kind, err: err.message });
  }
  // The person who filed the issue is named in the thread only. On GitHub a
  // platform username is never written as an @mention (#723: it would
  // notify whoever owns that handle there), and GitHub already notifies the
  // author of an issue opened there about comments on it.
  const threadText = mention ? `@${mention} ${text}` : text;
  try {
    message = await ws.sendSystemMessage(pool, app.id, threadText, msgType, metadata, { type: 'issue', ref: issueNumber });
  } catch (err) {
    log.warn('homeroom-bot', 'Thread post failed (continuing)', { app: app.slug, issueNumber, kind, err: err.message });
  }
  // A system message fires no mention notifications of its own, so the
  // mention row is written here, as the "needs a conversation" prompt does
  // (conversation-prompt.js). Only for the poster: the content handed over
  // is their handle alone, never the message, whose model-written text could
  // name anybody.
  let notified = 0;
  if (mention && message?.id) {
    try {
      const notify = notifications || require('./notifications');
      const rows = await notify.createMentionNotifications(pool, {
        appId: app.id, chatMessageId: message.id, senderId, content: `@${mention}`,
      });
      await Promise.all(rows.map((row) => notify.hydrateAndPush(pool, row)));
      notified = rows.length;
    } catch (err) {
      log.warn('homeroom-bot', 'Poster mention failed (post kept)', { app: app.slug, issueNumber, kind, err: err.message });
    }
  }
  // #3264: a follow-up answers where it was asked. When somebody wrote in
  // the proposal's own discussion, the reply goes there too, as the same
  // kind of system message the promote route writes in that thread.
  let proposalMessage = null;
  if (proposalSessionId) {
    try {
      proposalMessage = await ws.sendSystemMessage(pool, app.id, text, 'system', null, {
        type: 'session', ref: Number(proposalSessionId),
      });
    } catch (err) {
      log.warn('homeroom-bot', 'Proposal thread post failed (continuing)', { app: app.slug, issueNumber, kind, err: err.message });
    }
  }
  await pool.query(
    `UPDATE homeroom_bot_posts SET github_comment_id = $2, thread_message_id = $3
      WHERE id = $1`,
    [postId, comment?.id ?? null, message?.id ?? null],
  ).catch(() => {});
  log.info('homeroom-bot', 'Posted on issue', {
    app: app.slug, issueNumber, kind, github: !!comment, thread: !!message,
    ...(mention ? { mentioned: mention, notified } : {}),
    ...(proposalSessionId ? { proposalThread: !!proposalMessage } : {}),
  });
  return { postId, githubCreatedAt: comment?.created_at || null, github: !!comment, thread: !!message };
}

/**
 * The GitHub account the bot comments as, or null when it cannot be read.
 * `github.getBotUsername()` is async. Used unawaited, the Promise reached
 * the triage seed, where tagging a GitHub comment called .toLowerCase() on
 * it and threw; live mode posts its "looking" comment before triaging, so
 * every live run failed there (rss-reader #24, 2026-09-25). Here it also
 * read as "[object promise]", which no comment author matches.
 */
async function botUsernameOf(github) {
  try {
    const login = await github.getBotUsername?.();
    return typeof login === 'string' && login ? login : null;
  } catch {
    return null;
  }
}

/**
 * Record what the bot has now seen of this issue, so its own GitHub comment
 * does not read as a change on the next refresh — unless somebody else
 * posted while it worked, in which case the issue is left to be looked at
 * again. `since` is when the run read the thread.
 */
async function advanceSeen({
  pool, github, threadContext, app, repo, issueNumber, runId, since, postedAt, proposalSessionId = null,
}) {
  const times = (postedAt || []).filter(Boolean).map((t) => Date.parse(t)).filter(Number.isFinite);
  if (!runId || !times.length) return { advanced: false, reason: 'nothing_posted' };
  const sinceMs = Date.parse(since);
  const [{ comments = [] } = {}, thread, login, proposalThread] = await Promise.all([
    github.fetchIssueComments(repo.owner, repo.repo, issueNumber).catch(() => ({ comments: [] })),
    threadContext.loadIssueThread(pool, app.id, issueNumber),
    botUsernameOf(github),
    // #3264: on a follow-up, the proposal's own discussion is a third place
    // a person can have replied while the bot worked.
    proposalSessionId
      ? threadContext.loadProposalThread(pool, app.id, proposalSessionId)
      : Promise.resolve({ messages: [] }),
  ]);
  const botLogin = String(login || '').toLowerCase();
  const newer = (at) => Number.isFinite(Date.parse(at)) && Date.parse(at) > sinceMs;
  const someoneElse = comments.some((c) => String(c.author || '').toLowerCase() !== botLogin && newer(c.createdAt))
    || (thread?.messages || []).some((m) => newer(m.createdAt))
    || (proposalThread?.messages || []).some((m) => newer(m.createdAt));
  if (someoneElse) {
    log.info('homeroom-bot', 'Someone replied while the bot worked; leaving the issue to be read again', {
      app: app.slug, issueNumber,
    });
    return { advanced: false, reason: 'someone_replied' };
  }
  const seen = new Date(Math.max(...times)).toISOString();
  await pool.query(
    `UPDATE homeroom_bot_runs
        SET thread_seen_at = GREATEST(COALESCE(thread_seen_at, $2::timestamptz), $2::timestamptz),
            posted_at = NOW()
      WHERE id = $1`,
    [runId, seen],
  );
  return { advanced: true, seen };
}

/** The bot's open proposal for this issue, if it already has one. */
async function openBotProposal(pool, botId, appId, issueNumber) {
  const { rows } = await pool.query(
    `SELECT id, status, pr_number FROM chat_sessions
      WHERE app_id = $1 AND user_id = $2 AND $3 = ANY(linked_issues)
        AND status IN ('promoted', 'merging') AND is_headless = FALSE
      ORDER BY id DESC LIMIT 1`,
    [appId, botId, issueNumber],
  );
  return rows[0] || null;
}

// ── Proposing ────────────────────────────────────────────────────────────

let votesRouter = null;

/**
 * Run POST /api/sessions/:id/promote as the bot, in-process. Resolves the
 * status and JSON the route answered with; never throws.
 */
function promoteAsBot({ config, bot, sessionId, router = null }) {
  const target = router || (votesRouter ||= require('../routes/votes').voteRoutes(config));
  const url = `/api/sessions/${Number(sessionId)}/promote`;
  return new Promise((resolve) => {
    let statusCode = 200;
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    const req = {
      method: 'POST', url, originalUrl: url, baseUrl: '', path: url,
      headers: {}, query: {}, params: {}, body: {}, cookies: {},
      // The marker app-access and the membership gate honour for the bot's
      // own session only: it proposes on apps in its live list whether or
      // not it is a collaborator or member there. Never an admin.
      user: {
        id: bot.id, username: bot.username, is_admin: false, is_synthetic: true,
        [require('./app-access').HOMEROOM_BOT_PROPOSAL]: true,
      },
      get() { return undefined; },
      header() { return undefined; },
    };
    const res = {
      statusCode: 200,
      headersSent: false,
      locals: {},
      status(code) { statusCode = code; this.statusCode = code; return this; },
      json(body) { this.headersSent = true; done({ status: statusCode, body }); return this; },
      send(body) { this.headersSent = true; done({ status: statusCode, body }); return this; },
      end() { this.headersSent = true; done({ status: statusCode, body: null }); return this; },
      set() { return this; },
      setHeader() {},
      getHeader() { return undefined; },
    };
    try {
      target.handle(req, res, (err) => done({
        status: err ? 500 : 404,
        body: { error: err ? err.message : 'promote route not found' },
      }));
    } catch (err) {
      done({ status: 500, body: { error: err.message } });
    }
  });
}

function buildPrompt({ seed, buildNote }) {
  return [
    seed,
    '',
    'You are the Homeroom bot, building this request so the app\'s group can review it as a proposal.',
    'Your triage of the request concluded it is ready to build, with this plan:',
    '',
    clipText(buildNote, 4000) || '(no plan recorded: work from the request itself)',
    '',
    'Make exactly that change, and nothing else:',
    '- Read the repository\'s own agent instructions (AGENTS.md, CLAUDE.md) first, and follow them.',
    '- Keep the change as small as the request needs. Do not refactor or tidy unrelated code.',
    '- Run the tests that cover what you changed, if the repository has them.',
    '- Do not commit or push yourself: when you finish, your working tree is committed and pushed for you.',
    '- If you find you cannot make the change safely, stop and say why instead of changing code.',
    'End with a short, plain-language summary of what you changed.',
  ].join('\n');
}

/**
 * Build the change in a dev session of the bot's own and put it up for a
 * vote. Resolves { ok, sessionId, prNumber, costUsd, error }; never throws.
 */
async function buildAndPropose({
  pool, config, bot, app, repo, issueNumber, issue, seed, buildNote,
  turnBudgetMs, model, deps,
}) {
  const { worker, sessions, agentTurn, sessionLifecycle, activeWorkers } = deps;
  const title = clipText(issue?.title || `Issue #${issueNumber}`, 120);
  let session;
  try {
    const { rows } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless,
                                  created_from_issue_number, linked_issues, issue_link_seeded,
                                  session_title, agent_backend, agent_provider, agent_model,
                                  agent_reasoning_effort)
       VALUES ($1, $2, NULL, 'active', FALSE, $3, ARRAY[$3]::int[], TRUE, $4,
               'codex_openrouter', 'openrouter', $5, $6)
       RETURNING *`,
      [app.id, bot.id, issueNumber, `Homeroom bot: #${issueNumber} ${title}`,
        model, config.openrouterDefaultCodexReasoning || 'low'],
    );
    session = rows[0];
    session.app_slug = app.slug;
    session.app_name = app.name;
    session.repo_url = app.repo_url;
    session.app_self_hosted = app.self_hosted;
  } catch (err) {
    return { ok: false, error: `could not open a session: ${err.message}` };
  }

  const fail = async (error) => {
    // The bot's own failed attempt. Archived so it never reads as work
    // under way; its branch stays on GitHub for a person to look at.
    await pool.query(
      `UPDATE chat_sessions SET status = 'archived', archived_at = NOW()
        WHERE id = $1 AND user_id = $2 AND status IN ('active', 'paused')`,
      [session.id, bot.id],
    ).catch(() => {});
    return { ok: false, sessionId: session.id, error };
  };

  let branchName;
  try {
    ({ branchName } = await sessionLifecycle.ensureSessionBranch({
      pool, sessionId: session.id, username: bot.username,
    }));
    session.branch_name = branchName;
  } catch (err) {
    return fail(`could not create its branch: ${err.message}`);
  }

  // The request, as the proposal's pull request metadata reads it: the
  // promote route drafts the title and body from the session's last user
  // message.
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content)
     VALUES ($1, 'user', $2)`,
    [session.id, `Build issue #${issueNumber}: ${title}\n\n${clipText(buildNote, 4000)}`],
  ).catch(() => {});

  let containerName;
  try {
    await worker.ensureWorkerImage();
    containerName = await worker.ensureWorker(session.id, {
      repoOwner: repo.owner, repoName: repo.repo, branchName,
      temporary: true, onProgress: () => {},
    });
  } catch (err) {
    return fail(`the worker would not start: ${err.message}`);
  }

  // The same wall clock a triage turn has, ended the same way.
  let stopped = false;
  let stopping = null;
  const timer = setTimeout(() => {
    stopped = true;
    stopping = Promise.resolve(worker.stopTurn(session.id)).catch(() => {});
  }, turnBudgetMs);
  if (typeof timer.unref === 'function') timer.unref();
  activeWorkers.add(session.id);
  const prompt = buildPrompt({ seed, buildNote });
  let routed;
  try {
    routed = await sessions.runCodexAttemptLoop({
      pool, session, userId: bot.id, config, isCodexSession: true,
      turnModel: model, resumeThreadId: null, mode: 'build',
      telemetryComponent: 'homeroom_bot_build',
      resolveRuntime: () => agentTurn.resolveCodexRuntimeContext({
        pool, session, userId: bot.id, model, resumeThreadId: null, config,
      }),
      dispatchOnce: (ctx) => worker.execInWorker(session.id, {
        mode: 'build',
        prompt,
        model,
        commitMsg: `Homeroom bot: #${issueNumber} ${title}`.slice(0, 120),
        resumeSessionId: null,
        branchName,
        ...(ctx || {}),
        telemetryComponent: 'homeroom_bot_build',
        onProgress: () => {},
      }),
      retryPredicate: () => null,
      sendStatus: async () => {},
      waitForStopped: async () => {},
      prepareRetry: async () => false,
      classifyAttemptStatus: ({ failed }) => (failed ? 'failed' : 'completed'),
      containerName,
    });
  } catch (err) {
    routed = { error: `dispatch: ${err.message}` };
  } finally {
    clearTimeout(timer);
    if (stopping) await stopping;
    activeWorkers.delete(session.id);
    await pool.query(
      "UPDATE chat_sessions SET status = 'paused', last_activity_at = NOW() WHERE id = $1 AND status = 'active'",
      [session.id],
    ).catch(() => {});
  }

  const result = (routed && routed.result) || {};
  const costUsd = Number.isFinite(routed && routed.estimatedCostUsd) ? routed.estimatedCostUsd : null;
  if (stopped) return { ...(await fail('the build ran past its time limit')), costUsd };
  if (routed?.error) return { ...(await fail(`the build turn failed (${routed.error})`)), costUsd };
  if (!result.pushOk || !(Number(result.ahead) > 0)) {
    return { ...(await fail('the build produced no change to propose')), costUsd };
  }

  const promoted = await promoteAsBot({ config, bot, sessionId: session.id, router: deps.votesRouter || null });
  if (promoted.status !== 200 || !promoted.body?.ok) {
    const why = promoted.body?.error || promoted.body?.message || `promotion answered ${promoted.status}`;
    // Built but not proposed: the branch holds the work. Left paused, not
    // archived, so a person can open the session and propose it.
    log.warn('homeroom-bot', 'Built but could not propose', { app: app.slug, issueNumber, sessionId: session.id, why });
    return { ok: false, sessionId: session.id, costUsd, error: `the change was built but could not be proposed: ${why}` };
  }
  return { ok: true, sessionId: session.id, prNumber: promoted.body.prNumber || null, costUsd };
}

module.exports = {
  isLiveFor,
  isStaging,
  lookingText,
  questionText,
  personText,
  emptyText,
  proposalText,
  buildFailedText,
  heldText,
  heldKind,
  lastPostKind,
  proposalLink,
  tagsPoster,
  issuePoster,
  post,
  advanceSeen,
  botUsernameOf,
  openBotProposal,
  promoteAsBot,
  buildPrompt,
  buildAndPropose,
};
