'use strict';

// The Homeroom bot's proposals for requests that closed some other way.
//
// noteRequestMerged (homeroom-bot.js) withdraws the bot's other proposals for
// a request once the bot's OWN proposal for it merges. A request also closes
// when a person's change ships it, when the group votes to close it, or when
// somebody closes it on GitHub, and none of those touched the bot's proposal:
// it stayed up for a vote, and since classifyIssue never reads a closed
// request again, the bot never looked at it again either. On 15 October three
// of the five proposals the platform project allows the bot
// (PROPOSALS_PER_APP_CAP) were for closed requests: #4817 shipped by a
// person's PR, #4389 shipped by another change, #4968 closed by a vote. Every
// other ready request on the project waited behind them.
//
// So a proposal of the bot's that is up for a vote is withdrawn once EVERY
// request it is linked to is closed (one linked to two stays while either is
// open), the same system archive noteRequestMerged uses, with a line on each
// request saying why. A person's proposal is theirs, and one already approved
// (merging, merged) is past withdrawing. What calls this:
//   - every observed close after a merge, the bot's or a person's
//     (issue-close-watcher.js, and merge-followups/facts.ts for a change that went
//     live inside another);
//   - a passed close-issue vote (the governance machine's bot.requestsClosed
//     work, src/workflow/governance-proposal/services.ts);
//   - the bot's own refresh, for a request closed on GitHub, where Homeroom
//     gets no signal (homeroom-bot.js refreshApp, sweepClosedRequests).
// Best effort everywhere: never a reason a merge, a vote or a refresh fails.
//
// The platform's own row for such a request stayed open too. The tray already
// moves a request whose row is closed out of Needs you (homeroom-bot-tray.js,
// pastRuns' request_closed, #4539 and #5009), so once the row closes the
// strip lets the request go — but nothing closed it: a merge and a close vote
// do, a close on GitHub does not, and #4752 kept showing in Needs you after
// the bot's own chat answer had read it closed on GitHub. closeRequestRows
// below closes it, on the bot's refresh: for the tracked requests the
// refresh's open list no longer names, GitHub is asked once, and only a close
// GitHub itself reports closes the row (one-way; a reopen never reopens it),
// then the caches are busted and open trays re-read, the same way a merge's
// close does (issue-close-watcher.js bustAndBroadcast, closeTwinRows).
// then the caches are busted and open trays re-read, the same way a merge's
// close does (issue-close-watcher.js bustAndBroadcast, closeTwinRows).
//
// 16 Oct 2026: #4752 never had such a row. A request filed through Suggest an
// improvement or a comment pin (routes/feedback.js) gets a GitHub issue and a
// requester, not a row in issues, so neither closing a row nor reading one
// could ever tell the tray it closed, and its old ask stayed in Needs you.
// Every close the bot sees of a request it tracks is now also recorded in
// homeroom_bot_closed_requests (recordClosed), row or no row: by
// noteRequestsClosed, which every merge's and every close vote's close
// reaches, and by closeRequestRows, whose candidates are now the tracked
// requests themselves rather than their rows. The bot's readers take a
// request as closed when either its row or this record says so.

const log = require('./logger');
const repoRef = require('./repo-ref');

const BOT_USERNAME = 'homeroom_bot';
const REASON = 'request-closed';

// The bot's proposals up for a vote on one app, by what they are linked to:
// any of `$3` (a close just seen), or none of `$3` (a refresh's open list).
// Kept whole, rather than one query with a clause added, so each stays a
// static statement the SQL checks read as written.
const LINKED_TO_ANY_SQL = `
  SELECT cs.id, cs.app_id, cs.linked_issues,
         COALESCE(NULLIF(cs.pr_title, ''), NULLIF(cs.session_title, '')) AS title,
         a.repo_url
    FROM chat_sessions cs
    JOIN users u ON u.id = cs.user_id
    JOIN apps a ON a.id = cs.app_id
   WHERE cs.app_id = $1 AND cs.status = 'promoted' AND cs.is_headless = FALSE
     AND u.username = $2 AND u.is_synthetic = TRUE
     AND cs.linked_issues && $3::int[]
   ORDER BY cs.id`;

