'use strict';

// #4239: moving a request about Homeroom itself to Homeroom's own board.
//
// People file problems with the platform (its header, its suggestion form, the
// invite email it sends) on a project's board, where no change to the project
// can fix them. A project's name, description and icon are lines in its own
// dapp.json, so a change to them stays on its board and never moves here.
// The triage says so (its `platform` flag on a person verdict, stored on the
// run as about_platform) and the DM's chat model can say so too
// (offer_move_request). Either way the requester is offered a move, decided
// by a tap like any offer:
//
//   Move it to Homeroom  files the request on Homeroom's board with its
//                        original title and words and a footer naming where
//                        it came from and who first asked, credited to its
//                        author; leaves a link on the original; and closes
//                        the original. Closed at once ONLY when the person
//                        tapping filed it and nobody else has taken part in
//                        it (no comments, votes, claims, kudos or
//                        proposals; an open bounty from before kudos was
//                        parked still counts, unnamed); otherwise the
//                        original's group votes on closing it (a
//                        close_issue proposal), so nothing
//                        somebody else is involved in closes without a vote.
//   Keep it here         leaves everything as it is.

const log = require('./logger');
const { KUDOS_PARKED } = require('./kudos-parked');
const repoRef = require('./repo-ref');

const MAX_TITLE_CHARS = 200;
// GitHub's own limit on an issue's body, less room for the footer.
const MAX_BODY_CHARS = 60000;
// What a close proposal's reason may hold (routes/issues.js).
const MAX_CLOSE_REASON_CHARS = 2000;

