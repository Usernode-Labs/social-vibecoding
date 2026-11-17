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
// column, rename a table or a column, change a column's type, truncate a
// table, or make a column required (`SET NOT NULL`). A type change that
// loses nothing is allowed when the column's current type is known:
// widening a `VARCHAR`, `VARCHAR` to `TEXT`, `SMALLINT` → `INTEGER` →
// `BIGINT`, or a larger `NUMERIC` precision or scale (`isLosslessType`).
// `columnTypes` reads the app's own migration and schema files for the
// current types; without it every type change stays destructive. The facts
// an update shows (`facts.destructive`) are read with the same rule.
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
  // Making a column required rejects rows already stored with NULL.
  new RegExp(String.raw`\bSET\s+NOT\s+NULL\b`, 'i'),
  // TRUNCATE [TABLE] [ONLY] t, as SQL: an identifier followed by the end of
  // the statement, a list, an option or the end of a string. "truncate the
  // text to 80 characters" is not one.
  new RegExp(String.raw`\bTRUNCATE\s+(?:TABLE\b|(?:ONLY\s+)?${IDENT}(?:\.${IDENT})?\s*(?:;|,|$|['"\x60)]|`
    + String.raw`\b(?:RESTART|CONTINUE|CASCADE|RESTRICT)\b))`, 'i'),
]);

// ALTER [COLUMN] c TYPE t / SET DATA TYPE t. Not in RULES: a type change that
// loses nothing is allowed when the column's current type is known.
const TYPE_RULE = new RegExp(
  String.raw`\bALTER\s+(?:COLUMN\s+)?(?!TABLE\b|TYPE\b)${IDENT}\s+(?:SET\s+DATA\s+)?TYPE\b`, 'i'
);

// The most statements a refusal lists, and how long each may be.
const MAX_STATEMENTS = 20;
const MAX_STATEMENT_LENGTH = 200;

function stripComment(line) {
  // `--` (SQL) and `//` (JS) to the end of the line, outside a URL's `://`.
  return line.replace(/(^|[^:])\/\/.*$/, '$1').replace(/--.*$/, '');
}

// ── Types that lose nothing ──────────────────────────────────────────────
//
// A column may be loosened without a row changing: a longer text field, a
// bigger number, more digits, DROP NOT NULL, a DEFAULT. Everything else
// stays destructive (and goes to a person).

const TYPE_RANK = Object.freeze({
  smallint: 1, int2: 1, smallserial: 1, serial2: 1,
  integer: 2, int: 2, int4: 2, serial: 2, serial4: 2,
  bigint: 3, int8: 3, bigserial: 3, serial8: 3,
});

/** One type as it reads in SQL, lower-cased and with its spacing made regular. Pure. */
function normaliseType(value) {
  const raw = String(value == null ? '' : value)
    .toLowerCase()
    .replace(/\bpg_catalog\./g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s*\)/g, ')');
  if (!raw) return '';
  const varying = /^(?:varchar|character varying)(?:\((\d+)\))?$/.exec(raw);
  if (varying) return varying[1] === undefined ? 'varchar' : `varchar(${varying[1]})`;
  if (raw === 'text') return 'text';
  const rank = TYPE_RANK[raw];
  if (rank) return rank === 1 ? 'smallint' : rank === 2 ? 'integer' : 'bigint';
  const numeric = /^(?:numeric|decimal)(?:\((\d+)(?:,(\d+))?\))?$/.exec(raw);
  if (numeric) {
    if (numeric[1] === undefined) return 'numeric';
    const scale = numeric[2] === undefined ? 0 : Number(numeric[2]);
    return `numeric(${Number(numeric[1])},${scale})`;
  }
  return raw;
}