const LINKED_TO_NONE_SQL = `
  SELECT cs.id, cs.app_id, cs.linked_issues,
         COALESCE(NULLIF(cs.pr_title, ''), NULLIF(cs.session_title, '')) AS title,
         a.repo_url
    FROM chat_sessions cs
    JOIN users u ON u.id = cs.user_id
    JOIN apps a ON a.id = cs.app_id
   WHERE cs.app_id = $1 AND cs.status = 'promoted' AND cs.is_headless = FALSE
     AND u.username = $2 AND u.is_synthetic = TRUE
     AND cardinality(cs.linked_issues) > 0
     AND NOT (cs.linked_issues && $3::int[])
   ORDER BY cs.id`;

function parseRepo(url) {
  return repoRef.ownerRepo(url);
}

function numbersOf(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

/** Pure: the line a withdrawal leaves on each of its requests (the proposal machine's close writes it). */
const { withdrawnNote: closedNote } = require('../workflow/rules/bot-notes.ts');

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR_SOCKET']);
const transient = (err) => err?.status === 429 || Number(err?.status) >= 500 || NETWORK_CODES.has(err?.code);

// Whether GitHub says #n is a closed issue. Only a positive answer counts: a
// pull request or anything else keeps the proposal up. A failed read keeps
// it up too, except for a durable caller (`strict`), which is told: its
// retry reads again, rather than settling the proposal as up for good.
function githubClosed(repo, deps, { strict = false } = {}) {
  const memo = new Map();
  return (n) => {
    if (!memo.has(n)) {
      const github = deps.github || require('./github');
      memo.set(n, !repo ? Promise.resolve(false) : Promise.resolve()
        .then(() => github.getIssue(repo.owner, repo.repo, n))
        .then((issue) => !!issue && issue.state === 'closed' && !issue.pull_request, (err) => {
          // What may answer on a retry (GitHub down, rate limited, the
          // network) is retried by a durable caller; anything else (gone,
          // forbidden, not configured) keeps the proposal up, as before.
          if (strict && transient(err)) throw err;
          return false;
        }));
    }
    return memo.get(n);
  };
}

// Withdrawn through the proposal machine, whose close (reason
// `request-closed`) also writes the line each of its requests' threads
// says, in the same transaction: a crash between the two cannot lose it.
async function withdrawOne(pool, session, numbers, deps) {
  void numbers;
  const lifecycle = deps.sessionLifecycle || require('./session-lifecycle');
  let archived = false;
  try {
    ({ archived } = await lifecycle.archiveSession({ pool, sessionId: Number(session.id), reason: REASON, from: 'promoted' }));
  } catch (err) {
    // A side effect after the archive failed: it is withdrawn if its row says so.
    log.warn('homeroom-bot-closed-requests', 'Withdrawing a proposal partly failed', { sessionId: session.id, err: err.message });
    const { rows } = await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [session.id]);
    archived = rows[0]?.status === 'archived';
  }
  return !!archived;
}

async function withdrawWhereAllClosed(pool, sessions, { known = new Set(), deps = {}, strict = false }) {
  const withdrawn = [];
  for (const session of sessions) {
    const linked = numbersOf(session.linked_issues);
    if (!linked.length) continue;
    const isClosed = deps.isClosed || githubClosed(parseRepo(session.repo_url), deps, { strict });
    let allClosed = true;
    for (const n of linked) {
      if (known.has(n)) continue;
      if (!(await isClosed(n))) { allClosed = false; break; }
    }
    if (allClosed && await withdrawOne(pool, session, linked, deps)) withdrawn.push(Number(session.id));
  }
  return withdrawn;
}