function clip(value, max) {
  const text = String(value == null ? '' : value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function mayorModule() { return require('./homeroom-bot-mayor'); }
function botModule(deps) { return deps.botSvc || require('./homeroom-bot'); }
function dmModule(deps) { return deps.dmSvc || require('./homeroom-bot-dm'); }

function repoOf(app) {
  return repoRef.ownerRepo(app?.repo_url);
}

// Where links point: the platform's own domain, as the mayor's own posts use it.
function domainOf(deps) {
  return deps.domain !== undefined ? deps.domain : require('./caddy').USERNODE_DOMAIN;
}

/** Pure: a request's page on Homeroom. */
function requestLink(domain, appSlug, issueNumber) {
  return `https://${domain}/#app/${encodeURIComponent(appSlug)}/dev/issues/${Number(issueNumber)}`;
}

// ── Where a request belongs (#6771) ─────────────────────────────────────
//
// A request on one project's board that is about another app is offered a
// move there. The triage names the app (`elsewhere`, or a few candidates
// when it is unsure) and the server resolves it against what the requester
// can see: a project they cannot see is never named, and one they can see
// but have not joined is offered to join first.

/** Pure: how a target project is named on screen. */
function targetNameOf(app) {
  return app?.name || app?.slug || '';
}

/** Pure: whose board something lands on, as a sentence names it. */
function boardPhrase(app, deps = {}) {
  return app && app.slug === botModule(deps).PLATFORM_SELF_APP_SLUG
    ? 'Homeroom\'s own board' : `${targetNameOf(app)}'s board`;
}

/**
 * #6771: the project a request is about, resolved against what its requester
 * can see. `name` is the app's name as the request names it; `candidates`
 * are up to three names the triage offered when it was unsure. `requester` is
 * `{ id }` of the person who filed or first asked (a guest view when there is
 * none). Resolves { target, join } when one project fits (join true when they
 * can see it but must join before filing), { candidates } when none can be
 * resolved but some can be suggested, or null. Never throws.
 */
async function resolveElsewhere(pool, { app, name = null, candidates = [], requester = null, deps = {} }) {
  const mayor = mayorModule();
  const viewer = requester && Number(requester.id) > 0 ? requester : null;
  const usable = async (named) => {
    const found = await mayor.findApp(pool, named).catch(() => null);
    if (!found || Number(found.id) === Number(app?.id)) return null;
    return (await mayor.canView(pool, found, viewer)) ? found : null;
  };
  const wanted = typeof name === 'string' ? name.trim() : '';
  if (wanted) {
    const target = await usable(wanted);
    if (target) {
      const join = !(await mayor.canFile(pool, target, viewer));
      return { target, join };
    }
  }
  const seen = [];
  for (const candidate of Array.isArray(candidates) ? candidates.slice(0, 3) : []) {
    const found = await usable(candidate);
    if (found && !seen.some((s) => Number(s.id) === Number(found.id))) seen.push(found);
  }
  return seen.length ? { candidates: seen.map(targetNameOf) } : null;
}


/** Homeroom's own project, where a request about the platform belongs, or null. */
async function platformApp(pool, deps = {}) {
  return mayorModule().findApp(pool, botModule(deps).PLATFORM_SELF_APP_SLUG);
}

/**
 * #6311: whether this request is "theirs" to move or copy: a person who
 * asked for it (homeroom_bot_requesters), who filed its row (issues.
 * created_by), or the project's creator or an admin (app-admins.js
 * canManageApp). No GitHub read: the requester check of moveGate, on its
 * own. Never throws; a check that cannot be made is false.
 */
async function asksForRequest(pool, { app, issueNumber, user, deps = {} }) {
  try {
    const n = Number(issueNumber);
    if (!app?.id || !user?.id || !Number.isInteger(n) || n <= 0) return false;
    const { rows: asked } = await pool.query(
      'SELECT 1 FROM homeroom_bot_requesters WHERE app_id = $1 AND issue_number = $2 AND user_id = $3 LIMIT 1',
      [app.id, n, user.id],
    );
    if (asked.length) return true;
    const { rows: filed } = await pool.query(
      'SELECT 1 FROM issues WHERE app_id = $1 AND github_issue_number = $2 AND created_by = $3 LIMIT 1',
      [app.id, n, user.id],
    );
    if (filed.length) return true;
    return !!(await require('./app-admins').canManageApp(pool, app, user));
  } catch (err) {
    log.warn('homeroom-bot-move', 'Could not check whether a request is theirs', {
      app: app?.slug, issueNumber, err: err.message,
    });
    return false;
  }
}

/** Whether `app` is Homeroom's own project (or another on its repository). */
async function isPlatformApp(pool, app, deps = {}) {
  const slugs = await botModule(deps).platformAppSlugs(pool);
  return slugs.includes(app.slug);
}

/** A project by id, with the columns the access checks read. */
async function appById(pool, appId) {
  const { rows } = await pool.query('SELECT slug FROM apps WHERE id = $1', [appId]);
  return rows[0] ? mayorModule().findApp(pool, rows[0].slug) : null;
}

/**
 * Pure: the footer of the request a move files, naming where it came from
 * and who first asked. A private project is not named on Homeroom's public
 * board, nor linked.
 */
function movedFooter({ app, issueNumber, link, author }) {
  const who = author ? `, first asked by @${author}` : '';
  if (app.view_visibility && app.view_visibility !== 'public') return `Moved from a private project's request #${issueNumber}${who}.`;
  return `Moved from ${app.name || app.slug} #${issueNumber} (${link})${who}.`;
}

/**
 * Pure (#6311): the footer of the request a copy files: the same link back
 * to where it came from and who asked, without ever saying it moved. A
 * private project is not named on Homeroom's public board, nor linked.
 */
function copiedFooter({ app, issueNumber, link, author, asked }) {
  const who = asked || author ? `, asked by @${asked || author}` : '';
  if (app.view_visibility && app.view_visibility !== 'public') return `Also filed from a private project's request #${issueNumber}${who}.`;
  return `Also filed from ${app.name || app.slug} #${issueNumber} (${link})${who}.`;
}

/**
 * #6771: what people said on the request being moved, as part of the new
 * one's body: the people's messages, oldest first, each as "@name: words".
 * A private project's discussion is left out, as its name is: the target's
 * board may be more public than where it came from. Pure.
 */
function discussionSection({ app, messages = [] }) {
  if (!app || (app.view_visibility && app.view_visibility !== 'public')) return '';
  const lines = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && m.username && String(m.content || '').trim())
    .map((m) => `@${m.username}: ${String(m.content).trim()}`);
  return lines.length ? `\n\n---\nDiscussion on the original:\n\n${lines.join('\n\n')}` : '';
}

/**
 * #6771: the discussion a moved request carries, read from its issue thread:
 * the people's own messages, never the bot's. Empty for a private project.
 * Never throws.
 */
async function discussionOf(pool, { app, issueNumber, bot = null }) {
  try {
    if (!app || (app.view_visibility && app.view_visibility !== 'public')) return [];
    const { rows } = await pool.query(
      `SELECT u.username, m.content
         FROM chat_messages m JOIN users u ON u.id = m.user_id
        WHERE m.app_id = $1 AND m.thread_type = 'issue' AND m.thread_ref = $2
          AND m.msg_type = 'message' AND m.deleted_at IS NULL
          AND m.user_id IS NOT NULL AND m.user_id IS DISTINCT FROM $3::int
        ORDER BY m.id`,
      [app.id, Number(issueNumber), bot?.id == null ? null : Number(bot.id)],
    );
    return rows;
  } catch (err) {
    log.warn('homeroom-bot-move', 'Could not read a moved request\'s discussion', {
      app: app?.slug, issueNumber, err: err.message,
    });
    return [];
  }
}

/**
 * The request a move is about, read fresh: an open issue (not a pull
 * request) on a project that is not the one it would move to, which this
 * person asked for (homeroom_bot_requesters) or filed, or whose project they
 * run (its creator or an admin: app-admins.js canManageApp). Without `target`
 * the move is to Homeroom, so a request already there cannot move. Resolves
 * { ok: true, app, repo, issue: { title, body, login }, author: { userId,
 * username } | null } or { ok: false, code, error }.
 */
async function moveGate(pool, { app, issueNumber, user, target = null, deps = {} }) {
  const github = deps.github || require('./github');
  const n = Number(issueNumber);
  if (!app || !Number.isInteger(n) || n <= 0) return { ok: false, code: 'not_found', error: 'There is no such request.' };
  if (target ? Number(target.id) === Number(app.id) : await isPlatformApp(pool, app, deps)) {
    return { ok: false, code: 'already_there', error: 'It is already on that project\'s board.' };
  }
  const repo = repoOf(app);
  if (!repo || !github.isEnabled()) return { ok: false, code: 'unreadable', error: 'Its request cannot be read right now.' };
  let raw;
  try {
    raw = await github.getIssue(repo.owner, repo.repo, n);
  } catch (err) {
    if (err?.status === 404) return { ok: false, code: 'not_found', error: 'There is no such request.' };
    log.warn('homeroom-bot-move', 'Could not read a request to move', { app: app.slug, issueNumber: n, err: err.message });
    // Under a tap's claim (its act's work), a read a retry can cure is
    // thrown, so the work tries again rather than fail the tap.
    if (mayorModule().retryAct(err, deps.actKey)) throw err;
    return { ok: false, code: 'unreadable', error: 'Its request cannot be read right now.' };
  }
  if (!raw || raw.pull_request) return { ok: false, code: 'not_found', error: 'There is no such request.' };
  if (raw.state !== 'open') return { ok: false, code: 'closed', error: 'That request is already closed.' };
  const issue = { title: String(raw.title || '').trim(), body: String(raw.body || ''), login: raw.user?.login || null };
  const poster = await require('./homeroom-bot-live').issuePoster(pool, { app, repo, issueNumber: n, issue: { body: issue.body, user: issue.login } })
    .catch(() => null);
  let author = null;
  if (poster) {
    const { rows } = await pool.query('SELECT id, username FROM users WHERE username = $1', [poster]);
    if (rows[0]) author = { userId: Number(rows[0].id), username: rows[0].username };
  }
  // The project's creator and admins may move it too: HOMESTEAD #33 and #35
  // stayed on its board because only their requester could, and never did.
  // #6311: the rest of "theirs" is asksForRequest, read the same at a copy.
  const theirs = author?.userId === Number(user.id)
    || await asksForRequest(pool, { app, issueNumber: n, user, deps });
  if (!theirs) {
    return { ok: false, code: 'not_theirs', error: 'Only the person who filed it or asked for it, or the project\'s creator or admins, can move it.' };
  }
  return { ok: true, app, repo, issueNumber: n, issue, author };
}

/**
 * Who besides its author has taken part in a request, as short plain
 * reasons: empty when nobody has. Anything that cannot be read counts as
 * somebody, so a doubt always goes to a vote rather than a close.
 */
async function othersInvolved(pool, { app, repo, issueNumber, authorId, authorLogin = null, bot = null, deps = {} }) {
  const github = deps.github || require('./github');
  const n = Number(issueNumber);
  const author = authorId == null ? null : Number(authorId);
  const reasons = [];
  const { rows: [counts] } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM chat_messages
         WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = $2 AND msg_type = 'message'
           AND deleted_at IS NULL AND user_id IS NOT NULL AND user_id IS DISTINCT FROM $3::int
           AND user_id IS DISTINCT FROM $4::int) AS comments,
       (SELECT COUNT(*)::int FROM issue_votes v JOIN issues i ON i.id = v.issue_id
         WHERE i.app_id = $1 AND i.github_issue_number = $2 AND v.user_id IS DISTINCT FROM $3::int)
       + (SELECT COUNT(*)::int FROM topic_attribute_votes
           WHERE app_id = $1 AND target_type = 'issue' AND target_ref = $2 AND user_id IS DISTINCT FROM $3::int) AS votes,
       (SELECT COUNT(*)::int FROM issue_claims
         WHERE app_id = $1 AND github_issue_number = $2 AND user_id IS DISTINCT FROM $3::int) AS claims,
       (SELECT COUNT(*)::int FROM issue_bounties
         WHERE app_id = $1 AND github_issue_number = $2 AND status = 'open'
           AND giver_user_id IS DISTINCT FROM $3::int) AS kudos,
       (SELECT COUNT(*)::int FROM chat_sessions WHERE app_id = $1 AND $2 = ANY(linked_issues)) AS proposals,
       (SELECT COUNT(*)::int FROM issues
         WHERE app_id = $1 AND kind = 'close_issue' AND status = 'open'
           AND (payload->>'issueNumber')::int = $2 AND created_by IS DISTINCT FROM $3::int) AS closing`,
    [app.id, n, author, bot?.id == null ? null : Number(bot.id)],
  );
  if (counts.comments) reasons.push('others wrote in its discussion');
  if (counts.votes) reasons.push('others voted on it');
  if (counts.claims) reasons.push('somebody else claimed it');
  // #5249: a bounty somebody pledged before kudos was parked still keeps the
  // original open for a vote (it is still paid when a merged change closes
  // the request), but members no longer see kudos, so the reply names it the
  // way it names any other involvement it does not spell out.
  if (counts.kudos) reasons.push(KUDOS_PARKED ? 'others are involved in it' : 'somebody put kudos on it');
  if (counts.proposals) reasons.push('a proposal is linked to it');
  if (counts.closing) reasons.push('somebody already proposed closing it');
  // Its comments on GitHub, less the bot's own posts and the platform's
  // accounts (homeroom-bot-live.js isOtherBotLogin's rule).
  let read;
  try {
    read = await github.fetchIssueComments(repo.owner, repo.repo, n);
  } catch {
    read = { comments: [], note: 'fetch failed' };
  }
  if (read?.note) {
    reasons.push('its comments could not be read');
  } else {
    const { rows: own } = await pool.query(
      'SELECT github_comment_id FROM homeroom_bot_posts WHERE app_id = $1 AND issue_number = $2 AND github_comment_id IS NOT NULL',
      [app.id, n],
    );
    const ownIds = new Set(own.map((r) => String(r.github_comment_id)));
    const logins = new Set([authorLogin].filter(Boolean).map((l) => String(l).toLowerCase()));
    if (author != null) {
      const { rows: linked } = await pool.query('SELECT github_login FROM users WHERE id = $1', [author]);
      if (linked[0]?.github_login) logins.add(String(linked[0].github_login).toLowerCase());
    }
    const others = (read.comments || []).filter((c) => {
      if (c.id != null && ownIds.has(String(c.id))) return false;
      const login = String(c.author || '').toLowerCase();
      if (!login || login.endsWith('[bot]') || login === 'usernode-bot') return false;
      return !logins.has(login);
    });
    if (others.length) reasons.push('others commented on it');
  }
  return reasons;
}

/**
 * Open a vote on closing request `issueNumber` of `app`, proposed by
 * `user`, as the request page's "Propose to close" does (routes/issues.js
 * POST /api/apps/:slug/issues, kind close_issue). Resolves { ok, id } or
 * { ok: false, code } (already_proposed, join_required).
 */
/**
 * Homeroom's line in a request's (or a proposal's) thread naming what a
 * person did: one post (bot-post.js RULES' `line` family), said once by its
 * `version`, with no author. Never throws.
 */
async function movedLine(pool, { app, thread, kind, words, version, deps = {} }) {
  const botPost = require('./bot-post');
  await botPost.post(pool, {
    place: thread, appId: app.id, kind, words, version,
    ...(thread.type === 'issue' ? { issueNumber: thread.ref } : {}),
    subject: thread.type === 'issue' ? botPost.requestSubject(app.id, thread.ref) : botPost.placeSubject(app.id, thread),
    record: false,
  }, { ws: deps.ws || require('./ws') }).catch((err) => log.warn('homeroom-bot-move', 'Could not say a line in the thread', {
    app: app.slug, thread, kind, err: err.message,
  }));
}

async function proposeClose(pool, { app, user, issueNumber, issueTitle, reason, deps = {} }) {
  const ws = deps.ws || require('./ws');
  const n = Number(issueNumber);
  const { rows: open } = await pool.query(
    `SELECT id FROM issues
      WHERE app_id = $1 AND kind = 'close_issue' AND status = 'open' AND (payload->>'issueNumber')::int = $2`,
    [app.id, n],
  );
  if (open.length) return { ok: false, code: 'already_proposed', id: Number(open[0].id) };
  if (!(await mayorModule().canFile(pool, app, user))) return { ok: false, code: 'join_required' };
  const title = clip(String(issueTitle || ''), 300);
  const payload = { issueNumber: n, issueTitle: title, reason: clip(reason, MAX_CLOSE_REASON_CHARS) || null };
  const { rows: [row] } = await pool.query(
    `INSERT INTO issues (app_id, github_issue_number, title, description, kind, payload, created_by)
     VALUES ($1, NULL, $2, $3, 'close_issue', $4, $5) RETURNING id`,
    [app.id, `Close issue #${n}: "${title}"`.slice(0, 512), payload.reason, JSON.stringify(payload), user.id],
  );
  const id = Number(row.id);
  const said = `${user.username} proposed closing issue #${n}: "${title}"`;
  // Step 4: Homeroom's lines, each one post (bot-post.js), once per proposal.
  await movedLine(pool, { app, thread: { type: 'governance', ref: id }, kind: 'close_proposed', words: said, version: `close-${id}`, deps });
  await movedLine(pool, { app, thread: { type: 'issue', ref: n }, kind: 'close_proposed', words: said, version: `close-${id}`, deps });
  try {
    const workflow = deps.workflow || require('../workflow/platform.ts');
    await workflow.fileProposal(id, app.id);
  } catch (err) {
    // The next vote, or the boot backfill, files it (routes/issues.js).
    log.warn('homeroom-bot-move', 'Filing the close proposal failed', { issueId: id, err: err.message });
  }
  ws.pushIssueUpdate?.({ action: 'created', appSlug: app.slug, appId: app.id, issueId: id, kind: 'close_issue' });
  return { ok: true, id };
}

