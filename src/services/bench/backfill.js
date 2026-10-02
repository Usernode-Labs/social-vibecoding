'use strict';

// #3654 Core v1: a snapshot rebuilt AFTER the fact, for a run that recorded
// none (snapshots only started being recorded when the benchmark shipped).
//
// What the bot read is rebuilt as of `asOf`, the moment the original run was
// recorded (homeroom_bot_runs.created_at, which is written before the bot
// posts its verdict, so its own answer is never inside the cutoff):
//
//   the request   GitHub's issue as it reads today (title and body), and its
//                 comments with created_at <= asOf;
//   the thread    the platform's own Homeroom thread for that issue, from the
//                 database, messages with created_at <= asOf (a message
//                 deleted later still counts: it was there when the bot read);
//   the code      the default branch's commit at asOf (GitHub's commits API,
//                 sha=<default branch>&until=asOf&per_page=1);
//   the seed      built by the same builder the bot uses
//                 (routes/sessions buildHeadlessSeed), and the triage prompt
//                 by the bot's own triagePromptFor, so the prompt is the one
//                 the bot would have read.
//
// Limits, recorded on the snapshot (`extra`) rather than hidden:
//
//   * An issue BODY or TITLE edited after asOf cannot be undone from the
//     REST API: it serves today's text only. GitHub's GraphQL
//     userContentEdits would recover it, but this platform's GitHub client
//     reads issues through the public REST endpoints, so that is left for
//     later. Instead `bodyEditedAfter` is true when the issue's updated_at is
//     later than asOf and no later comment or close explains it (a label
//     change counts too, so it errs towards "maybe edited").
//   * A comment EDITED after asOf reads as edited; a comment DELETED after
//     asOf is gone from GitHub and cannot be recovered.
//   * The seed's per-comment and per-thread clipping is applied to what was
//     there at asOf, as the bot applied it then.
//
// Reads only. Every GitHub call goes through the client the caller hands in,
// which the materializer makes the benchmark's guardedGithub (reads, and
// nothing else); this module never writes to GitHub. Snapshots go through
// the existing tables (homeroom-bot-snapshots recordSnapshot: each text
// stored once by its sha256).

const snapshots = require('../homeroom-bot-snapshots');

// GitHub's updated_at and the event that bumped it can differ by a moment.
const SLACK_MS = 5000;
const THREAD_ROW_LIMIT = 200;
// GitHub reads that say nothing about the issue itself: try again later.
const TRANSIENT_NOTES = new Set(['rate limited', 'fetch failed']);

function ms(value) {
  if (value instanceof Date) return value.getTime();
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

function skip(reason, transient = false) {
  return { ok: false, reason, transient };
}

/**
 * The thread as it stood at `asOf`. Pure. Entries without a timestamp are
 * dropped (there is no way to tell they were there). Also says whether the
 * request itself may have been edited since (see the header).
 */
function threadAsOf({ issue = {}, comments = [], threadMessages = [], asOf }) {
  const cutoff = ms(asOf);
  if (cutoff == null) throw new Error('threadAsOf needs a valid asOf');
  const before = (at) => {
    const t = ms(at);
    return t != null && t <= cutoff;
  };
  const keptComments = (comments || []).filter((c) => before(c.createdAt));
  const keptThread = (threadMessages || []).filter((m) => before(m.createdAt));
  const updated = ms(issue.updatedAt);
  const explained = [...(comments || []).map((c) => ms(c.createdAt)), ms(issue.closedAt)]
    .filter((t) => t != null && t > cutoff)
    .some((t) => Math.abs(t - updated) <= SLACK_MS);
  const bodyEditedAfter = updated != null && updated > cutoff + SLACK_MS && !explained;
  return {
    comments: keptComments,
    threadMessages: keptThread,
    dropped: {
      comments: (comments || []).length - keptComments.length,
      thread: (threadMessages || []).length - keptThread.length,
    },
    createdAfter: ms(issue.createdAt) != null && ms(issue.createdAt) > cutoff,
    bodyEditedAfter,
  };
}

/** The platform's own thread on an issue as it stood at `asOf`, clipped as the bot clips it. */
async function threadMessagesAsOf(pool, appId, issueNumber, asOf) {
  const { rows } = await pool.query(
    `SELECT m.content, m.created_at, u.username
       FROM chat_messages m
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.app_id = $1 AND m.thread_type = 'issue' AND m.thread_ref = $2
        AND m.msg_type = 'message'
        AND m.created_at <= $3::timestamptz
        AND (m.deleted_at IS NULL OR m.deleted_at > $3::timestamptz)
      ORDER BY m.id ASC
      LIMIT ${THREAD_ROW_LIMIT}`,
    [Number(appId), Number(issueNumber), new Date(asOf).toISOString()],
  );
  const messages = rows.map((r) => ({
    author: r.username || 'unknown',
    body: typeof r.content === 'string' ? r.content : '',
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at || ''),
  }));
  return require('../thread-context').clipThreadMessages(messages);
}

