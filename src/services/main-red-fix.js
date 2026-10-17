'use strict';

// When main is red: which merge did it, and a request to fix it.
//
// Main watch (services/main-watch.js) runs the repo's unit suite on each
// merge commit, and a confirmed red pauses the app's merges until a fix
// lands or an admin resumes them. Until now nothing said which merge broke
// it or asked anybody to fix it: on 12 Oct 2026 eleven proposals merged in
// five minutes, two of them fixes for the same request that together failed
// a test, and main stayed paused while people read logs. Admins resumed it
// twice; each next merge paused it again.
//
// Two things here:
//
//   - Every verdict main watch reaches is kept (main_watch_verdicts), even
//     one a newer merge superseded before it could be stored on the app's
//     row. A superseded green is still the newest merge known to pass.
//   - On a confirmed red, the merges since the newest green before it are
//     read off GitHub, and those whose changed files the failing test files
//     name are the suspects: the same mapping `npm run test:changed` uses to
//     pick the suites a change can break (scripts/test-changed.js). Then one
//     request, filed as the Homeroom bot and put at the front of its queue,
//     says what fails, where it likely came from, and what to do. A fix
//     built on main as it stands is level with main, so it merges while
//     merges are paused. One such request per app is open at a time.
//
// MAIN_WATCH_FIX_REQUESTS=0 turns the request off; the verdicts are kept
// either way. Nothing here throws into main watch.

const log = require('./logger');

// The merges read for suspects. A longer range is listed, not attributed.
const MAX_SUSPECT_MERGES = 15;
// Passing verdicts tried, newest first, for one that is an ancestor of the red.
const MAX_GREEN_CANDIDATES = 5;
// Failing test files read from GitHub to match against.
const MAX_SUITES = 5;
const MAX_EXCERPTS = 3;
const EXCERPT_CHARS = 1500;

