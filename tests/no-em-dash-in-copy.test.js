'use strict';

// Regression guard for #1389 ("Remove AI hyphen").
//
// The em dash reads as machine-written when it carries a sentence the way
// it does in generated prose ("Saved — reload to see it"), and the issue
// asked for it out of every string a user reads. Rewriting the ~1,600
// occurrences was the one-time part; this test is the part that keeps them
// out, because nothing else in the suite looks at punctuation and a single
// new toast would quietly restore the texture.
//
// It checks FOUR encodings, because an em dash arrives in this repo as any
// of them: the raw character, `&mdash;`, the `—` JS escape, and the
// numeric entity `&#8212;`.
//
// TWO scans, deliberately asymmetric:
//
//   1. Deny-by-default over `frontend/src/**`, `public/js/**` and
//      `dapp.json`'s declared-check text. Nearly every string in those
//      trees is rendered, so anything that is NOT copy is the exception
//      and earns an allowlist line below.
//   2. Allow-by-default over `src/**`, narrowed to the call shapes that
//      actually emit text to a person (`sendStatus(...)`, an `error:` /
//      `message:` / `title:` / `body:` field, a mail `subject:`). The
//      server tree is mostly LLM-facing: prompt bodies, MCP tool
//      `description:` fields, `[SYSTEM NOTE …]` blocks and other
//      model-context text, where an em dash is not a copy decision and
//      the spec explicitly leaves it alone. Scanning that deny-by-default
//      needs a ~400-line allowlist that would rot on contact; scanning the
//      emitters catches the strings a user can actually see.
//
// Comments are stripped before matching (this file's punctuation included),
// so prose about the rule never trips it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const DASH = /—|&mdash;|\\u2014|&#8212;/;

// Blank out the comment portions of each line. Line-scoped on purpose: a
// whole-file tokenizer desyncs on the first apostrophe in JSX text (`don't`)
// and never recovers, and the only thing it buys is `//` inside a multi-line
// template literal. Block-comment and HTML-comment state DO carry across
// lines; quote state resets per line.
function stripComments(src) {
  const lines = src.split('\n');
  const out = [];
  let inBlock = false;
  let inHtml = false;
  for (let raw of lines) {
    if (inBlock) {
      const end = raw.indexOf('*/');
      if (end < 0) { out.push(''); continue; }
      inBlock = false;
      raw = ' '.repeat(end + 2) + raw.slice(end + 2);
    }
    if (inHtml) {
      const end = raw.indexOf('-->');
      if (end < 0) { out.push(''); continue; }
      inHtml = false;
      raw = ' '.repeat(end + 3) + raw.slice(end + 3);
    }
    let s = '';
    let i = 0;
    let quote = '';
    while (i < raw.length) {
      const c = raw[i];
      const d = raw[i + 1];
      if (quote) {
        if (c === '\\') { s += '  '; i += 2; continue; }
        if (c === quote) quote = '';
        s += c; i++; continue;
      }
      if (c === "'" || c === '"' || c === '`') { quote = c; s += c; i++; continue; }
      if (c === '/' && d === '/') break;
      if (c === '#' && i === 0) break;
      if ((c === '/' && d === '*') || (c === '{' && d === '/' && raw[i + 2] === '*')) {
        const from = i + (c === '{' ? 3 : 2);
        const end = raw.indexOf('*/', from);
        if (end < 0) { inBlock = true; i = raw.length; break; }
        i = end + 2;
        if (raw[i] === '}') i++;
        continue;
      }
      if (c === '<' && raw.startsWith('<!--', i)) {
        const end = raw.indexOf('-->', i + 4);
        if (end < 0) { inHtml = true; i = raw.length; break; }
        i = end + 3;
        continue;
      }
      s += c; i++;
    }
    out.push(s);
  }
  return out;
}

function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(f);
  }
  return out;
}

const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

// ---------------------------------------------------------------------------
// Exemptions
// ---------------------------------------------------------------------------