/** Every Homeroom thread message on an issue, unclipped, for finding a reply after a time. */
async function threadMessagesAfter(pool, appId, issueNumber, after) {
  const { rows } = await pool.query(
    `SELECT m.content, m.created_at, u.username
       FROM chat_messages m
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.app_id = $1 AND m.thread_type = 'issue' AND m.thread_ref = $2
        AND m.msg_type = 'message' AND m.deleted_at IS NULL
        AND m.created_at > $3::timestamptz
      ORDER BY m.id ASC
      LIMIT ${THREAD_ROW_LIMIT}`,
    [Number(appId), Number(issueNumber), new Date(after).toISOString()],
  );
  return rows.map((r) => ({
    author: r.username || 'unknown',
    body: typeof r.content === 'string' ? r.content : '',
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at || ''),
  }));
}

/** The default branch's commit at `asOf`, or a skip. */
async function commitAsOf(github, repo, asOf) {
  if (typeof github.getCommitAt !== 'function') return skip('GitHub cannot say which commit the repository was at');
  try {
    const commit = await github.getCommitAt(repo.owner, repo.repo, asOf);
    if (!commit?.sha) return skip(`the repository has no commit on its default branch before ${asOf}`);
    return { ok: true, ...commit };
  } catch (err) {
    if (err.status === 404) return skip('the repository is gone');
    return skip(`could not read the commit at ${asOf}: ${err.message}`, true);
  }
}

/** The request and its comments from GitHub, or a skip. */
async function readIssue(github, repo, issueNumber) {
  const fetched = await github.fetchPublicIssue(repo.owner, repo.repo, issueNumber);
  if (!fetched?.issue) {
    const note = fetched?.note || 'not found';
    return skip(`request #${issueNumber} could not be read (${note})`, TRANSIENT_NOTES.has(note));
  }
  const read = await github.fetchIssueComments(repo.owner, repo.repo, issueNumber)
    .catch((err) => ({ comments: [], note: err.message }));
  // A comment list that failed to load would silently be a different
  // thread: refuse rather than record it.
  if (read?.note) return skip(`the comments on #${issueNumber} could not be read (${read.note})`, read.note !== 'not found');
  return { ok: true, issue: fetched.issue, comments: read?.comments || [], commentsTruncated: !!read?.truncated };
}

function botLoginOf(github) {
  return require('../homeroom-bot-live').botUsernameOf(github);
}

function issueForSeed(issue) {
  return {
    number: issue.number, title: issue.title || '', body: issue.body || '', state: issue.state,
    author: issue.user || issue.author || null, createdAt: issue.createdAt || null, updatedAt: issue.updatedAt || null,
  };
}

/**
 * A triage snapshot rebuilt as of `asOf`. `synthetic` ({ title, body }) is
 * an authored request with no thread and no GitHub issue (the adversarial
 * tasks); everything else is read. Resolves { ok, snapshotId, issue, meta }
 * or { ok: false, reason, transient }.
 */