// 16 Oct 2026 (V4): the people who asked the bot for requests somebody
// else's merged change just shipped: each requester of a request the bot
// had live runs on, beside the change that shipped it and whoever made it.
// Not when the bot's own change merged (that is its own news, Live), nor
// when the requester made it themselves, and never a first version. `$1` the app, `$2` the requests, `$3` the bot's
// username.
const DONE_ELSEWHERE_SQL = `
  SELECT q.user_id, q.issue_number, q.issue_title, a.slug, a.name, d.username, d.pr_number
    FROM homeroom_bot_requesters q
    JOIN apps a ON a.id = q.app_id
    JOIN LATERAL (
      SELECT u.username, cs.pr_number
        FROM chat_sessions cs JOIN users u ON u.id = cs.user_id
       WHERE cs.app_id = q.app_id AND cs.status = 'merged' AND u.username <> $3 AND cs.user_id <> q.user_id
         AND (q.issue_number = ANY(cs.linked_issues) OR cs.created_from_issue_number = q.issue_number)
       ORDER BY cs.merged_at DESC NULLS LAST, cs.id DESC
       LIMIT 1
    ) d ON TRUE
   WHERE q.app_id = $1 AND q.issue_number = ANY($2::int[]) AND q.first_version IS NOT TRUE
     AND EXISTS (SELECT 1 FROM homeroom_bot_runs r
                  WHERE r.app_id = q.app_id AND r.issue_number = q.issue_number AND r.mode = 'live')
     AND NOT EXISTS (SELECT 1 FROM chat_sessions b JOIN users bu ON bu.id = b.user_id
                      WHERE b.app_id = q.app_id AND b.status = 'merged' AND bu.username = $3
                        AND q.issue_number = ANY(b.linked_issues))`;

/** Pure: what the bot says to whoever asked, when somebody else's change shipped their request. */
function doneElsewhereText({ title, username }) {
  const what = title ? `“${String(title).slice(0, 120)}”` : 'This request';
  const who = username ? `a change by @${username}` : 'another change';
  return `${what} was done another way: ${who} did what it asked. There's nothing more for me to build here.`;
}

/**
 * Tell each person who asked the bot for one of `numbers` (just closed) that
 * somebody else's change shipped it, once (rings as done another way:
 * homeroom-bot-dm.js STORY_MOMENTS `request_closed`), and re-read their open
 * tray. Resolves how many were told. Best effort, never throws, unless
 * `strict` (a durable caller's work, which retries): then a read or a DM
 * that failed throws, and the retry tells only who was not told yet (each
 * DM is keyed per request and person).
 */
async function tellDoneElsewhere(pool, { appId, numbers, deps = {}, strict = false }) {
  let told = 0;
  try {
    const { rows } = await pool.query(DONE_ELSEWHERE_SQL, [Number(appId), numbers, BOT_USERNAME]);
    if (!rows.length) return 0;
    const { rows: [bot] = [] } = await pool.query(
      'SELECT id, username FROM users WHERE username = $1 AND is_synthetic = TRUE', [BOT_USERNAME],
    );
    if (!bot) return 0;
    const dm = deps.dm || require('./homeroom-bot-dm');
    const tray = deps.tray || require('./homeroom-bot-tray');
    for (const row of rows) {
      const n = Number(row.issue_number);
      const sent = await dm.sendDm(pool, {
        bot,
        userId: Number(row.user_id),
        content: doneElsewhereText({ title: row.issue_title, username: row.username }),
        metadata: {
          kind: 'request_closed', appSlug: row.slug, appName: row.name || row.slug, issueNumber: n,
          requestTitle: row.issue_title || null, said: 'done_elsewhere', doneBy: row.username || null,
        },
        idempotencyKey: `hrbot-done-elsewhere-${Number(appId)}-${n}-${Number(row.user_id)}`,
      }).catch((err) => {
        if (strict) throw err;
        log.warn('homeroom-bot-closed-requests', 'Could not tell a requester their request was done another way', { appId, n, err: err.message });
        return null;
      });
      if (sent) told += 1;
      tray.noteWorkChanged(Number(row.user_id));
    }
  } catch (err) {
    if (strict) throw err;
    log.warn('homeroom-bot-closed-requests', 'Could not tell requesters their requests were done another way', { appId, err: err.message });
  }
  return told;
}

