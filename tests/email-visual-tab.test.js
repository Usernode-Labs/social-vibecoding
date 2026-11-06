'use strict';

// frontend/src/features/admin/email-templates/visual-tab.tsx: the Visual tab
// of the email editor, where an admin retypes an email's text in place.
// It draws a decorated copy of the HTML in a script-less iframe and splices
// each edited block back into the source through ./html-runs.ts, so what was
// not touched keeps every byte.
//
// Effects and the browser's editing do not run under node, so the DOM side is
// split into pure steps that are tested here on all 13 seeds and the layout:
// decorating, reading a block back from the DOM's HTML, splicing it, pasting.
// tests/admin-email-templates-section.test.js pins how the editors use it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { KINDS } = require('../src/services/mail/templates');
const { englishTemplate, seededLayout } = require('../src/db/email-template-seeds');

const ROOT = path.join(__dirname, '..');
const FILE = 'frontend/src/features/admin/email-templates/visual-tab.tsx';
const ADMIN_UI = new Proxy({}, {
  get: (_t, key) => (['btn', 'badge'].includes(key) ? new Proxy({}, { get: (_u, k) => `${key}-${String(k)}` }) : String(key)),
});
const visual = loadTsx(FILE, { stubs: { '../admin-console.js': { AdminUI: ADMIN_UI } } });
const runs = loadTsx('frontend/src/features/admin/email-templates/html-runs.ts');

const SOURCES = [
  ...['waitlist_released', ...KINDS.filter((k) => k !== 'waitlist_released')].map((kind) => [kind, englishTemplate(kind).html]),
  ['layout: Homeroom standard', seededLayout('Homeroom standard').html],
];

// The editable blocks' inner HTML as the decorated document carries it.
function decoratedInners(decorated) {
  const out = [];
  const re = /data-hr-block="(\d+)"[^>]*>/g;
  let m;
  while ((m = re.exec(decorated))) out.push({ index: Number(m[1]), at: m.index + m[0].length });
  return out;
}

test('opening and saving with no edit sends source unchanged', () => {
  for (const [name, source] of SOURCES) {
    const decorated = visual.decorate(source, { editable: true });
    // Everything the decoration adds comes off again, byte for byte.
    assert.equal(visual.undecorate(decorated), source, name);
    const model = visual.openModel(source);
    assert.equal(decoratedInners(decorated).length, model.blocks.length, `${name}: every block is drawn editable`);
    // A block read back untouched is the block as it was.
    model.blocks.forEach((block, i) => {
      const inner = visual.chipify(block.html);
      assert.equal(visual.fromEditorHtml(inner), block.html, `${name}: ${block.html}`);
      assert.equal(visual.applyBlockEdit(model, i, block.html, []).source, source, name);
      assert.equal(visual.readEdit(inner, inner, block.html), block.html, 'the browser\'s own spelling of an unedited block is not an edit');
    });
  }
  // Rendered, the tab changes nothing until someone types.
  let calls = 0;
  const source = englishTemplate('waitlist_released').html;
  const html = renderToHtml(createElement(visual.VisualTab, {
    source, opened: source, onChange() { calls += 1; }, placeholders: [], readOnly: false,
  }));
  assert.equal(calls, 0);
  assert.match(html, /<iframe[^>]*sandbox="allow-same-origin"/);
  assert.doesNotMatch(html, /allow-scripts/);
  assert.match(html, /srcDoc=|srcdoc=/i);
  assert.match(html, /data-hr-block=&quot;0&quot;/, 'the frame is drawn with its blocks marked');
});

