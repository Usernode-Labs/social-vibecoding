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

const KINDS = new Set(['proposal', 'gov', 'issue']);

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
 * What the model is given: the subject and nothing else.
 *
 * `appName` is here so an answer can say "this app" and mean something.
 * Every value in it came from resolveSubject — see the trust note at the
 * top of the file.
 */
function buildContext(app, subject) {
  return {
    app: clip(app.name || app.slug, 120),
    item: subject,
  };
}

/**
 * Answer one question about one card.
 *
 * Throws with a `code` the route maps to a status:
 *   not_found       — the reference names nothing in this app
 *   budget_exceeded — the asker is out of allowance and has no key on file
 *   llm_unavailable — no model is configured on this server
 */
async function ask({ pool, config, app, userId, target, question, history, model }) {
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

  let result;
  try {
    result = await llm.answerWorkshopQuestion({
      contextJson: JSON.stringify(buildContext(app, subject)),
      question: q,
      history,
      model,
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

  return { text: result.text, model: result.model };
}

module.exports = {
  ask, parseTarget, resolveSubject, buildContext,
  TITLE_MAX, SUMMARY_MAX, BODY_MAX, QUESTION_MAX,
};