function fixRequestsEnabled() {
  const v = String(process.env.MAIN_WATCH_FIX_REQUESTS ?? '1').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

const short = (sha) => String(sha || '').slice(0, 9);

// Every verdict is kept in main_watch_verdicts by the main-check machine's
// transition (src/workflow/main-check/machine.ts), which suspectsFor reads.

// The PR number a squash merge's subject ends with: "… (#4826)".
function prOf(subject) {
  const m = String(subject || '').match(/\(#(\d+)\)\s*$/);
  return m ? Number(m[1]) : null;
}

// The suites among `suites` (path → text) that a merge's files reach, by
// test:changed's mapping.
function suitesReached(files, suites) {
  if (!files.length || !suites.size) return [];
  const { selectSuites } = require('../../scripts/test-changed');
  return selectSuites(files, suites).suites.filter((s) => suites.has(s));
}

/**
 * The merges since main last passed, and which of them the failing tests
 * point at. Resolves { greenSha, merges: [{ sha, pr, subject, suites }],
 * total, complete } or null when no green before the red can be found.
 * `deps` stands in for GitHub in tests.
 */
async function suspectsFor(pool, { app, parsed, redSha, failingTests = [] }, deps = null) {
  const github = deps || require('./github');
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (sha) sha, created_at FROM main_watch_verdicts
      WHERE app_id = $1 AND state = 'passing' AND sha <> $2
      ORDER BY sha, created_at DESC`,
    [app.id, String(redSha).toLowerCase()]
  );
  const greens = rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, MAX_GREEN_CANDIDATES);
  let greenSha = null;
  for (const g of greens) {
    try {
      const a = await github.compareCommitAncestry(parsed.owner, parsed.repo, g.sha, redSha);
      if (a.status === 'ahead') { greenSha = g.sha; break; }
    } catch { /* an unreadable candidate is skipped */ }
  }
  if (!greenSha) return null;

  const range = await github.compareCommitSubjects(parsed.owner, parsed.repo, greenSha, redSha);
  const commits = range.commits || [];
  const files = [...new Set(failingTests.map((t) => t.file).filter((f) => /^tests\/[^/]+\.test\.js$/.test(f || '')))].slice(0, MAX_SUITES);
  const suites = new Map();
  for (const file of files) {
    try {
      const text = await github.getFileContent(parsed.owner, parsed.repo, file, redSha);
      if (typeof text === 'string') suites.set(file, text);
    } catch { /* a suite that cannot be read reaches nothing */ }
  }
  const attribute = commits.length <= MAX_SUSPECT_MERGES && suites.size > 0;
  const merges = [];
  let previous = greenSha;
  for (const c of commits) {
    let reached = [];
    if (attribute) {
      try {
        const diff = await github.compareRefs(parsed.owner, parsed.repo, `${previous}...${c.sha}`);
        reached = suitesReached(diff.files || [], suites);
      } catch { /* unattributed */ }
    }
    merges.push({ sha: c.sha, pr: prOf(c.subject), subject: c.subject, suites: reached });
    previous = c.sha;
  }
  return { greenSha, merges, total: range.totalCommits || commits.length, complete: attribute };
}

// A fence longer than any run of backticks in `text`.
function fenceFor(text) {
  const longest = (String(text).match(/`+/g) || []).reduce((n, run) => Math.max(n, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** The request's title and body. Pure. */
function fixRequestText({ redSha, prNumber = null, failingTests = [], excerpts = [], found = null }) {
  const first = failingTests[0] ? failingTests[0].test : 'the repo unit suite';
  const name = first.length > 100 ? `${first.slice(0, 99)}…` : first;
  const lines = [
    `Main's unit suite fails on ${short(redSha)}${prNumber ? ` (the merge of #${prNumber})` : ''}, and merges into this project are paused until it passes again.`,
    '',
    '### Failing',
    ...(failingTests.length
      ? failingTests.map((t) => `- ${t.file ? `\`${t.file}\`: ` : ''}${t.test}`)
      : ['- The suite failed without naming a test.']),
  ];
  if (found) {
    const suspects = found.merges.filter((m) => m.suites.length);
    lines.push('', `### Merged since main last passed (${short(found.greenSha)})`);
    if (suspects.length) {
      lines.push('Likely from these, which changed files the failing tests read:');
      for (const m of suspects) lines.push(`- ${m.pr ? `#${m.pr}` : short(m.sha)} ${m.subject.replace(/\s*\(#\d+\)\s*$/, '')} (reaches ${m.suites.map((s) => `\`${s}\``).join(', ')})`);
      if (suspects.length >= 2) {
        lines.push('', 'Two or more of them together may be the cause: each passed its own checks before the other merged.');
      }
    } else {
      lines.push(found.complete
        ? 'None of them changed a file the failing tests name, so the cause may be one that changed something they reach indirectly:'
        : 'Too many to attribute one by one:');
      for (const m of found.merges.slice(0, MAX_SUSPECT_MERGES)) lines.push(`- ${m.pr ? `#${m.pr}` : short(m.sha)} ${m.subject.replace(/\s*\(#\d+\)\s*$/, '')}`);
      if (found.total > MAX_SUSPECT_MERGES) lines.push(`- …and ${found.total - MAX_SUSPECT_MERGES} more`);
    }
  }
  const shown = excerpts.filter((d) => d && d.excerpt).slice(0, MAX_EXCERPTS);
  if (shown.length) {
    lines.push('', '### What they printed');
    for (const d of shown) {
      const text = String(d.excerpt).slice(0, EXCERPT_CHARS);
      const fence = fenceFor(text);
      lines.push('', `${d.test}:`, '', `${fence}text`, text, fence);
    }
  }
  lines.push(
    '',
    '### What to do',
    '- Make the failing tests pass on main as it is now. Build on main\'s current head: a fix level with main merges while merges are paused.',
    '- If two merged changes did the same thing in different ways, keep one and take the other out, rather than changing the test to match whichever landed last.',
    '- Run the failing test files and the suites for the files you change before proposing.',
    '',
    '---',
    'Filed by Homeroom\'s main watch, which runs main\'s unit suite after every merge.',
  );
  return { title: `Main is failing: ${name}`, body: lines.join('\n') };
}

async function front(pool, app, issueNumber) {
  try {
    await require('./homeroom-bot').enqueueFront(pool, { appId: app.id, issueNumber, reason: 'main_red' });
  } catch (err) {
    log.warn('main-red-fix', 'Could not put the request at the front of the bot\'s queue', { appId: app.id, issueNumber, err: err.message });
  }
}

/**
 * File the request for a confirmed red, unless one is open for this app
 * already. Resolves the issue number, or null. Never throws.
 * `fileBotIssue(config, pool, app, parsed, { title, body })` files it as the
 * Homeroom bot (main-watch.fileBotIssue); `deps` stands in for GitHub.
 */
//
// `claimedBy` (the main-check machine's work): the work item taking the
// claim, written with it, so the attempt after a crash at any point carries
// its own claim on: it returns the number recorded on it, or the bot's
// request of that title filed since the claim (a process that died before
// writing the number), or files under it. `strict`: a failure (after giving
// the claim back) throws, for the work to retry.
async function fileFixRequest(config, pool, {
  app, parsed, redSha, prNumber = null, detail = {}, excerpts = [], fileBotIssue, deps = null,
  claimedBy = null, strict = false,
}) {
  if (!fixRequestsEnabled() || !pool || !app || !parsed || !redSha) return null;
  if (!deps && !require('./github').isEnabled()) return null;
  const failingTests = Array.isArray(detail.failingTests) ? detail.failingTests : [];
  const sha = String(redSha).toLowerCase();
  let claimed;
  try {
    if (claimedBy) {
      const { rows: [own] } = await pool.query(
        'SELECT id, issue_number, filed_at FROM main_red_requests WHERE app_id = $1 AND red_sha = $2 AND claimed_by = $3',
        [app.id, sha, String(claimedBy)]);
      let filed = own && own.issue_number ? Number(own.issue_number) : null;
      if (own && !filed) {
        const { title } = fixRequestText({ redSha, prNumber, failingTests });
        const { rows: [r] } = await pool.query(
          `SELECT github_issue_number FROM issues
            WHERE app_id = $1 AND kind = 'general' AND title = $2 AND created_at >= $3 ORDER BY id LIMIT 1`,
          [app.id, title, own.filed_at]);
        if (r) {
          filed = Number(r.github_issue_number);
          await pool.query('UPDATE main_red_requests SET issue_number = $2 WHERE id = $1', [own.id, filed]);
        }
      }
      // Filed by the attempt before: put at the front again (a no-op once
      // the bot has started it), in case that attempt died before.
      if (filed) { await front(pool, app, filed); return filed; }
      if (own) claimed = [{ id: own.id }];
    }
    if (!claimed) {
      ({ rows: claimed } = await pool.query(
        `INSERT INTO main_red_requests (app_id, red_sha, claimed_by)
         SELECT $1, $2, $3
          WHERE NOT EXISTS (
            SELECT 1 FROM main_red_requests r
              LEFT JOIN issues i ON i.app_id = r.app_id AND i.github_issue_number = r.issue_number
             WHERE r.app_id = $1
               AND ((r.issue_number IS NULL AND r.filed_at > NOW() - interval '1 hour')
                    OR i.status = 'open'))
         ON CONFLICT (app_id, red_sha) DO NOTHING
         RETURNING id`,
        [app.id, sha, claimedBy == null ? null : String(claimedBy)]
      ));
    }
  } catch (err) {
    if (strict) throw err;
    log.warn('main-red-fix', 'request claim failed (non-fatal)', { appId: app.id, err: err.message });
    return null;
  }
  if (!claimed || !claimed.length) return null;
  let found = null;
  try {
    found = await suspectsFor(pool, { app, parsed, redSha, failingTests }, deps);
  } catch (err) {
    log.warn('main-red-fix', 'Could not read the merges since main last passed', { appId: app.id, err: err.message });
  }
  const { title, body } = fixRequestText({ redSha, prNumber, failingTests, excerpts, found });
  try {
    const issueNumber = await fileBotIssue(config, pool, app, parsed, { title, body });
    await pool.query('UPDATE main_red_requests SET issue_number = $2 WHERE id = $1', [claimed[0].id, issueNumber]);
    await front(pool, app, issueNumber);
    log.info('main-red-fix', 'Filed a request to fix a red main', {
      appId: app.id, slug: app.slug, sha: short(redSha), issueNumber,
      suspects: found ? found.merges.filter((m) => m.suites.length).map((m) => m.pr || short(m.sha)) : null,
    });
    return issueNumber;
  } catch (err) {
    log.warn('main-red-fix', 'fix request failed (non-fatal)', { appId: app.id, err: err.message });
    await pool.query('DELETE FROM main_red_requests WHERE id = $1', [claimed[0].id]).catch(() => {});
    if (strict) throw err;
    return null;
  }
}

module.exports = {
  suspectsFor,
  fixRequestText,
  fileFixRequest,
  fixRequestsEnabled,
  prOf,
  MAX_SUSPECT_MERGES,
};