// An em dash standing alone in a cell is the "no value here" glyph, not
// prose: `{n == null ? '—' : …}`. Roughly seventy of these across the admin
// tables and the topochain screens. Blank them before matching rather than
// listing every site, and keep the rule tight (the literal must be JUST the
// dash) so `'— and then'` still fails.
const PLACEHOLDER_GLYPH = /(['"`])—\1|<>—<\/>|>—</g;

// A `<select>`'s empty choice spells the absence out with dashes on both
// sides. Same glyph role, different shape.
const BLANK_OPTION = /— No season —|— \(season-wide\)/g;

// Staging fixtures are seed rows, not product copy: the spec scopes them
// out because their whole job is to look like plausible third-party content
// in a preview. Recognised by the marker they already carry, anywhere in the
// statement that builds them.
const FIXTURE = /\[Mock\]|Staging demo|staging fixture|Staging-only mock/;
const FIXTURE_LOOKBACK = 10;

// A diagnostic whose string opens with a bracketed module tag (`[home] …`,
// `[tailwind] …`) is written to the console for whoever is debugging, and
// is often a continuation line of a `console.error(` that started above.
const TAGGED_DIAGNOSTIC = /(['"`])\[[a-z][a-z0-9-]*\]/;

const LOG_LINE = /^\s*(log|logger|console)\./;
const SQL_COMMENT = /^\s*--/;

// Whole files the scans skip, each with the reason it is not copy.
const SKIP_FILES = new Map([
  ['frontend/src/features/admin/e2e-results-data.js',
    'archived notes from a manual end-to-end run, replayed verbatim in the console'],
  ['src/db/migrate.js',
    'staging seed fixtures and SQL'],
  ['src/services/github-mock.js', 'staging fixtures for the GitHub mock'],
  ['src/services/gallery-demo.js', 'staging fixtures for the gallery'],
  ['src/services/mcp-tools.js', 'MCP tool descriptions and prompt text, read by a model'],
  ['src/services/mcp-charter.js', 'the connector charter, read by a model'],
  ['src/services/external-agent-tasks.js', 'work-order prompt text, read by a model'],
  ['src/services/template.js', 'scaffold prompt text, read by a model'],
  ['src/services/visuals.js', 'prompt text, read by a model'],
  ['src/services/llm.js', 'prompt text, read by a model'],
  ['src/services/prompts.js', 'prompt text, read by a model'],
  ['src/services/recovery-pills.js',
    'the quick-reply rules prompt, plus the matcher that must keep recognising '
    + 'the pre-#1389 wording of rows already in the database'],
]);

// Individual lines, by the text that identifies them.
const ALLOW = [
  {
    file: 'frontend/src/features/admin/admin-db-export.tsx',
    contains: '<li className="list-none pl-4">—',
    reason: 'the dash is the bullet glyph on an unbulleted list, not punctuation',
  },
  {
    file: 'frontend/src/features/settings/settings.js',
    contains: 'Something went wrong',
    reason: "quotes an OAuth provider's own error screen verbatim, so a user can match it",
  },
  {
    file: 'public/js/app-view.js',
    contains: 'label: `— ${node.textContent',
    reason: 'a menu separator row: the dashes are the rule, and the label is its text',
  },
  {
    file: 'src/services/github.js',
    contains: '[truncated —',
    reason: 'a marker inside an issue body handed to a coding agent, not shown to anyone',
  },
];

function allowed(file, line) {
  return ALLOW.some((a) => a.file === file && line.includes(a.contains));
}

function scannable(raw) {
  const code = stripComments(raw);
  return code.map((l) => l
    .replace(PLACEHOLDER_GLYPH, '')
    .replace(BLANK_OPTION, ''));
}

// ---------------------------------------------------------------------------

test('no em dashes in shell or client-side copy', () => {
  const files = [
    ...walk(path.join(ROOT, 'frontend/src'), ['.js', '.ts', '.tsx', '.jsx', '.html']),
    ...walk(path.join(ROOT, 'public/js'), ['.js']),
  ];

  const offenders = [];
  for (const abs of files) {
    const f = rel(abs);
    if (SKIP_FILES.has(f)) continue;
    const raw = fs.readFileSync(abs, 'utf8');
    const lines = raw.split('\n');
    const code = scannable(raw);
    for (let i = 0; i < code.length; i++) {
      if (!DASH.test(code[i])) continue;
      const line = lines[i];
      if (TAGGED_DIAGNOSTIC.test(line)) continue;
      if (FIXTURE.test(line)) continue;
      if (allowed(f, line)) continue;
      offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
    }
  }

  assert.deepStrictEqual(offenders, [],
    'Em dash in user-facing copy (#1389). Rewrite it: a full stop when the '
    + 'dash joins a status to an instruction, a colon for a label and its '
    + 'value, parentheses for an aside, ", so" for a consequence. Never a '
    + 'plain or spaced hyphen, which reads as a typo. If the string is not '
    + 'copy (a placeholder glyph, a separator, a staging fixture), add it to '
    + 'ALLOW or SKIP_FILES in this file with the reason.');
});

// The declared checks assert on rendered text, so a rewritten string and a
// stale `expectText` fail merge together. Scanning them here means the two
// can never drift back apart. `name` values are NOT scanned: check history
// keys on sha256(name + path), so renaming one starts a fresh key with no
// first-pass date and silently downgrades a blocking check to advisory.
test('no em dashes in the text dapp.json checks assert on', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'dapp.json'), 'utf8'));
  const offenders = [];
  for (const t of manifest.tests || []) {
    for (const field of ['expectText', 'expectSelector']) {
      const v = t[field];
      if (typeof v !== 'string' || !DASH.test(v)) continue;
      if (FIXTURE.test(v)) continue;
      offenders.push(`${field} of "${t.name}": ${v}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    'A declared check still asserts on copy containing an em dash. Update it '
    + 'to the rewritten string (#1389).');
});

test('no em dashes in server-side messages that reach a person', () => {
  // The shapes server-side copy actually leaves through. Everything else in
  // src/** is prompt or model-context text and is out of scope by design.
  const EMITTER = new RegExp([
    'sendStatus\\(',
    'toast\\(',
    "\\berror:\\s*[`'\"]",
    "\\bmessage:\\s*[`'\"]",
    "\\breason:\\s*[`'\"]",
    "\\bsubject:\\s*[`'\"]",
    "\\btitle:\\s*[`'\"]",
    "\\bbody:\\s*[`'\"]",
    "\\blabel:\\s*[`'\"]",
  ].join('|'));

  const offenders = [];
  for (const abs of walk(path.join(ROOT, 'src'), ['.js'])) {
    const f = rel(abs);
    if (SKIP_FILES.has(f)) continue;
    const raw = fs.readFileSync(abs, 'utf8');
    const lines = raw.split('\n');
    const code = scannable(raw);
    for (let i = 0; i < code.length; i++) {
      if (!DASH.test(code[i])) continue;
      const line = lines[i];
      if (!EMITTER.test(line)) continue;
      if (LOG_LINE.test(line) || SQL_COMMENT.test(line)) continue;
      if (TAGGED_DIAGNOSTIC.test(line)) continue;
      const near = lines.slice(Math.max(0, i - FIXTURE_LOOKBACK), i + 1);
      if (near.some((l) => FIXTURE.test(l))) continue;
      if (allowed(f, line)) continue;
      offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
    }
  }

  assert.deepStrictEqual(offenders, [],
    'Em dash in a server-side message a user reads (#1389). Same rewrite '
    + 'rules as the client-side guard above.');
});

// The one string the sweep could not simply rewrite. Rows carrying the old
// wording are already in the database, and the backfill uses this matcher to
// recognise its own breadcrumb: drop the old alternative and every affected
// session gets a second one posted under it.
test('the code-landed breadcrumb reads without a dash, and still matches the old rows', () => {
  const pills = require('../src/services/recovery-pills.js');

  const fresh = pills.buildCodeLandedBreadcrumb({ prNumber: 41 });
  assert.ok(!DASH.test(fresh), `breadcrumb still carries an em dash: ${fresh}`);
  assert.match(fresh, /Rebuilding the preview now\.$/);
  assert.ok(pills.isCodeLandedBreadcrumb(fresh));
  assert.ok(pills.isCodeLandedBreadcrumb(
    pills.buildCodeLandedBreadcrumb({ rebuildingPreview: false })));

  assert.ok(pills.isCodeLandedBreadcrumb(
    'Your changes are committed and pushed to PR #41 — rebuilding the preview now.'),
  'the pre-#1389 wording must keep matching: those rows are already persisted');
  assert.ok(pills.isCodeLandedBreadcrumb(
    'Your changes are committed and pushed to your branch — rebuilding the preview now.'));
});

// The rules themselves, so a future edit cannot quietly drop them and let
// every generated app and every Mayor reply grow the dash back.
test('the copy-style rule is stated for generated apps and for the assistant', () => {
  const conventions = fs.readFileSync(
    path.join(ROOT, 'src/prompts/app-conventions.md'), 'utf8');
  assert.match(conventions, /## Writing user-facing copy: no em dashes/);

  const sessions = fs.readFileSync(path.join(ROOT, 'src/routes/sessions.js'), 'utf8');
  assert.match(sessions, /Do not use em dashes/);
});