// Of `$2`, the requests of app `$1` the bot tracks (somebody filed it through
// the bot, or the bot has a live run on it), recorded closed now. A request
// recorded open (asked about, not closed) is recorded closed; one already
// closed keeps when it closed.
const RECORD_CLOSED_SQL = `
  INSERT INTO homeroom_bot_closed_requests (app_id, issue_number, closed_at, checked_at)
  SELECT $1, w.n, NOW(), NOW()
    FROM UNNEST($2::int[]) AS w(n)
   WHERE EXISTS (SELECT 1 FROM homeroom_bot_requesters q WHERE q.app_id = $1 AND q.issue_number = w.n)
      OR EXISTS (SELECT 1 FROM homeroom_bot_runs r WHERE r.app_id = $1 AND r.issue_number = w.n AND r.mode = 'live')
  ON CONFLICT (app_id, issue_number) DO UPDATE
     SET closed_at = COALESCE(homeroom_bot_closed_requests.closed_at, EXCLUDED.closed_at),
         checked_at = EXCLUDED.checked_at`;

// The reconcile asked GitHub about `$2` and none was closed: remembered, so
// the next refresh asks about the others first (OPEN_TRACKED_SQL's order).
const CHECKED_OPEN_SQL = `
  INSERT INTO homeroom_bot_closed_requests (app_id, issue_number, closed_at, checked_at)
  SELECT $1, w.n, NULL, NOW() FROM UNNEST($2::int[]) AS w(n)
  ON CONFLICT (app_id, issue_number) DO UPDATE SET checked_at = EXCLUDED.checked_at
   WHERE homeroom_bot_closed_requests.closed_at IS NULL`;

// A request on a whole, fresh open list is open: whatever was recorded about
// it goes. A close recorded in the last ten minutes stays, in case the list
// was read before GitHub's own caught up with the close.
const CLEAR_REOPENED_SQL = `
  DELETE FROM homeroom_bot_closed_requests
   WHERE app_id = $1 AND issue_number = ANY($2::int[])
     AND (closed_at IS NULL OR closed_at < NOW() - INTERVAL '10 minutes')`;

/**
 * Record that requests `numbers` of app `appId` closed, for those the bot
 * tracks (homeroom_bot_closed_requests). Throws on a failed write; the callers
 * decide whether that matters.
 */
async function recordClosed(pool, { appId, numbers }) {
  const list = numbersOf(numbers);
  if (!pool || !(Number(appId) > 0) || !list.length) return;
  await pool.query(RECORD_CLOSED_SQL, [Number(appId), list]);
}

// The bot's lane hears a slot came free: the project is refreshed soon (a
// held request may take it). A hint: a lost one waits for the next refresh.
function wakeFor(appId, deps) {
  Promise.resolve()
    .then(() => (deps.wake || ((a) => require('../workflow/platform.ts').botRefresh(a.appId)))({ appId: Number(appId) }))
    .catch((err) => log.warn('homeroom-bot-closed-requests', 'Could not wake the bot after a withdrawal', { appId, err: err.message }));
}

/**
 * Requests `closed` on app `appId` were just closed. Withdraws every proposal
 * of the bot's up for a vote that is linked to one of them and whose other
 * linked requests GitHub also reads closed, then wakes the bot for the app so
 * a held request takes the slot. Resolves { withdrawn: [sessionId] }, or null
 * when it could not read; `strict` (the merge-followups machine's durable
 * work, which retries) throws that instead. Never throws otherwise.
 */
// `tellStrict` (default: as `strict`): whether a requester's DM that fails
// fails the call, for a caller whose retry would gate something else on it.
async function noteRequestsClosed(pool, { appId, closed, strict = false, tellStrict = strict, deps = {} } = {}) {
  const numbers = numbersOf(closed);
  if (!pool || !(Number(appId) > 0) || !numbers.length) return { withdrawn: [] };
  try {
    // 16 Oct 2026: recorded first, so the tray reads them closed, a request
    // with no row of ours among them (recordClosed). A failed write never
    // keeps the bot's proposals for them up, unless `strict` retries it all.
    try {
      await recordClosed(pool, { appId, numbers });
    } catch (err) {
      if (strict) throw err;
      log.warn('homeroom-bot-closed-requests', 'Could not record requests as closed', { appId, closed: numbers, err: err.message });
    }
    const { rows } = await pool.query(LINKED_TO_ANY_SQL, [Number(appId), BOT_USERNAME, numbers]);
    const withdrawn = await withdrawWhereAllClosed(pool, rows, { known: new Set(numbers), deps, strict });
    if (withdrawn.length) {
      log.info('homeroom-bot-closed-requests', 'Withdrew the bot\'s proposals for closed requests', { appId, closed: numbers, withdrawn });
      wakeFor(appId, deps);
    }
    // 16 Oct 2026 (V4): whoever asked the bot for one of them hears it was
    // done another way, when somebody else's merged change shipped it.
    if (deps.tellDoneElsewhere !== false) await tellDoneElsewhere(pool, { appId: Number(appId), numbers, deps, strict: tellStrict });
    return { withdrawn };
  } catch (err) {
    if (strict) throw err;
    log.warn('homeroom-bot-closed-requests', 'Could not settle the bot\'s proposals for closed requests', { appId, closed: numbers, err: err.message });
    return null;
  }
}