test('chips serialize back to {{name}}', () => {
  assert.equal(visual.chipHtml('why'), '<span data-hr-chip="why" contenteditable="false" class="hr-chip">why</span>');
  assert.equal(visual.fromEditorHtml(`Homeroom<br>${visual.chipHtml('why')}`), 'Homeroom<br>{{why}}');
  // As a browser may hand it back: attributes moved, the chip wrapped in bold,
  // its shown text changed.
  assert.equal(visual.fromEditorHtml('A <b><span class="hr-chip" contenteditable="false" data-hr-chip="code">x</span></b>.'), 'A <b>{{code}}</b>.');
  assert.equal(visual.fromEditorHtml('<span contenteditable="false" data-hr-chip="a" class="hr-chip">a</span>'), '{{a}}');
  // A span is a chip only with the editor's own markers: the email's own
  // markup that happens to carry data-hr-chip stays markup.
  assert.equal(visual.fromEditorHtml('<span data-hr-chip="b">b</span>'), '<span data-hr-chip="b">b</span>');
  assert.equal(visual.fromEditorHtml('<span data-hr-chip="b" class="hr-chip">b</span>'), '<span data-hr-chip="b" class="hr-chip">b</span>');
  // Conditions are labels outside every block; read back, they are the marker.
  const decorated = visual.decorate('{{#if x}}<p>Hi {{name}}</p>{{else}}<p>Bye</p>{{/if}}', { editable: true });
  assert.match(decorated, /Shown only when x/);
  assert.match(decorated, />Otherwise</);
  assert.equal(visual.undecorate(decorated), '{{#if x}}<p>Hi {{name}}</p>{{else}}<p>Bye</p>{{/if}}');
  // A structure block (a condition inside) is outlined and labelled, never editable.
  const structure = visual.decorate('<p>Hi {{#if x}}there{{/if}}</p>', { editable: true });
  assert.match(structure, /<p data-hr-structure="" title="[^"]+">/);
  // The editor's attributes come right after the tag name, so they win over
  // the email's own of the same name.
  const own = visual.decorate('<p title="mine" contenteditable="false">Hi</p>', { editable: true });
  assert.match(own, /^<p data-hr-block="0" contenteditable="true" [^>]*title="mine" contenteditable="false">Hi<\/p>$/);
  assert.equal(visual.undecorate(own), '<p title="mine" contenteditable="false">Hi</p>');
  assert.doesNotMatch(structure, /contenteditable="true"/);
});

