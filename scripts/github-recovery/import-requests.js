#!/usr/bin/env node
'use strict';

// The SQL that puts the request boards rescued from the platform's memory
// (26 Oct 2026) into the requests table, for the primary.
//
// Requests were GitHub issues until GitHub suspended the account that filed
// them; the boards survived only in the platform processes' caches, which
// were copied out (requests/web/*.json through the connector, and
// requests/conductors/*.json through the inspector). This writes one SQL
// file that, in one transaction:
//
//   1. makes the tables, exactly as src/db/schema.sql does (so it can run
//      before the release that brings them);
//   2. copies the issues twins, exactly as the boot migration does
//      (services/github-move.js TWIN_SQL);
//   3. lays each board's current text over them ('board');
//   4. closes the twins a board no longer listed as open. Three copies of a
//      board were rescued and they do not always agree, so a request open in
//      ANY of them stays open: a stale open request is the lesser harm.
//      Only for a board read in full (not a truncated list).
//
// Request text is user content: the file is written 0600 next to the
// rescue, and goes nowhere but the primary.
//
//   node scripts/github-recovery/import-requests.js --rescue ~/homeroom-rescue-2026-10-26 [--out file.sql]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const rescue = path.resolve(String(arg('--rescue', '')).replace(/^~/, os.homedir()));
if (!rescue || !fs.existsSync(rescue)) { console.error('--rescue <folder> is required'); process.exit(1); }
const out = path.resolve(String(arg('--out', path.join(rescue, 'recovery', 'import-requests.sql'))).replace(/^~/, os.homedir()));

const REPO = /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;
const apps = fs.readFileSync(path.join(rescue, 'inventory', 'apps.tsv'), 'utf8').split('\n').slice(1).filter(Boolean)
  .map((l) => l.split('\t')).map(([id, slug, repoUrl]) => ({ id, slug, repoUrl }));
const slugByRepo = new Map();
for (const a of apps) {
  const m = String(a.repoUrl || '').match(REPO);
  if (m) slugByRepo.set(`${m[1]}/${m[2]}`.toLowerCase(), a.slug);
}

// Every copy of every board: { slug -> { rows: Map(number -> row), complete, copies } }
const boards = new Map();
function board(slug) {
  if (!boards.has(slug)) boards.set(slug, { rows: new Map(), complete: false, openIn: new Map() });
  return boards.get(slug);
}
function take(slug, r, { copy, open }) {
  const b = board(slug);
  const prev = b.rows.get(r.number);
  const row = {
    number: Number(r.number),
    title: String(r.title || ''),
    body: String(r.body || ''),
    labels: Array.isArray(r.labels) ? r.labels.map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean) : null,
    author: r.user || r.author || null,
    createdAt: r.createdAt || null,
    updatedAt: r.updatedAt || null,
    closedAt: r.closedAt || null,
    state: r.state === 'closed' ? 'closed' : 'open',
  };
  // The newest copy of a request wins; labels from whichever copy has them.
  if (!prev || String(row.updatedAt || '') > String(prev.updatedAt || '') || (row.body.length > prev.body.length && row.updatedAt === prev.updatedAt)) {
    b.rows.set(row.number, { ...row, labels: row.labels || (prev && prev.labels) || [] });
  } else if (!prev.labels.length && row.labels) {
    prev.labels = row.labels;
  }
  if (open && row.state === 'open') b.openIn.set(row.number, (b.openIn.get(row.number) || 0) + 1);
  void copy;
}

let files = 0;
for (const f of fs.readdirSync(path.join(rescue, 'requests', 'web')).filter((f) => f.endsWith('.json'))) {
  const d = JSON.parse(fs.readFileSync(path.join(rescue, 'requests', 'web', f), 'utf8'));
  for (const r of d.requests || []) take(d.slug, { ...r, user: r.author }, { copy: 'web', open: true });
  board(d.slug).complete = true; // the web pod's list was the whole list it held
  files += 1;
}
const condDir = path.join(rescue, 'requests', 'conductors');
for (const f of fs.existsSync(condDir) ? fs.readdirSync(condDir).filter((f) => f.endsWith('.json')) : []) {
  const d = JSON.parse(fs.readFileSync(path.join(condDir, f), 'utf8'));
  for (const [key, entry] of Object.entries((d.maps && d.maps.issuesCache) || {})) {
    const slug = slugByRepo.get(key.toLowerCase());
    if (!slug || !entry || !entry.result) continue;
    for (const r of entry.result.issues || []) take(slug, r, { copy: d.pod, open: true });
    if (!entry.result.truncatedList) board(slug).complete = true;
  }
  // Single reads: closed requests too, with their full text.
  for (const [key, entry] of Object.entries((d.maps && d.maps.singleIssueCache) || {})) {
    const m = key.match(/^(.+)#(\d+)$/);
    const slug = m && slugByRepo.get(m[1].toLowerCase());
    const issue = entry && entry.result && entry.result.issue;
    if (slug && issue) take(slug, issue, { copy: d.pod, open: false });
  }
  files += 1;
}

// ── The SQL ───────────────────────────────────────────────────────────

const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'db', 'schema.sql'), 'utf8');
const marker = '-- ── Off GitHub (docs/plans/github-independence-build.md)';
const ddl = schema.slice(schema.indexOf(marker));
if (schema.indexOf(marker) === -1) throw new Error('schema.sql has no "Off GitHub" block');
const { TWIN_SQL } = require('../../src/services/github-move');