/**
 * The bot's refresh of one app read its open requests (`openNumbers`, a
 * complete list): a proposal of the bot's up for a vote none of whose linked
 * requests is among them may be for requests closed on GitHub. Each is
 * withdrawn once GitHub confirms every one of its requests closed. The list
 * alone is not trusted: a number just closed is hidden from it before GitHub
 * agrees (github.noteIssuesClosed), and one closed by mistake may be reopened.
 * The caller does not wake the bot; it is the refresh. Resolves
 * { withdrawn: [sessionId] }; never throws.
 */
async function sweepClosedRequests(pool, { appId, openNumbers, deps = {} } = {}) {
  if (!pool || !(Number(appId) > 0) || !Array.isArray(openNumbers)) return { withdrawn: [] };
  try {
    const { rows } = await pool.query(LINKED_TO_NONE_SQL, [Number(appId), BOT_USERNAME, numbersOf(openNumbers)]);
    const withdrawn = await withdrawWhereAllClosed(pool, rows, { deps });
    if (withdrawn.length) {
      log.info('homeroom-bot-closed-requests', 'Withdrew the bot\'s proposals for requests closed on GitHub', { appId, withdrawn });
    }
    return { withdrawn };
  } catch (err) {
    log.warn('homeroom-bot-closed-requests', 'Sweep for the bot\'s proposals on closed requests failed', { appId, err: err.message });
    return { withdrawn: [] };
  }
}

// The bot's tracked requests whose GitHub number is NOT on the refresh's open
// list and that nothing yet reads closed, a few at a time (RECONCILE_LIMIT):
// a large backlog clears over several refreshes instead of asking GitHub
// about all of it at once. Tracked means somebody filed it through the bot
// (homeroom_bot_requesters) or the bot has a live run on it — a request filed
// straight on GitHub that the bot never read is never a candidate. Until 16
// Oct 2026 these were the tracked requests' open rows in issues, so a request
// with no row (Suggest an improvement, a comment pin) was never asked about.
// One its row already reads closed is not asked about either. Never asked
// first, newest first; then the ones asked longest ago, so a request GitHub
// keeps not reporting closed (deleted, moved) never holds a place for good.
const RECONCILE_LIMIT = 25;

const OPEN_TRACKED_SQL = `
  SELECT t.n AS github_issue_number
    FROM (SELECT q.issue_number AS n FROM homeroom_bot_requesters q WHERE q.app_id = $1
          UNION
          SELECT r.issue_number FROM homeroom_bot_runs r WHERE r.app_id = $1 AND r.mode = 'live') t
    LEFT JOIN homeroom_bot_closed_requests c ON c.app_id = $1 AND c.issue_number = t.n
   WHERE t.n IS NOT NULL AND t.n > 0
     AND NOT (t.n = ANY($2::int[]))
     AND c.closed_at IS NULL
     AND COALESCE((SELECT i.status = 'closed' FROM issues i
                    WHERE i.app_id = $1 AND i.github_issue_number = t.n
                    ORDER BY i.id DESC LIMIT 1), FALSE) IS FALSE
   ORDER BY c.checked_at ASC NULLS FIRST, t.n DESC
   LIMIT $3`;

/**
 * The bot's refresh of one app read its open requests (`openNumbers`): its
 * tracked requests missing from that list may have been closed on GitHub by
 * hand, where Homeroom gets no signal. Each candidate is confirmed with
 * GitHub once — the open list alone is never trusted, for the same reasons
 * sweepClosedRequests gives — and only a close GitHub itself reports closes
 * the platform's row, which the tray's Needs you reads, through the watcher's
 * closeTwinRows: the one writer of issues.status outside the governance
 * machine, so this adds no second one. One-way: nothing reopens a row here.
 * When anything closed, the issues cache is busted and `github_synced`
 * broadcast (a merge's close does the same), and every requester whose
 * request closed has their open tray re-read. Never throws; resolves
 * { closed: [number] }.
 */
