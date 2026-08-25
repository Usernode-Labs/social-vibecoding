// tests/no-em-dash-in-copy.test.js — static analysis: no em dash in
// user-facing copy (#1389, the "AI hyphen"). Heavy em-dash use reads as
// AI-generated, so the product's visible strings use plainer punctuation
// (a colon, a comma, parentheses, or two sentences). This test keeps the
// sweep from drifting back one merge at a time.
//
// Modelled on tests/admin-ui-registry.test.js: scan source text with
// comments stripped, fail with the offending file:line list.
//
// SCOPE — exactly what the scan below covers, no more (a rule that names
// a stronger property than it checks is worse than a narrower one
// honestly stated): frontend/src/**, public/js/**, src/routes/**,
// src/services/**, src/middleware/**, and the expectText/expectSelector
// values of dapp.json's declared tests. The em dash is policed in all
// four encodings (raw —, &mdash;, —, &#8212;).
//
// Deliberately NOT policed:
//  - The en dash (–): every non-comment occurrence is a numeric or date
//    range, where it is the correct character.
//  - Code comments of every kind — developer text, not user copy.
//  - The lone-dash "no value" placeholder ('—' in a table cell / stat
//    tile) and the `— label —` separator row: glyphs, not prose.
//  - Fixture copy prefixed [Mock] / Staging demo: staging-only strings
//    several dapp.json checks assert on verbatim.
//  - Text authored for language models rather than users (see
//    ALLOWED_FILES) and verbatim quotes of third-party UI (see
//    ALLOWED_SNIPPETS).
//
// Run with: node --test tests/no-em-dash-in-copy.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const SCAN_ROOTS = [
  'frontend/src',
  'public/js',
  'src/routes',
  'src/services',
  'src/middleware',
];

const EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.html']);

// Files whose em dashes are not user copy. Each entry carries its reason;
// a new entry needs one too.
const ALLOWED_FILES = new Set([
  // LLM prompt / agent-facing text (read by models, not shown to users).
  // sessions.js also holds user-facing strings, but its prompt blocks are
  // interleaved through the file at line granularity no static scan can
  // separate — its user copy is policed by review instead.
  'src/routes/sessions.js',
  'src/services/mcp-charter.js',
  'src/services/mcp-tools.js',
  'src/services/llm.js',
  'src/services/prompts.js', // conventions-doc excerpts injected into agent prompts
  'src/services/debug-access.js', // the prod-debug prompt block handed to agents
  'src/services/thread-context.js', // discussion-context builder for agent prompts
  'src/services/external-agent-tasks.js',
  'src/services/external-agent-head.js',
  'src/services/fleet-maintenance.js',
  'src/services/recovery-pills.js', // prompt rules text + the legacy-wording matcher regex
  'src/services/attachments.js', // agent-message builders ("[image attachment: … ]")
  'src/services/in-loop-browser.js', // notes injected into agent transcripts
  // Scaffolded-repo documentation (generated CLAUDE.md/README content for
  // child apps) — spec'd as deferred work, not platform UI.
  'src/services/template.js',
  // HTML entity decode map (mdash/ndash are DATA here, not copy).
  'src/services/web-fetch.js',
  // Fixture data files (mock/demo content, mostly [Mock]-prefixed already).
  'src/services/github-mock.js',
  'src/services/gallery-demo.js',
  'src/services/analytics-demo.js',
  'src/services/local-agent-demo.js',
  'frontend/src/features/admin/e2e-results-data.js',
]);