/**
 * Close request `issueNumber` of `app` at once, for its author, when nobody
 * else is involved. Resolves { ok }.
 */
async function closeNow(pool, { app, repo, issueNumber, user, newNumber, targetName = 'Homeroom', deps = {} }) {
  const github = deps.github || require('./github');
  const ws = deps.ws || require('./ws');
  const n = Number(issueNumber);
  try {
    await github.closeIssue(repo.owner, repo.repo, n);
  } catch (err) {
    log.warn('homeroom-bot-move', 'Could not close a moved request', { app: app.slug, issueNumber: n, err: err.message });
    return { ok: false };
  }
  // The request's own twin rows: a governance proposal that names the same
  // number is decided by its vote (and its machine), not by a move.
  await pool.query(
    `UPDATE issues SET status = 'closed' WHERE app_id = $1 AND github_issue_number = $2 AND status = 'open' AND kind = 'general'`,
    [app.id, n],
  ).catch(() => {});
  await require('./work-state').touched(pool, [{ appId: app.id, issueNumber: n }]);
  await movedLine(pool, {
    app, thread: { type: 'issue', ref: n }, kind: 'moved', version: `to-${Number(newNumber)}`, deps,
    words: `${user.username} moved this request to ${targetName} as #${newNumber} and closed it here`,
  });
  try {
    ws.pushIssueUpdate?.({ action: 'github_synced', appSlug: app.slug, appId: app.id, source: 'moved' });
  } catch {}
  return { ok: true };
}

