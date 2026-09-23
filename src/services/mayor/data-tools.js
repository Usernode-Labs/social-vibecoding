'use strict';

// In-process resolution of the Mayor's data tools (and the side-effecting
// draft_issue_report), looped back to the model as tool_results.
//
// Moved verbatim out of routes/sessions.js (#2779) so the Mayor turn can run
// for a conversation that is not one change (see docs/agent-sessions.md).
// The classic dev-chat route, headless runs and interrupted-turn recovery
// import it from here; routes/sessions.js re-exports it for existing callers.

const debugAccess = require('../debug-access');
const github = require('../github');
const issueDraft = require('../issue-draft');
const log = require('../logger');
const statusSvc = require('../status');
const threadContext = require('../thread-context');
const webFetch = require('../web-fetch');

// The Mayor's read-only DATA tools — resolved in-process and looped
// back as tool_results (unlike the terminal dispatch tools).
// get_prod_status is in the set so the loop services it, but the tool
// itself is only OFFERED on prod-debug-eligible sessions (see the
// tools-array construction in the chat handler).
const DATA_TOOL_NAMES = new Set(['list_github_issues', 'get_github_issue', 'web_fetch', 'get_prod_status']);

// #1037: draft_issue_report is resolved by the SAME in-process loop, but
// it is not a data tool — it has a side effect (a draft card lands in the
// timeline). Kept as its own name so the read-only guarantees documented
// on DATA_TOOL_NAMES stay accurate, and folded into the superset below
// wherever the loop just needs "can I answer this tool_use in-process?".
const DRAFT_TOOL_NAME = 'draft_issue_report';

const IN_PROCESS_TOOL_NAMES = new Set([...DATA_TOOL_NAMES, DRAFT_TOOL_NAME]);

// Cap on how many consecutive data-tool fetches we'll service
// within a single Mayor turn before forcing the model to move on. Bounds
// the worst case where the model loops on the data tools instead of acting.
const MAYOR_DATA_TOOLS_MAX_ITERS = 3;

// Resolve a list_github_issues tool call to the JSON string we hand back as
// tool_result content. Owner/repo come straight from apps.repo_url; when
// they're absent we return the well-formed empty-with-note shape rather
// than erroring. github.fetchPublicIssues never throws.
async function resolveGithubIssuesToolResult(repoOwner, repoName) {
  if (!repoOwner || !repoName) {
    return JSON.stringify({ issues: [], truncatedList: false, note: 'no repo' });
  }
  // Clip verbose bodies for the model's context — the cache itself carries
  // full bodies for the web route / Create-PR seeding (#158). The marker
  // names get_github_issue so the Mayor knows the on-demand escape hatch.
  const result = await github.fetchPublicIssues(repoOwner, repoName);
  return JSON.stringify(github.truncateIssueBodies(result, (n) => `get_github_issue(${n})`));
}

// Resolve a get_github_issue tool call: ONE issue, FULL body (#158), plus
// its comment thread (#396). Calls both fetchPublicIssue and
// fetchIssueComments (mirroring the headless seed) and merges them — the
// thread is clipped via clipIssueComments so a chatty issue can't blow up
// the turn's context. Both fetchers never throw; `comments` is always an
// array and `commentsNote` carries a comment-fetch failure independently of
// the issue's own `note`. `commentsTruncated` is true when older comments
// were omitted (long thread or kept-count cap).
// `threadCtx` ({ pool, appId }, #945): when present, the issue's
// Homeroom-side Discussion thread rides along as `usernodeThread`. Call
// sites that can't supply it (or a lookup that finds nothing) simply omit
// the field — the GitHub halves are unaffected either way.
async function resolveGithubIssueToolResult(repoOwner, repoName, number, threadCtx = null) {
  if (!repoOwner || !repoName) {
    return JSON.stringify({ issue: null, comments: [], commentsTruncated: false, note: 'no repo' });
  }
  const { issue, note } = await github.fetchPublicIssue(repoOwner, repoName, number);
  const raw = await github.fetchIssueComments(repoOwner, repoName, number);
  const { comments, truncated } = github.clipIssueComments(raw.comments, { wasTruncated: raw.truncated });
  const thread = threadCtx && threadCtx.pool
    ? await threadContext.loadIssueThread(threadCtx.pool, threadCtx.appId, number)
    : { messages: [], truncated: false };
  return JSON.stringify({
    issue,
    comments,
    commentsTruncated: truncated,
    ...(thread.messages.length
      ? { usernodeThread: thread.messages, usernodeThreadTruncated: thread.truncated }
      : {}),
    ...(note ? { note } : {}),
    ...(raw.note ? { commentsNote: raw.note } : {}),
  });
}

