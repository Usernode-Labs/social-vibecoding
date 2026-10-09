// HTML specs (#3699): the viewer, the capture path and the safety rules.
//
// The proposal card's before/after viewer is now a shared builder
// (AppView._shotsViewerHtml); the card's own markup is pinned by
// tests/shots-ui.test.js and must not move. These tests pin what the spec
// adds on top (side by side, side by side by default when there is room,
// close-up / whole screen), how a spec author's final message is stored, the
// per-app setting that asks for HTML, and the rules the browser half
// (frontend/src/lib/spec-html.ts) holds an author's markup to.
//
// Run with: node --test tests/spec-html-viewer.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AppView = require('../public/js/app-view.js');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function screens() {
  return [
    { viewport: 'desktop', afterHtml: '<span class="a-side"></span>', beforeHtml: '<span class="b-side"></span>', afterChip: 'After · planned', beforeChip: 'Before · today', notesHtml: '<div>notes</div>', zoomable: true },
    { viewport: 'phone', afterHtml: '<span></span>', beforeHtml: '<span></span>', notesHtml: '', zoomable: false },
    { viewport: 'phone', afterHtml: '<span></span>', beforeHtml: '<span></span>', notesHtml: '', zoomable: true },
  ];
}

test('the shared viewer, with the card\'s options, is the card\'s markup: two side radios, After checked', () => {
  const html = AppView._shotsViewerHtml({ key: 7, screens: screens() });
  const picks = html.match(/<input type="radio" class="shots-side-pick[^>]*>/g) || [];
  assert.equal(picks.length, 2);
  assert.match(picks[1], /shots-side-after" name="shots-7-side" id="shots-7-side-after" aria-label="Show the screen after the change" checked>$/);
  assert.doesNotMatch(html, /shots-seg-both|shots-zoom-pick|shots-side-auto/);
  assert.match(html, /^<div class="shots-viewer">/);
  assert.equal(AppView._shotsViewerHtml({ key: 7, screens: [] }), '', 'no screens, no viewer');
});

test('a spec\'s viewer adds side by side, starts on auto, and offers close-up only where a screen has one', () => {
  const html = AppView._shotsViewerHtml({ key: 'spec-dc-9-2-0', screens: screens(), sideBySide: true, autoSide: true, zoom: true, className: 'shots-viewer-spec' });
  assert.match(html, /^<div class="shots-viewer shots-viewer-spec">/);
  const picks = html.match(/<input type="radio" class="shots-side-pick[^>]*>/g) || [];
  assert.deepEqual(picks.map((p) => /shots-side-(before|after|both|auto)/.exec(p)[1]), ['before', 'after', 'both', 'auto']);
  assert.doesNotMatch(picks[1], /checked/, 'After is not the start on a spec');
  assert.match(picks[3], / checked>$/, 'auto is');
  // Every screen's side switch has the third option.
  assert.equal((html.match(/class="shots-seg-btn shots-seg-both"/g) || []).length, 3);
  assert.match(html, /<label for="shots-spec-dc-9-2-0-side-both" class="shots-seg-btn shots-seg-both" title="Side by side">/);
  // One pair of zoom radios, Close-up first, and a zoom switch only on screens with a close-up.
  assert.match(html, /class="shots-zoom-pick shots-zoom-close" name="shots-spec-dc-9-2-0-zoom" id="shots-spec-dc-9-2-0-zoom-close" aria-label="Show a close-up of what changes" checked>/);
  assert.equal((html.match(/class="shots-seg shots-seg-zoom"/g) || []).length, 2);
  // The spec's chips, escaped by the builder.
  assert.match(html, /shots-flip-chip-after">After · planned</);
  assert.match(html, /shots-flip-chip-before">Before · today</);
  // The stepper is still the last thing in each bar.
  for (const bar of html.match(/<div class="shots-bar">[\s\S]*?<\/div>/g)) {
    assert.match(bar, /<span class="shots-screen-nav"[\s\S]*<\/span><\/div>$/);
  }
  assert.doesNotMatch(html, /<script|onclick|onchange/, 'still radios and labels');
});

test('the viewer CSS: the card\'s rules are untouched; side by side, auto and zoom are added beside them', () => {
  const css = read('public/css/app.css');
  assert.match(css, /\.shots-stage > \.shots-flip-side \{[^}]*width: min\(100cqw, calc\(100cqh \* \(var\(--shots-shape, 16 \/ 10\)\)\)\); aspect-ratio: var\(--shots-shape, 16 \/ 10\);/);
  assert.match(css, /\.shots-viewer:has\(\.shots-side-both:checked\) \.shots-stage \{ grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\);/);
  assert.match(css, /\.shots-viewer:has\(\.shots-side-both:checked\) \.shots-stage > \.shots-flip-after \{ grid-area: 1 \/ 2; \}/);
  // Auto: After with no room, side by side with room, per screen size.
  assert.match(css, /@container \(max-width: 419\.98px\) \{\s*\.shots-viewer:has\(\.shots-side-auto:checked\) \.shots-view\[data-shots-viewport="phone"\] \.shots-flip-before \{ visibility: hidden; \}/);
  assert.match(css, /@container \(min-width: 420px\) \{\s*\.shots-viewer:has\(\.shots-side-auto:checked\) \.shots-view\[data-shots-viewport="phone"\] \.shots-stage \{ grid-template-columns/);
  assert.match(css, /@container \(max-width: 719\.98px\) \{\s*\.shots-viewer:has\(\.shots-side-auto:checked\) \.shots-view\[data-shots-viewport="desktop"\]/);
  assert.match(css, /@container \(min-width: 720px\) \{\s*\.shots-viewer:has\(\.shots-side-auto:checked\) \.shots-view\[data-shots-viewport="desktop"\]/);
  assert.match(css, /\.spec-frame-side > iframe \{[^}]*transform-origin: 0 0; pointer-events: none;/);
});

test('captureSpecOutput: markdown as it always was; an HTML spec as its markdown copy plus the document', () => {
  const { captureSpecOutput } = require('../src/routes/sessions.js');
  assert.deepEqual(captureSpecOutput('```markdown\n# T\n\n## User-facing changes\n\n- a\n```'), {
    text: '# T\n\n## User-facing changes\n\n- a', html: null,
  });
  const doc = '<article data-spec><h1>T</h1><section data-spec-tab="user"><p>See it.</p></section><section data-spec-tab="tech"><p>Build it.</p></section></article>';
  const captured = captureSpecOutput(`\`\`\`html\n${doc}\n\`\`\``);
  assert.equal(captured.html, doc);
  assert.equal(captured.text, '# T\n\n## User-facing changes\n\nSee it.\n\n## Technical implementation\n\nBuild it.');
  assert.deepEqual(captureSpecOutput(''), { text: '', html: null });
});

test('the setting: HTML specs for every app by default; a list of slugs or `none` otherwise', () => {
  const { htmlSpecsEnabledFor } = require('../src/services/spec-html.js');
  assert.equal(htmlSpecsEnabledFor({ htmlSpecApps: ['usernode-2d5619'] }, 'usernode-2d5619'), true);
  assert.equal(htmlSpecsEnabledFor({ htmlSpecApps: ['usernode-2d5619'] }, 'todo-list-b91765'), false);
  assert.equal(htmlSpecsEnabledFor({ htmlSpecApps: ['*'] }, 'todo-list-b91765'), true);
  assert.equal(htmlSpecsEnabledFor({ htmlSpecApps: [] }, 'usernode-2d5619'), false);
  assert.equal(htmlSpecsEnabledFor({}, 'usernode-2d5619'), false);
  const configSrc = read('src/config.js');
  assert.match(configSrc, /htmlSpecApps: \(\(\) => \{\s*const raw = process\.env\.HTML_SPEC_APPS;\s*if \(raw == null \|\| raw\.trim\(\) === ''\) return \['\*'\];\s*if \(raw\.trim\(\)\.toLowerCase\(\) === 'none'\) return \[\];/);
});

test('the scout is asked for HTML on apps in the setting, with the right stylesheet, and an HTML spec is revised as HTML', () => {
  const src = read('src/routes/sessions.js');
  assert.match(src, /const htmlSpec = specHtml\.htmlSpecsEnabledFor\(config, session\.app_slug\);/);
  assert.match(src, /const existingShown = htmlSpec && existingDoc\.html \? existingDoc\.html\.trim\(\) : existingSpec;/);
  assert.match(src, /produce \$\{htmlSpec \? 'an HTML SPEC' : 'a MARKDOWN SPEC'\} for the change/);
  assert.match(src, /\$\{htmlSpec \? specHtmlContract\(platformStyles\) : `The spec is rendered as markdown/);
  assert.match(src, /const platformStyles = specHtml\.specStylesFor\(\{ slug: session\.app_slug, self_hosted: session\.app_self_hosted \}\) === 'platform';/);
  // Each capture site stores the document beside its markdown copy.
  assert.equal((src.match(/const capturedSpec = captureSpecOutput\(result\.lastResultText\);/g) || []).length, 2);
  assert.equal((src.match(/contentHtml: capturedSpec\.html,/g) || []).length, 2);
  assert.match(read('server.js'), /contentHtml: capturedSpec\.html,/);
  const { SPEC_HTML_CONTRACT } = require('../src/services/prompts.js');
  for (const rule of ['<article data-spec>', '<section data-spec-tab="user">', '<figure data-screens>', 'data-side="before"', 'data-change="N"', 'data-focus="x y w h"', 'scripts off and no network', 'spec-box-new']) {
    assert.ok(SPEC_HTML_CONTRACT.includes(rule), `the contract names ${rule}`);
  }
});

test('the browser half holds an author\'s markup to the rules: prose sanitised, screens sandboxed and offline', () => {
  const src = read('frontend/src/lib/spec-html.ts');
  // Screens: a sandbox with no tokens at all, and a policy that loads nothing off this site.
  assert.match(src, /<iframe sandbox="" referrerpolicy="no-referrer"/);
  assert.doesNotMatch(src, /allow-scripts|allow-same-origin|allow-forms|allow-popups|allow-top-navigation/);
  assert.match(src, /const csp = `default-src 'none'; style-src 'unsafe-inline' \$\{origin\}; img-src data: \$\{origin\}; font-src data: \$\{origin\}`;/);
  assert.match(src, /const SCREEN_DROP = 'script,noscript,iframe,frame,frameset,object,embed,applet,base,meta,link,portal,template';/);
  // A screen loads only once it is the one showing.
  assert.match(src, /if \(showing && !frame\.getAttribute\('srcdoc'\) && frame\.dataset\.srcdoc\) frame\.setAttribute\('srcdoc', frame\.dataset\.srcdoc\);/);
  // Prose: a fixed list, no styles, scripts, ids or data attributes, and only the spec's own classes.
  const tags = /const PROSE_TAGS = \[([\s\S]*?)\];/.exec(src)[1];
  for (const banned of ['script', 'style', 'iframe', 'img', 'input', 'form', 'foreignObject', 'use', 'image']) {
    assert.ok(!new RegExp(`'${banned}'`).test(tags), `${banned} is not prose`);
  }
  const attrs = /const PROSE_ATTRS = \[([\s\S]*?)\];/.exec(src)[1];
  for (const banned of ['style', 'id', 'src', 'xlink:href', 'onload']) {
    assert.ok(!new RegExp(`'${banned}'`).test(attrs), `${banned} is not a prose attribute`);
  }
  assert.match(src, /ALLOW_DATA_ATTR: false,/);
  assert.match(src, /\.filter\(\(c\) => \/\^spec-\[a-z0-9-\]\+\$\/\.test\(c\)\)/);
});

test('the three surfaces render an HTML spec from its document and keep copying the markdown', () => {
  const devChat = read('frontend/src/features/dev-chat/dev-chat.js');
  assert.match(devChat, /DevChat\.specViewer\.draftHtml = data\.html \|\| null;/);
  assert.match(devChat, /DevChat\.specViewer\.viewVersionHtml = data\.spec\.content_html \|\| null;/);
  assert.match(devChat, /raw: displayContent,/, 'Copy markdown still copies the markdown');
  const groupChat = read('public/js/group-chat.js');
  assert.equal((groupChat.match(/html: data\.spec\.content_html \|\| null,/g) || []).length, 2);
  assert.match(groupChat, /GroupChat\._specPanelRaw = content == null \? '' : String\(content\);/);
  const pane = read('frontend/src/features/agent-session/index.tsx');
  assert.match(pane, /sheet\.html \? renderSpecHtml\(sheet\.html, \{ key: `as-\$\{sheet\.changeId\}-\$\{sheet\.version \?\? 'latest'\}` \}\) : null/);
  for (const file of ['frontend/src/features/dev-chat/spec-viewer.tsx', 'frontend/src/features/group-chat/spec-panel.tsx', 'frontend/src/features/agent-session/index.tsx']) {
    assert.match(read(file), /useSpecFrames\(ref, /, `${file} fits the screens`);
  }
});

test('every app writes HTML specs; the platform\'s screens draw with its stylesheet, every other app\'s with the native kit', async () => {
  const { specStylesFor, stampSpecStyles } = require('../src/services/spec-html.js');
  assert.equal(specStylesFor({ slug: 'usernode-2d5619', self_hosted: false }), 'platform');
  assert.equal(specStylesFor({ slug: 'my-fork-app', self_hosted: true }), 'platform');
  assert.equal(specStylesFor({ slug: 'todo-list-b91765', self_hosted: false }), 'kit');
  assert.equal(specStylesFor(null), 'kit', 'an app that cannot be read never borrows the shell\'s styles');
  assert.equal(stampSpecStyles('<article data-spec><h1>T</h1></article>', 'kit'), '<article data-spec-styles="kit" data-spec><h1>T</h1></article>');
  assert.equal(stampSpecStyles('<article data-spec-styles="platform" data-spec>', 'kit'), '<article data-spec-styles="kit" data-spec>', 'an author cannot pick the platform\'s styles');
  assert.equal(stampSpecStyles('<article data-spec>', 'other'), '<article data-spec>');

  // The publication stamps it from the session's app.
  const { persistScoutPublication } = require('../src/routes/sessions.js');
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/SELECT a\.slug, a\.self_hosted FROM chat_sessions cs JOIN apps a/.test(sql)) return { rows: [{ slug: 'todo-list-b91765', self_hosted: false }] };
      if (/INSERT INTO chat_session_specs/.test(sql)) return { rows: [{ version: 1 }] };
      return { rows: [] };
    },
  };
  await persistScoutPublication({ pool, sessionId: 5, content: '# T\n\n## User-facing changes\n\nx', contentHtml: '<article data-spec><h1>T</h1></article>' });
  const update = calls.find((c) => /UPDATE chat_sessions SET spec_md = \$1, spec_html = \$3/.test(c.sql));
  assert.equal(update.params[2], '<article data-spec-styles="kit" data-spec><h1>T</h1></article>');
  const version = calls.find((c) => /INSERT INTO chat_session_specs/.test(c.sql));
  assert.equal(version.params[2], update.params[2], 'the version keeps the same document');
  // A markdown spec reads no app and stores no document.
  calls.length = 0;
  await persistScoutPublication({ pool, sessionId: 5, content: '# T' });
  assert.ok(!calls.some((c) => /JOIN apps a/.test(c.sql)));
  assert.equal(calls.find((c) => /UPDATE chat_sessions SET spec_md/.test(c.sql)).params[2], null);

  // The instructions say which stylesheet the screens get.
  const { specHtmlContract, SPEC_HTML_CONTRACT } = require('../src/services/prompts.js');
  assert.equal(SPEC_HTML_CONTRACT, specHtmlContract(true));
  assert.match(specHtmlContract(true), /it renders with the app's real stylesheet/);
  assert.match(specHtmlContract(false), /native UI kit stylesheet only \(native\.css, which every app shares\), not with this app's own stylesheet or Tailwind/);
  assert.match(specHtmlContract(false), /data-side="after"/);

  // The browser loads only the kit for an app's screens, and treats an unstamped document the same way.
  const lib = read('frontend/src/lib/spec-html.ts');
  assert.match(lib, /\.filter\(\(href\) => styles === 'platform' \|\| href\.startsWith\(`\$\{origin\}\/usernode-native\/`\)\)/);
  assert.match(lib, /const styles: SpecStyles = article\.getAttribute\('data-spec-styles'\) === 'platform' \? 'platform' : 'kit';/);
});

test('the Homeroom bot writes its spec as HTML where the setting says, and stores the document beside the markdown', () => {
  const live = require('../src/services/homeroom-bot-live.js');
  const html = live.specPrompt({ seed: 'SEED', buildNote: 'the plan', html: true, platformStyles: false });
  assert.match(html, /an HTML document, in the format described below/);
  assert.match(html, /native UI kit stylesheet only/);
  assert.match(html, /End the "user" section with an <h3>Assumptions<\/h3>/);
  assert.match(html, /your final message must be ONLY the HTML spec, starting with <article data-spec>/);
  assert.match(html, /BLOCKED:/, 'the one way out is the same');
  const md = live.specPrompt({ seed: 'SEED', buildNote: 'the plan' });
  assert.match(md, /ONLY the markdown spec, as raw markdown/, 'the markdown prompt is unchanged when html is off');
  const read = live.readSpec('<article data-spec><h1>Show the reason</h1><section data-spec-tab="user"><p>Now — clear</p><h3>Assumptions</h3><ul><li>x</li></ul></section><section data-spec-tab="tech"><p>t</p></section></article>');
  assert.equal(read.ok, true);
  assert.match(read.specMd, /^# Show the reason\n\n## User-facing changes\n\nNow\S* clear/);
  assert.doesNotMatch(read.specMd, /\u2014/);
  assert.match(read.specHtml, /<h1>Show the reason<\/h1>/);
  assert.doesNotMatch(read.specHtml, /\u2014/, 'no em dashes in the document either');
  assert.ok(!('specHtml' in live.readSpec('# T\n\n## User-facing changes\n\nx')), 'a markdown spec reads as it did');
  const src = read2('src/services/homeroom-bot-live.js');
  assert.match(src, /html: specHtml\.htmlSpecsEnabledFor\(config, session\.app_slug\),/);
  // #4612: the same call, and `revised` decides hadSpec, so a revised plan's
  // transcript line says the plan was revised.
  assert.match(src, /\.\.\.\(html \? \{ contentHtml: html \} : \{\}\), hadSpec: !!revised,/);
  assert.match(src, /revised = false/, 'the first plan is stored as it always was');
  function read2(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
});