test('paste strips markup', () => {
  const clipboard = (types) => ({ getData: (type) => types[type] || '' });
  const pasted = visual.pastedHtml(clipboard({ 'text/html': '<b>Bold</b><script>x()</script>', 'text/plain': 'Bold & <b>x</b>\r\nNext line' }));
  assert.equal(pasted, 'Bold &amp; &lt;b&gt;x&lt;/b&gt;<br>Next line');
  assert.equal(visual.pastedHtml(clipboard({ 'text/html': '<p>Only HTML</p>' })), '', 'HTML is never read');
  const src = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
  assert.match(src, /addEventListener\('paste'/);
  assert.doesNotMatch(src, /getData\('text\/html'\)/);
});

test('a block edit reaches onChange with only that range changed', () => {
  const source = englishTemplate('waitlist_released').html;
  let model = visual.openModel(source);
  const headline = model.blocks.findIndex((b) => b.html === 'Make and share apps with groups and friends.');
  const chip = model.blocks.findIndex((b) => b.html === 'Use and improve apps together');
  assert.ok(headline >= 0 && chip > headline);
  const before = model.blocks[headline];
  model = visual.applyBlockEdit(model, headline, 'Make apps <b>together</b>.', []);
  assert.equal(model.source, source.slice(0, before.start) + 'Make apps <b>together</b>.' + source.slice(before.end));
  // A later block, read after the first edit shifted it, changes only its own range.
  const later = model.blocks[chip];
  const after = visual.applyBlockEdit(model, chip, 'Improve apps together', []);
  assert.equal(after.source, model.source.slice(0, later.start) + 'Improve apps together' + model.source.slice(later.end));
  assert.ok(after.source.includes('<td style="font-size:15px;line-height:1.4;padding:0 12px 0 8px;color:#1c1c1e">Improve apps together</td>'));
  // A chip's placeholder stays: an edit that drops it is refused.
  const layout = visual.openModel(seededLayout('Homeroom standard').html);
  const footer = layout.blocks.findIndex((b) => b.html === 'Homeroom<br>{{why}}');
  assert.throws(() => visual.applyBlockEdit(layout, footer, 'Homeroom', []), /drops \{\{why\}\}/);
  // Inserting an allowed placeholder at the caret is an edit like any other.
  const content = visual.openModel(englishTemplate('content_report').html);
  const first = content.blocks[0];
  const withUrl = visual.applyBlockEdit(content, 0, `${first.html} ${visual.fromEditorHtml(visual.chipHtml('url'))}`, ['url']);
  assert.ok(withUrl.source.startsWith(`<p>${first.html} {{url}}</p>`));
});

test('links take a web address or a link placeholder, and a button goes after the block', () => {
  assert.equal(visual.linkProblem('https://x.test/a', null), null);
  assert.equal(visual.linkProblem('', 'url'), null);
  assert.match(visual.linkProblem('javascript:alert(1)', null), /http/);
  assert.match(visual.linkProblem('x.test', null), /http/);
  const source = englishTemplate('password_reset').html;
  const model = visual.openModel(source);
  const snippet = visual.buttonSnippet('{{url}}', 'Reset <now>');
  assert.match(snippet, /^<p><a href="\{\{url\}\}" style="display:inline-block;[^"]*">Reset &lt;now&gt;<\/a><\/p>$/);
  const next = runs.insertAfterBlock(source, model.blocks[0], snippet);
  assert.equal(next, source.slice(0, model.blocks[0].outerEnd) + snippet + source.slice(model.blocks[0].outerEnd));
});

test('the toolbar offers what the brief lists, labelled, with Image opening its panel', () => {
  const source = englishTemplate('otp').html;
  const html = renderToHtml(createElement(visual.VisualTab, {
    source, opened: source, onChange() {},
    placeholders: [{ name: 'code', description: 'The code' }, { name: 'hasUrl', description: 'flag', kind: 'flag' }, { name: 'url', description: 'link', kind: 'url' }],
  }));
  for (const label of ['Bold', 'Italic', 'Link', 'Button', 'Image', 'Insert placeholder', 'Placeholder to insert', 'Revert to opened']) {
    assert.match(html, new RegExp(`aria-label="${label}"|>${label}<`), label);
  }
  // Image is a working button now: it opens the panel (tests/email-image-panel.test.js).
  assert.match(html, /<button[^>]*aria-label="Image" aria-expanded="false"/);
  assert.doesNotMatch(html, /aria-label="Image"[^>]*aria-disabled/);
  assert.doesNotMatch(html, /next part/);
  // Choosing a placeholder does nothing by itself: the Insert button inserts it.
  assert.match(html, /<select[^>]*aria-label="Placeholder to insert"/);
  assert.match(html, /<button[^>]*aria-label="Insert placeholder"[^>]*disabled=""/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, FILE), 'utf8'), /onChange=\{\(ev\) => insertPlaceholder/);
  assert.match(html, /<option value="code">/);
  assert.doesNotMatch(html, /<option value="hasUrl">/, 'a flag is for conditions, not text');
  const insertSelect = html.match(/<select[^>]*aria-label="Placeholder to insert"[\s\S]*?<\/select>/)[0];
  assert.doesNotMatch(insertSelect, /<option value="url">/, 'a link goes in through Link, as a whole href, never as loose text');
  assert.match(html, /flex-wrap/, 'the toolbar wraps on a phone');
  const readOnly = renderToHtml(createElement(visual.VisualTab, { source, opened: source, onChange() {}, placeholders: [], readOnly: true }));
  assert.doesNotMatch(readOnly, /aria-label="Bold"/);
  assert.doesNotMatch(readOnly, /contenteditable=&quot;true&quot;/);
});

