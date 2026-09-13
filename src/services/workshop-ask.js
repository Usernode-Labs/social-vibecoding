'use strict';

// The Needs-you deck's ask box (frontend/src/features/dev-board/workshop —
// NeedsDeck). The deck puts one card in front of a voter and asks for a
// decision; the box under it is for the question they need answered BEFORE
// they can give one. Until this landed, its replies were a hardcoded string
// saying it was not wired up.
//
// ── The client names the CARD, never the context ─────────────────────
//
// A request carries a target — a kind and a reference — and a question.
// Everything the model reads is looked up HERE, from this app's own rows
// and its GitHub thread. That is not defensive tidiness: a prompt assembled
// out of a request body is a prompt the caller writes, and this one is
// billed to the caller's budget and answers with the platform's voice under
// a card somebody is about to vote on. `resolveSubject` is the whole trust
// boundary — if a field is not in what it returns, the model never sees it.
//
// ── Three kinds, because the deck holds three ────────────────────────
//
//   proposal — a chat_sessions row (the deck's vote cards). Its PR number,
//              title, branch and the voter-facing pr_summary_md.
//   gov      — an issues row with a non-'general' kind: the platform's
//              governance proposals, which carry their case in `description`
//              rather than in a diff.
//   issue    — a GitHub issue number (the deck's claim cards). Title and
//              body, from the same anonymous cache the board paints from.
//
// Each is scoped to the app the route already resolved, so a reference
// belonging to another app resolves to nothing rather than to somebody
// else's row.

const github = require('./github');
const limits = require('./limits');
const llm = require('./llm');
const log = require('./logger');

// Caps keep one question's prompt bounded. A voter's question is about the
// shape of a change, not a code review, and an issue body that runs to
// thousands of words is one the summary should be answering from anyway.
const TITLE_MAX = 300;
const SUMMARY_MAX = 4000;
const BODY_MAX = 6000;
const QUESTION_MAX = 1000;

// The diff budget. github.getProposalDiff defaults to 12000, which is sized
// for an agent reading a change; this is a voter asking one question with a
// summary already in front of them, and the ceiling exists so a
// three-hundred-file proposal costs the same as a one-file one.
const DIFF_CHAR_BUDGET = 9000;
// Comments kept, most recent first-in-thread order preserved.
// clipIssueComments defaults to 30 — that is the topic page's budget, which
// has a whole screen. Twelve is the tail of a conversation, which is the
// part a question is usually about.
const COMMENTS_KEEP = 12;

// NOT included: src/prompts/app-conventions.md. The pane's original note
// named "the app's conventions" alongside the diff and the discussion, and
// that document is 141 KB — the same 141 KB on every question, dwarfing the
// change being asked about, to answer "how should apps here be written",
// which is a question a voter is not asking. If a conventions answer is
// wanted later it belongs behind a retrieval step, not stapled to every
// call.

const KINDS = new Set(['proposal', 'gov', 'issue']);

// The stored thread (workshop_ask_messages). READ is what comes back to the
// pane and rides along as history; KEEP is what stays on disk. Both are
// turns, not exchanges, so 30 is fifteen questions — well past a scratchpad
// for one decision, and the trim keeps a thread from growing without end on
// a card somebody keeps coming back to.
const THREAD_READ = 30;
const THREAD_KEEP = 60;

const clip = (v, n) => {
  const s = String(v == null ? '' : v).trim();
  return s ? s.slice(0, n) : null;
};