/** Whether `to` keeps every value and precision `from` already holds. Pure. */
function isLosslessType(from, to) {
  const a = normaliseType(from);
  const b = normaliseType(to);
  if (!a || !b) return false;
  if (a === b) return true;

  const av = /^varchar(?:\((\d+)\))?$/.exec(a);
  if (av) {
    if (b === 'text') return true;
    if (av[1] === undefined) return false; // unbounded text cannot become bounded
    const bv = /^varchar(?:\((\d+)\))?$/.exec(b);
    if (!bv) return false;
    if (bv[1] === undefined) return true;
    return Number(bv[1]) >= Number(av[1]);
  }

  if (TYPE_RANK[a] && TYPE_RANK[b]) return TYPE_RANK[b] >= TYPE_RANK[a];

  const an = /^numeric\((\d+),(\d+)\)$/.exec(a);
  if (an) {
    if (b === 'numeric') return true;
    const bn = /^numeric\((\d+),(\d+)\)$/.exec(b);
    if (!bn) return false;
    const [p, s] = [Number(an[1]), Number(an[2])];
    const [p2, s2] = [Number(bn[1]), Number(bn[2])];
    return s2 >= s && (p2 - s2) >= (p - s);
  }

  // A bare numeric, an array, an enum, a domain, a timestamp: unknown or not
  // lossless, so it stays destructive.
  return false;
}

// ── Reading the columns a project already has ────────────────────────────

const ONE_IDENT = String.raw`(?:"(?:[^"]|"")*"|[A-Za-z_][\w$]*)`;
const QUALIFIED = String.raw`${ONE_IDENT}(?:\.${ONE_IDENT})?`;

const CREATE_TABLE_AT = /\bCREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMPORARY|TEMP|UNLOGGED)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/gi;
const ALTER_ADD_AT = new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED})\s+`
  + String.raw`ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${ONE_IDENT})\s+([^;]*)`, 'gi');
const ALTER_TYPE_AT = new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED})\s+`
  + String.raw`ALTER\s+(?:COLUMN\s+)?(?!TABLE\b|TYPE\b)(${ONE_IDENT})\s+(?:SET\s+DATA\s+)?TYPE\s+([^;]*)`, 'gi');