/** Pure: what the person hears about the original, once the move is filed. */
function closedWords({ how, appName, reasons = [], author }) {
  switch (how) {
    case 'closed': return `I closed the original on ${appName}, since nobody else had joined in on it.`;
    case 'vote': {
      const why = !author ? 'you didn\'t file it' : reasons.length ? reasons[0] : 'others are involved in it';
      return `The original on ${appName} stays open until its group votes on closing it, because ${why}.`;
    }
    case 'already_proposed': return `A vote on closing the original on ${appName} is already open.`;
    default: return `The original on ${appName} is still open: I couldn't close it or start a vote on closing it.`;
  }
}

/**
 * Move a request to a project's board: file it there with its title and
 * words, the discussion so far, and a footer naming where it came from and
 * who asked (credited to its author when they are on Homeroom), link it from
 * the original, and close the original: at once for its author when nobody
 * else is in it, else by a vote of its group. `target` is the project it
 * moves to (Homeroom's own board when left out, or when it is Homeroom).
 * `fileKey` files it once per move, whoever retries. A person who may see
 * the target but is not yet a member joins it first, as the target's own
 * rules allow. Resolves { ok: true, target, issueNumber, title, how
 * ('closed' | 'vote' | 'already_proposed' | 'failed'), reasons, mine,
 * appName } or { ok: false, code, error }. Throws only what a retry can cure
 * (mayor.retryAct), so the caller's work tries again.
 */
