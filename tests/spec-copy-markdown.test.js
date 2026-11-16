// Guards for #1012: "Copy markdown" on the shared-spec panel.
//
// The button's whole value is that it yields the WHOLE document for the
// version on screen. That is exactly the property a later refactor can
// silently break (by copying the rendered body instead of the source), so
// these guards pin the copy SOURCE, not just the button's presence.
//
// public/js/*.js are plain browser scripts with no module.exports and the
// suite has no jsdom, so the UI layers assert on stable source tokens. The
// staging mock is checked against the spec-version route it is served from.
//
// Run with: node --test tests/spec-copy-markdown.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const platformUiSrc = read('public', 'js', 'platform-ui.js');
const groupChatSrc = read('public', 'js', 'group-chat.js');
// The panel's MARKUP moved to a component in #1191; group-chat.js keeps the
// fetch, the raw-source stash and the gate that decides whether Copy appears.
const panelTsx = read('frontend', 'src', 'features', 'group-chat', 'spec-panel.tsx');
// #6230: the open state and the raw document moved to the detail store.
const detailTs = read('frontend', 'src', 'features', 'ai', 'detail.ts');
const { renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');
const appCss = read('public', 'css', 'app.css');
const sessionsSrc = read('src', 'routes', 'sessions.js');

// Slice out a method body by name. Coarse but stable: starts at the
// method's `name(` declaration and ends at the next method declaration
// sharing its indentation, generalised over indent width because
// platform-ui.js's object literal lives inside an IIFE (4 spaces) while
// group-chat.js is top-level (2).
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

// ── 2. Group-chat shared-spec panel ─────────────────────────────────────

test('the detail store keeps the raw markdown, and the panel copies it', () => {
  // #6230: the raw source moved from `GroupChat._specPanelRaw` into the one
  // detail store, so a closed panel's document is forgotten with its entry.
  assert.ok(/raw: string \| null/.test(detailTs), 'the store carries the raw document');
  assert.ok(/raw: input\.payload\?\.error \? null : \(markdown \|\| null\)/.test(detailTs),
    'a text plan keeps its own markdown as the raw source');
  assert.ok(/raw: spec\.content == null \? null : String\(spec\.content\)/.test(detailTs),
    'a fetched spec keeps the markdown the server sent');
  // Multi-KB markdown with quotes/newlines must never be inlined into markup.
  assert.ok(!/data-spec-(?:raw|content|markdown)/.test(detailTs),
    'the raw spec must not be interpolated into a data- attribute');
  assert.ok(!/data-spec-(?:raw|content|markdown)/.test(panelTsx),
    'nor into one on the React side');
  assert.ok(/copyText\?\.\(raw\)/.test(panelTsx),
    'the panel copy handler must copy the raw markdown it was given');
});

test('the panel copy button is gated on canCopy and a non-error body', () => {
  // #6230: the GATE is the store's now, where `error` and the raw document
  // live; the button is drawn from the one field it produces.
  assert.ok(/canCopy: !!markdown && !input\.payload\?\.error/.test(detailTs),
    'a text plan offers Copy only when it has markdown and is no error');
  assert.ok(/canCopy: !!spec\.content/.test(detailTs),
    'a fetched spec offers Copy only when it has content');

  const header = (state) => renderComponent(
    'frontend/src/features/group-chat/spec-panel.tsx', 'SpecPanelView', state);
  const base = {
    open: true, title: 'Spec', subtitle: 'v1', canCopy: true,
    body: { kind: 'markdown', html: '<p>hi</p>' },
  };
  const withCopy = header(base);
  assert.ok(withCopy.indexOf('gc-spec-panel-copy') < withCopy.indexOf('gc-spec-panel-close'),
    'the copy button must sit left of the close ✕');
  assert.ok(!header({ ...base, canCopy: false }).includes('gc-spec-panel-copy'));
  assert.ok(!header({ ...base, canCopy: false, body: { kind: 'error', text: 'Not found' } })
    .includes('gc-spec-panel-copy'));
  const err = header({ ...base, canCopy: false, body: { kind: 'error', text: '<b>404</b>' } });
  assert.ok(!err.includes('<b>404</b>'), 'the error message is not markup');
  assert.match(err, /gc-spec-panel-error">&lt;b&gt;404&lt;\/b&gt;/);
});

test('the loading skeleton is not copyable', () => {
  assert.equal(message('chat:group.spec.loading'), 'Loading…');
  // #6230: the store paints the header while the fetch is in flight, with no
  // Copy until the real content lands.
  assert.ok(/canCopy: false, body: \{ kind: 'error', text: say\('chat:group\.spec\.loading'/.test(detailTs),
    "the 'Loading…' skeleton render must offer no Copy");
  const src = methodSource(groupChatSrc, '_restoreSpecPanelIfSaved', 'group-chat.js');
  assert.ok(/detail\?\.open\(\{[\s\S]{0,220}sessionId: saved\.sessionId/.test(src),
    'a reload reopens the saved plan version');
});

test('closing the panel forgets its document', () => {
  // #6230: closeDetail resets the whole state, raw document included.
  assert.ok(/state = CLOSED;/.test(detailTs), 'closing resets the store');
  const src = methodSource(groupChatSrc, '_closeSpecPanel', 'group-chat.js');
  assert.ok(/detail\?\.close/.test(src), 'the shim closes the one detail store');
});

test('the spec fetches forward the ?demo=1 flag', () => {
  assert.ok(/fetch\(path\)/.test(detailTs), 'the store fetches the spec version');
  assert.ok(/\$\{demoQS\(\)\}/.test(detailTs),
    'the spec path forwards the demo flag');
  assert.ok(/function demoQS\(\)[\s\S]{0,140}get\('demo'\) === '1' \? '\?demo=1' : ''/.test(detailTs),
    'demoQS must only forward demo=1 when the page URL carries it');
});

// ── 3. CSS ──────────────────────────────────────────────────────────────

test('the copy button reserves width for the label flash', () => {
  assert.ok(/\.gc-spec-panel-copy\s*\{[^}]*min-width:\s*108px/.test(appCss),
    '.gc-spec-panel-copy needs a min-width so "Copied!" cannot re-wrap the header');
  assert.ok(/\.gc-spec-panel-copy\s*\{[^}]*flex-shrink:\s*0/.test(appCss),
    'the panel copy button must not be compressed by a long spec title');
});

// ── 4. Staging mock spec version ────────────────────────────────────────

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

test('the mock spec document is obviously fake', () => {
  // Parsed out of the shipped source rather than duplicated here, so this
  // can't pass against a stale copy of the document.
  const md = extractMockMd();
  assert.ok(md.split('\n')[0].includes('[Mock]'),
    'the mock must be obviously fake per the staging-seed convention');
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