const ALTER_TABLE_AT = new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED})`, 'gi');
const TYPE_CLAUSE_AT = new RegExp(
  String.raw`\bALTER\s+(?:COLUMN\s+)?(?!TABLE\b|TYPE\b)(${ONE_IDENT})\s+(?:SET\s+DATA\s+)?TYPE\b`, 'gi'
);
const CONSTRAINT_ENTRY = /^(?:CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|EXCLUDE|LIKE)\b/i;
const CONSTRAINT_WORD = /^(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE|LIKE)$/i;
// Where a column's type stops: whatever follows is a constraint or a clause.
const TYPE_STOP = /(?:^|\s)(?:NOT\s+NULL|NULL|DEFAULT|PRIMARY\s+KEY|UNIQUE|CHECK|REFERENCES|COLLATE|CONSTRAINT|GENERATED|IDENTITY|USING)\b/i;

/** A table or column name as Postgres reads it: unquoted folds to lower case, a public. schema is dropped. Pure. */
function identName(raw) {
  const parts = [];
  const re = /"(?:[^"]|"")*"|[A-Za-z_][\w$]*/g;
  let m;
  while ((m = re.exec(String(raw || '')))) {
    const token = m[0];
    parts.push(token.startsWith('"') ? token.slice(1, -1).replace(/""/g, '"') : token.toLowerCase());
  }
  while (parts.length > 1 && parts[0] === 'public') parts.shift();
  return parts.join('.');
}

/** The text inside the parentheses that open at `openAt`, or null. Pure. */
function insideParens(text, openAt) {
  let depth = 0;
  let single = false;
  let double = false;
  for (let i = openAt; i < text.length; i += 1) {
    const ch = text[i];
    if (single) {
      if (ch === "'") { if (text[i + 1] === "'") i += 1; else single = false; }
      continue;
    }
    if (double) {
      if (ch === '"') { if (text[i + 1] === '"') i += 1; else double = false; }
      continue;
    }
    if (ch === "'") { single = true; continue; }
    if (ch === '"') { double = true; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(openAt + 1, i);
    }
  }
  return null;
}

/** A table body split on its top-level commas. Pure. */
function splitTopLevel(body) {
  const out = [];
  let depth = 0;
  let single = false;
  let double = false;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (single) {
      if (ch === "'") { if (body[i + 1] === "'") i += 1; else single = false; }
      continue;
    }
    if (double) {
      if (ch === '"') { if (body[i + 1] === '"') i += 1; else double = false; }
      continue;
    }
    if (ch === "'") { single = true; continue; }
    if (ch === '"') { double = true; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) { out.push(body.slice(start, i)); start = i + 1; }
  }
  out.push(body.slice(start));
  return out;
}

/** One ALTER action, up to its `;` or the comma that starts the next one. Pure. */
function actionText(rest) {
  const text = String(rest || '');
  let depth = 0;
  let single = false;
  let double = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (single) {
      if (ch === "'") { if (text[i + 1] === "'") i += 1; else single = false; }
      continue;
    }
    if (double) {
      if (ch === '"') { if (text[i + 1] === '"') i += 1; else double = false; }
      continue;
    }
    if (ch === "'") { single = true; continue; }
    if (ch === '"') { double = true; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if ((ch === ',' && depth === 0) || ch === ';') return text.slice(0, i);
  }
  return text;
}

/** The type at the start of a column definition or an ALTER action. Pure. */
function typeIn(rest) {
  const text = String(rest || '');
  const stop = TYPE_STOP.exec(text);
  return (stop ? text.slice(0, stop.index) : text).trim();
}

function putType(types, conflicted, key, type, kind) {
  const norm = normaliseType(type);
  if (!norm) return;
  if (conflicted.has(key)) return;
  if (kind === 'alter') { types.set(key, norm); return; }
  if (types.has(key)) {
    if (types.get(key) !== norm) { types.set(key, null); conflicted.add(key); }
    return;
  }
  types.set(key, norm);
}

/** Apply one file's CREATE TABLE, ALTER TABLE ... ADD and ALTER ... TYPE in the order written. */
function readSchemaText(text, types, conflicted) {
  const events = [];

  for (const m of text.matchAll(CREATE_TABLE_AT)) {
    const after = text.slice(m.index + m[0].length);
    const name = new RegExp(String.raw`^\s*(${QUALIFIED})`).exec(after);
    if (!name) continue;
    const open = text.indexOf('(', m.index + m[0].length + name[0].length);
    if (open === -1) continue;
    const body = insideParens(text, open);
    if (body == null) continue;
    const table = identName(name[1]);
    for (const rawDef of splitTopLevel(body)) {
      const def = rawDef.trim();
      if (!def || CONSTRAINT_ENTRY.test(def)) continue;
      const column = new RegExp(String.raw`^(${ONE_IDENT})\s+([\s\S]+)$`).exec(def);
      if (!column) continue;
      const type = typeIn(column[2]);
      if (type) events.push({ at: open, key: `${table}.${identName(column[1])}`, type, kind: 'declare' });
    }
  }

  for (const m of text.matchAll(ALTER_ADD_AT)) {
    if (CONSTRAINT_WORD.test(identName(m[2]))) continue; // ADD CONSTRAINT / PRIMARY KEY / ...
    const type = typeIn(actionText(m[3]));
    if (type) events.push({ at: m.index, key: `${identName(m[1])}.${identName(m[2])}`, type, kind: 'declare' });
  }

  for (const m of text.matchAll(ALTER_TYPE_AT)) {
    if (CONSTRAINT_WORD.test(identName(m[2]))) continue; // ALTER CONSTRAINT / ...
    const type = typeIn(actionText(m[3]));
    if (type) events.push({ at: m.index, key: `${identName(m[1])}.${identName(m[2])}`, type, kind: 'alter' });
  }

  events.sort((a, b) => a.at - b.at);
  for (const event of events) putType(types, conflicted, event.key, event.type, event.kind);
}

/**
 * What columns the project's texts say exist, as a Map from `"table.column"`
 * to the normalised type. An ordered array: later files and later statements
 * win, except that a column declared twice with different types is unknown
 * (`null`). Pure.
 */
function columnTypes(texts) {
  const types = new Map();
  const conflicted = new Set();
  for (const raw of Array.isArray(texts) ? texts : []) {
    if (typeof raw !== 'string' || !raw) continue;
    readSchemaText(raw.split('\n').map(stripComment).join('\n'), types, conflicted);
  }
  return types;
}

/**
 * Whether every `ALTER [COLUMN] c [SET DATA] TYPE x` in `text` only loosens
 * its column. The table is the nearest preceding `ALTER TABLE t` in the same
 * text; a clause whose table or current type cannot be known, or that carries
 * a `USING`, is destructive. Pure.
 */
function losslessTypeChange(text, types) {
  const source = String(text || '');
  const known = new Map(types instanceof Map ? types : []);
  const clauses = [...source.matchAll(TYPE_CLAUSE_AT)];
  if (!clauses.length) return false;
  const tables = [...source.matchAll(ALTER_TABLE_AT)].map((m) => ({ at: m.index, name: identName(m[1]) }));

  for (const clause of clauses) {
    let table = null;
    for (const t of tables) {
      if (t.at <= clause.index) table = t.name;
      else break;
    }
    if (!table) return false;
    const afterClause = clause.index + clause[0].length;
    const semicolon = source.indexOf(';', afterClause);
    const rest = source.slice(afterClause, semicolon === -1 ? source.length : semicolon);
    if (/\bUSING\b/i.test(rest)) return false;
    const type = typeIn(rest);
    if (!type) return false;
    const key = `${table}.${identName(clause[1])}`;
    const current = known.get(key);
    if (typeof current !== 'string' || !current) return false;
    if (!isLosslessType(current, type)) return false;
    known.set(key, normaliseType(type));
  }
  return true;
}

/**
 * The destructive schema statements a unified diff ADDS, as the trimmed
 * text of each line that carries one (deduplicated, at most 20). Reads
 * `diff --git a/x b/y` headers (and `+++ b/y`) for the file each line is
 * in; only code and SQL files count. A statement split over several added
 * lines of one file (ALTER TABLE on one, DROP c on the next) is found too.
 * `columnTypes` (a Map from `columnTypes()`) lets a type change that loses
 * nothing through; without it every type change counts. Pure.
 */
function destructiveStatements(diffText, { columnTypes: types } = {}) {
  const found = [];
  const seen = new Set();
  const note = (text) => {
    const t = String(text || '').trim().replace(/\s+/g, ' ').slice(0, MAX_STATEMENT_LENGTH);
    if (!t || seen.has(t) || found.length >= MAX_STATEMENTS) return;
    seen.add(t);
    found.push(t);
  };
  const allowedType = (text) => {
    try { return losslessTypeChange(text, types); } catch { return false; }
  };

  let file = null;
  let added = [];
  const flush = () => {
    if (!added.length) return;
    // Line by line first, so each refusal names the line it is about.
    const before = found.length;
    for (let i = 0; i < added.length; i += 1) {
      const line = added[i];
      if (RULES.some((rule) => rule.test(line))) note(line);
      if (!TYPE_RULE.test(line)) continue;
      // The table may stand on an earlier added line of the same statement.
      let from = i;
      while (from > 0 && !/\bALTER\s+TABLE\b/i.test(added[from])) from -= 1;
      const context = added.slice(from, i + 1).join('\n');
      if (!(/\bALTER\s+TABLE\b/i.test(context) && allowedType(context))) note(line);
    }
    // Then the file's added lines as one text: a statement written over
    // several lines.
    if (found.length === before) {
      const joined = added.join('\n');
      for (const rule of [...RULES, TYPE_RULE]) {
        const m = new RegExp(rule.source, 'gi').exec(joined);
        if (!m) continue;
        const at = joined.lastIndexOf('\n', m.index) + 1;
        const end = joined.indexOf('\n', m.index + m[0].length);
        const line = joined.slice(at, end === -1 ? joined.length : end);
        if (rule === TYPE_RULE) {
          // From the nearest ALTER TABLE before the match, up to its `;`.
          let start = -1;
          const tables = new RegExp(ALTER_TABLE_AT.source, 'gi');
          let t;
          while ((t = tables.exec(joined)) && t.index <= m.index) start = t.index;
          const semi = joined.indexOf(';', m.index + m[0].length);
          const stop = semi === -1 ? joined.length : semi;
          if (start >= 0 && !joined.slice(start, m.index).includes(';') && allowedType(joined.slice(start, stop))) continue;
        }
        note(line);
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

// How many of the base's own files the type check reads, and how big one may be.
const MAX_TYPE_FILES = 40;
const MAX_TYPE_FILE_BYTES = 256 * 1024;

/** The code files a unified diff touches, in the order it names them. Pure. */
function touchedFiles(diffText) {
  const out = [];
  const seen = new Set();
  for (const line of String(diffText || '').split('\n')) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m && !seen.has(m[2])) { seen.add(m[2]); out.push(m[2]); }
  }
  return out;
}

/**
 * The columns the base's own files say exist, or null when they cannot be
 * read (a listing that fails or is truncated, a file that will not load).
 * The files the diff touches come first, then every `.sql` sorted by path,
 * at most 40 of at most 256 KB.
 */
async function baseColumnTypes(github, repo, diff) {
  let listing;
  try {
    listing = await github.listRepoFiles(repo.owner, repo.repo, 'main');
  } catch (err) {
    log.warn('schema-safety', 'Could not list the base to check a type change; refusing', { err: err && err.message });
    return null;
  }
  if (!listing || listing.truncated === true || !Array.isArray(listing.files)) return null;
  const byPath = new Map();
  for (const file of listing.files) {
    if (file && typeof file.path === 'string' && CODE_FILE.test(file.path)
      && Number(file.size || 0) <= MAX_TYPE_FILE_BYTES) {
      byPath.set(file.path, file);
    }
  }
  const picked = [];
  const seen = new Set();
  for (const p of touchedFiles(diff)) {
    const file = byPath.get(p);
    if (file && !seen.has(p)) { seen.add(p); picked.push(file); }
  }
  for (const file of [...byPath.values()].filter((f) => /\.sql$/i.test(f.path)).sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if (!seen.has(file.path)) { seen.add(file.path); picked.push(file); }
  }
  const texts = [];
  for (const file of picked.slice(0, MAX_TYPE_FILES)) {
    try {
      const text = await github.getBlobContent(repo.owner, repo.repo, file.sha);
      if (typeof text !== 'string') return null;
      texts.push(text);
    } catch (err) {
      log.warn('schema-safety', 'Could not read a base file to check a type change; refusing', {
        path: file.path, err: err && err.message,
      });
      return null;
    }
  }
  return columnTypes(texts);
}

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
  let statements = destructiveStatements(diff);
  if (!statements.length) return null;
  if (statements.some((statement) => TYPE_RULE.test(statement))) {
    // A type change may be a lossless widening. Read what the columns are at
    // the base; if that cannot be read, the first pass stands.
    const types = await baseColumnTypes(github, repo, diff);
    if (types) {
      const checked = destructiveStatements(diff, { columnTypes: types });
      if (!checked.length) return null;
      statements = checked;
    }
  }
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
  columnTypes,
  destructiveStatements,
  followingVersions,
  isLosslessType,
  losslessTypeChange,
  mergeRefusal,
  normaliseType,
  refusalMessage,
  sayOnce,
};