// Exact substrings allowed to carry a dash wherever they appear —
// verbatim quotes of text some OTHER system shows, which we must not
// paraphrase, plus agent-facing fragments inside otherwise user-facing
// files.
const ALLOWED_SNIPPETS = [
  // Facebook/OAuth provider's own error dialog, quoted verbatim in the
  // social-identity help text (settings.js).
  'Something went wrong — You weren’t able to give access to the App',
  "Something went wrong — You weren't able to give access to the App",
  // Truncation hint appended to issue bodies handed to coding agents
  // (services/github.js) — read by models, not users.
  'truncated — use',
  // votes.js: the prompt instructing a model how to write vote
  // explanations (both variants share this fragment).
  'the new explanation',
  // Mayor-prompt fragment about the user's uploaded agent files
  // (services/user-agent-files.js) — model-facing.
  'see their full contents — only this list',
  // Shell comment inside the worker's generated unit-test script
  // (services/unit-suite.js) — developer-facing heredoc.
  'work somewhere it can write',
  // dev-flow.js staging demo work order mirrors the REAL work-order text
  // built in external-agent-tasks.js (an allowlisted agent-facing file) —
  // the two must stay verbatim-identical.
  'nothing to invalidate — but this is',
  // app-view.js EXPLORE_SEED: the editable kickoff message SENT TO the
  // dev-chat model. Its tail is load-bearing (keeps an unedited send
  // chat-only) and pinned byte-for-byte by
  // tests/explore-pr-in-dev-chat.test.js — model-facing, do not reword.
  "Just explain it for now — don't",
  'explore PR #${row.pr_number} in this app — ',
  // launchpad.js prefillText: the work-order prompt the user copies into
  // their own coding agent — model-facing instructions, not UI copy.
  "(title ? ' — ' + title : '')",
  'Follow the work order it returns EXACTLY — it names the repository',
  // native-chrome.js permission verdicts: `reason` is consumed only by
  // settings.js's _unNotifDeadEnd console.error — a developer log line.
  'the notification permission is denied — iOS shows no',
  'still un-determined — no OS prompt was presented',
];

// One dash form to rule them all. — is matched as the ESCAPE
// SEQUENCE in source text (the raw character is the first alternative).
const DASH_RE = /—|&mdash;|\\u2014|&#8212;/;

function sourcesUnder(dir) {
  const out = [];
  const walk = (p) => {
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (EXTS.has(path.extname(entry.name))) out.push(full);
    }
  };
  walk(dir);
  return out;
}

