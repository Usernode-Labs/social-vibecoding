'use strict';

// An agent session's spec, beside the chat and in two tabs (#2779 follow-up).
//
//   1. From 1024px up the spec is a pane BESIDE the conversation, behind a
//      divider that drags, instead of a sheet over it. In Messages the
//      conversation list steps aside while it is open. Narrower windows, and
//      the side panel beside a running app, keep the sheet.
//   2. The width is the dev chat viewer's remembered one (the same key, the
//      same default and floor), and the chat always keeps 320px.
//   3. A spec written in the platform's two halves shows as the dev chat
//      viewer's User-facing / Technical tabs, plain-language half first; any
//      other spec shows whole, as it always did.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { splitSpecSections } = require('../public/js/spec-sections.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const layout = loadTsx('frontend/src/features/agent-session/spec-layout.ts');

const TWO_HALVES = [
  '# Dark mode',
  '',
  'A toggle for the board.',
  '',
  '## User-facing changes',
  '- A toggle sits in the header.',
  '',
  '## Technical implementation',
  '- Add it beside the view switcher.',
].join('\n');

test('the width: the remembered one or 480, never under 280, and the chat keeps 320', () => {
  const { clampSpecWidth } = layout;
  assert.equal(clampSpecWidth(null, 1200), 480, 'the dev chat viewer\'s default');
  assert.equal(clampSpecWidth(600, 1200), 600);
  assert.equal(clampSpecWidth(900, 1000), 676, 'the chat beside it keeps 320px, after the 4px divider');
  assert.equal(clampSpecWidth(120, 1200), 280, 'never under the floor');
  assert.equal(clampSpecWidth(-320, 1200), 280, 'a drag past zero stops at the floor, not at the default');
  assert.equal(clampSpecWidth(500, 400), 280, 'the floor wins in a container too narrow for both');
  assert.equal(clampSpecWidth(Number.NaN, null), 480, 'a garbled stored value is the default');
  assert.equal(clampSpecWidth(2000, null), 2000, 'unmeasured, CSS holds the ceiling');
  assert.equal(layout.SPEC_WIDTH_KEY, 'dc-spec-viewer-width-v1', 'one layout preference with the dev chat viewer');
  assert.equal(layout.SPEC_BESIDE_QUERY, '(min-width: 1024px)', 'the dev chat viewer\'s own breakpoint');
});

test('the split is the dev chat viewer\'s, and anything it cannot split shows whole', () => {
  const split = layout.splitSpec(TWO_HALVES, splitSpecSections);
  assert.deepEqual(split, {
    preamble: '# Dark mode\n\nA toggle for the board.',
    userFacing: '- A toggle sits in the header.',
    technical: '- Add it beside the view switcher.',
  });
  assert.equal(layout.splitSpec('# Spec\n\n## Goal\nDo it.', splitSpecSections), null, 'no markers: whole');
  assert.equal(layout.splitSpec(TWO_HALVES, null), null, 'no splitter on the page: whole');
  assert.equal(layout.splitSpec(TWO_HALVES, () => { throw new Error('boom'); }), null, 'a failing splitter: whole');
  assert.match(read('frontend/src/features/agent-session/spec-layout.ts'), /window as unknown as \{ splitSpecSections\?: Splitter \}\)\.splitSpecSections/,
    'the page\'s own copy, the one the dev chat viewer calls');
});

