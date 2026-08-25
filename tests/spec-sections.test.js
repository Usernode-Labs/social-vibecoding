// Tests for the two-half spec convention (#196).
//
// Three layers:
//   1. Unit tests for splitSpecSections — public/js/spec-sections.js is
//      a plain script with a module.exports guard, so we require the
//      REAL splitter the viewer ships instead of mirroring its logic.
//   2. Source guards — index.html must load spec-sections.js before
//      dev-chat.js, and dev-chat.js's _renderSpecViewer must actually
//      call the splitter, so the unit-tested function can't silently
//      become dead code.
//   3. Prompt guard — the scout prompt in src/routes/sessions.js must
//      mandate the exact two marker headings the splitter keys on, so
//      prompt and splitter can't drift apart.
//
// Run with: node --test tests/spec-sections.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { splitSpecSections } = require('../public/js/spec-sections.js');

// ── 1. splitSpecSections unit tests ─────────────────────────────────────

const CONFORMING = [
  '# Add a leaderboard',
  '',
  'One-line summary.',
  '',
  '## User-facing changes',
  '',
  'A new Leaderboard tab appears.',
  '',
  '### Questions',
  '',
  '1. Top 10 or top 25? (default: 10)',
  '',
  '## Technical implementation',
  '',
  '### Affected files',
  '',
  '- server.js',
].join('\n');

test('both markers present: three-way split with marker lines dropped', () => {
  const split = splitSpecSections(CONFORMING);
  assert.ok(split);
  assert.equal(split.preamble, '# Add a leaderboard\n\nOne-line summary.');
  assert.ok(split.userFacing.startsWith('A new Leaderboard tab appears.'));
  assert.ok(split.userFacing.includes('### Questions'));
  assert.ok(!split.userFacing.includes('## User-facing changes'));
  assert.ok(!split.userFacing.includes('Technical implementation'));
  assert.equal(split.technical, '### Affected files\n\n- server.js');
  assert.ok(!split.technical.includes('## Technical implementation'));
});

test('lenient marker matching: case, heading level 1-3, trailing colon, spacing variants', () => {
  for (const doc of [
    '# T\n\n## USER-FACING CHANGES\n\nu\n\n## TECHNICAL IMPLEMENTATION\n\nt',
    '# T\n\n# User facing change\n\nu\n\n# Technical implementation:\n\nt',
    '# T\n\n### User-facing changes:\n\nu\n\n### Technical Implementation\n\nt',
  ]) {
    const split = splitSpecSections(doc);
    assert.ok(split, `expected split for: ${doc.split('\n')[2]}`);
    assert.equal(split.userFacing, 'u');
    assert.equal(split.technical, 't');
  }
  // Level 4+ headings are NOT markers (### is the sub-structure level).
  assert.equal(splitSpecSections('#### User-facing changes\n\nu\n\n#### Technical implementation\n\nt'), null);
  // Extra words after the marker text don't match.
  assert.equal(splitSpecSections('## User-facing changes overview\n\nu\n\n## Technical implementation\n\nt'), null);
});

test('marker headings inside fenced code blocks are ignored', () => {
  const fencedOnly = [
    '# T',
    '```',
    '## User-facing changes',
    '## Technical implementation',
    '```',
    'prose',
  ].join('\n');
  assert.equal(splitSpecSections(fencedOnly), null);

  // Real markers still win when a fence also quotes them.
  const mixed = [
    '# T',
    '',
    '## User-facing changes',
    '',
    '```',
    '## Technical implementation',
    '```',
    '',
    'after the fence',
    '',
    '## Technical implementation',
    '',
    'real tech half',
  ].join('\n');
  const split = splitSpecSections(mixed);
  assert.ok(split);
  assert.ok(split.userFacing.includes('after the fence'));
  assert.ok(split.userFacing.includes('## Technical implementation')); // the quoted one stays put
  assert.equal(split.technical, 'real tech half');
});

