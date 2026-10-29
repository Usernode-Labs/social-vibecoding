'use strict';

// Additive changes only, on an original that versions get their updates
// from (docs/plans/versions.md, "Suggestions up").
//
// Each version that follows an original is offered the original's merged
// changes as an update its own group votes on (services/upstream-offers.js).
// An update runs against the version's OWN data: a table the original drops,
// a column it renames or a type it changes takes rows with it in every
// version that takes the update. So an original with following versions
// cannot merge a change whose diff adds destructive schema statements, and
// the merge gate says so in words (src/workflow/proposal/services.ts,
// `merge.gate`).
//
// `destructiveStatements(diffText)` is the rule, pure: the ADDED lines of
// code and SQL files in a unified diff that drop a table, a schema or a
// column, rename a table or a column, change a column's type, or truncate a
// table. The facts an update shows (`facts.destructive`) are read with the
// same rule.
//
// What counts as code: .js, .cjs, .mjs, .ts and .sql files, where an app
// keeps its migrations. Comments (`//` and `--` to the end of the line) are
// left out, so a note about a drop is not one. Removed lines never count:
// taking a DROP out of a migration removes nothing.

const log = require('./logger');

const CODE_FILE = /\.(?:c|m)?js$|\.ts$|\.sql$/i;

// One identifier: bare, or "double quoted".
const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
// What can sit between ALTER TABLE and the clause it is about without a
// statement ending: no semicolon, and not much of it.
const SAME_STATEMENT = String.raw`[^;]{0,200}?`;

const RULES = Object.freeze([
  // DROP TABLE / DROP SCHEMA (IF EXISTS ... CASCADE alike).
  new RegExp(String.raw`\bDROP\s+(?:TABLE|SCHEMA)\b`, 'i'),
  // ALTER TABLE ... DROP COLUMN c, and the short form DROP c (Postgres takes
  // both). DROP CONSTRAINT, DEFAULT, NOT NULL, IDENTITY and EXPRESSION change
  // no rows and are left alone.
  new RegExp(String.raw`\bDROP\s+COLUMN\b`, 'i'),
  new RegExp(String.raw`\bALTER\s+TABLE\b${SAME_STATEMENT}\bDROP\s+(?:IF\s+EXISTS\s+)?`
    + String.raw`(?!(?:CONSTRAINT|DEFAULT|NOT|IDENTITY|EXPRESSION|COLUMN)\b)${IDENT}`, 'i'),
  // ALTER TABLE t RENAME TO u, RENAME COLUMN a TO b, RENAME a TO b. Renaming
  // a constraint or an index renames no data.
  new RegExp(String.raw`\bALTER\s+TABLE\b${SAME_STATEMENT}\bRENAME\s+(?:COLUMN\s+)?`
    + String.raw`(?!CONSTRAINT\b)(?:${IDENT}\s+)?TO\b`, 'i'),
  // ALTER [COLUMN] c TYPE t / SET DATA TYPE t.
  new RegExp(String.raw`\bALTER\s+(?:COLUMN\s+)?(?!TABLE\b|TYPE\b)${IDENT}\s+(?:SET\s+DATA\s+)?TYPE\b`, 'i'),
  // TRUNCATE [TABLE] [ONLY] t, as SQL: an identifier followed by the end of
  // the statement, a list, an option or the end of a string. "truncate the
  // text to 80 characters" is not one.
  new RegExp(String.raw`\bTRUNCATE\s+(?:TABLE\b|(?:ONLY\s+)?${IDENT}(?:\.${IDENT})?\s*(?:;|,|$|['"\x60)]|`
    + String.raw`\b(?:RESTART|CONTINUE|CASCADE|RESTRICT)\b))`, 'i'),
]);

// The most statements a refusal lists, and how long each may be.
const MAX_STATEMENTS = 20;
const MAX_STATEMENT_LENGTH = 200;

function stripComment(line) {
  // `--` (SQL) and `//` (JS) to the end of the line, outside a URL's `://`.
  return line.replace(/(^|[^:])\/\/.*$/, '$1').replace(/--.*$/, '');
}

/**
 * The destructive schema statements a unified diff ADDS, as the trimmed
 * text of each line that carries one (deduplicated, at most 20). Reads
 * `diff --git a/x b/y` headers (and `+++ b/y`) for the file each line is
 * in; only code and SQL files count. A statement split over several added
 * lines of one file (ALTER TABLE on one, DROP c on the next) is found too.
 * Pure.
 */
