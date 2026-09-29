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
//   blocked         the spec found a ready request impossible as written:
//                   nothing is built, and the post says why
//   ready           a spec, then one GLM build turn in a dev session of the
//                   bot's own, then the SAME /promote handler a person's
//                   Propose button runs — pull request, staging, checks,
//                   vote — and a post on the issue that links the proposal.
//                   The spec is posted on the issue as soon as it is written
//                   and on the proposal once it is up, for reference: the
//                   build does not wait for anybody to approve it
//
// Every post goes to two places: a GitHub comment on the issue, and a
// message from the bot's own user in the issue's Homeroom discussion thread
// (an ordinary message since #3288, drawn as its bubble; it used to be a
// system line). Every post is recorded in homeroom_bot_posts.
//
// ── The loop this must never start ───────────────────────────────────────
//
// A post is issue activity, and issue activity re-queues the issue. Two
// halves keep the bot from answering itself:
//   - its Homeroom posts come from a synthetic user, and every "did a person
//     reply?" check leaves synthetic authors out: the queue's thread-activity
//     queries by is_synthetic, advanceSeen and the follow-up by BOT_USERNAME.
//     They are written by ws.sendBotMessage, which, unlike a person's post,
//     never fires the bot's own wake hooks;
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
const { stripSpecWrapperFence } = require('./spec-format');
const { agentApiFailure } = require('./agent-result-text');
const { SPEC_DESIGN_BRIEF } = require('./prompts');

// A staging copy of the platform starts from production's settings, live
// list included. Posting on real GitHub issues and pushing real branches
// from it would be an irreversible side effect of a preview, so on staging a
// live app is triaged exactly as a shadow one.
// The bot's platform username. Its Homeroom thread posts are ordinary
// messages from this user (#3288), so every "did a person reply?" check
// leaves this author out. The GitHub login it comments as is a different
// name (github.getBotUsername()).
const BOT_USERNAME = 'homeroom_bot';

function isOwnMessage(m) {
  return String(m?.author || '').toLowerCase() === BOT_USERNAME;
}

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

// ── The spec ─────────────────────────────────────────────────────────────
//
// Before it builds a ready request, the bot writes a spec for it, the way a
// person's dev session does: a read-only scout turn in the build's own
// session, whose final message IS the spec, stored as that session's spec
// doc (spec_md and a numbered version). The build then works from it. On a
// live app it is posted on the issue as soon as it exists, and on the
// proposal once it is up. For reference only: nothing waits on it.

// The spec gets a clock of its own, shorter than a build's: the triage has
// already read the code, so this is writing down a plan, not discovering one.
const SPEC_TURN_MAX_MS = 10 * 60 * 1000;
// GitHub refuses a comment over 65,536 characters.
const MAX_SPEC_COMMENT_CHARS = 60_000;

function specPrompt({ seed, buildNote }) {
  return [
    seed,
    '',
    'You are the Homeroom bot. Your triage of this request concluded it is ready to build, with this plan:',
    '',
    clipText(buildNote, 4000) || '(no plan recorded: work from the request itself)',
    '',
    'Before it is built, write the SPEC for it: a markdown document the app\'s group can read, and that the build',
    'that follows will work from. You are running in PLAN MODE: read and search the repository with read-only',
    'shell commands (for example `rg`, `ls`, `sed -n`, `cat`), but do not edit, create, delete, commit, or push',
    'anything; anything this run changes in the repository is discarded when it ends.',
    '',
    'The spec must be:',
    '- Grounded in the real code: name actual files and describe current behaviour, not guesses.',
    '- Two halves under these exact H2 headings, in this order: "## User-facing changes" then',
    '  "## Technical implementation". Start with a "# " title line; keep everything else inside one of the',
    '  two halves, and use ### or deeper for any other heading. "User-facing changes" is for a non-developer:',
    '  what people will see and do differently, no file paths or code. "Technical implementation" holds the',
    '  files, data, edge cases and tests.',
    '- As small as the request: the plan above, no refactoring or extra features.',
    `- ${SPEC_DESIGN_BRIEF}`,
    '',
    'Nobody is available to answer questions: this run is unattended, and the build starts as soon as you finish.',
    'Where something is open, make the sensible choice yourself. End the "User-facing changes" half with a',
    '"### Assumptions" subsection: every assumption listed in the plan above and every choice you made, one',
    'plain-language line each, so the group can see them and object in review. Do not write a "### Questions"',
    'section.',
    '',
    'There is one exception. If reading the code shows the request is IMPOSSIBLE as written (it depends on',
    'something that does not exist and cannot be built here, or the code contradicts what it asks), do not write',
    'a spec: reply with a single line that starts with "BLOCKED:" and says why in one sentence. That is for',
    'impossible only. A choice, however unsure you are about it, is an assumption, never a BLOCKED.',
    '',
    'Otherwise your final message must be ONLY the markdown spec, as raw markdown: no preamble, and not wrapped',
    'in a code fence. It is captured verbatim.',
  ].join('\n');
}