async function closeRequestRows(pool, { appId, appSlug, repoUrl, openNumbers, deps = {} } = {}) {
  const numbers = numbersOf(openNumbers);
  const repo = parseRepo(repoUrl);
  if (!pool || !(Number(appId) > 0) || !repo || !Array.isArray(openNumbers)) return { closed: [] };
  try {
    // A request back on the open list is open again (CLEAR_REOPENED_SQL).
    if (numbers.length) await pool.query(CLEAR_REOPENED_SQL, [Number(appId), numbers]);
    const { rows: candidates } = await pool.query(OPEN_TRACKED_SQL, [Number(appId), numbers, RECONCILE_LIMIT]);
    const isClosed = deps.isClosed || githubClosed(repo, deps);
    const confirmed = [];
    const notClosed = [];
    for (const row of candidates) {
      const n = Number(row.github_issue_number);
      if (await isClosed(n)) confirmed.push(n);
      else notClosed.push(n);
    }
    if (notClosed.length) await pool.query(CHECKED_OPEN_SQL, [Number(appId), notClosed]);
    if (!confirmed.length) return { closed: [] };
    // Recorded for the tray (a request with no row of ours too), then the
    // row closed where there is one.
    await recordClosed(pool, { appId, numbers: confirmed });
    const watcher = deps.watcher || require('./issue-close-watcher');
    // closeTwinRows swallows its own failures (non-strict); it awaits the
    // UPDATE, so a caller (a test, the next refresh) sees the close done.
    // Its prNumber is only failure-log context; this close is not a PR's.
    await watcher.closeTwinRows({ pool, appId: Number(appId), numbers: confirmed });
    await announceClosed(pool, { repo, appId: Number(appId), appSlug, closed: confirmed, watcher, deps });
    return { closed: confirmed };
  } catch (err) {
    log.warn('homeroom-bot-closed-requests', 'Reconciling rows of requests closed on GitHub failed', { appId, err: err.message });
    return { closed: [] };
  }
}

// The side effects of rows just closed, awaited by closeRequestRows so a
// caller (a test, the next refresh) sees them done: the caches a merge's
// close busts, and an open tray re-read per requester. The watcher is the
// one closeRequestRows resolved (deps.watcher, else the real one); the tray
// is a lazy require (a sibling this file's other callers already require).
// Both best-effort: the rows are closed either way.
async function announceClosed(pool, { repo, appId, appSlug, closed, watcher, deps }) {
  try {
    watcher.bustAndBroadcast({
      owner: repo.owner, repo: repo.repo, appSlug: appSlug || null, appId, closed,
    });
  } catch (err) {
    log.warn('homeroom-bot-closed-requests', 'Cache bust / broadcast after closing request rows failed', { appId, err: err.message });
  }
  try {
    const tray = deps.tray || require('./homeroom-bot-tray');
    const { rows } = await pool.query(
      'SELECT DISTINCT user_id FROM homeroom_bot_requesters WHERE app_id = $1 AND issue_number = ANY($2::int[])',
      [appId, closed],
    );
    for (const row of rows) tray.noteWorkChanged(Number(row.user_id));
  } catch (err) {
    log.warn('homeroom-bot-closed-requests', 'Could not re-read the open trays after closing request rows', { appId, err: err.message });
  }
  log.info('homeroom-bot-closed-requests', 'Closed the platform\'s rows for requests closed on GitHub', { appId, closed });
}

module.exports = {
  noteRequestsClosed, sweepClosedRequests, closeRequestRows, closedNote, REASON,
  RECONCILE_LIMIT, DONE_ELSEWHERE_SQL, doneElsewhereText, tellDoneElsewhere,
  recordClosed, RECORD_CLOSED_SQL, CHECKED_OPEN_SQL, CLEAR_REOPENED_SQL, OPEN_TRACKED_SQL,
};