// Resolve a web_fetch tool call (#30). webFetch.fetchUrl never throws —
// SSRF refusals, timeouts, and network errors all come back as
// { url, content: null, note } and the Mayor reasons with the note.
async function resolveWebFetchToolResult(rawUrl) {
  return JSON.stringify(await webFetch.fetchUrl(rawUrl));
}

// Byte cap on the get_prod_status tool_result. The admin status payload
// plus the log ring can get large; the Mayor only needs the headline
// numbers, so we bound what enters its context.
const PROD_STATUS_MAX_BYTES = 24 * 1024;

// Resolve a get_prod_status tool call (#616 follow-up): the admin
// status payload + the redacted platform log ring, the same snapshot
// `usernode-debug status` serves dispatched agents. Never throws —
// failures come back as { status: null, note } and the Mayor reasons
// with the note. Defense in depth: eligibility is re-checked here at
// resolution time, so a mid-turn admin revocation (or a stale replay)
// yields a not_eligible note instead of production state.
async function resolveProdStatusToolResult({ pool, config, sessionId }) {
  let check;
  try {
    check = await debugAccess.checkSessionEligibility(pool, sessionId);
  } catch (err) {
    log.warn('prod-debug', 'Mayor status snapshot eligibility check failed', {
      sessionId, err: err.message,
    });
    return JSON.stringify({ status: null, note: 'eligibility check failed' });
  }
  if (!check.eligible) {
    log.warn('prod-debug', 'Mayor status snapshot rejected — session not eligible', { sessionId });
    return JSON.stringify({ status: null, note: 'not_eligible' });
  }
  // Audit trail before executing, same shape as the internal prod-debug
  // routes' per-call lines.
  log.info('prod-debug', 'Mayor status snapshot', { sessionId, ownerId: check.ownerId });
  try {
    const status = await statusSvc.gather(config, { isAdmin: true });
    let out = JSON.stringify({ status, recentLog: log.tail(100) });
    if (out.length > PROD_STATUS_MAX_BYTES) {
      // The log ring is the bulkiest, least structured part — drop it
      // first and only then hard-truncate (leaving JSON invalid past the
      // marker is acceptable: the note tells the model what happened).
      out = JSON.stringify({ status, recentLog: [], note: 'recentLog omitted — payload too large' });
    }
    if (out.length > PROD_STATUS_MAX_BYTES) {
      out = `${out.slice(0, PROD_STATUS_MAX_BYTES)}… [truncated]`;
    }
    return out;
  } catch (err) {
    log.warn('prod-debug', 'Mayor status snapshot failed', { sessionId, err: err.message });
    return JSON.stringify({ status: null, note: `status unavailable: ${err.message}` });
  }
}