// The spec turn's one way out: a first line "BLOCKED: <why>".
const BLOCKED_RE = /^\s*BLOCKED:\s*(.+)/i;

/** Why the spec turn found the request impossible, or null. */
function specBlocked(text) {
  const firstLine = String(text || '').trim().split('\n')[0] || '';
  const m = BLOCKED_RE.exec(firstLine);
  return m ? clipText(m[1], 500) : null;
}

function blockedText(reason) {
  return [
    'Homeroom bot started on this and found it cannot be built as asked:',
    '',
    clipText(reason, 500) || '(no reason given)',
    '',
    REPLY_HINT,
  ].join('\n');
}

/** The spec's "# " title, as routes/sessions.js extractSpecTitle reads it. */
function specTitle(spec) {
  const lines = String(spec || '').split('\n');
  for (let i = 0; i < Math.min(lines.length, 30); i += 1) {
    const line = lines[i].trim();
    if (line.startsWith('# ') && line.slice(2).trim()) return line.slice(2).trim().slice(0, 120);
  }
  return null;
}

/** The card's preview: the body after the title, as the share route cuts it. */
function specSnippet(spec, title) {
  const lines = String(spec || '').split('\n');
  let start = 0;
  if (title) {
    while (start < lines.length && !lines[start].trim()) start += 1;
    if (start < lines.length && lines[start].trim().startsWith('# ')) start += 1;
  }
  while (start < lines.length && !lines[start].trim()) start += 1;
  return lines.slice(start).join('\n').slice(0, 280);
}

/** The spec as a GitHub comment: said what it is for, then the document. */
function specCommentText(spec) {
  return [
    'Homeroom bot wrote a spec for this request and is building it now. It is here for reference: nobody needs '
      + 'to approve it, and the proposal will be linked here when it is up.',
    '',
    '<details><summary>The spec</summary>',
    '',
    clipText(spec, MAX_SPEC_COMMENT_CHARS),
    '',
    '</details>',
  ].join('\n');
}

/**
 * The spec as a thread message: the same spec card a person's "Share"
 * posts (metadata.specShare), opening the version the build worked from.
 */
function specCard({ sessionId, version, spec, bot, proposed = false }) {
  const title = specTitle(spec);
  const content = proposed
    ? `📋 The spec this proposal was built from${title ? `: "${title}"` : ''}.`
    : `📋 Homeroom bot's spec for this request${title ? `: "${title}"` : ''}. It is building it now; this is for reference, not for approval.`;
  return {
    content,
    msgType: 'spec_share',
    metadata: {
      specShare: {
        sessionId: Number(sessionId),
        version: Number(version),
        builtAt: null,
        commitSha: null,
        prNumber: null,
        title,
        snippet: specSnippet(spec, title),
        totalChars: String(spec || '').length,
        sharedBy: { id: bot.id, username: bot.username },
      },
    },
  };
}