// Strip comments: block (/* */ including JSDoc and JSX {/* */}), line
// (//), and HTML (<!-- -->). Line-oriented on purpose — replacing
// comment REGIONS with blank lines keeps reported line numbers true.
function stripComments(src) {
  const lines = src.split('\n');
  const out = [];
  let inBlock = false; // /* … */
  let inHtml = false; // <!-- … -->
  for (let raw of lines) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) { out.push(''); continue; }
      line = ' '.repeat(end + 2) + line.slice(end + 2);
      inBlock = false;
    }
    if (inHtml) {
      const end = line.indexOf('-->');
      if (end === -1) { out.push(''); continue; }
      line = ' '.repeat(end + 3) + line.slice(end + 3);
      inHtml = false;
    }
    // Whole-line comments FIRST — a `//` line may contain `/*`-looking
    // text (`public/js/**`) that would derail the inline scanner below.
    // `*`-led lines are JSDoc/block continuations; `--`-led lines are SQL
    // comments inside template literals; `#`-led follow in shell heredocs.
    if (/^\s*(\/\/|\*[^/]|\*$|--)/.test(line)) { out.push(''); continue; }
    // Iteratively blank inline block comments; a trailing unterminated
    // one sets the flag for the following lines.
    for (;;) {
      const start = line.indexOf('/*');
      if (start === -1) break;
      const end = line.indexOf('*/', start + 2);
      if (end === -1) {
        line = line.slice(0, start);
        inBlock = true;
        break;
      }
      line = line.slice(0, start) + ' '.repeat(end + 2 - start) + line.slice(end + 2);
    }
    const html = line.indexOf('<!--');
    if (html !== -1) {
      const end = line.indexOf('-->', html + 4);
      if (end === -1) { line = line.slice(0, html); inHtml = true; }
      else line = line.slice(0, html) + line.slice(end + 3);
    }
    // Line comments: only when the // is not inside a string literal.
    // Cheap heuristic that matches this repo's style — a // preceded by
    // start-of-line/whitespace (so protocol-relative `://` never counts),
    // with balanced quotes before it. Everything after a genuine // is
    // comment, whatever it ends with.
    const m = line.match(/(^|\s)\/\//);
    if (m) {
      const before = line.slice(0, m.index + m[1].length);
      const quotes = (before.match(/['"`]/g) || []).length;
      if (quotes % 2 === 0 && !/:$/.test(before)) line = before;
    }
    out.push(line);
  }
  return out.join('\n');
}

// Glyph (non-prose) dash uses, removed before flagging:
//  - a lone quoted dash: '—' / "—" / `—`  (the "no value" placeholder)
//  - a JSX lone dash: >—<  (e.g. <>—</>)
//  - the separator-row template: `— ${…} —`
//  - a dash-prefixed interpolation with no prose around it: `— ${…}`
//    (the dev-chat progress suffix — a separator before a phase name)
function stripGlyphUses(line) {
  return line
    .replace(/`— \$\{[^}]*\} —`/g, '')
    .replace(/` ?— \$\{[^}]*\}`/g, '')
    .replace(/(['"`])—\1/g, '')
    .replace(/>—</g, '');
}

function findOffenders() {
  const offenders = [];
  for (const rootRel of SCAN_ROOTS) {
    for (const file of sourcesUnder(path.join(ROOT, rootRel))) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (ALLOWED_FILES.has(rel)) continue;
      const src = fs.readFileSync(file, 'utf8');
      if (!DASH_RE.test(src)) continue;
      const lines = stripComments(src).split('\n');
      lines.forEach((line, i) => {
        if (!DASH_RE.test(line)) return;
        if (/\[Mock\]|Staging demo|Staging Demo/.test(line)) return;
        // Developer diagnostics: server log.* lines, browser console.*
        // lines, and thrown internal Errors are read by operators and
        // developers, not users. The call opener may sit on one of the
        // two preceding lines (multi-line arguments).
        const DIAG_RE = /\blog\.(info|warn|error|debug|trace)\(|\bconsole\.(log|warn|error|info|debug)\(|\bnew Error\(/;
        if (DIAG_RE.test(line)) return;
        const prev = `${lines[i - 2] || ''}\n${lines[i - 1] || ''}`;
        if (/(\blog\.(info|warn|error|debug|trace)|\bconsole\.(log|warn|error|info|debug)|\bnew Error)\((\s*'[^']*',?)?\s*$/m.test(prev)) return;
        if (ALLOWED_SNIPPETS.some((s) => line.includes(s))) return;
        const stripped = stripGlyphUses(line);
        if (!DASH_RE.test(stripped)) return;
        offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
      });
    }
  }
  return offenders;
}

test('no em dash in user-facing copy (frontend, public/js, server messages)', () => {
  const offenders = findOffenders();
  assert.deepStrictEqual(offenders, [],
    'em dash in user-facing copy (the "AI hyphen", #1389). Rewrite with a '
    + 'colon, comma, parentheses, or two sentences (see "Copy style" in '
    + 'src/prompts/app-conventions.md). If a hit is genuinely not user copy, '
    + 'extend the allowlist in this test WITH a reason:\n'
    + offenders.join('\n'));
});

test('no em dash in dapp.json expectText / expectSelector', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'dapp.json'), 'utf8'));
  const offenders = [];
  for (const t of manifest.tests || []) {
    for (const key of ['expectText', 'expectSelector']) {
      const v = t[key];
      if (typeof v !== 'string' || !DASH_RE.test(v)) continue;
      // Fixture assertions track staging fixture copy, which keeps its
      // dashes (fixtures are out of the sweep's scope on purpose).
      if (/\[Mock\]|Staging demo/.test(v)) continue;
      offenders.push(`"${t.name || t.path}" ${key}: ${v}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    'dapp.json assertions must track the de-dashed copy they assert on:\n'
    + offenders.join('\n'));
});