const tag = `r${crypto.randomBytes(6).toString('hex')}`;
const q = (v) => {
  if (v == null) return 'NULL';
  const s = String(v);
  if (s.includes(`$${tag}$`)) throw new Error('quote tag collision');
  return `$${tag}$${s}$${tag}$`;
};
const qArray = (list) => `ARRAY[${list.map(q).join(', ')}]::text[]`;
const ts = (v) => (v ? `${q(v)}::timestamptz` : 'NULL::timestamptz');

const lines = [
  '\\set ON_ERROR_STOP on',
  '\\pset pager off',
  'BEGIN;',
  '-- 1. The tables, as src/db/schema.sql makes them.',
  ddl,
  '-- 2. The issues twins, as services/github-move.js copies them.',
  `${TWIN_SQL};`,
];
let total = 0;
let closingBoards = 0;
for (const [slug, b] of [...boards.entries()].sort()) {
  const rows = [...b.rows.values()].sort((x, y) => x.number - y.number);
  if (rows.length) {
    lines.push(`-- ${slug}: ${rows.length} request(s)`);
    lines.push(`INSERT INTO requests (app_id, number, title, body, state, labels, author_login, created_at, updated_at, closed_at, source, recovered_partial)
SELECT a.id, v.number, v.title, v.body, v.state, v.labels, v.author_login, COALESCE(v.created_at, NOW()), COALESCE(v.updated_at, NOW()), v.closed_at, 'board', FALSE
  FROM apps a, (VALUES
${rows.map((r) => `    (${r.number}, ${q(r.title.slice(0, 512) || `Request #${r.number}`)}, ${q(r.body)}, ${q(b.openIn.has(r.number) ? 'open' : r.state)}, ${qArray(r.labels || [])}, ${q(r.author)}, ${ts(r.createdAt)}, ${ts(r.updatedAt)}, ${b.openIn.has(r.number) ? 'NULL::timestamptz' : ts(r.closedAt)})`).join(',\n')}
  ) AS v(number, title, body, state, labels, author_login, created_at, updated_at, closed_at)
 WHERE a.slug = ${q(slug)}
ON CONFLICT (app_id, number) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, state = EXCLUDED.state,
  labels = EXCLUDED.labels, author_login = EXCLUDED.author_login, created_at = EXCLUDED.created_at,
  updated_at = EXCLUDED.updated_at, closed_at = EXCLUDED.closed_at, source = 'board', recovered_partial = FALSE;`);
    total += rows.length;
  }
  if (b.complete) {
    const open = [...b.openIn.keys()];
    lines.push(`UPDATE requests SET state = 'closed', state_reason = 'completed', closed_at = COALESCE(closed_at, NOW())
 WHERE app_id = (SELECT id FROM apps WHERE slug = ${q(slug)}) AND state = 'open' AND source = 'twin'
   AND NOT (number = ANY(ARRAY[${open.join(', ')}]::int[]));`);
    closingBoards += 1;
  }
}
lines.push(`SELECT COUNT(*) FILTER (WHERE source = 'board') AS from_boards, COUNT(*) FILTER (WHERE source = 'twin') AS from_twins,
       COUNT(*) FILTER (WHERE state = 'open') AS open FROM requests;`);
lines.push('COMMIT;');
fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
fs.writeFileSync(out, `${lines.join('\n')}\n`, { mode: 0o600 });
console.log(`${files} copies read; ${boards.size} boards, ${total} requests; ${closingBoards} boards close their stale twins -> ${out}`);