/**
 * Make the spec version readable by everyone who can see the card: a
 * version is private to its session's owner until it is shared, exactly as
 * the share route marks it.
 */
async function shareSpecVersion(pool, sessionId, version) {
  await pool.query(
    `UPDATE chat_session_specs SET shared_to_group_at = NOW()
      WHERE session_id = $1 AND version = $2 AND shared_to_group_at IS NULL`,
    [Number(sessionId), Number(version)],
  );
}

/** The spec card in the proposal's own discussion, once it is up. */
async function postSpecOnProposal({ pool, ws, app, bot, sessionId, version, spec }) {
  if (!spec || !version || !sessionId) return null;
  await shareSpecVersion(pool, sessionId, version);
  const card = specCard({ sessionId, version, spec, bot, proposed: true });
  return ws.sendBotMessage(pool, app.id, {
    user: bot, content: card.content, metadata: card.metadata,
    thread: { type: 'session', ref: Number(sessionId) }, msgType: card.msgType,
  });
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

// The kinds of post that tag people: whoever filed the issue and whoever
// took part in its discussion (see mentionTargets). Every answer, the spec
// and the proposal, and every follow-up on the proposal. Not "looking" (a
// notice, before anything is known) and not a held note (nothing for them
// to do; the bot comes back on its own).
const TAGGING_KINDS = new Set([
  'question', 'person', 'empty', 'proposal', 'build_failed', 'blocked', 'spec',
  'followup_answer', 'followup_ask', 'followup_revise', 'followup_person', 'followup_failed',
]);

function tagsPoster(kind) {
  return TAGGING_KINDS.has(kind);
}

// At most this many people are tagged on one post: whoever filed it, then
// the earliest to join in. A crowded issue does not become a crowded inbox.
const MAX_MENTIONS = 6;

function isOtherBotLogin(login, botLogin) {
  const l = String(login || '').toLowerCase();
  return !l || l.endsWith('[bot]') || l === 'usernode-bot' || (botLogin && l === String(botLogin).toLowerCase());
}

/**
 * Who a post on this issue tags, as Homeroom usernames, in order: whoever
 * filed it, then everybody who wrote in its Homeroom thread (and the
 * proposal's, when there is one) or commented on GitHub from an account
 * linked to Homeroom, earliest first. Never the bot or another synthetic
 * account, never somebody who asked the bot to stop tagging them here
 * (homeroom_bot_mention_optouts), and at most MAX_MENTIONS.
 */
async function mentionTargets({
  pool, github, app, repo, issueNumber, issue, botLogin = null, bot = null, proposalSessionId = null,
}) {
  const names = [];
  const poster = await issuePoster(pool, { app, repo, issueNumber, issue, botLogin }).catch(() => null);
  if (poster) names.push(poster);
  const { rows: talked } = await pool.query(
    `SELECT u.username, MIN(m.id) AS first_id
       FROM chat_messages m
       JOIN users u ON u.id = m.user_id
      WHERE m.app_id = $1 AND m.msg_type = 'message' AND m.deleted_at IS NULL
        AND u.is_synthetic = FALSE
        AND ((m.thread_type = 'issue' AND m.thread_ref = $2)
             OR ($3::int IS NOT NULL AND m.thread_type = 'session' AND m.thread_ref = $3::int))
      GROUP BY u.username
      ORDER BY first_id`,
    [app.id, issueNumber, proposalSessionId == null ? null : Number(proposalSessionId)],
  );
  names.push(...talked.map((r) => r.username));
  let comments = [];
  try {
    ({ comments = [] } = await github.fetchIssueComments(repo.owner, repo.repo, issueNumber));
  } catch {
    comments = [];
  }
  const logins = [...new Set(comments.map((c) => String(c.author || '')).filter((l) => !isOtherBotLogin(l, botLogin))
    .map((l) => l.toLowerCase()))];
  if (logins.length) {
    const { rows: linked } = await pool.query(
      `SELECT username, LOWER(github_login) AS login FROM users
        WHERE LOWER(github_login) = ANY($1::text[]) AND is_synthetic = FALSE`,
      [logins],
    );
    const byLogin = new Map(linked.map((r) => [r.login, r.username]));
    for (const l of logins) if (byLogin.has(l)) names.push(byLogin.get(l));
  }
  const { rows: out } = await pool.query(
    `SELECT u.username FROM homeroom_bot_mention_optouts o JOIN users u ON u.id = o.user_id
      WHERE o.app_id = $1 AND o.issue_number = $2`,
    [app.id, issueNumber],
  );
  const optedOut = new Set(out.map((r) => r.username.toLowerCase()));
  const botName = String(bot?.username || BOT_USERNAME).toLowerCase();
  const seen = new Set();
  const targets = [];
  for (const name of names) {
    const key = String(name || '').toLowerCase();
    if (!key || key === botName || key === BOT_USERNAME || optedOut.has(key) || seen.has(key)) continue;
    seen.add(key);
    targets.push(name);
    if (targets.length >= MAX_MENTIONS) break;
  }
  return targets;
}

/** The names a triage or follow-up turn read asking the bot to stop tagging them. */
function parseStopMentioning(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((n) => (typeof n === 'string' ? n.replace(/^@/, '').trim() : ''))
    .filter((n) => /^[A-Za-z0-9_.-]{1,64}$/.test(n)))].slice(0, 20);
}