function destructiveStatements(diffText) {
  const found = [];
  const seen = new Set();
  const note = (text) => {
    const t = String(text || '').trim().replace(/\s+/g, ' ').slice(0, MAX_STATEMENT_LENGTH);
    if (!t || seen.has(t) || found.length >= MAX_STATEMENTS) return;
    seen.add(t);
    found.push(t);
  };

  let file = null;
  let added = [];
  const flush = () => {
    if (!added.length) return;
    // Line by line first, so each refusal names the line it is about.
    const before = found.length;
    for (const line of added) {
      if (RULES.some((rule) => rule.test(line))) note(line);
    }
    // Then the file's added lines as one text: a statement written over
    // several lines.
    if (found.length === before) {
      const joined = added.join('\n');
      for (const rule of RULES) {
        const m = new RegExp(rule.source, 'gi').exec(joined);
        if (m) {
          const at = joined.lastIndexOf('\n', m.index) + 1;
          const end = joined.indexOf('\n', m.index + m[0].length);
          note(joined.slice(at, end === -1 ? joined.length : end));
        }
      }
    }
    added = [];
  };

  for (const raw of String(diffText || '').split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
    if (header) {
      flush();
      file = header[2];
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const to = raw.slice(4).trim();
      if (to !== '/dev/null') file = to.replace(/^b\//, '');
      continue;
    }
    if (raw.startsWith('--- ')) continue;
    if (!file || !CODE_FILE.test(file)) continue;
    if (raw.startsWith('+')) added.push(stripComment(raw.slice(1)));
  }
  flush();
  return found;
}

/** The words a refusal says: how many versions get this project's updates. */
function refusalMessage(following) {
  const n = Number(following) || 0;
  const versions = n === 1 ? '1 version gets' : `${n} versions get`;
  return `This change removes or renames data, and ${versions} this project's updates. `
    + 'Changes here have to add, not remove.';
}

/** How many versions get this app's updates (apps.upstream following it). */
async function followingVersions(pool, appId) {
  const { rows: [row] = [] } = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM apps
      WHERE upstream IS NOT NULL
        AND (upstream->>'appId')::int = $1
        AND upstream->>'following' = 'true'`,
    [appId]
  );
  return row ? Number(row.n) || 0 : 0;
}

// The head the merge would take: what was reviewed, else the branch.
function headOf(session) {
  const sha = session.source === 'imported' ? session.imported_pr_head_sha : session.reviewed_head_sha;
  if (typeof sha === 'string' && /^[0-9a-f]{40}$/i.test(sha)) return sha.toLowerCase();
  return session.branch_name || null;
}

// Enough for any change a vote is asked about; past it the rest is unread,
// as the check is best effort beside the review itself.
const DIFF_BUDGET = 1024 * 1024;

/**
 * Why `session` (a proposal row with its app's `repo_url`) may not merge on
 * an original with following versions, or null when it may: none follow,
 * the diff adds nothing destructive, or the diff cannot be read (fails
 * open, like the gate's other diff reads: a code host hiccup must not hold
 * every merge). Resolves { following, statements, message }.
 */
async function mergeRefusal(pool, session, { github = require('./github'), repoRef = require('./repo-ref') } = {}) {
  if (!session || !session.app_id) return null;
  const following = await followingVersions(pool, session.app_id);
  if (!following) return null;
  const repo = repoRef.ownerRepo(session.repo_url);
  const head = headOf(session);
  if (!repo || !head) return null;
  let diff;
  try {
    ({ diff } = await github.getProposalDiff(repo.owner, repo.repo, `main...${head}`, DIFF_BUDGET));
  } catch (err) {
    log.warn('schema-safety', 'Could not read the change to check its schema; not blocking', {
      sessionId: session.id, err: err && err.message,
    });
    return null;
  }
  const statements = destructiveStatements(diff);
  if (!statements.length) return null;
  return { following, statements, message: refusalMessage(following) };
}

/**
 * Say the refusal in the proposal's own thread, once: the gate runs on every
 * pass of the merge queue, and the same sentence twice in a row says
 * nothing new.
 */
async function sayOnce(pool, session, message, { ws = require('./ws') } = {}) {
  try {
    const { rows: [last] = [] } = await pool.query(
      `SELECT content FROM chat_messages
        WHERE app_id = $1 AND msg_type = 'system'
          AND thread_type = 'session' AND thread_ref = $2
        ORDER BY id DESC LIMIT 1`,
      [session.app_id, session.id]
    );
    if (last && last.content === message) return false;
    await ws.sendSystemMessage(pool, session.app_id, message, 'system', null, { type: 'session', ref: session.id });
    return true;
  } catch (err) {
    log.warn('schema-safety', 'Could not say why the merge waits', { sessionId: session.id, err: err && err.message });
    return false;
  }
}

module.exports = {
  BLOCK_REASON: 'destructive_schema',
  destructiveStatements,
  followingVersions,
  mergeRefusal,
  refusalMessage,
  sayOnce,
};
