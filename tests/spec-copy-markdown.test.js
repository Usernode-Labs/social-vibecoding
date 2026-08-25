// Guards for #1012: "Copy markdown" on both full-spec surfaces.
//
// The button's whole value is that it yields the WHOLE document — both
// halves plus their marker headings — for the version on screen. That is
// exactly the property a later refactor can silently break (by copying
// the rendered half, or the active tab's slice), so these guards pin the
// copy SOURCE, not just the button's presence.
//
// public/js/*.js are plain browser scripts with no module.exports and the
// suite has no jsdom, so the UI layers assert on stable source tokens —
// the same coarse style as tests/spec-viewer-session-reset.test.js and
// layer 2 of tests/spec-sections.test.js. The staging mock is checked
// through the REAL splitter so the mock document and the two-half
// convention can't drift apart.
//
// Run with: node --test tests/spec-copy-markdown.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { splitSpecSections } = require('../public/js/spec-sections.js');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const platformUiSrc = read('public', 'js', 'platform-ui.js');
const devChatSrc = read('frontend', 'src', 'features', 'dev-chat', 'dev-chat.js');
const groupChatSrc = read('public', 'js', 'group-chat.js');
// The panel's MARKUP moved to a component in #1191; group-chat.js keeps the
// fetch, the raw-source stash and the gate that decides whether Copy appears.
const panelTsx = read('frontend', 'src', 'features', 'group-chat', 'spec-panel.tsx');
// #1078: the dev-chat viewer's markup moved the same way the panel's did.
const viewerTsx = read('frontend', 'src', 'features', 'dev-chat', 'spec-viewer.tsx');
const { renderComponent } = require('./lib/render-tsx');
const appCss = read('public', 'css', 'app.css');
const sessionsSrc = read('src', 'routes', 'sessions.js');

// Slice out a method body by name. Coarse but stable: starts at the
// method's `name(` declaration and ends at the next method declaration
// sharing its indentation. Same helper as
// tests/spec-viewer-session-reset.test.js, generalised over indent width
// because platform-ui.js's object literal lives inside an IIFE (4 spaces)
// while dev-chat.js / group-chat.js are top-level (2).
function methodSource(src, name, label, indent = '  ') {
  const startRe = new RegExp(`\\n${indent}(?:async )?${name}\\(`);
  const startMatch = src.match(startRe);
  assert.ok(startMatch, `method ${name} not found in ${label}`);
  const start = startMatch.index;
  const rest = src.slice(start + startMatch[0].length);
  const endMatch = rest.match(new RegExp(`\\n${indent}(?:async )?[_A-Za-z][\\w]*\\((?:[^)]*)\\)\\s*\\{`));
  const end = endMatch ? start + startMatch[0].length + endMatch.index : src.length;
  return src.slice(start, end);
}