function parseOwnerRepo(repoUrl) {
  const m = String(repoUrl || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * Validate the target a client sent. Returns { kind, ref } or null.
 *
 * `ref` is an integer in every kind — a session id, an internal issues id,
 * or a GitHub issue number — so one check covers all three, and a
 * non-numeric reference never reaches a query.
 */
function parseTarget(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = String(raw.kind || '');
  if (!KINDS.has(kind)) return null;
  const ref = Number(raw.ref);
  if (!Number.isInteger(ref) || ref <= 0) return null;
  return { kind, ref };
}

/**
 * The card, as the server knows it. Null when the reference names nothing
 * this app has — which the route turns into a 404, the same deny every
 * other app-scoped read uses.
 */
async function resolveSubject(pool, app, target) {
  if (target.kind === 'proposal') {
    const { rows } = await pool.query(
      `SELECT id, pr_number, pr_title, pr_summary_md, branch_name, status
         FROM chat_sessions
        WHERE id = $1 AND app_id = $2`,
      [target.ref, app.id]
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      kind: 'proposal',
      ref: r.id,
      what: 'A proposed change, awaiting the group\'s vote',
      title: clip(r.pr_title, TITLE_MAX),
      summary: clip(r.pr_summary_md, SUMMARY_MAX),
      state: clip(r.status, 64),
      prNumber: r.pr_number == null ? null : Number(r.pr_number),
      branch: clip(r.branch_name, 200),
    };
  }

  if (target.kind === 'gov') {
    const { rows } = await pool.query(
      `SELECT id, title, description, kind, status, github_issue_number
         FROM issues
        WHERE id = $1 AND app_id = $2`,
      [target.ref, app.id]
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      kind: 'gov',
      ref: r.id,
      what: 'A governance proposal, awaiting the group\'s vote',
      title: clip(r.title, TITLE_MAX),
      // A governance proposal has no diff: its case IS its description, so
      // that is the body rather than a secondary field.
      body: clip(r.description, BODY_MAX),
      govKind: clip(r.kind, 64),
      state: clip(r.status, 64),
      prNumber: null,
      issueNumber: r.github_issue_number == null ? null : Number(r.github_issue_number),
    };
  }

  // A GitHub issue. Read through services/github's anonymous in-process
  // cache — the same one the board paints from — so an ask can never cost
  // more GitHub traffic than opening the board already did.
  const or = parseOwnerRepo(app.repo_url);
  if (!or || !github.isEnabled()) return null;
  let issue = null;
  try {
    const res = await github.fetchPublicIssues(or.owner, or.repo);
    const list = Array.isArray(res && res.issues) ? res.issues : [];
    issue = list.find((i) => Number(i.number) === target.ref) || null;
  } catch (err) {
    log.warn('workshop-ask', 'issue lookup failed', { app: app.slug, message: err.message });
    return null;
  }
  if (!issue) return null;
  return {
    kind: 'issue',
    ref: target.ref,
    what: 'An open request nobody has picked up yet',
    title: clip(issue.title, TITLE_MAX),
    body: clip(issue.body, BODY_MAX),
    state: 'open',
    issueNumber: target.ref,
  };
}

/**
 * The change itself and what has been said about it — best effort.
 *
 * BOTH HALVES FAIL OPEN, and that is the whole design of this function. An
 * answer built from the title and summary alone is worse than one built
 * from the diff, but it is far better than an error: GitHub being slow is
 * not a reason a voter cannot ask what a change does. Every absence is
 * REPORTED rather than silently omitted — `diffAvailable: false` in the
 * snapshot is what stops the model answering about code it never saw, and
 * the system prompt tells it to say so instead of guessing.
 *
 * The diff is a three-dot compare against `main`, matching every other
 * caller in the codebase (platform-env-check, app-admins).
 */
async function gatherEvidence(app, subject) {
  const out = { diff: null, diffAvailable: false, diffTruncated: false, filesChanged: null,
    discussion: null, discussionTruncated: false };
  const or = parseOwnerRepo(app.repo_url);
  if (!or || !github.isEnabled()) return out;

  // A proposal's code. Governance items and issues have none by
  // construction, so this is not attempted for them.
  if (subject.kind === 'proposal' && subject.branch) {
    try {
      const d = await github.getProposalDiff(
        or.owner, or.repo, `main...${subject.branch}`, DIFF_CHAR_BUDGET
      );
      if (d && d.diff) {
        out.diff = d.diff;
        out.diffAvailable = true;
        out.diffTruncated = !!d.truncated;
        out.filesChanged = d.fileCount;
      }
    } catch (err) {
      log.warn('workshop-ask', 'diff fetch failed', {
        app: app.slug, branch: subject.branch, message: err.message,
      });
    }
  }

  // The thread. A proposal's discussion lives on its pull request, which is
  // an issue number as far as the comments API is concerned — so one call
  // covers all three kinds, on whichever number the subject carries.
  const thread = subject.prNumber || subject.issueNumber || null;
  if (thread) {
    try {
      const raw = await github.fetchIssueComments(or.owner, or.repo, thread);
      const clipped = github.clipIssueComments(raw.comments, {
        max: COMMENTS_KEEP, wasTruncated: !!raw.truncated,
      });
      if (clipped.comments.length) {
        out.discussion = clipped.comments;
        out.discussionTruncated = !!clipped.truncated;
      }
    } catch (err) {
      log.warn('workshop-ask', 'comment fetch failed', {
        app: app.slug, thread, message: err.message,
      });
    }
  }

  return out;
}

/**
 * What the model is given: the subject, the evidence, and nothing else.
 *
 * `appName` is here so an answer can say "this app" and mean something.
 * Every value in it came from resolveSubject or gatherEvidence — see the
 * trust note at the top of the file.
 */
function buildContext(app, subject, evidence) {
  const e = evidence || {};
  return {
    app: clip(app.name || app.slug, 120),
    item: subject,
    // Stated whether or not there is a diff. The model is told to answer
    // from the snapshot and to say when it cannot, and "there is no diff
    // here" is the fact that makes that instruction actionable rather than
    // a hope.
    code: {
      available: !!e.diffAvailable,
      filesChanged: e.filesChanged == null ? null : e.filesChanged,
      truncated: !!e.diffTruncated,
      diff: e.diff || null,
    },
    discussion: {
      available: !!(e.discussion && e.discussion.length),
      truncated: !!e.discussionTruncated,
      comments: e.discussion || [],
    },
  };
}

/**
 * This viewer's own thread on this card, oldest turn first.
 *
 * Both app_id and user_id are in the predicate, always. There is no route
 * that reads somebody else's thread and no shape of request that could ask
 * for one — the user id comes from the session, never from the body.
 */
async function loadThread(pool, app, userId, target) {
  const { rows } = await pool.query(
    `SELECT role, body FROM workshop_ask_messages
      WHERE app_id = $1 AND user_id = $2 AND target_kind = $3 AND target_ref = $4
      ORDER BY id DESC
      LIMIT $5`,
    [app.id, userId, target.kind, target.ref, THREAD_READ]
  );
  // Newest-first in SQL so the LIMIT keeps the TAIL, then flipped: an
  // ORDER BY id ASC with a LIMIT would keep the oldest turns and drop the
  // conversation the reader is actually in.
  return rows.reverse().map((r) => ({ who: r.role === 'ai' ? 'ai' : 'you', text: r.body }));
}

/**
 * Record one exchange, and trim the thread behind it.
 *
 * NEVER THROWS. A stored transcript is a convenience; the answer has
 * already been given and, on the streaming path, already delivered. Losing
 * the write is a thread that does not come back, which is the same place
 * the feature was one commit ago — failing the request over it would turn
 * a cosmetic loss into a visible one. Same tolerance limits.recordSpend
 * takes, for the same reason.
 */
async function recordExchange(pool, app, userId, target, question, answer, model) {
  try {
    await pool.query(
      `INSERT INTO workshop_ask_messages
         (app_id, user_id, target_kind, target_ref, role, body, model)
       VALUES ($1, $2, $3, $4, 'you', $5, NULL),
              ($1, $2, $3, $4, 'ai',  $6, $7)`,
      [app.id, userId, target.kind, target.ref, question, answer, model || null]
    );
    // Trim to the tail. Done per write rather than by a sweeper because the
    // bound is per thread and this is the only thing that ever grows one.
    await pool.query(
      `DELETE FROM workshop_ask_messages
        WHERE app_id = $1 AND user_id = $2 AND target_kind = $3 AND target_ref = $4
          AND id NOT IN (
            SELECT id FROM workshop_ask_messages
             WHERE app_id = $1 AND user_id = $2 AND target_kind = $3 AND target_ref = $4
             ORDER BY id DESC LIMIT $5
          )`,
      [app.id, userId, target.kind, target.ref, THREAD_KEEP]
    );
  } catch (err) {
    log.warn('workshop-ask', 'thread write failed', {
      app: app.slug, kind: target.kind, ref: target.ref, message: err.message,
    });
  }
}

/**
 * Answer one question about one card.
 *
 * Throws with a `code` the route maps to a status:
 *   not_found       — the reference names nothing in this app
 *   budget_exceeded — the asker is out of allowance and has no key on file
 *   llm_unavailable — no model is configured on this server
 */
async function ask({ pool, config, app, userId, target, question, model, onToken, signal }) {
  const q = clip(question, QUESTION_MAX);
  if (!q) {
    const err = new Error('Ask a question first');
    err.code = 'empty_question';
    throw err;
  }

  const subject = await resolveSubject(pool, app, target);
  if (!subject) {
    const err = new Error('That item is not on this app');
    err.code = 'not_found';
    throw err;
  }

  const billing = await limits.resolveBillingPath(pool, config.dataEncryptionKey, userId);
  if (billing.error) {
    const err = new Error(billing.error);
    err.code = 'budget_exceeded';
    throw err;
  }

  // AFTER the budget check, never before: a user who cannot be billed for
  // the answer should not cost the platform two GitHub round trips first.
  const evidence = await gatherEvidence(app, subject);

  // THE THREAD IS THE SERVER'S, not the client's. The pane used to send its
  // own transcript back as history, which meant a caller could put any
  // words in their own mouth — or the model's — and have them replayed as
  // established context on the next turn. Reading it from the row the last
  // exchange wrote removes that entirely, and it is also what makes the
  // conversation survive a reload: one source, not two that can disagree.
  const history = await loadThread(pool, app, userId, target);

  let result;
  try {
    result = await llm.answerWorkshopQuestion({
      contextJson: JSON.stringify(buildContext(app, subject, evidence)),
      question: q,
      history,
      model,
      onToken,
      signal,
      apiKey: billing.apiKey,
      telemetryContext: { pool, appId: app.id },
    });
  } catch (err) {
    if (/LLM not initialized/.test(err.message)) {
      const e = new Error('No AI model is configured on this server');
      e.code = 'llm_unavailable';
      throw e;
    }
    throw err;
  }

  // Debit the asker, into the BYOK bucket when their own key paid for it —
  // the same settle report-ai does after its Haiku call.
  if (result.usage) {
    await limits.recordSpend(
      pool, userId, llm.estimateCostCents(result.usage, result.model),
      { byok: !!billing.apiKey }
    );
  }

  await recordExchange(pool, app, userId, target, q, result.text, result.model);

  return { text: result.text, model: result.model };
}

module.exports = {
  ask, parseTarget, resolveSubject, buildContext, gatherEvidence,
  loadThread, recordExchange,
  TITLE_MAX, SUMMARY_MAX, BODY_MAX, QUESTION_MAX,
  DIFF_CHAR_BUDGET, COMMENTS_KEEP, THREAD_READ, THREAD_KEEP,
};