/**
 * Of the names a turn read, the people who actually wrote on this issue: a
 * Homeroom username from the issue's thread (or the proposal's, on a
 * follow-up), or a GitHub login linked to a Homeroom account that commented
 * on the issue. Only they can change whether the bot tags them here, and
 * only for themselves. Resolves Map(user id → username).
 */
async function issueAuthorsNamed({ pool, github, app, repo, issueNumber, names, proposalSessionId = null }) {
  const asked = [...new Set((names || []).map((n) => String(n || '').replace(/^@/, '').trim().toLowerCase()).filter(Boolean))];
  if (!asked.length) return new Map();
  const { rows: fromThread } = await pool.query(
    `SELECT DISTINCT u.id, u.username
       FROM chat_messages m
       JOIN users u ON u.id = m.user_id
      WHERE m.app_id = $1 AND m.msg_type = 'message' AND m.deleted_at IS NULL
        AND u.is_synthetic = FALSE AND LOWER(u.username) = ANY($4::text[])
        AND ((m.thread_type = 'issue' AND m.thread_ref = $2)
             OR ($3::int IS NOT NULL AND m.thread_type = 'session' AND m.thread_ref = $3::int))`,
    [app.id, issueNumber, proposalSessionId == null ? null : Number(proposalSessionId), asked],
  );
  let fromGithub = [];
  try {
    const { comments = [] } = await github.fetchIssueComments(repo.owner, repo.repo, issueNumber);
    const logins = [...new Set(comments.map((c) => String(c.author || '').toLowerCase()))].filter((l) => asked.includes(l));
    if (logins.length) {
      ({ rows: fromGithub } = await pool.query(
        `SELECT id, username FROM users WHERE LOWER(github_login) = ANY($1::text[]) AND is_synthetic = FALSE`,
        [logins],
      ));
    }
  } catch {
    fromGithub = [];
  }
  return new Map([...fromThread, ...fromGithub].map((u) => [u.id, u.username]));
}

/**
 * The people a triage or follow-up turn read asking the bot to stop tagging
 * them on this issue, recorded so no later post does. Resolves the
 * usernames recorded.
 */
async function recordMentionOptOuts({
  pool, github, app, repo, issueNumber, names, runId = null, proposalSessionId = null,
}) {
  const people = await issueAuthorsNamed({ pool, github, app, repo, issueNumber, names, proposalSessionId });
  if (!people.size) return [];
  await pool.query(
    `INSERT INTO homeroom_bot_mention_optouts (app_id, issue_number, user_id, run_id)
     SELECT $1, $2, u, $4 FROM UNNEST($3::int[]) AS u
     ON CONFLICT (app_id, issue_number, user_id) DO NOTHING`,
    [app.id, issueNumber, [...people.keys()], runId],
  );
  log.info('homeroom-bot', 'Stopped tagging people who asked', { app: app.slug, issueNumber, people: [...people.values()] });
  return [...people.values()];
}