// The GET /api/sessions/:id/specs/:version handler, sliced out so the
// mock-fallback assertions can't accidentally match an earlier route's
// `if (!rows.length)`.
function specVersionRouteSource() {
  const start = sessionsSrc.indexOf("router.get('/api/sessions/:id/specs/:version'");
  assert.ok(start !== -1, 'spec-version route not found in src/routes/sessions.js');
  const rest = sessionsSrc.slice(start + 1);
  const nextRoute = rest.search(/\n  router\.(get|post|put|patch|delete)\(/);
  return nextRoute === -1 ? sessionsSrc.slice(start) : sessionsSrc.slice(start, start + 1 + nextRoute);
}

// ── 1. The shared clipboard helper ──────────────────────────────────────

test('PlatformUI exposes copyText with a clipboard path and an execCommand fallback', () => {
  const src = methodSource(platformUiSrc, 'copyText', 'platform-ui.js', '    ');
  assert.ok(/navigator\.clipboard\?\.writeText/.test(src),
    'copyText must try navigator.clipboard.writeText first');
  assert.ok(src.includes("document.execCommand('copy')"),
    'copyText must fall back to execCommand for insecure/blocked contexts');
  assert.ok(src.includes('createElement(\'textarea\')'),
    'the fallback needs a real (off-screen) textarea to select');
  // The fallback element must always be torn down, whichever branch ran.
  assert.ok(/finally\s*\{[\s\S]*removeChild/.test(src),
    'the fallback textarea must be removed in a finally block');
});

test('copyText resolves a boolean instead of throwing', () => {
  const src = methodSource(platformUiSrc, 'copyText', 'platform-ui.js', '    ');
  assert.ok(/catch\s*\{\s*\}/.test(src) || /catch\s*\{\s*return false;/.test(src),
    'copyText must swallow clipboard rejections so callers can branch on the result');
  assert.ok(/return false;/.test(src) && /return true;/.test(src),
    'copyText must return both success and failure booleans');
});

// ── 2. Dev-chat spec viewer ─────────────────────────────────────────────

// #1078: the panel's MARKUP moved to features/dev-chat/spec-viewer.tsx, the
// same split the group-chat panel below already made. What crosses the seam
// is `raw` — the whole selected version — so the property #1012 is about is
// now pinned on BOTH sides: the model must carry the raw document, and the
// button must copy what the model carried.
test('the viewer renders a copy button and the model tells it what to copy', () => {
  const src = methodSource(devChatSrc, '_specViewerView', 'dev-chat.js');
  assert.ok(/raw: displayContent,/.test(src),
    'the model must carry displayContent — the raw selected version');
  assert.ok(/copy = isEmpty \? \{ kind: 'blank' \} : \{ kind: 'live' \}/.test(src),
    'an empty spec must blank the copy button, mirroring the share buttons');

  assert.ok(viewerTsx.includes('id="dc-spec-viewer-copy"'), 'the copy button is rendered');
  assert.ok(/disabled\s*\n?\s*title="No spec to copy yet"/.test(viewerTsx),
    'and its disabled placeholder keeps the same title');
});

test('the dev-chat copy button copies `raw` — the WHOLE document', () => {
  assert.ok(/copyText\?\.\(raw\)/.test(viewerTsx),
    'the copy handler must pass the raw selected version to copyText');
  // The crux of #1012: never the rendered half, never the active tab.
  assert.ok(!/copyText\?\.\((?:[^)]*\b(?:split|activeTab|tab|halfHtml|body)\b[^)]*)\)/.test(viewerTsx),
    'the copy source must not be a split half or keyed off the active tab');
  // And the model's `raw` is not the rendered body either.
  const src = methodSource(devChatSrc, '_specViewerView', 'dev-chat.js');
  assert.ok(!/raw: (?:body|split|half)/.test(src));
});

test('the copy button sits after the version select and before the share buttons', () => {
  const selectIdx = viewerTsx.indexOf('id="dc-spec-viewer-version"');
  const copyIdx = viewerTsx.indexOf('<CopyButton ');
  const shareUserIdx = viewerTsx.indexOf('<UserShareButton ');
  const shareIdx = viewerTsx.indexOf('<GroupShareButton ');
  assert.ok(selectIdx !== -1, 'version select missing from the header');
  assert.ok(copyIdx !== -1, 'copy button missing from the header');
  assert.ok(shareUserIdx !== -1, 'share-to-user button missing from the header');
  assert.ok(selectIdx < copyIdx && copyIdx < shareUserIdx && shareUserIdx < shareIdx,
    'header order must be: version select, copy, share buttons (close stays trailing)');
});

test('the copy button flashes its own label and reports failure', () => {
  assert.ok(viewerTsx.includes("'Copied!'") && viewerTsx.includes("'Copy failed'"),
    'both the success and failure labels must be present');
  assert.ok(/setTimeout\(\(\) => setLabel\('Copy markdown'\), 1500\)/.test(viewerTsx),
    'the label must be restored after the flash');
  assert.ok(/if \(!ok\) ui\(\)\?\.toast\?\.\(/.test(viewerTsx),
    'a failed copy must also explain the manual fallback via a toast');
});

// ── 3. Group-chat shared-spec panel ─────────────────────────────────────

test('_showSpecPanel stashes the raw markdown in JS state', () => {
  const src = methodSource(groupChatSrc, '_showSpecPanel', 'group-chat.js');
  assert.ok(/GroupChat\._specPanelRaw = content/.test(src),
    '_showSpecPanel must stash `content` on _specPanelRaw — the panel does not '
    + 'hold the raw source, it renders the markdown');
  // Multi-KB markdown with quotes/newlines must never be inlined into markup.
  assert.ok(!/data-spec-(?:raw|content|markdown)/.test(src),
    'the raw spec must not be interpolated into a data- attribute');
  // The copy handler moved into the panel component with the markup (#1191);
  // what it copies did not change, and it still reaches the stash by name
  // because that is where the raw source lives.
  assert.ok(!/data-spec-(?:raw|content|markdown)/.test(panelTsx),
    'nor into one on the React side');
  assert.ok(/copyText\?\.\(controller\(\)\?\._specPanelRaw\)/.test(panelTsx),
    'the panel copy handler must copy the stashed raw markdown');
});

test('the panel copy button is gated on canCopy and a non-error body', () => {
  // The GATE is still decided in the module, where `isError` and the option
  // live; the button is drawn from the one field it produces.
  const src = methodSource(groupChatSrc, '_showSpecPanel', 'group-chat.js');
  assert.ok(/canCopy = true/.test(src),
    '_showSpecPanel must accept a canCopy option defaulting to true');
  assert.ok(/canCopy: !!\(canCopy && !isError && content\)/.test(src),
    'the button must render only for a copyable, non-error, non-empty body');

  // …and the header's order is checked on the RENDERED markup rather than on
  // template-literal positions, which is a stronger statement of the same
  // thing: the copy control sits left of the close ✕.
  const header = (state) => renderComponent(
    'frontend/src/features/group-chat/spec-panel.tsx', 'SpecPanelView', state);
  const base = {
    open: true, title: 'Spec', subtitle: 'v1', canCopy: true,
    body: { kind: 'markdown', html: '<p>hi</p>' },
  };
  const withCopy = header(base);
  assert.ok(withCopy.indexOf('gc-spec-panel-copy') < withCopy.indexOf('gc-spec-panel-close'),
    'the copy button must sit left of the close ✕');
  // Gated off: an error body, and an explicit canCopy: false.
  assert.ok(!header({ ...base, canCopy: false }).includes('gc-spec-panel-copy'));
  assert.ok(!header({ ...base, canCopy: false, body: { kind: 'error', text: 'Not found' } })
    .includes('gc-spec-panel-copy'));
  // An error body is TEXT, never markdown — formatting a 404 makes it look
  // like a document.
  const err = header({ ...base, canCopy: false, body: { kind: 'error', text: '<b>404</b>' } });
  assert.ok(!err.includes('<b>404</b>'), 'the error message is not markup');
  assert.match(err, /gc-spec-panel-error">&lt;b&gt;404&lt;\/b&gt;</);
});

test('the reload-restore skeleton is not copyable', () => {
  const src = methodSource(groupChatSrc, '_restoreSpecPanelIfSaved', 'group-chat.js');
  assert.ok(/content: 'Loading…',[\s\S]{0,240}canCopy: false/.test(src),
    "the 'Loading…' skeleton render must pass canCopy: false");
});

test('_closeSpecPanel clears the stashed document', () => {
  const src = methodSource(groupChatSrc, '_closeSpecPanel', 'group-chat.js');
  assert.ok(/GroupChat\._specPanelRaw = null/.test(src),
    'a closed panel must not leave its document copyable');
});

test('both group-chat spec fetches forward the ?demo=1 flag', () => {
  const fetches = groupChatSrc.match(/fetch\(`\/api\/sessions\/\$\{sessionId\}\/specs\/\$\{version\}[^`]*`\)/g) || [];
  assert.equal(fetches.length, 2,
    'expected exactly the two spec-version fetches (click delegate + reload restore)');
  for (const f of fetches) {
    assert.ok(f.includes('GroupChat._specDemoQS()'),
      `spec fetch must forward the demo flag: ${f}`);
  }
  const helper = methodSource(groupChatSrc, '_specDemoQS', 'group-chat.js');
  assert.ok(/get\('demo'\) === '1' \? '\?demo=1' : ''/.test(helper),
    '_specDemoQS must only forward demo=1 when the page URL carries it');
});

// ── 4. CSS ──────────────────────────────────────────────────────────────

test('both copy buttons reserve width for the label flash', () => {
  assert.ok(/\.dc-spec-copy-btn\s*\{[^}]*min-width:\s*108px/.test(appCss),
    '.dc-spec-copy-btn needs a min-width so "Copied!" cannot re-wrap the header');
  assert.ok(/\.gc-spec-panel-copy\s*\{[^}]*min-width:\s*108px/.test(appCss),
    '.gc-spec-panel-copy needs the same reserved width');
  assert.ok(/\.gc-spec-panel-copy\s*\{[^}]*flex-shrink:\s*0/.test(appCss),
    'the panel copy button must not be compressed by a long spec title');
});

// ── 5. Staging mock spec version ────────────────────────────────────────

test('the mock spec version is gated on staging AND ?demo=1', () => {
  const route = specVersionRouteSource();
  const gate = route.match(
    /process\.env\.USERNODE_ENV === 'staging' && req\.query\.demo === '1'\) \{\s*return res\.json\(\{ spec: stagingMockSpecVersion\(version\) \}\);/
  );
  assert.ok(gate, 'the mock must require both USERNODE_ENV=staging and demo=1');
  // A real row must always win: the fallback lives inside the empty-result branch.
  const emptyBranch = route.indexOf('if (!rows.length) {');
  const mockCall = route.indexOf('stagingMockSpecVersion(version)');
  const realJson = route.indexOf('res.json({ spec: rows[0] })');
  assert.ok(emptyBranch !== -1 && mockCall !== -1 && realJson !== -1,
    'spec-version route shape changed unexpectedly');
  assert.ok(emptyBranch < mockCall && mockCall < realJson,
    'the mock must only be reachable when the real query returned no rows');
});

test('the mock spec document conforms to the two-half convention', () => {
  // Parsed out of the shipped source rather than duplicated here, so this
  // can't pass against a stale copy of the document.
  const split = splitSpecSections(extractMockMd());
  assert.ok(split, 'the mock spec must split into two halves (both marker headings present)');
  assert.ok(split.preamble.includes('[Mock]'),
    'the mock must be obviously fake per the staging-seed convention');
  assert.ok(split.userFacing.trim(), 'the mock needs a non-empty user-facing half');
  assert.ok(split.technical.trim(), 'the mock needs a non-empty technical half');
});

// The mock lives in a joined array literal in src/routes/sessions.js; parse
// it out of the source so this test can't pass against a stale copy.
function extractMockMd() {
  const m = sessionsSrc.match(/const STAGING_MOCK_SPEC_MD = \[([\s\S]*?)\]\.join\('\\n'\);/);
  assert.ok(m, 'STAGING_MOCK_SPEC_MD literal not found in src/routes/sessions.js');
  return m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith("'"))
    .map((l) => l.replace(/,$/, '').replace(/^'/, '').replace(/'$/, ''))
    .join('\n');
}