async function moveRequest(pool, config, {
  bot = null, user, app, issueNumber, target = null, fileKey, fallbackTitle = null, settings, deps = {},
}) {
  const github = deps.github || require('./github');
  const mayor = mayorModule();
  const to = target || await platformApp(pool, deps);
  if (!to) return { ok: false, code: 'no_platform', error: 'Homeroom\'s own board isn\'t available right now.' };
  const gate = await moveGate(pool, { app, issueNumber, user, target: to, deps });
  if (!gate.ok) return { ok: false, code: gate.code, error: gate.error };
  const name = targetNameOf(to);
  // The target's own rule for who may file there. A project they can see but
  // have not joined is joined first (the project page's own Join).
  let canFile = await mayor.canFile(pool, to, user);
  if (!canFile && await mayor.canView(pool, to, user)) {
    if (to.view_visibility === 'public' && await require('./usernames').isProvisional(pool, user.id)) {
      return { ok: false, code: 'username_required', error: `you need to pick a username before joining ${name}. You can do that on its page.` };
    }
    await require('./communities').join(pool, to, user.id);
    canFile = await mayor.canFile(pool, to, user);
  }
  if (!canFile) {
    return { ok: false, code: 'not_allowed', error: `you need to join ${name} first. You can join it from its page, or ask its people to invite you.` };
  }
  const appName = app.name || app.slug;
  const n = gate.issueNumber;
  const domain = domainOf(deps);
  const link = requestLink(domain, app.slug, n);
  // Its GitHub author when nobody on Homeroom filed it: never the
  // platform's own account, which files for everybody.
  const login = /\[bot\]$|^usernode-bot$/i.test(String(gate.issue.login || '')) ? null : gate.issue.login;
  const author = gate.author?.username || login || null;
  // Credited to whoever first asked, when they are on Homeroom.
  const credited = gate.author ? { id: gate.author.userId, username: gate.author.username } : user;
  const footer = movedFooter({ app, issueNumber: n, link, author });
  // #6771: the discussion goes with it, when both boards may show it.
  const discussion = discussionSection({ app, messages: await discussionOf(pool, { app, issueNumber: n, bot }) });
  const room = Math.max(2000, MAX_BODY_CHARS - footer.length - discussion.length - 8);
  let filed;
  try {
    filed = await mayor.fileRequest(pool, config, {
      user: credited, app: to, settings, deps,
      fileKey,
      title: clip(gate.issue.title || fallbackTitle, MAX_TITLE_CHARS),
      details: clip(gate.issue.body, room) + discussion,
      askedText: gate.issue.title || fallbackTitle,
      footer,
      reason: 'moved_request',
    });
  } catch (err) {
    log.warn('homeroom-bot-move', 'Could not file a moved request', { app: app.slug, issueNumber: n, err: err.message });
    // A failure a retry can cure: the act's work tries again, its claim kept.
    if (mayor.retryAct(err, deps.actKey)) throw err;
    return { ok: false, code: 'file_failed', error: 'it could not be filed just now. Try again in a minute.' };
  }
  const newLink = requestLink(domain, to.slug, filed.issueNumber);
  try {
    await github.createIssueComment(gate.repo.owner, gate.repo.repo, n,
      `Moved to ${boardPhrase(to, deps)} as request #${filed.issueNumber}: ${newLink}\n\n`
      + (to.slug === botModule(deps).PLATFORM_SELF_APP_SLUG
        ? `It is about the Homeroom platform itself rather than ${appName}, so it is followed up there.`
        : `It is about ${name} rather than ${appName}, so it is followed up there.`));
  } catch (err) {
    log.warn('homeroom-bot-move', 'Could not link a moved request from the original', { app: app.slug, issueNumber: n, err: err.message });
  }
  // Closed at once only for its author when nobody else is in it; otherwise
  // its group decides.
  const mine = gate.author?.userId === Number(user.id);
  const reasons = mine
    ? await othersInvolved(pool, {
      app, repo: gate.repo, issueNumber: n, authorId: gate.author.userId, authorLogin: gate.issue.login, bot, deps,
    })
    : [];
  let how;
  if (mine && !reasons.length) {
    how = (await closeNow(pool, {
      app, repo: gate.repo, issueNumber: n, user, newNumber: filed.issueNumber, targetName: name, deps,
    })).ok ? 'closed' : 'failed';
  }
  if (!how || how === 'failed') {
    const why = to.slug === botModule(deps).PLATFORM_SELF_APP_SLUG
      ? 'it is about the Homeroom platform itself'
      : `it is about ${name}`;
    const proposed = await proposeClose(pool, {
      app, user, issueNumber: n, issueTitle: gate.issue.title,
      reason: `Moved to ${boardPhrase(to, deps)} as request #${filed.issueNumber} (${newLink}): ${why}, not ${appName}.`,
      deps,
    }).catch((err) => {
      log.warn('homeroom-bot-move', 'Could not propose closing a moved request', { app: app.slug, issueNumber: n, err: err.message });
      return { ok: false, code: 'error' };
    });
    how = proposed.ok ? 'vote' : proposed.code === 'already_proposed' ? 'already_proposed' : 'failed';
  }
  log.info('homeroom-bot-move', 'Moved a request to another board', {
    app: app.slug, issueNumber: n, movedTo: filed.issueNumber, target: to.slug, original: how, userId: user.id,
  });
  return { ok: true, target: to, issueNumber: filed.issueNumber, title: gate.issue.title, how, reasons, mine, appName };
}

/**
 * A tap under a move offer in their chat with the bot (homeroom-bot-mayor.js
 * settleOffer), made before 5 Nov 2026: moveRequest, its action row
 * marked. `ack` sends the answer. Resolves what was sent.
 */
async function decideMove(pool, config, { bot = null, user, settings, action, yes, ack, deps = {} }) {
  if (!yes) return ack('OK, I\'ll leave it where it is.');
  const app = await appById(pool, action.app_id);
  let target = null;
  if (action.target_app_id) {
    target = await appById(pool, action.target_app_id);
    if (!target) {
      await pool.query('UPDATE bot_cards SET status = \'failed\', error = $2 WHERE id = $1', [action.id, 'target_gone']);
      return ack('I couldn\'t move it: the project it belongs on is no longer there.', { failed: true });
    }
  }
  const moved = await moveRequest(pool, config, {
    bot, user, app, issueNumber: action.source_issue_number, target, fileKey: `dm-action:${action.id}`,
    fallbackTitle: action.title, settings, deps,
  });
  if (!moved.ok) {
    await pool.query('UPDATE bot_cards SET status = \'failed\', error = $2 WHERE id = $1', [action.id, clip(moved.code, 300)]);
    return ack(moved.code === 'file_failed' ? 'I couldn\'t move it just now. Try again in a minute.' : `I couldn't move it: ${moved.error}`, { failed: true });
  }
  await pool.query('UPDATE bot_cards SET issue_number = $2 WHERE id = $1', [action.id, moved.issueNumber]);
  const line = dmModule(deps).requestLine({ appName: moved.target.name || moved.target.slug, issueNumber: moved.issueNumber, issueTitle: moved.title });
  return ack(
    `${line}\n\nMoved. It's on ${boardPhrase(moved.target, deps)} now, with a link to it left on the original. `
      + closedWords({ how: moved.how, appName: moved.appName, reasons: moved.reasons, author: moved.mine }),
    {
      objects: [{ type: 'issue', appId: Number(moved.target.id), issueNumber: moved.issueNumber }],
      metadata: {
        kind: 'filed', appSlug: moved.target.slug, appName: moved.target.name || moved.target.slug,
        issueNumber: moved.issueNumber, issueTitle: moved.title,
      },
    },
  );
}