// Resolve a draft_issue_report tool call (#1037): create the human-gated
// draft card and hand the model back the plain result object, so it can
// write "drafted it — tap to confirm" (or relay a de-dupe / failure) in
// the SAME turn. Needs `prodCtx` for { pool, config, sessionId }; without
// it there is no session to attach the card to, which is a call-site bug
// rather than a model error — report it as a note the Mayor can relay.
async function resolveDraftIssueToolResult(tu, ctx) {
  if (!ctx || !ctx.pool || !ctx.sessionId) {
    return JSON.stringify({ ok: false, code: 'not_configured' });
  }
  const input = tu.input || {};
  const result = await issueDraft.createDraft(ctx.pool, ctx.config, {
    sessionId: ctx.sessionId,
    title: input.title,
    body: input.body,
    target: input.target,
    source: 'user_request',
  });
  return JSON.stringify(result);
}

// Route one in-process tool_use to its resolver. Callers guard on
// IN_PROCESS_TOOL_NAMES so `tu.name` is always one of the five.
// `prodCtx` ({ pool, config, sessionId }) is only passed by the
// interactive chat handler — call sites that never offer get_prod_status
// or draft_issue_report (headless) omit it, and a get_prod_status call
// without it resolves to not_eligible.
// `threadCtx` ({ pool, appId }, #945) enriches get_github_issue with the
// issue's Homeroom Discussion thread. Omitted → the field is absent.
function resolveDataToolResult(tu, repoOwner, repoName, prodCtx = null, threadCtx = null) {
  if (tu.name === DRAFT_TOOL_NAME) {
    return resolveDraftIssueToolResult(tu, prodCtx);
  }
  if (tu.name === 'get_prod_status') {
    return prodCtx
      ? resolveProdStatusToolResult(prodCtx)
      : Promise.resolve(JSON.stringify({ status: null, note: 'not_eligible' }));
  }
  if (tu.name === 'web_fetch') {
    return resolveWebFetchToolResult(tu.input && tu.input.url);
  }
  return tu.name === 'get_github_issue'
    ? resolveGithubIssueToolResult(repoOwner, repoName, tu.input && tu.input.number, threadCtx)
    : resolveGithubIssuesToolResult(repoOwner, repoName);
}

// Status line for a batch of data-tool calls being resolved. web_fetch
// shows the hostname (not the full URL — the persisted system row stays
// tidy); issue calls keep the historical wording.
function dataToolStatusLine(calls) {
  // #1037: the draft is the visible outcome of the turn, so it names the
  // status line even when a read rides along in the same batch.
  if (calls.some((tc) => tc.name === DRAFT_TOOL_NAME)) {
    return 'Drafting an issue report...';
  }
  if (calls.some((tc) => tc.name === 'get_prod_status')) {
    return 'Checking production status...';
  }
  const wf = calls.find((tc) => tc.name === 'web_fetch');
  if (wf) {
    try {
      return `Fetching ${new URL(String(wf.input && wf.input.url)).hostname}...`;
    } catch {
      return 'Fetching a web page...';
    }
  }
  return "Reading the repo's GitHub issues...";
}

// #990: the step line emitted once a data-tool batch has RESOLVED, while
// the model is re-invoked with the fetched material in context. Without it
// the ladder's last live row still says "Fetching github.com..." for the
// whole (observed: ~12s) compose window — the reporter read that stale,
// still-spinning row as "it wasn't thinking", then the reply popped in.
// Emitting a fresh row is what makes the client freeze the fetch row with
// its real "(took Xs)" and start a new ticker, on reload as well as live.
const DATA_TOOL_THINKING_STATUS = 'Thinking about what came back...';

module.exports = {
  DATA_TOOL_NAMES,
  DRAFT_TOOL_NAME,
  IN_PROCESS_TOOL_NAMES,
  MAYOR_DATA_TOOLS_MAX_ITERS,
  resolveGithubIssuesToolResult,
  resolveGithubIssueToolResult,
  resolveWebFetchToolResult,
  PROD_STATUS_MAX_BYTES,
  resolveProdStatusToolResult,
  resolveDraftIssueToolResult,
  resolveDataToolResult,
  dataToolStatusLine,
  DATA_TOOL_THINKING_STATUS,
};