async function backfillTriage(pool, {
  app, repo, issueNumber, asOf, github, synthetic = null, firstVersion = false, extra = {}, deps = {},
}) {
  const sessions = deps.sessions || require('../../routes/sessions');
  const bot = deps.bot || require('../homeroom-bot');
  const n = Number(issueNumber);
  if (!Number.isInteger(n) || n <= 0) return skip('no request number');
  if (ms(asOf) == null) return skip('no as_of time');

  let issue;
  let comments = [];
  let threadMessages = [];
  let meta = { bodyEditedAfter: false, commentsAfterAsOf: 0, threadAfterAsOf: 0, commentsTruncated: false };
  if (synthetic) {
    issue = { number: n, title: String(synthetic.title || ''), body: String(synthetic.body || ''), author: 'bench-author', createdAt: new Date(asOf).toISOString() };
  } else {
    const read = await readIssue(github, repo, n);
    if (!read.ok) return read;
    const thread = await threadMessagesAsOf(pool, app.id, n, asOf);
    const asof = threadAsOf({ issue: read.issue, comments: read.comments, threadMessages: thread.messages, asOf });
    if (asof.createdAfter) return skip(`request #${n} was opened after ${asOf}`);
    issue = issueForSeed(read.issue);
    comments = asof.comments;
    threadMessages = asof.threadMessages;
    meta = {
      bodyEditedAfter: asof.bodyEditedAfter,
      commentsAfterAsOf: asof.dropped.comments,
      threadAfterAsOf: asof.dropped.thread,
      commentsTruncated: read.commentsTruncated,
    };
  }
  const commit = await commitAsOf(github, repo, asOf);
  if (!commit.ok) return commit;
  const botLogin = await botLoginOf(github);
  const seed = sessions.buildHeadlessSeed(n, issue, comments, botLogin, threadMessages);
  const prompt = bot.triagePromptFor({ seed, issueNumber: n, firstVersion: !!firstVersion });
  const snapshotId = await snapshots.recordSnapshot(pool, {
    runId: null, stage: 'triage', appId: app.id, issueNumber: n, baseSha: commit.sha, source: 'import',
    texts: {
      seed,
      prompt,
      thread: snapshots.frozenThread({ issueNumber: n, issue, comments, threadMessages, botLogin }),
    },
    extra: {
      ...extra, backfilled: true, asOf: new Date(asOf).toISOString(), committedAt: commit.committedAt || null,
      firstVersion: !!firstVersion, synthetic: !!synthetic, ...meta,
    },
  });
  if (!snapshotId) return skip('the snapshot could not be recorded', true);
  return { ok: true, snapshotId, issue, seed, meta: { ...meta, baseSha: commit.sha } };
}

/**
 * A build snapshot rebuilt for a shadow build that recorded none: the seed
 * as of the triage, the triage's own plan (the run's build_note), and the
 * default branch's commit when the build ran (the build lane cuts its branch
 * from main's tip then).
 */
async function backfillBuild(pool, {
  app, repo, issueNumber, asOf, buildAt = null, buildNote = '', github, platformRepo = false, extra = {}, deps = {},
}) {
  const sessions = deps.sessions || require('../../routes/sessions');
  const n = Number(issueNumber);
  const read = await readIssue(github, repo, n);
  if (!read.ok) return read;
  const thread = await threadMessagesAsOf(pool, app.id, n, asOf);
  const asof = threadAsOf({ issue: read.issue, comments: read.comments, threadMessages: thread.messages, asOf });
  if (asof.createdAfter) return skip(`request #${n} was opened after ${asOf}`);
  const commit = await commitAsOf(github, repo, buildAt || asOf);
  if (!commit.ok) return commit;
  const botLogin = await botLoginOf(github);
  const issue = issueForSeed(read.issue);
  const seed = sessions.buildHeadlessSeed(n, issue, asof.comments, botLogin, asof.threadMessages);
  const snapshotId = await snapshots.recordSnapshot(pool, {
    runId: null, stage: 'build', appId: app.id, issueNumber: n, baseSha: commit.sha, source: 'import',
    texts: {
      seed,
      build_note: buildNote || '',
      thread: snapshots.frozenThread({ issueNumber: n, issue, comments: asof.comments, threadMessages: asof.threadMessages, botLogin }),
    },
    extra: {
      ...extra, backfilled: true, asOf: new Date(asOf).toISOString(), platformRepo: !!platformRepo,
      bodyEditedAfter: asof.bodyEditedAfter, commentsAfterAsOf: asof.dropped.comments,
    },
  });
  if (!snapshotId) return skip('the snapshot could not be recorded', true);
  return { ok: true, snapshotId, issue, seed };
}