/**
 * The people a turn read asking to be tagged again on this issue, after
 * they had asked it to stop. The same rule: only somebody who wrote there,
 * only for themselves. Resolves the usernames tagged again.
 */
async function clearMentionOptOuts({
  pool, github, app, repo, issueNumber, names, proposalSessionId = null,
}) {
  const people = await issueAuthorsNamed({ pool, github, app, repo, issueNumber, names, proposalSessionId });
  if (!people.size) return [];
  const { rows } = await pool.query(
    `DELETE FROM homeroom_bot_mention_optouts
      WHERE app_id = $1 AND issue_number = $2 AND user_id = ANY($3::int[])
      RETURNING user_id`,
    [app.id, issueNumber, [...people.keys()]],
  );
  const back = rows.map((r) => people.get(r.user_id));
  if (back.length) log.info('homeroom-bot', 'Tagging people again who asked', { app: app.slug, issueNumber, people: back });
  return back;
}

/**
 * What a turn read about tagging, applied before anything from that run is
 * posted. A name in both lists is left as it was: the turn could not tell
 * which ask came last, and the prompt forbids listing anybody twice.
 */
async function applyMentionAsks({
  pool, github, app, repo, issueNumber, stop = [], resume = [], runId = null, proposalSessionId = null,
}) {
  const lower = (list) => new Set((list || []).map((n) => String(n).toLowerCase()));
  const both = [...lower(stop)].filter((n) => lower(resume).has(n));
  const keep = (list) => (list || []).filter((n) => !both.includes(String(n).toLowerCase()));
  const stopped = keep(stop).length
    ? await recordMentionOptOuts({ pool, github, app, repo, issueNumber, names: keep(stop), runId, proposalSessionId })
    : [];
  const resumed = keep(resume).length
    ? await clearMentionOptOuts({ pool, github, app, repo, issueNumber, names: keep(resume), proposalSessionId })
    : [];
  return { stopped, resumed };
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
  msgType = 'system', metadata = null, mention = null, mentions = null, senderId = null, notifications = null,
  proposalSessionId = null, sender = null, threadMessage = null,
}) {
  // Everybody this post tags (mentionTargets); `mention` is the one-person
  // form the older callers pass.
  const tagged = [...new Set([...(mentions || []), ...(mention ? [mention] : [])].filter(Boolean))];
  const handles = tagged.map((n) => `@${n}`).join(' ');
  // #3288: with a sender (the bot's own user), the thread posts are ordinary
  // messages from it, drawn as its bubbles. `msgType` then no longer picks
  // the row's kind: the proposal link is a message whose `metadata.vote`
  // the chat hangs the vote card on. Without one, the old system line.
  const inThread = (content, thread, meta = metadata, kindOfRow = msgType) => (sender
    ? ws.sendBotMessage(pool, app.id, { user: sender, content, metadata: meta, thread })
    : ws.sendSystemMessage(pool, app.id, content, kindOfRow, meta, thread));
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
  const threadText = handles ? `${handles} ${text}` : text;
  try {
    // A spec is a card in the thread (its full text is on GitHub, and one
    // click away from the card), not a wall of markdown in a chat bubble.
    message = threadMessage && sender
      ? await ws.sendBotMessage(pool, app.id, {
        user: sender, content: handles ? `${handles} ${threadMessage.content}` : threadMessage.content,
        metadata: threadMessage.metadata,
        thread: { type: 'issue', ref: issueNumber }, msgType: threadMessage.msgType,
      })
      : await inThread(threadText, { type: 'issue', ref: issueNumber });
  } catch (err) {
    log.warn('homeroom-bot', 'Thread post failed (continuing)', { app: app.slug, issueNumber, kind, err: err.message });
  }
  // A system message fires no mention notifications of its own, so the
  // mention row is written here, as the "needs a conversation" prompt does
  // (conversation-prompt.js). Only for the people it tags: the content
  // handed over is their handles alone, never the message, whose
  // model-written text could name anybody.
  let notified = 0;
  if (handles && message?.id) {
    try {
      const notify = notifications || require('./notifications');
      const rows = await notify.createMentionNotifications(pool, {
        appId: app.id, chatMessageId: message.id, senderId: senderId ?? sender?.id ?? null, content: handles,
      });
      await Promise.all(rows.map((row) => notify.hydrateAndPush(pool, row)));
      notified = rows.length;
    } catch (err) {
      log.warn('homeroom-bot', 'Poster mention failed (post kept)', { app: app.slug, issueNumber, kind, err: err.message });
    }
  }
  // #3264: a follow-up answers where it was asked. When somebody wrote in
  // the proposal's own discussion, the reply goes there too, as a message
  // from the bot (#3288).
  let proposalMessage = null;
  if (proposalSessionId) {
    try {
      proposalMessage = await inThread(text, { type: 'session', ref: Number(proposalSessionId) }, null, 'system');
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
    ...(tagged.length ? { mentioned: tagged, notified } : {}),
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
    || (thread?.messages || []).some((m) => !isOwnMessage(m) && newer(m.createdAt))
    || (proposalThread?.messages || []).some((m) => !isOwnMessage(m) && newer(m.createdAt));
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

function buildPrompt({ seed, buildNote, spec = null }) {
  const specBlock = spec
    ? [
      '',
      '==== SPEC (written for this request just before this build; authoritative for what to build) ====',
      '',
      String(spec),
      '',
      '==== END SPEC ====',
      '',
      'Build what the SPEC describes. The plan above is the triage\'s short version of it: where they differ,',
      'the spec wins. The repository\'s own agent instructions still come first.',
    ]
    : [];
  return [
    seed,
    '',
    'You are the Homeroom bot, building this request so the app\'s group can review it as a proposal.',
    'Your triage of the request concluded it is ready to build, with this plan:',
    '',
    clipText(buildNote, 4000) || '(no plan recorded: work from the request itself)',
    ...specBlock,
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
/**
 * The spec turn: read-only, in the build's own session and worker, its
 * final message stored as the session's spec doc. Resolves
 * { ok, specMd, version, costUsd, error, stopped }; never throws. A spec
 * that fails is not a failed build: the build goes ahead from the plan.
 */
async function draftSpec({
  pool, config, bot, session, containerName, seed, buildNote, turnBudgetMs, model, deps,
}) {
  const { worker, sessions, agentTurn, activeWorkers } = deps;
  const budgetMs = Math.min(turnBudgetMs, SPEC_TURN_MAX_MS);
  let stopped = false;
  let stopping = null;
  const timer = setTimeout(() => {
    stopped = true;
    stopping = Promise.resolve(worker.stopTurn(session.id)).catch(() => {});
  }, budgetMs);
  if (typeof timer.unref === 'function') timer.unref();
  activeWorkers.add(session.id);
  const prompt = specPrompt({ seed, buildNote });
  let routed;
  try {
    routed = await sessions.runCodexAttemptLoop({
      pool, session, userId: bot.id, config, isCodexSession: true,
      turnModel: model, resumeThreadId: null, mode: 'scout',
      telemetryComponent: 'homeroom_bot_spec',
      resolveRuntime: () => agentTurn.resolveCodexRuntimeContext({
        pool, session, userId: bot.id, model, resumeThreadId: null, config,
      }),
      dispatchOnce: (ctx) => worker.execInWorker(session.id, {
        mode: 'scout',
        prompt,
        model,
        commitMsg: '',
        resumeSessionId: null,
        branchName: session.branch_name,
        ...(ctx || {}),
        telemetryComponent: 'homeroom_bot_spec',
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
  }
  const costUsd = Number.isFinite(routed && routed.estimatedCostUsd) ? routed.estimatedCostUsd : null;
  if (stopped) return { ok: false, stopped: true, costUsd, error: 'the spec ran past its time limit' };
  if (!routed) return { ok: false, costUsd, error: 'the spec turn did not run' };
  if (routed.error) return { ok: false, costUsd, error: `the spec turn failed (${routed.error})` };
  const specMd = stripSpecWrapperFence(String(routed.result?.lastResultText || '').trim());
  if (!specMd) return { ok: false, costUsd, error: 'the spec turn returned nothing' };
  const blocked = specBlocked(specMd);
  if (blocked) return { ok: false, blocked, costUsd, error: `blocked: ${blocked}` };
  // A run that died on the wire can report the failure as its final message,
  // which would otherwise be stored as the spec.
  if (agentApiFailure(specMd)) return { ok: false, costUsd, error: 'the spec turn ended on an API error' };
  let version = null;
  try {
    // The same three effects a person's scout has: spec_md, a numbered
    // version, and the spec card in the session's own transcript.
    const published = await sessions.persistScoutPublication({
      pool, sessionId: session.id, content: specMd, hadSpec: false,
      agentBackend: 'codex_openrouter', agentModel: model,
    });
    version = published?.specVersion ?? null;
  } catch (err) {
    log.warn('homeroom-bot', 'Could not store the spec; building from it anyway', { sessionId: session.id, err: err.message });
  }
  return { ok: true, specMd, version, costUsd };
}

async function buildAndPropose({
  pool, config, bot, app, repo, issueNumber, issue, seed, buildNote,
  turnBudgetMs, model, deps, propose = true, onSpec = null,
}) {
  const { worker, sessions, agentTurn, sessionLifecycle, activeWorkers } = deps;
  const title = clipText(issue?.title || `Issue #${issueNumber}`, 120);
  // A shadow build (`propose: false`) is the same build, on a session of the
  // bot's own that links no issue, so no board reads it as work under way
  // on one, and that is archived the moment the build ends. Its branch is
  // the only thing it leaves, on the app's repository, for spot checks.
  let session;
  try {
    const { rows } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless,
                                  created_from_issue_number, linked_issues, issue_link_seeded,
                                  session_title, agent_backend, agent_provider, agent_model,
                                  agent_reasoning_effort)
       VALUES ($1, $2, NULL, 'active', FALSE, $3,
               CASE WHEN $3::int IS NULL THEN '{}'::int[] ELSE ARRAY[$3::int] END, TRUE, $4,
               'codex_openrouter', 'openrouter', $5, $6)
       RETURNING *`,
      [app.id, bot.id, propose ? issueNumber : null,
        `${propose ? 'Homeroom bot' : 'Homeroom bot shadow build'}: #${issueNumber} ${title}`,
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

  // What the spec turn wrote, carried on every outcome below so a run that
  // failed to build still shows what it meant to build.
  let spec = null;
  const specOut = () => (spec?.ok ? { specMd: spec.specMd, specVersion: spec.version } : {});
  const fail = async (error) => {
    // The bot's own failed attempt. Archived so it never reads as work
    // under way; its branch stays on GitHub for a person to look at.
    await pool.query(
      `UPDATE chat_sessions SET status = 'archived', archived_at = NOW()
        WHERE id = $1 AND user_id = $2 AND status IN ('active', 'paused')`,
      [session.id, bot.id],
    ).catch(() => {});
    return { ok: false, sessionId: session.id, branchName: session.branch_name || null, error, ...specOut() };
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

  spec = await draftSpec({
    pool, config, bot, session, containerName, seed, buildNote, turnBudgetMs, model, deps,
  });
  if (spec.blocked) {
    // Impossible as written: nothing is built, and the caller says why.
    log.info('homeroom-bot', 'The spec found the request impossible; not building', {
      sessionId: session.id, why: spec.blocked,
    });
    return { ...(await fail(spec.error)), blocked: spec.blocked, costUsd: spec.costUsd };
  }
  if (spec.ok) {
    if (onSpec) {
      // Posted, not waited on: the build starts whatever happens to the post.
      try {
        await onSpec({ sessionId: session.id, version: spec.version, specMd: spec.specMd });
      } catch (err) {
        log.warn('homeroom-bot', 'Posting the spec failed (building anyway)', { sessionId: session.id, err: err.message });
      }
    }
  } else {
    log.warn('homeroom-bot', 'No spec; building from the plan', { sessionId: session.id, error: spec.error });
    if (spec.stopped) {
      // Stopping a turn takes its container down with it.
      try {
        containerName = await worker.ensureWorker(session.id, {
          repoOwner: repo.owner, repoName: repo.repo, branchName,
          temporary: true, onProgress: () => {},
        });
      } catch (err) {
        return { ...(await fail(`the worker would not start: ${err.message}`)), costUsd: spec.costUsd };
      }
    }
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
  const prompt = buildPrompt({ seed, buildNote, spec: spec.ok ? spec.specMd : null });
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
  const buildCostUsd = Number.isFinite(routed && routed.estimatedCostUsd) ? routed.estimatedCostUsd : null;
  // Both turns, the spec's and the build's, are the build's cost.
  const costUsd = buildCostUsd == null && spec.costUsd == null
    ? null
    : (buildCostUsd || 0) + (spec.costUsd || 0);
  if (stopped) return { ...(await fail('the build ran past its time limit')), costUsd };
  if (routed?.error) return { ...(await fail(`the build turn failed (${routed.error})`)), costUsd };
  if (!result.pushOk || !(Number(result.ahead) > 0)) {
    return { ...(await fail('the build produced no change to propose')), costUsd };
  }

  if (!propose) {
    // Built, pushed, and put away: the session is archived exactly as a
    // failed attempt is, and nothing is promoted, posted or shown.
    await pool.query(
      `UPDATE chat_sessions SET status = 'archived', archived_at = NOW()
        WHERE id = $1 AND user_id = $2 AND status IN ('active', 'paused')`,
      [session.id, bot.id],
    ).catch(() => {});
    return {
      ok: true, sessionId: session.id, branchName: session.branch_name,
      sha: result.sha || null, commits: Number(result.ahead) || 0, costUsd, ...specOut(),
    };
  }

  const promoted = await promoteAsBot({ config, bot, sessionId: session.id, router: deps.votesRouter || null });
  if (promoted.status !== 200 || !promoted.body?.ok) {
    const why = promoted.body?.error || promoted.body?.message || `promotion answered ${promoted.status}`;
    // Built but not proposed: the branch holds the work. Left paused, not
    // archived, so a person can open the session and propose it.
    log.warn('homeroom-bot', 'Built but could not propose', { app: app.slug, issueNumber, sessionId: session.id, why });
    return { ok: false, sessionId: session.id, costUsd, error: `the change was built but could not be proposed: ${why}`, ...specOut() };
  }
  return { ok: true, sessionId: session.id, prNumber: promoted.body.prNumber || null, costUsd, ...specOut() };
}

module.exports = {
  BOT_USERNAME,
  isOwnMessage,
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
  mentionTargets,
  recordMentionOptOuts,
  clearMentionOptOuts,
  applyMentionAsks,
  parseStopMentioning,
  MAX_MENTIONS,
  post,
  advanceSeen,
  botUsernameOf,
  openBotProposal,
  promoteAsBot,
  buildPrompt,
  buildAndPropose,
  draftSpec,
  specPrompt,
  specTitle,
  specSnippet,
  specCommentText,
  specCard,
  specBlocked,
  blockedText,
  shareSpecVersion,
  postSpecOnProposal,
  SPEC_TURN_MAX_MS,
  MAX_SPEC_COMMENT_CHARS,
};