/**
 * #6311: "put it on Homeroom's board too". Files a new request on Homeroom's
 * own board with the original's title and words, a footer naming where it
 * came from and who asked, credited to its author when they are on Homeroom.
 * Leaves a link on the original. Never closes it and never proposes a close:
 * this request stays open here. Resolves
 * { ok: true, issueNumber, link, target, title } or { ok: false, code, error }.
 */
async function copyToHomeroom(pool, config, {
  user, app, issueNumber, fileKey = null, settings = null, deps = {},
}) {
  const github = deps.github || require('./github');
  const mayor = mayorModule();
  const gate = await moveGate(pool, { app, issueNumber, user, deps });
  if (!gate.ok) return { ok: false, code: gate.code, error: gate.error };
  const target = await platformApp(pool, deps);
  if (!target) return { ok: false, code: 'no_platform', error: 'Homeroom\'s own board isn\'t available right now.' };
  if (!(await mayor.canFile(pool, target, user))) {
    return { ok: false, code: 'not_allowed', error: 'You need to join Homeroom\'s own community first. You can join it from its page.' };
  }
  const domain = domainOf(deps);
  const n = gate.issueNumber;
  // Its GitHub author when nobody on Homeroom filed it: never the platform's
  // own account, which files for everybody.
  const login = /\[bot\]$|^usernode-bot$/i.test(String(gate.issue.login || '')) ? null : gate.issue.login;
  const author = gate.author?.username || login || null;
  // Credited to whoever first asked, when they are on Homeroom.
  const credited = gate.author ? { id: gate.author.userId, username: gate.author.username } : user;
  let filed;
  try {
    filed = await mayor.fileRequest(pool, config, {
      user: credited, app: target, settings, deps,
      // Filed once per ask: a retry finds the copy (the tap's or turn's work).
      fileKey,
      title: clip(gate.issue.title, MAX_TITLE_CHARS),
      details: clip(gate.issue.body, MAX_BODY_CHARS),
      askedText: gate.issue.title,
      footer: copiedFooter({
        app, issueNumber: n, link: requestLink(domain, app.slug, n), author, asked: user.username,
      }),
      reason: 'copied_request',
    });
  } catch (err) {
    log.warn('homeroom-bot-move', 'Could not file a copy of a request', { app: app.slug, issueNumber: n, err: err.message });
    // A failure a retry can cure: the act's work tries again, its claim kept.
    if (mayor.retryAct(err, deps.actKey)) throw err;
    return { ok: false, code: 'file_failed', error: 'It could not be filed just now. Try again in a minute.' };
  }
  const link = requestLink(domain, target.slug, filed.issueNumber);
  // A retry of the same ask finds the copy (fileRequest's fileKey) and does
  // not leave a second link on the original.
  if (!filed.again) {
    await movedLine(pool, {
      app, thread: { type: 'issue', ref: n }, kind: 'copied', version: `to-${Number(filed.issueNumber)}`, deps,
      words: `Also filed on Homeroom's own board as request #${filed.issueNumber}: ${link}. This request stays open here. `
        + `Homeroom's team picks it up there; there is nothing to build on ${app.name || app.slug} for it.`,
    });
    // #6869: Homeroom's own full admins hear about a report that landed on
    // their board, through the board's new-request notification. Best-effort.
    await (deps.notifications || require('./notifications')).notifyPlatformAdminsOfCopy?.(pool, {
      appId: target.id, issueNumber: filed.issueNumber, authorId: credited.id,
    });
    try {
      await github.createIssueComment(gate.repo.owner, gate.repo.repo, n,
        `Also on Homeroom's own board as request #${filed.issueNumber}: ${link}\n\nThis request stays open here.`);
    } catch (err) {
      log.warn('homeroom-bot-move', 'Could not link a copied request from the original', { app: app.slug, issueNumber: n, err: err.message });
    }
  }
  log.info('homeroom-bot-move', 'Filed a copy of a request on Homeroom', {
    app: app.slug, issueNumber: n, copiedTo: filed.issueNumber, userId: user.id,
  });
  return { ok: true, issueNumber: filed.issueNumber, link, target, title: gate.issue.title };
}

/**
 * A tap under a copy offer in the person's chat with the bot
 * (homeroom-bot-mayor.js settleOffer). Files the copy, links it from the
 * original and leaves the original open. `ack` sends the answer.
 */
async function decideCopy(pool, config, { user, settings, action, yes, ack, deps = {} }) {
  if (!yes) return ack('OK, I\'ll leave it where it is.');
  const app = await appById(pool, action.app_id);
  let filed;
  try {
    filed = await copyToHomeroom(pool, config, {
      user, app, issueNumber: action.source_issue_number, fileKey: `dm-action:${action.id}`, settings, deps,
    });
  } catch (err) {
    // A failure a retry can cure: the act's work tries again, its claim kept.
    if (mayorModule().retryAct(err, deps.actKey)) throw err;
    filed = { ok: false, code: 'file_failed', error: err.message };
  }
  if (!filed.ok) {
    await pool.query('UPDATE bot_cards SET status = \'failed\', error = $2 WHERE id = $1',
      [action.id, clip(filed.error || filed.code, 300)]);
    return ack(`I couldn't file it there: ${filed.error}`, { failed: true });
  }
  await pool.query('UPDATE bot_cards SET issue_number = $2 WHERE id = $1', [action.id, filed.issueNumber]);
  const name = filed.target.name || filed.target.slug;
  const line = dmModule(deps).requestLine({ appName: name, issueNumber: filed.issueNumber, issueTitle: filed.title });
  return ack(
    `${line}\n\nFiled on Homeroom's own board, with a link to it left on the original. This request stays open here. `
      + `Homeroom's team picks it up there; there is nothing to build on ${app?.name || app?.slug || 'this project'} for it.`,
    {
      objects: [{ type: 'issue', appId: Number(filed.target.id), issueNumber: filed.issueNumber }],
      metadata: {
        kind: 'filed', appSlug: filed.target.slug, appName: name,
        issueNumber: filed.issueNumber, issueTitle: filed.title,
      },
    },
  );
}