/**
 * A checks-fix snapshot from a proposal's stored check verdict, when the
 * proposal is STILL red on the head its checks ran on. Once the head moved
 * or the checks went green, the failing output of the old head is no longer
 * stored, and this resolves a skip saying so.
 */
async function backfillChecksFix(pool, {
  app, repo, session, issueNumber, github, extra = {}, deps = {},
}) {
  const sessions = deps.sessions || require('../../routes/sessions');
  const followup = deps.followup || require('../homeroom-bot-followup');
  const threadContext = deps.threadContext || require('../thread-context');
  const head = String(session.reviewed_head_sha || '').toLowerCase();
  if (session.check_state !== 'failing' || !head || String(session.checks_commit_sha || '').toLowerCase() !== head) {
    return skip('the proposal is no longer red on the head its checks ran on, and the old failing output is not stored');
  }
  const { failing, total } = followup.failingChecks(session.test_results);
  if (!failing.length) return skip('the proposal\'s stored check results name no failing check');
  const n = Number(issueNumber);
  const read = await readIssue(github, repo, n);
  if (!read.ok) return read;
  const [issueThread, proposalThread, botLogin] = await Promise.all([
    threadContext.loadIssueThread(pool, app.id, n),
    threadContext.loadProposalThread(pool, app.id, session.id),
    botLoginOf(github),
  ]);
  const issue = issueForSeed(read.issue);
  const seed = sessions.buildHeadlessSeed(n, issue, read.comments, botLogin, issueThread?.messages || []);
  const proposalBlock = threadContext.buildProposalDiscussionBlock({
    sessionId: session.id, prNumber: session.pr_number,
    threadMessages: proposalThread?.messages || [], truncated: !!proposalThread?.truncated,
  });
  const prompt = followup.checksFixPrompt({ seed, proposalBlock, prNumber: session.pr_number, failing, total });
  const snapshotId = await snapshots.recordSnapshot(pool, {
    runId: null, stage: 'checks_fix', appId: app.id, issueNumber: n, baseSha: head, source: 'import',
    texts: {
      seed, prompt, proposal_block: proposalBlock, failing: JSON.stringify(failing),
      thread: snapshots.frozenThread({ issueNumber: n, issue, comments: read.comments, threadMessages: issueThread?.messages || [], botLogin }),
    },
    extra: { ...extra, backfilled: true, prNumber: session.pr_number || null, total },
  });
  if (!snapshotId) return skip('the snapshot could not be recorded', true);
  return { ok: true, snapshotId, failing: failing.length, total };
}

/**
 * The requester's own next reply after `after`, from the GitHub comments and
 * the Homeroom thread merged in time order. Pure. Only the requester's words
 * count (a bystander's answer is not theirs to give); with no known
 * requester, nothing does.
 */
function nextReplyAfter({ comments = [], threadMessages = [], after, requester = [] }) {
  const cutoff = ms(after);
  const names = new Set((Array.isArray(requester) ? requester : [requester])
    .filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().toLowerCase()));
  if (cutoff == null || !names.size) return null;
  const entries = [
    ...(comments || []).map((c) => ({ ...c, source: 'github' })),
    ...(threadMessages || []).map((m) => ({ ...m, source: 'thread' })),
  ]
    .filter((e) => ms(e.createdAt) != null && ms(e.createdAt) > cutoff)
    .filter((e) => names.has(String(e.author || '').toLowerCase()))
    .filter((e) => String(e.body || '').trim())
    .sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  const first = entries[0];
  return first ? { text: String(first.body).trim().slice(0, 2000), at: first.createdAt, source: first.source } : null;
}

module.exports = {
  SLACK_MS,
  threadAsOf,
  threadMessagesAsOf,
  threadMessagesAfter,
  commitAsOf,
  readIssue,
  backfillTriage,
  backfillBuild,
  backfillChecksFix,
  nextReplyAfter,
};