test('going back to what was opened draws the frame again, even when its document is the same as before', () => {
  // A frame handed the srcdoc it already has keeps its edited DOM, so Revert
  // would show edits that are gone. Each redraw remounts the frame instead.
  const src = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
  assert.match(src, /<iframe key=\{drawn\.count\}/);
  assert.match(src, /count: d\.count \+ 1/);
  assert.match(src, /onClick=\{\(\) => \{ setNotice\(null\); onChange\(opened\); \}\}/);
});

test('a block wholly inside a condition stays editable, outlined and labelled with that condition', () => {
  const source = '<p>Always</p>{{#if a}}<p>When a</p>{{#unless b}}<p>A, not b</p>{{/unless}}{{else}}<p>Not a</p>{{/if}}<p>After</p>';
  const decorated = visual.decorate(source, { editable: true });
  const opening = (text) => decorated.match(new RegExp(`<p [^>]*>${text}<`))[0];
  assert.doesNotMatch(opening('Always'), /data-hr-in-cond/);
  assert.match(opening('When a'), /contenteditable="true"/);
  assert.match(opening('When a'), /data-hr-in-cond="Shown only when a" title="Shown only when a"/);
  assert.match(opening('A, not b'), /data-hr-in-cond="Shown only when a and not b"/);
  assert.match(opening('Not a'), /data-hr-in-cond="Shown only when not a"/);
  assert.doesNotMatch(opening('After'), /data-hr-in-cond/);
  assert.equal(visual.undecorate(decorated), source);
  // In the seeds: waitlist_released's account line sits inside {{#if hasAccount}}.
  const released = visual.decorate(englishTemplate('waitlist_released').html, { editable: true });
  assert.match(released, /data-hr-in-cond="Shown only when hasAccount"[^>]*>Your account now has access\./);
  // The frame's stylesheet outlines them and shows the label.
  const src = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
  assert.match(src, /\[data-hr-in-cond\]\{outline:1px dashed/);
  assert.match(src, /\[data-hr-in-cond\]::before\{content:attr\(data-hr-in-cond\)/);
  for (const [name, seed] of SOURCES) assert.equal(visual.undecorate(visual.decorate(seed, { editable: true })), seed, name);
});

test('reading a block back: an accepted edit moves the model, a refused one says why and restores the block', () => {
  const source = seededLayout('Homeroom standard').html;
  const model = visual.openModel(source);
  const i = model.blocks.findIndex((b) => b.html === 'Homeroom<br>{{why}}');
  const shown = visual.chipify(model.blocks[i].html);
  // Untouched: the same model, nothing to emit.
  assert.deepEqual(visual.blockInput(model, i, shown, shown, []), { model });
  // Typed into.
  const typed = visual.blockInput(model, i, `The ${shown}`, shown, []);
  assert.equal(typed.model.source, source.replace('>Homeroom<br>{{why}}<', '>The Homeroom<br>{{why}}<'));
  // The chip deleted some way the guards missed: refused, with the block as the source has it.
  const refused = visual.blockInput(model, i, 'Homeroom<br>', shown, []);
  assert.match(refused.refused, /drops \{\{why\}\}/);
  assert.equal(refused.restore, shown);
  assert.equal(refused.model, undefined);
  // The DOM side uses exactly this, and restores with what it returns.
  const src = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
  assert.match(src, /const result = blockInput\(m, index, el\.innerHTML, baseline\.current\[index\] \?\? '', latest\.current\.allowed\);/);
  assert.match(src, /el\.innerHTML = result\.restore;/);
});

test('the frame\'s editing guards: Enter from any keyboard is a line break, composition is left alone, a stale model never splices', () => {
  const src = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
  assert.match(src, /e\.inputType === 'insertParagraph'/);
  assert.match(src, /if \(e\.isComposing\) return;/);
  assert.match(src, /ev\.key === 'Enter' && !ev\.isComposing/);
  assert.match(src, /useLayoutEffect\(\(\) => \{\s*if \(source === model\.current\.source\) return;/);
  assert.match(src, /if \(model\.current\.source !== latest\.current\.source\) return;/);
});