test('one or zero markers → null (legacy fallback)', () => {
  assert.equal(splitSpecSections('# Goal\n\nA legacy spec with free-form sections.\n\n## Edge cases\n\n- none'), null);
  assert.equal(splitSpecSections('# T\n\n## User-facing changes\n\nonly half'), null);
  assert.equal(splitSpecSections('# T\n\n## Technical implementation\n\nonly half'), null);
  assert.equal(splitSpecSections(''), null);
  assert.equal(splitSpecSections('   \n  '), null);
  assert.equal(splitSpecSections(null), null);
  assert.equal(splitSpecSections(undefined), null);
});

test('reversed marker order: each half runs to the other marker or EOF', () => {
  const reversed = '# T\n\n## Technical implementation\n\ntech stuff\n\n## User-facing changes\n\nuser stuff';
  const split = splitSpecSections(reversed);
  assert.ok(split);
  assert.equal(split.preamble, '# T');
  assert.equal(split.technical, 'tech stuff');
  assert.equal(split.userFacing, 'user stuff');
});

test('duplicate markers: first occurrence wins', () => {
  const doc = [
    '## User-facing changes',
    'first user',
    '## Technical implementation',
    'tech',
    '## User-facing changes',
    'stray duplicate',
  ].join('\n');
  const split = splitSpecSections(doc);
  assert.ok(split);
  assert.equal(split.preamble, '');
  assert.equal(split.userFacing, 'first user');
  // The duplicate is just content inside the technical half.
  assert.ok(split.technical.includes('tech'));
  assert.ok(split.technical.includes('stray duplicate'));
});

test('no content before the first marker → empty preamble', () => {
  const split = splitSpecSections('## User-facing changes\nu\n## Technical implementation\nt');
  assert.ok(split);
  assert.equal(split.preamble, '');
});

// ── 2. Source guards ─────────────────────────────────────────────────────

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const devChatSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'dev-chat.js'), 'utf8');

test('index.html loads spec-sections.js before the dev chat reads it', () => {
  // #1084 chunk G moved dev-chat.js into the React bundle, so there is no
  // longer a second <script> tag to compare document positions against. The
  // ordering guarantee is now the bundle's `type="module"`, which defers it
  // past every classic /js/** script — so assert the helper tag still exists
  // and that the entry is still deferred. tests/shell-script-order.test.js
  // pins the same contract shell-wide.
  const specIdx = indexHtml.indexOf('/js/spec-sections.js');
  assert.ok(specIdx !== -1, 'spec-sections.js script tag missing from index.html');
  assert.ok(!indexHtml.includes('src="/js/dev-chat.js"'),
    'dev-chat.js is bundled now (chunk G) — it must not come back as a tag');
  assert.ok(indexHtml.includes('<script type="module" src="/shell/assets/shell.js">'),
    'the React entry must stay a deferred module so DevChat sees window.splitSpecSections');
});

// #1078: the panel's MARKUP moved to features/dev-chat/spec-viewer.tsx.
// dev-chat.js keeps the split — which half is on screen is a decision, not a
// tag — and the component draws the toggle from it.
test('dev-chat.js spec viewer calls splitSpecSections and wires the tabs', () => {
  assert.ok(devChatSrc.includes('splitSpecSections(displayContent)'),
    '_specViewerView must split the displayed content');
  assert.ok(devChatSrc.includes("activeTab: 'user'"), 'activeTab must default to the user-facing half');
  assert.ok(devChatSrc.includes("kind: 'split'"), 'the split reaches the component as its own body kind');
  const viewerTsx = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'spec-viewer.tsx'),
    'utf8'
  );
  assert.ok(viewerTsx.includes('dc-spec-viewer-tab'), 'tab markup missing');
  assert.ok(viewerTsx.includes('data-spec-tab'), 'each tab still names the half it selects');
});

// ── 3. Prompt guard ──────────────────────────────────────────────────────

test('scout prompt mandates the exact marker headings the splitter keys on', () => {
  const sessionsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'sessions.js'), 'utf8');
  assert.ok(sessionsSrc.includes('## User-facing changes'), 'scout prompt missing the user-facing marker');
  assert.ok(sessionsSrc.includes('## Technical implementation'), 'scout prompt missing the technical marker');
  // And the splitter recognizes exactly what the prompt mandates.
  const split = splitSpecSections('## User-facing changes\nu\n## Technical implementation\nt');
  assert.ok(split && split.userFacing === 'u' && split.technical === 't');
});
