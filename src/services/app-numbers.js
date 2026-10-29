'use strict';

// One number sequence per app, shared by its requests and its proposals.
//
// On GitHub an issue and a pull request in one repository draw from the same
// counter, so "#57" names one thing, and some 25 tables key on those numbers
// (chat threads, bounties, claims, the bot's queue, `linked_issues`, ...).
// Requests and proposals are native now (services/requests.js,
// services/native-pulls.js), and their numbers continue from there: an app's
// counter starts above the highest number Homeroom knows for it, from either
// kind and from every place a number was kept, so every key stays valid and
// "#N" stays unambiguous.

let pool = null;

function setPool(p) { pool = p; }

// Set once at startup (src/workflow/setup.ts) for every process that files
// or reads requests; a caller with its own pool passes it as `db`.
function getPool() {
  if (pool) return pool;
  throw new Error('app-numbers: no database pool (setPool was not called)');
}

// The highest number the app has used anywhere, plus one.
const START_SQL = `
  INSERT INTO app_numbers (app_id, next_number)
  SELECT $1::int, 1 + GREATEST(
    COALESCE((SELECT MAX(number) FROM requests WHERE app_id = $1), 0),
    COALESCE((SELECT MAX(number) FROM native_pulls WHERE app_id = $1), 0),
    COALESCE((SELECT MAX(github_issue_number) FROM issues WHERE app_id = $1), 0),
    COALESCE((SELECT MAX(pr_number) FROM chat_sessions WHERE app_id = $1), 0),
    COALESCE((SELECT main_pr_number FROM apps WHERE id = $1), 0)
  )
  ON CONFLICT (app_id) DO NOTHING`;

/**
 * The next number for `appId`, taken. A number some row already holds (one
 * imported after the counter started) is skipped, never reused. That
 * includes a pull request's: on a project still on GitHub, GitHub numbers
 * the pull requests and its counter knows nothing of this one, so a request
 * must not take a number a pull request already has (#6002 was both).
 */
async function next(appId, { db = getPool() } = {}) {
  const id = Number(appId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('app_numbers: invalid app id');
  await db.query(START_SQL, [id]);
  for (let tries = 0; tries < 50; tries += 1) {
    const { rows: [row] } = await db.query(
      'UPDATE app_numbers SET next_number = next_number + 1 WHERE app_id = $1 RETURNING next_number - 1 AS number',
      [id]);
    const number = Number(row.number);
    const { rows: [taken] } = await db.query(
      `SELECT 1 FROM requests WHERE app_id = $1 AND number = $2
       UNION ALL SELECT 1 FROM native_pulls WHERE app_id = $1 AND number = $2
       UNION ALL SELECT 1 FROM chat_sessions WHERE app_id = $1 AND pr_number = $2
       LIMIT 1`, [id, number]);
    if (!taken) return number;
  }
  throw new Error('app_numbers: no free number after 50 tries');
}

/** Make sure the counter is above `number` (after an import). */
async function reserveThrough(appId, number, { db = getPool() } = {}) {
  await db.query(START_SQL, [appId]);
  await db.query(
    'UPDATE app_numbers SET next_number = GREATEST(next_number, $2::int + 1) WHERE app_id = $1',
    [appId, number]);
}

module.exports = { next, reserveThrough, setPool, getPool };