/** Pure: the words of a copy offer in the person's chat with the bot. */
function copyOfferText({ name, issueNumber, text = null, title = null, why = null }) {
  return [
    text || `Want me to file request #${issueNumber} on Homeroom's own board too? The people who work on Homeroom look there, and this request stays open here.`,
    '',
    `**${name}** · request #${issueNumber}${title ? `: ${clip(title, 140)}` : ''}`,
    ...(why ? ['', `Why: ${clip(why, 600)}`] : []),
  ].join('\n');
}

/** Pure: a copy offer's metadata: its question and buttons (homeroom-bot-mayor.js offerActions). */
function copyOfferMeta({ app, actionId }) {
  const name = app.name || app.slug;
  return {
    kind: 'confirm', appSlug: app.slug, appName: name, actionId: Number(actionId),
    question: `File this request on Homeroom's own board too, and keep it here?`,
    // `answers` for a client that predates `actions`.
    answers: [...mayorModule().OFFER_ANSWERS.copy_request], actions: mayorModule().offerActions('copy_request'),
    status: 'open', mirrors: false,
  };
}

// What became of a platform verdict's move offer (homeroom_bot_runs
// move_offer): sent, or why it was not.
const MOVE_OFFER_OUTCOMES = Object.freeze(['sent', 'no_requester', 'no_bot', 'repeat_held', 'already_offered', 'not_sent']);

/**
 * Record on run `runId` what became of its move offer (MOVE_OFFER_OUTCOMES),
 * for the console's Move offers line and get_homeroom_bot. Only on a run the
 * triage flagged as about Homeroom itself. Never throws.
 */
async function noteMoveOffer(pool, runId, outcome) {
  const id = Number(runId);
  if (!Number.isInteger(id) || id <= 0 || !MOVE_OFFER_OUTCOMES.includes(outcome)) return;
  await pool.query('UPDATE homeroom_bot_runs SET move_offer = $2 WHERE id = $1 AND about_platform', [id, outcome])
    .catch((err) => log.warn('homeroom-bot-move', 'Could not record a move offer\'s outcome', { runId: id, outcome, err: err.message }));
}

// How far back the console's Move offers line looks.
const MOVE_OFFER_DAYS = 7;

/**
 * The move offers of the last MOVE_OFFER_DAYS days, for the console and
 * get_homeroom_bot: offers sent (any source: a platform verdict's DM, or
 * the DM chat's offer_move_request), and how each was decided: moved
 * (Move it to Homeroom), kept (Keep it here), still open, failed. And the
 * live `person` verdicts flagged as about Homeroom itself that sent no
 * offer, counted by why (move_offer; `unrecorded` for a run from before it
 * was kept, or whose DM news did not go out), with the latest few.
 * Codes and counts, never anybody's words.
 */
async function moveOfferSummary(pool, { days = MOVE_OFFER_DAYS } = {}) {
  const { rows: [o] } = await pool.query(
    `SELECT COUNT(*)::int AS sent,
            COUNT(*) FILTER (WHERE status = 'done')::int AS moved,
            COUNT(*) FILTER (WHERE status = 'declined')::int AS kept,
            COUNT(*) FILTER (WHERE status = 'open')::int AS open,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
            COUNT(*) FILTER (WHERE target_app_id IS NOT NULL)::int AS to_other_projects,
            COUNT(*) FILTER (WHERE target_app_id IS NOT NULL AND status = 'done')::int AS moved_to_other
       FROM bot_cards
      WHERE kind = 'move_request' AND created_at > NOW() - make_interval(days => $1)`,
    [days],
  );
  const { rows: missed } = await pool.query(
    `SELECT r.id, r.issue_number, r.created_at, a.slug AS app_slug,
            COALESCE(r.move_offer, 'unrecorded') AS why
       FROM homeroom_bot_runs r JOIN apps a ON a.id = r.app_id
      WHERE r.about_platform AND r.verdict = 'person' AND r.mode = 'live'
        AND r.created_at > NOW() - make_interval(days => $1)
        AND r.move_offer IS DISTINCT FROM 'sent'
        AND (r.move_offer IS NOT NULL OR NOT EXISTS (
          SELECT 1 FROM bot_cards x
           WHERE x.kind = 'move_request' AND x.app_id = r.app_id AND x.source_issue_number = r.issue_number))
      ORDER BY r.id DESC`,
    [days],
  );
  const byWhy = {};
  for (const m of missed) byWhy[m.why] = (byWhy[m.why] || 0) + 1;
  return {
    days,
    sent: o?.sent || 0,
    moved: o?.moved || 0,
    kept: o?.kept || 0,
    open: o?.open || 0,
    failed: o?.failed || 0,
    toOtherProjects: o?.to_other_projects || 0,
    movedToOther: o?.moved_to_other || 0,
    notOffered: missed.length,
    notOfferedByWhy: byWhy,
    notOfferedRecent: missed.slice(0, 10).map((m) => ({
      runId: Number(m.id), app: m.app_slug, issueNumber: Number(m.issue_number),
      why: m.why, at: new Date(m.created_at).toISOString(),
    })),
  };
}