test('two halves are two tabs, plain-language first; one half empty says so; one half is never both', () => {
  const api = loadTsx('tests/fixtures/agent-session-api.ts');
  const split = splitSpecSections(TWO_HALVES);
  const render = (props) => renderToHtml(createElement(api.SpecBody, { text: TWO_HALVES, split, onTab: () => {}, ...props }));

  const user = render({ tab: 'user' });
  assert.match(user, /class="dc-spec-viewer-preamble"[\s\S]*A toggle for the board/, 'the title and summary above the tabs');
  assert.match(user, /class="dc-spec-viewer-tabs" role="tablist" aria-label="Spec sections"/);
  assert.match(user, /aria-selected="true" class="dc-spec-viewer-tab dc-spec-viewer-tab-active" data-spec-tab="user">User-facing</);
  assert.match(user, /aria-selected="false" class="dc-spec-viewer-tab" data-spec-tab="tech">Technical</);
  assert.match(user, /data-agent-session-spec-half="user"[\s\S]*A toggle sits in the header/);
  assert.doesNotMatch(user, /beside the view switcher/, 'the technical half waits behind its tab');

  const tech = render({ tab: 'tech' });
  assert.match(tech, /data-agent-session-spec-half="tech"[\s\S]*beside the view switcher/);
  assert.doesNotMatch(tech, /A toggle sits in the header/);

  const empty = render({ tab: 'tech', split: { ...split, technical: '' } });
  assert.match(empty, /class="dc-spec-tab-empty">Nothing in this section\./);

  const whole = renderToHtml(createElement(api.SpecBody, { text: '# Spec\n\n## Goal', split: null, tab: 'user', onTab: () => {} }));
  assert.doesNotMatch(whole, /role="tablist"/);
  assert.match(whole, /data-agent-session-spec-text=""[^>]*># Spec/, 'a spec in no halves shows whole, as it always did');
});

test('the tab survives a version switch and starts on the plain-language half for another change', async () => {
  const spec = { 12: TWO_HALVES, 13: '# Other' };
  globalThis.fetch = async (url) => {
    const m = /^\/api\/sessions\/(\d+)\/spec$/.exec(url);
    const body = m ? { spec: spec[m[1]], versions: [{ version: 2 }, { version: 1 }] }
      : /\/specs\/1$/.test(url) ? { spec: { version: 1, content: '# First draft' } }
        : {};
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    const api = loadTsx('tests/fixtures/agent-session-api.ts');
    await api.openSpec(12);
    assert.equal(api.getAgentSessionState().specSheet.tab, 'user', 'plain-language half first');
    api.setSpecTab('tech');
    assert.equal(api.getAgentSessionState().specSheet.tab, 'tech');
    await api.openSpec(12, 1);
    const older = api.getAgentSessionState().specSheet;
    assert.deepEqual([older.version, older.text, older.tab], [1, '# First draft', 'tech'], 'kept across a version switch');
    await api.openSpec(13);
    assert.equal(api.getAgentSessionState().specSheet.tab, 'user', 'another change starts on the first tab');
    api.closeSpec();
    api.setSpecTab('tech');
    assert.equal(api.getAgentSessionState().specSheet, null, 'no sheet, nothing to switch');
  } finally {
    delete globalThis.fetch;
  }
});

test('beside from 1024px up, decided after mount; the list steps aside; the divider drags and keys', () => {
  const panel = read('frontend/src/features/agent-session/index.tsx');
  const specLayout = read('frontend/src/features/agent-session/spec-layout.ts');
  assert.match(specLayout, /const \[wide, setWide\] = useState\(false\);/, 'false in the prerender and the hydrating render');
  assert.match(specLayout, /return wide && snapshot\.open && snapshot\.host === host && !!snapshot\.specSheet;/);
  assert.match(panel, /const beside = useSpecBeside\(embedded \? 'messages' : 'screen'\);/);
  assert.match(panel, /\? <SpecBesidePane sheet=\{snapshot\.specSheet\} containerRef=\{root\} \/>\s*: <SpecSheet sheet=\{snapshot\.specSheet\} \/>/,
    'beside when there is room, the sheet otherwise');
  assert.match(panel, /data-agent-session-chat>[\s\S]*<ChangesDrawer[\s\S]*<\/div>\s*\{snapshot\.specSheet/,
    'the changes drawer covers the chat, not the spec beside it');
  assert.match(panel, /role="separator"\s+aria-orientation="vertical"\s+aria-label="Resize the spec"/);
  assert.match(panel, /min-w-\[280px\] max-w-\[calc\(100%-324px\)\]/, 'CSS holds the same bounds (320px of chat, 4px of divider) when the window narrows');
  assert.match(panel, /className="w-1 shrink-0 cursor-col-resize/, 'the divider is the 4px the ceiling allows for');
  assert.match(panel, /useEffect\(\(\) => \{ setWidth\(clampSpecWidth\(readSpecWidth\(\), containerWidth\(\)\)\); \}, \[\]\);/,
    'the stored width is read after mount, never during render');
  assert.match(panel, /const onUp = \(\) => \{[\s\S]*writeSpecWidth\(latest\);/, 'remembered when the drag ends');
  assert.match(panel, /event\.key !== 'ArrowLeft' && event\.key !== 'ArrowRight'/, 'and the arrow keys move it');

  const messages = read('frontend/src/features/messages/index.tsx');
  assert.match(messages, /const specBeside = useSpecBeside\('messages'\);/);
  assert.match(messages, /className=\{`messages-list-pane \$\{specBeside \? 'hidden' : /, 'the list steps aside while it is open');
});

test('the staging conversation\'s spec is written in the two halves, so its tabs can be seen there', () => {
  const migrate = read('src/db/migrate.js');
  const block = migrate.slice(migrate.indexOf('const STAGING_AGENT_SPEC = ['), migrate.indexOf("].join('\\n');", migrate.indexOf('const STAGING_AGENT_SPEC = [')));
  const lines = [...block.matchAll(/^\s+'(.*)',$/gm)].map((m) => m[1].replace(/\\'/g, "'"));
  const split = splitSpecSections(lines.join('\n'));
  assert.ok(split && split.userFacing && split.technical, 'both halves, both non-empty');
  assert.match(migrate, /\(\$1, 2, \$3, NOW\(\) - INTERVAL '3 minutes'\)\s+ON CONFLICT \(session_id, version\) DO UPDATE SET content = EXCLUDED\.content/,
    'a preview seeded before this picks up the new text');
});