// One story per request: what to tap under "This looks done already", the
// verdict and its offer in one message. Tell me what's missing quotes the
// message in the composer, and what they write goes on the request
// (homeroom-bot-dm.js MIRRORED_KINDS), which has the bot look again.
const DONE_ACTIONS = Object.freeze([
  Object.freeze({ id: 'yes', label: 'Propose to close', style: 'primary', type: 'server' }),
  Object.freeze({ id: 'missing', label: 'Tell me what\'s missing', style: 'secondary', type: 'reply' }),
]);

/**
 * One story per request: an offer folded into the moment that gives its
 * reason, so one verdict is one message and rings once (homeroom-bot-dm.js
 * relayIssuePost). `kind` is 'move_request' (about Homeroom itself: Move it
 * to Homeroom · Keep it here) or 'close_request' (done already: Propose to
 * close · Tell me what's missing), once per request and person (and, for
 * a close, not while a close vote is open). Resolves { card, metadata } to
 * send with the message: its card is written with it (step 3, sendDm
 * `card`), and what came of it is noted after (foldedOfferSent). Null when
 * there is nothing to offer. Never throws.
 */
async function foldOffer(pool, { kind, userId, app, issueNumber, title, reason = null, runId = null, target = null, deps = {} }) {
  try {
    const n = Number(issueNumber);
    if (!userId || !app?.id || !Number.isInteger(n)) return null;
    const move = kind === 'move_request';
    // A move to another project (#6771) needs no Homeroom board; a move with
    // no target still needs Homeroom's own one.
    if (move && (target
      ? Number(target.id) === Number(app.id) || !(await mayorModule().canFile(pool, target, { id: userId }))
      : (await isPlatformApp(pool, app, deps) || !(await platformApp(pool, deps))))) {
      await noteMoveOffer(pool, runId, 'not_sent');
      return null;
    }
    const { rows: before } = await pool.query(
      `SELECT 1 FROM bot_cards
        WHERE user_id = $1 AND app_id = $2 AND kind = $4 AND source_issue_number = $3
          AND status IN ('open', 'done')
       UNION ALL
       SELECT 1 FROM issues
        WHERE $4 = 'close_request' AND app_id = $2 AND kind = 'close_issue' AND status = 'open'
          AND (payload->>'issueNumber')::int = $3`,
      [userId, app.id, n, kind],
    );
    if (before.length) {
      if (move) await noteMoveOffer(pool, runId, 'already_offered');
      return null;
    }
    const mayor = mayorModule();
    const actions = move ? mayor.offerActions('move_request') : DONE_ACTIONS.map((a) => ({ ...a }));
    return {
      kind, runId,
      card: {
        kind, appId: app.id, title: clip(title || `Request #${n}`, MAX_TITLE_CHARS),
        details: reason ? clip(reason, 600) : null, sourceIssueNumber: n,
        ...(move && target ? { targetAppId: Number(target.id) } : {}),
      },
      metadata: { actions, answers: actions.map((a) => a.label), status: 'open' },
    };
  } catch (err) {
    log.warn('homeroom-bot-move', 'Could not fold an offer into its message', { app: app?.slug, issueNumber, kind, err: err.message });
    if (kind === 'move_request') await noteMoveOffer(pool, runId, 'not_sent');
    return null;
  }
}

/**
 * What came of a folded offer (foldOffer): its card was written with the
 * message sent, or with nothing, when no message was. A move's run says
 * which (noteMoveOffer). Never throws.
 */
async function foldedOfferSent(pool, offer, sent) {
  if (!offer || offer.kind !== 'move_request') return;
  const outcome = !sent?.messageId ? 'not_sent' : sent.duplicate ? 'already_offered' : 'sent';
  await noteMoveOffer(pool, offer.runId, outcome);
}

/** Pure: the words of a move offer. */
function moveOfferText({ name, issueNumber, text = null, title = null, why = null, targetName = null }) {
  const to = targetName ? `${targetName}'s board` : 'Homeroom\'s own board';
  return [
    text || `Want me to move request #${issueNumber} to ${to}? The people who work on ${targetName || 'Homeroom'} look there.`,
    '',
    `**${name}** · request #${issueNumber}${title ? `: ${clip(title, 140)}` : ''}`,
    ...(why ? ['', `Why: ${clip(why, 600)}`] : []),
    '',
    'If you filed it and nobody else has joined in, I close it here. Otherwise its group votes on closing it.',
  ].join('\n');
}

/** Pure: a move offer's metadata: its question and buttons (homeroom-bot-mayor.js offerActions). */
function moveOfferMeta({ app, actionId, targetName = null, join = false }) {
  const name = app.name || app.slug;
  const args = { ...(targetName ? { targetName, join } : {}) };
  // A DM's buttons are the server's own (a tap, never words typed back).
  const actions = require('./bot-cards').offerActions('move_request', undefined, args)
    .map(({ id, label, style }) => ({ id, label, style, type: 'server' }));
  return {
    kind: 'confirm', appSlug: app.slug, appName: name, actionId: Number(actionId),
    question: targetName
      ? `Move this request from ${name} to ${targetName}?`
      : `Move this request from ${name} to Homeroom's own board?`,
    // `answers` for a client that predates `actions`.
    answers: actions.map((a) => a.label), actions,
    status: 'open', mirrors: false,
  };
}

module.exports = {
  MOVE_OFFER_OUTCOMES,
  noteMoveOffer,
  movedLine,
  moveOfferSummary,
  foldOffer,
  foldedOfferSent,
  DONE_ACTIONS,
  domainOf,
  requestLink,
  movedFooter,
  copiedFooter,
  discussionSection,
  discussionOf,
  resolveElsewhere,
  moveGate,
  asksForRequest,
  platformApp,
  appById,
  copyToHomeroom,
  decideCopy,
  copyOfferText,
  copyOfferMeta,
  othersInvolved,
  proposeClose,
  closeNow,
  closedWords,
  moveRequest,
  decideMove,
  moveOfferText,
  moveOfferMeta,
};
