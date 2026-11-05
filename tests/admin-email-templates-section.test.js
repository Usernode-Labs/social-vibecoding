'use strict';

// Admin > Email templates (frontend/src/features/admin/admin-email-templates.tsx
// and its parts under ./email-templates/): the list of every platform email,
// the editor with its HTML and Text tabs, the layouts, and the replacement
// chooser a delete opens. The routes it reads and writes are
// src/routes/admin-email-templates.js, pinned by tests/admin-email-templates.test.js.
//
// The views are rendered with the real action list, so a new action shows up
// here without a test change. Effects do not run under a static render, so
// the parts that fetch are pinned by source and the views by their props.
//
// Run with: node --test tests/admin-email-templates-section.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ACTIONS } = require('../src/services/mail/actions');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SECTION = 'frontend/src/features/admin/admin-email-templates.tsx';
const PARTS = ['list', 'editor', 'layouts', 'replace-dialog', 'preview', 'shared', 'visual-tab', 'image-panel', 'translations']
  .map((name) => `frontend/src/features/admin/email-templates/${name}.tsx`);

const ADMIN_UI = new Proxy({}, {
  get: (_t, key) => (['btn', 'badge'].includes(key) ? new Proxy({}, { get: (_u, k) => `${key}-${String(k)}` }) : String(key)),
});

let loaded = null;
function load() {
  if (loaded) return loaded;
  globalThis.window = globalThis.window || globalThis;
  const { loadTsx } = require('./lib/render-tsx');
  loaded = loadTsx(SECTION, {
    stubs: {
      './admin-console.js': { AdminUI: ADMIN_UI },
      '../admin-console.js': { AdminUI: ADMIN_UI },
      '../../lib/legacy-portals': { mountLegacyPortal() {}, unmountLegacyPortal() {} },
    },
  });
  return loaded;
}

function render(name, props) {
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  return renderToHtml(createElement(load()[name], props));
}

// English and the twelve other languages Homeroom offers.
const OTHERS = [['fr', 'Français'], ['de', 'Deutsch'], ['es', 'Español'], ['it', 'Italiano'], ['pt-BR', 'Português'],
  ['nl', 'Nederlands'], ['pl', 'Polski'], ['ja', '日本語'], ['ko', '한국어'], ['zh-CN', '中文'], ['ar', 'العربية'], ['tr', 'Türkçe']]
  .map(([code, label]) => ({ code, label }));
const LANGUAGES = [{ code: 'en', label: 'English' }, ...OTHERS];

// The payload GET /api/admin/email-templates answers with, built from the
// real actions: one live version of each, plus an archived and a deleted one
// for otp, and two layouts (one deleted).
function payload() {
  const actions = Object.entries(ACTIONS).map(([action, a]) => ({
    action,
    label: a.label,
    englishOnly: !!a.englishOnly,
    required: a.required,
    placeholders: Object.entries(a.placeholders).map(([name, p]) => ({
      name, description: p.description, kind: p.kind, fromCode: !!p.fromCode,
    })),
  }));
  let id = 0;
  const templates = [];
  for (const { action, label } of actions) {
    templates.push({
      id: ++id, action, name: label, layout_family_id: 1, version: action === 'otp' ? 3 : 1, status: 'live',
      subject: `${label} subject`, preheader: '', why: '', html: '<p>{{code}}</p>', text: '{{code}}',
      created_by: action === 'otp' ? 7 : null, created_at: '2026-11-01T10:00:00Z', deleted_at: null,
      locales: action === 'otp' ? OTHERS.map((l) => l.code) : [],
    });
  }
  templates.push({ ...templates[0], id: 901, version: 2, status: 'archived', name: 'Sign-in code, second try', locales: [] });
  templates.push({ ...templates[0], id: 902, version: 1, status: 'archived', name: 'Sign-in code, first', layout_family_id: 2, locales: [] });
  templates.push({ ...templates[0], id: 903, version: 4, status: 'archived', name: 'Sign-in code, removed', deleted_at: '2026-11-02T10:00:00Z', locales: [] });
  return {
    actions,
    layoutPlaceholders: [
      { name: 'content', description: 'The email itself' },
      { name: 'why', description: 'Why the reader got it' },
      { name: 'preheader', description: 'The preview line' },
    ],
    languages: LANGUAGES,
    templates,
    layouts: [
      { id: 1, family_id: 1, name: 'Homeroom standard', version: 1, status: 'live', html: '{{content}}', text: '{{content}}', created_by: null, created_at: '2026-11-01T10:00:00Z', deleted_at: null, locales: [] },
      { id: 2, family_id: 2, name: 'Old frame', version: 1, status: 'archived', html: '{{content}}', text: '{{content}}', created_by: 7, created_at: '2026-10-01T10:00:00Z', deleted_at: '2026-10-05T10:00:00Z', locales: [] },
    ],
  };
}

const count = (html, re) => (html.match(re) || []).length;

test('the section is registered everywhere the console reads, inside the registry rules', () => {
  const consoleJs = read('frontend/src/features/admin/admin-console.js');
  const sections = consoleJs.slice(consoleJs.indexOf('SECTIONS: ['), consoleJs.indexOf('isOpen()'));
  assert.match(sections, /\{ key: 'email-templates', label: 'Email templates', group: 'Platform' \}/);
  assert.ok(sections.indexOf("key: 'email-templates'") > sections.indexOf("key: 'mail'"), 'beside Email delivery');
  assert.match(consoleJs, /'email-templates': 'AdminEmailTemplates'/);
  assert.match(consoleJs, /'email-templates': '<svg class="w-5 h-5 shrink-0"/, 'it has a nav icon');
  assert.ok(read('frontend/src/features/admin/sections.ts').includes("import './admin-email-templates.tsx';"));

  const src = read(SECTION);
  assert.match(src, /render\(el: Element\) \{\s*host = el;\s*mountLegacyPortal\(el, <EmailTemplatesSection \/>\);/);
  assert.match(src, /destroy\(\) \{\s*unmountLegacyPortal\(host\);\s*host = null;/);
  assert.match(src, /\(window as any\)\.AdminEmailTemplates = AdminEmailTemplates/);
  for (const file of [SECTION, ...PARTS]) {
    const part = read(file);
    assert.ok(!/@\/components\/ui/.test(part), `${file}: the console never reaches for the shell primitives`);
    assert.ok(!/target="_blank"/.test(part), `${file}: nothing opens a new tab`);
    assert.ok(!/dangerouslySetInnerHTML/.test(part), `${file}: server HTML goes only into the sandboxed frame`);
    assert.ok(!/—/.test(part), `${file}: no em dashes`);
  }

  const audit = read('scripts/audit-react-ownership.mjs');
  assert.match(audit, /\{ sel: '#admin-section-content', when: '#admin\/email-templates' \}/);
  assert.match(audit, /'#admin\/email-templates'/, 'and the audit visits the route');
});

test('lists 13 actions, one row each, with its live version, languages and when it was edited', () => {
  const data = payload();
  assert.equal(data.actions.length, 13);
  const html = render('TemplateList', {
    payload: data, canWrite: true, showArchived: false, now: Date.parse('2026-11-03T12:00:00Z'),
    onToggleArchived() {}, onNew() {}, onEdit() {}, onDelete() {}, onRestore() {}, onDeleteArchived() {},
  });
  assert.equal(count(html, /data-email-action="/g), 13);
  for (const a of data.actions) assert.ok(html.includes(a.label.replace(/&/g, '&amp;').replace(/'/g, '&#x27;')), `${a.action} is listed`);
  assert.match(html, /data-email-action="otp"[\s\S]*?Sign-in code \(OTP\)[\s\S]*?v3[\s\S]*?Live[\s\S]*?12 of 12[\s\S]*?2 days ago/);
  assert.match(html, /data-email-action="password_reset"[\s\S]*?0 of 12, 12 need translating[\s\S]*?Original/);
  assert.match(html, /data-email-action="admin_test"[\s\S]*?English only/, 'an English-only email says so');
  assert.ok(!/out of date|stale/i.test(html), 'the languages column says nothing about staleness');
  assert.match(html, />New template</);
  assert.match(html, /Show archived/);
  assert.ok(!/data-email-version="901"/.test(html), 'archived versions stay hidden until asked for');

  const archived = render('TemplateList', {
    payload: data, canWrite: true, showArchived: true, now: Date.parse('2026-11-03T12:00:00Z'),
    onToggleArchived() {}, onNew() {}, onEdit() {}, onDelete() {}, onRestore() {}, onDeleteArchived() {},
  });
  assert.match(archived, /data-email-version="901"[\s\S]*?v2[\s\S]*?Restore/);
  assert.match(archived, /data-email-version="903"[\s\S]*?Deleted/);
  assert.match(archived, /Hide archived/);
});

test('delete requires choosing a replacement', () => {
  const choices = [
    { id: 901, title: 'Sign-in code, second try (v2)' },
    { id: 902, title: 'Sign-in code, first (v1)', disabledReason: 'Its layout was deleted.' },
  ];
  const html = render('ReplaceDialog', {
    title: 'Delete "Sign-in code"?', intro: 'Choose which earlier version goes live instead.',
    choices, required: true, confirmLabel: 'Delete and put the chosen version live',
    busy: false, failure: null, onConfirm() {}, onCancel() {},
  });
  assert.match(html, /role="dialog"/);
  assert.equal(count(html, /type="radio"/g), 2);
  assert.match(html, /<input[^>]*disabled=""[^>]*value="902"|value="902"[^>]*disabled=""/, 'a version whose layout was deleted cannot be chosen');
  assert.match(html, /Its layout was deleted\./);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Delete and put the chosen version live<\/button>/, 'nothing is deleted before a choice');

  const none = render('ReplaceDialog', {
    title: 'Delete "Sign-in code"?', intro: 'Choose which earlier version goes live instead.',
    choices: [], required: true, emptyText: 'There is no earlier version to put live instead.',
    confirmLabel: 'Delete', busy: false, failure: null, onConfirm() {}, onCancel() {},
  });
  assert.match(none, /There is no earlier version to put live instead\./);
  assert.match(none, /<button[^>]*disabled=""[^>]*>Delete<\/button>/);

  const { templateReplacements, layoutReplacements } = load();
  const data = payload();
  const live = data.templates.find((t) => t.action === 'otp' && t.status === 'live');
  const options = templateReplacements(data, live);
  assert.deepEqual(options.map((o) => o.id), [901, 902], 'archived versions of this action, newest first, never a deleted one');
  assert.ok(options.find((o) => o.id === 902).disabledReason, 'the deleted-layout version is marked');
  assert.equal(options.find((o) => o.id === 901).disabledReason, undefined);
  assert.deepEqual(layoutReplacements(data, 1), [], 'a deleted layout is never offered');
});

test('view-only hides writes', () => {
  const data = payload();
  const list = render('TemplateList', {
    payload: data, canWrite: false, showArchived: true, now: Date.now(),
    onToggleArchived() {}, onNew() {}, onEdit() {}, onDelete() {}, onRestore() {}, onDeleteArchived() {},
  });
  assert.ok(!/New template/.test(list));
  assert.ok(!/>Delete</.test(list));
  assert.ok(!/>Restore</.test(list));
  assert.match(list, />View</, 'a view-only admin can still open each one');
  assert.match(list, /Show archived|Hide archived/);

  const live = data.templates.find((t) => t.action === 'otp' && t.status === 'live');
  const form = render('TemplateForm', {
    payload: data, draft: load().draftFrom(live), isNew: false, canWrite: false, tab: 'html',
    failure: null, saving: false, onChange() {}, onTab() {}, onSave() {}, onCancel() {}, onReload() {}, onRetry() {},
    preview: null,
  });
  assert.ok(!/>Save</.test(form), 'no Save');
  assert.ok(!/Upload image/.test(form), 'no image upload');
  assert.match(form, /Editing needs full admin access/);
  assert.match(form, /id="email-template-subject"[^>]*readOnly=""|id="email-template-subject"[^>]*readonly=""/i);

  const preview = render('PreviewView', {
    result: { subject: 'Your code', html: '<p>123456</p>', text: '123456', problems: [] },
    loading: false, failure: null, mode: 'html', locale: 'en', languages: data.languages,
    englishOnly: false, canWrite: false, testing: false, testResult: null, onLocale() {}, onSendTest() {},
  });
  assert.ok(!/Send test to me/.test(preview), 'no test send');
});

test('the editor shows server errors beside their field, and others above the form', () => {
  const data = payload();
  const live = data.templates.find((t) => t.action === 'otp' && t.status === 'live');
  const { draftFrom, readFailure } = load();
  const failure = readFailure(400, {
    error: 'This cannot be saved yet. Fix the problems shown and try again.', code: 'invalid',
    errors: [
      { field: 'subject', message: 'The subject cannot be empty.' },
      { field: 'html', message: 'The HTML does not always include {{code}}.' },
      { field: 'layoutFamilyId', message: 'That layout does not exist.' },
      { field: 'somethingElse', message: 'A problem with no field.' },
    ],
  });
  assert.equal(failure.kind, 'fields');
  const html = render('TemplateForm', {
    payload: data, draft: draftFrom(live), isNew: false, canWrite: true, tab: 'html',
    failure, saving: false, onChange() {}, onTab() {}, onSave() {}, onCancel() {}, onReload() {}, onRetry() {},
    preview: null,
  });
  assert.match(html, /id="email-template-subject"[^>]*aria-invalid="true"[^>]*aria-describedby="email-template-subject-error"|aria-describedby="email-template-subject-error"[^>]*aria-invalid="true"[^>]*id="email-template-subject"/);
  assert.match(html, /id="email-template-subject"[\s\S]{0,400}id="email-template-subject-error"[^>]*>The subject cannot be empty\./, 'right under the subject');
  assert.match(html, /id="email-template-html-error"[^>]*>The HTML does not always include \{\{code\}\}\./);
  assert.match(html, /id="email-template-layout-error"[^>]*>That layout does not exist\./, 'the layout dropdown carries layoutFamilyId');
  assert.match(html, /A problem with no field\./, 'an error with no field of its own is still shown');
  assert.match(html, />Save</);
  assert.match(html, />Preview</, 'the preview has its place beside the form');

  // Text tab: the text field and its error, the HTML one hidden.
  const text = render('TemplateForm', {
    payload: data, draft: draftFrom(live), isNew: false, canWrite: true, tab: 'text',
    failure: readFailure(400, { code: 'invalid', errors: [{ field: 'text', message: 'The text version cannot be empty.' }] }),
    saving: false, onChange() {}, onTab() {}, onSave() {}, onCancel() {}, onReload() {}, onRetry() {}, preview: null,
  });
  assert.match(text, /id="email-template-text"/);
  assert.match(text, /id="email-template-text-error"[^>]*>The text version cannot be empty\./);
  assert.ok(!/id="email-template-html"/.test(text));
});

test('conflict tells the admin to reload, and a busy database to try again', () => {
  const { readFailure } = load();
  const conflict = readFailure(409, { code: 'conflict', error: 'Someone else changed this since you opened it. Reload to see their version, then make your change again.' });
  assert.equal(conflict.kind, 'conflict');
  const html = render('FailureNotice', { failure: conflict, onReload() {}, onRetry() {} });
  assert.match(html, /Someone else changed this/);
  assert.match(html, /<button[^>]*>Reload<\/button>/);
  assert.ok(!/Try again/.test(html));

  const retry = readFailure(409, { code: 'retry', error: 'The database was busy with another change. Try again in a moment.' });
  assert.equal(retry.kind, 'retry');
  const again = render('FailureNotice', { failure: retry, onReload() {}, onRetry() {} });
  assert.match(again, /<button[^>]*>Try again<\/button>/);
  assert.ok(!/>Reload</.test(again));

  assert.equal(readFailure(0, null).kind, 'message');
  assert.match(readFailure(0, null).message, /Could not reach the platform/);
  assert.equal(readFailure(422, { code: 'replacement_required', error: 'Choose a version to put live instead.' }).message, 'Choose a version to put live instead.');
  assert.equal(readFailure(500, null).kind, 'message');
});

test('the placeholder list explains each one, marks required ones and words from code', () => {
  const data = payload();
  const html = render('PlaceholderList', { action: data.actions.find((a) => a.action === 'waitlist_released') || data.actions[0] });
  const action = data.actions.find((a) => a.action === 'waitlist_released') || data.actions[0];
  for (const p of action.placeholders) assert.ok(html.includes(`{{${p.name}}}`), `${p.name} is listed`);
  const required = [...new Set([...action.required.html, ...action.required.text])];
  assert.ok(required.length > 0);
  assert.equal(count(html, />Required</g), required.length);

  const fromCode = data.actions.flatMap((a) => a.placeholders.map((p) => ({ a, p }))).find(({ p }) => p.fromCode);
  assert.ok(fromCode, 'some action has a placeholder whose words come from code');
  const coded = render('PlaceholderList', { action: fromCode.a });
  assert.match(coded, /wording comes from Homeroom&#x27;s code/i);
});

test('the preview renders server HTML only in a frame with every sandbox permission off', () => {
  const html = render('PreviewView', {
    result: { subject: 'Your code', html: '<p>123456</p><script>alert(1)</script>', text: '123456', problems: [{ field: 'html', message: 'Not saveable yet.' }] },
    loading: false, failure: null, mode: 'html', locale: 'fr', languages: payload().languages,
    englishOnly: false, canWrite: true, testing: false, testResult: null, onLocale() {}, onSendTest() {},
  });
  assert.match(html, /<iframe[^>]*sandbox=""[^>]*srcDoc=|<iframe[^>]*srcDoc=[^>]*sandbox=""/i);
  assert.ok(!/<script>alert/.test(html.replace(/srcDoc="[^"]*"/i, '')), 'the HTML never lands outside the frame');
  assert.match(html, /Your code/);
  assert.match(html, /<option value="fr" selected="">Français<\/option>/);
  assert.match(html, /Not saveable yet\./);
  assert.match(html, /<button[^>]*>Send test to me<\/button>/);
  assert.match(html, /your own address|signed-in/i, 'it says where the test goes');

  const text = render('PreviewView', {
    result: { subject: 'Your code', html: '<p>1</p>', text: 'Your code is 123456', problems: [] },
    loading: false, failure: null, mode: 'text', locale: 'en', languages: payload().languages,
    englishOnly: true, canWrite: true, testing: false, testResult: null, onLocale() {}, onSendTest() {},
  });
  assert.match(text, /<pre[^>]*>Your code is 123456<\/pre>/);
  assert.match(text, /sent in English only/);
  assert.ok(!/<iframe/.test(text));

  const src = read('frontend/src/features/admin/email-templates/preview.tsx');
  assert.ok(count(src, /<iframe\b/g) >= 1);
  assert.equal(count(src, /<iframe\b/g), count(src, /<iframe\b[^>]*?\ssandbox=""/g), 'every frame is sandboxed, with nothing allowed');
});

test('layouts list each live layout, the emails using it, and the deleted case', () => {
  const data = payload();
  data.layouts.push({ id: 3, family_id: 3, name: 'Plain', version: 2, status: 'live', html: '{{content}}', text: '{{content}}', created_by: 7, created_at: '2026-11-02T10:00:00Z', deleted_at: null, locales: ['fr'] });
  data.layouts.push({ id: 4, family_id: 3, name: 'Plain', version: 1, status: 'archived', html: '{{content}}', text: '{{content}}', created_by: 7, created_at: '2026-11-01T10:00:00Z', deleted_at: null, locales: [] });
  const html = render('LayoutList', {
    payload: data, canWrite: true, showArchived: true, now: Date.parse('2026-11-03T12:00:00Z'),
    onToggleArchived() {}, onNew() {}, onEdit() {}, onDelete() {}, onRestore() {},
  });
  assert.equal(count(html, /data-email-layout="/g), 2, 'live layouts only');
  assert.match(html, /data-email-layout="1"[\s\S]*?Homeroom standard[\s\S]*?Used by 13 emails/);
  assert.match(html, /data-email-layout="3"[\s\S]*?Not used/);
  assert.match(html, /data-email-layout-version="4"[\s\S]*?Restore/);
  assert.ok(!/Old frame/.test(html), 'a deleted layout is gone');

  const { layoutReplacements } = load();
  assert.deepEqual(layoutReplacements(data, 1).map((o) => o.id), [3], 'another live layout, by family');
  assert.deepEqual(layoutReplacements(data, 3).map((o) => o.id), [1]);
});

// ── Fix round 1 ─────────────────────────────────────────────────────────

test('a delete sends the live version it was opened on, and says which version is live from the reloaded list', () => {
  const src = read(SECTION);
  assert.match(src, /const body: Record<string, unknown> = \{ expectedLiveId: dialog\.live\.id \};/);
  assert.match(src, /setBanner\(\{ kind: 'ok', text: deletedText\(dialog\.kind, gone, res\.data, fresh\), unusable: unusableOf\(res\.data\) \}\)/);
  assert.match(src, /DELETE', \{ expectedLiveId: live \? live\.id : null \}/, 'an archived version is deleted against the live one too');
  assert.ok(!/the version you chose is live/.test(src), 'it never claims a choice went live without reading it back');

  const { deletedText } = load();
  const data = payload();
  const gone = data.templates.find((t) => t.action === 'otp' && t.status === 'live');
  const v1 = { ...data.templates[0], id: 77, version: 1, name: 'Sign-in code, first' };
  const fresh = { ...data, templates: [...data.templates, v1] };
  assert.equal(deletedText('template', gone, { deletedId: gone.id, liveId: 77 }, fresh),
    'Sign-in code (OTP) v3 was deleted. Sign-in code, first v1 is now live.');
  assert.equal(deletedText('template', gone, { deletedId: gone.id, liveId: null }, fresh), 'Sign-in code (OTP) v3 was deleted.',
    'no live version named when the server put none live');
  const layout = data.layouts[0];
  const plain = { ...layout, id: 9, family_id: 9, name: 'Plain' };
  assert.equal(deletedText('layout', layout, { familyId: 1, movedTo: 9 }, { ...data, layouts: [plain] }),
    'The layout Homeroom standard was deleted. Its emails now use Plain.');
});

test('a conflict in the delete dialog offers Reload, and a busy database Try again', () => {
  const html = render('ReplaceDialog', {
    title: 'Delete?', intro: 'Choose.', choices: [{ id: 1, title: 'v1' }], required: true, confirmLabel: 'Delete',
    busy: false, failure: load().readFailure(409, { code: 'conflict' }), onConfirm() {}, onCancel() {}, onReload() {},
  });
  assert.match(html, /Someone else changed this/);
  assert.match(html, /<button[^>]*>Reload<\/button>/);
  const busy = render('ReplaceDialog', {
    title: 'Delete?', intro: 'Choose.', choices: [{ id: 1, title: 'v1' }], required: true, confirmLabel: 'Delete',
    busy: false, failure: load().readFailure(409, { code: 'retry' }), onConfirm() {}, onCancel() {}, onReload() {},
  });
  assert.match(busy, /<button[^>]*>Try again<\/button>/);
  assert.match(read(SECTION), /onCancel=\{closeDialog\} onReload=\{reloadFromDialog\}/);
});

test('the delete dialog takes focus, closes on Escape unless busy, and gives focus back', () => {
  const html = render('ReplaceDialog', {
    title: 'Delete?', intro: 'Choose.', choices: [], required: false, confirmLabel: 'Delete',
    busy: false, failure: null, onConfirm() {}, onCancel() {},
  });
  assert.match(html, /<div tabindex="-1"[^>]*role="dialog"/i, 'the panel can take focus');
  const src = read('frontend/src/features/admin/email-templates/replace-dialog.tsx');
  assert.match(src, /querySelector<HTMLInputElement>\('input\[type="radio"\]:not\(:disabled\)'\);\s*\(first \|\| panel\.current\)\?\.focus\(\);/);
  assert.match(src, /if \(e\.key !== 'Escape' \|\| state\.current\.busy\) return;/);
  assert.match(src, /document\.removeEventListener\('keydown', onKey\)/);
  const section = read(SECTION);
  assert.match(section, /opener\.current = typeof document !== 'undefined' \? document\.activeElement/);
  assert.match(section, /if \(back && back\.isConnected\) back\.focus\(\);/, 'Cancel returns focus to the button that opened it');
  assert.match(section, /bannerRef\.current\?\.focus\(\)/, 'a finished delete moves focus to what it did');
});

test('unsaved edits are not lost without asking', () => {
  const { isDirty } = load();
  assert.equal(isDirty({ a: 1, b: 'x' }, { a: 1, b: 'x' }), false);
  assert.equal(isDirty({ a: 1, b: 'y' }, { a: 1, b: 'x' }), true);

  for (const file of ['editor.tsx', 'layouts.tsx']) {
    const src = read(`frontend/src/features/admin/email-templates/${file}`);
    assert.match(src, /const dirty = isDirty\(draft, opened\);[\s\S]*?const anyDirty = dirty \|\| lang\.dirty;\s*useUnloadGuard\(anyDirty\);/, `${file}: closing the tab asks while the English or a language is dirty`);
    assert.match(src, /if \(anyDirty && !\(await confirmDiscard\('[^']+'\)\)\) return;\s*settled\.current = true;\s*onDone\(\);/, `${file}: Back and Cancel ask`);
    assert.match(src, /if \(anyDirty && !\(await confirmDiscard\('Reload discards your changes[^']*', 'Reload'\)\)\) return;/, `${file}: Reload asks`);
    assert.match(src, /keepDraft\(\{ kind: '(template|layout)'/, `${file}: a draft the console tore down is kept`);
    assert.ok(!/onClick=\{onDone\}|onCancel=\{onDone\}/.test(src), `${file}: nothing leaves without the check`);
  }
  const shared = read('frontend/src/features/admin/email-templates/shared.tsx');
  assert.match(shared, /window\.addEventListener\('beforeunload', onUnload\)/);
  assert.match(shared, /consoleApi\._confirm\(/, 'it asks through the console dialog');

  const kept = render('KeptDraftNotice', {
    draft: { kind: 'template', action: 'otp', isNew: false, label: 'Sign-in code (OTP)', draft: {} },
    onOpen() {}, onDiscard() {},
  });
  assert.match(kept, /You left unsaved changes to Sign-in code \(OTP\)/);
  assert.match(kept, />Continue editing</);
  assert.match(kept, />Discard</);
  assert.equal(render('KeptDraftNotice', { draft: null, onOpen() {}, onDiscard() {} }), '');
});

test('the preview asks in English for an English-only email, and dims the last good render after a refusal', () => {
  const src = read('frontend/src/features/admin/email-templates/preview.tsx');
  assert.match(src, /const sentLocale = englishOnly \? 'en' : locale;/);
  assert.equal(count(src, /locale: sentLocale/g), 2, 'both the preview and the test send');
  assert.ok(!/\{ \.\.\.body, locale \}/.test(src));

  const html = render('PreviewView', {
    result: { subject: 'Old', html: '<p>old</p>', text: 'old', problems: [] }, stale: true,
    loading: false, failure: load().readFailure(400, { code: 'invalid', errors: [{ field: 'html', message: 'Does not parse.' }] }),
    mode: 'html', locale: 'en', languages: payload().languages, englishOnly: false, canWrite: true,
    testing: false, testResult: null, onLocale() {}, onSendTest() {},
  });
  assert.match(html, /class="opacity-50 space-y-3" data-email-preview-stale=""/);
  assert.match(html, /Last good preview/);
  assert.match(html, /Does not parse\./);
  const fresh = render('PreviewView', {
    result: { subject: 'New', html: '<p>new</p>', text: 'new', problems: [] },
    loading: false, failure: null, mode: 'html', locale: 'en', languages: payload().languages, englishOnly: false,
    canWrite: true, testing: false, testResult: null, onLocale() {}, onSendTest() {},
  });
  assert.ok(!/Last good preview|opacity-50/.test(fresh));
});

// ── Fix round 2 ─────────────────────────────────────────────────────────

test('a restored draft saves against the live version it was opened on, so a save in between is a conflict', () => {
  const { expectedLiveFor } = load();
  const data = payload();
  const nowLive = data.templates.find((t) => t.action === 'otp' && t.status === 'live');
  // Kept while v2 (id 901) was live; someone has since saved nowLive.
  assert.equal(expectedLiveFor({ action: 'otp', id: 901 }, 'otp', data), 901, 'the kept id, not the one live now');
  assert.notEqual(nowLive.id, 901);
  assert.equal(expectedLiveFor({ action: 'otp', id: 901 }, 'password_reset', data),
    data.templates.find((t) => t.action === 'password_reset' && t.status === 'live').id,
    'a new template moved to another email expects that one');

  const editor = read('frontend/src/features/admin/email-templates/editor.tsx');
  assert.match(editor, /if \(restore\) return \{ action: restore\.action, id: restore\.openedLiveId \};/);
  assert.match(editor, /keepDraft\(\{ kind: 'template', action, isNew, label, draft: now\.draft, opened, openedLiveId: openedLive\.id, language \}\)/);
  assert.match(editor, /request\('\/api\/admin\/email-templates', 'POST', \{ \.\.\.draft, expectedLiveId \}\)/);
  const layouts = read('frontend/src/features/admin/email-templates/layouts.tsx');
  assert.match(layouts, /useState<number \| null>\(\(\) => \(restore \? restore\.openedLiveId : live \? live\.id : null\)\)/);
  assert.match(layouts, /expectedLiveId: openedLiveId,/);
  assert.match(layouts, /draft: now\.draft, opened, openedLiveId, language \}\)/);
  // The stale save is the route's ordinary 409 (tests/admin-email-templates.test.js
  // "stale expectedLiveId is 409"), shown with Reload, and Reload drops the restore.
  assert.match(read(SECTION), /setView\(\(v\) => \(v\.kind === 'list' \? v : \{ \.\.\.v, restore: undefined \}\)\);/);

  // Rendered with a restore, the editor shows the kept words, measured
  // against what it had opened, not against what is live now.
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const { TemplateEditor } = load();
  const opened = { ...load().draftFrom(nowLive), subject: 'What was live then' };
  const html = renderToHtml(createElement(TemplateEditor, {
    payload: data, action: 'otp', isNew: false, canWrite: true, onDone() {}, onSaved() {}, onReload() {},
    restore: { kind: 'template', action: 'otp', isNew: false, label: 'Sign-in code', opened, openedLiveId: 901,
      draft: { ...opened, subject: 'My unsaved subject' } },
  }));
  assert.match(html, /id="email-template-subject"[^>]*value="My unsaved subject"/);
});

test('opening an editor by hand leaves the kept draft and its notice alone', () => {
  const { keepDraft, keptDraft, TemplateEditor, draftFrom } = load();
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const data = payload();
  const nowLive = data.templates.find((t) => t.action === 'otp' && t.status === 'live');
  const record = { kind: 'template', action: 'otp', isNew: false, label: 'Sign-in code', opened: draftFrom(nowLive),
    openedLiveId: nowLive.id, draft: { ...draftFrom(nowLive), subject: 'Kept words' } };
  keepDraft(record);
  const html = renderToHtml(createElement(TemplateEditor, {
    payload: data, action: 'otp', isNew: false, canWrite: true, onDone() {}, onSaved() {}, onReload() {},
  }));
  assert.match(html, /id="email-template-subject"[^>]*value="Sign-in code \(OTP\) subject"/, 'it opens on what is live');
  assert.ok(keptDraft(), 'the kept draft is still there for Continue editing');
  assert.equal(keptDraft().draft.subject, 'Kept words');
  assert.ok(!/keptDraft\(\)/.test(read('frontend/src/features/admin/email-templates/editor.tsx')), 'editors never read the store themselves');
  assert.match(read(SECTION), /keepDraft\(null\);\s*setKept\(null\);\s*if \(kept\.kind === 'template'\)/, 'only Continue editing takes it');
  keepDraft(null);
});

test('a kept draft belongs to the account that left it', () => {
  const { keepDraft, keptDraft, draftFrom } = load();
  const data = payload();
  const live = data.templates.find((t) => t.action === 'otp' && t.status === 'live');
  const prior = globalThis.App;
  try {
    globalThis.App = { user: { id: 1 } };
    keepDraft({ kind: 'template', action: 'otp', isNew: false, label: 'x', opened: draftFrom(live), openedLiveId: live.id, draft: draftFrom(live) });
    assert.ok(keptDraft(), 'kept for the same account');
    globalThis.App = { user: { id: 2 } };
    assert.equal(keptDraft(), null, 'another account signed in: gone');
    globalThis.App = { user: { id: 1 } };
    assert.equal(keptDraft(), null, 'and it does not come back');
  } finally {
    globalThis.App = prior;
    keepDraft(null);
  }
});

test('Visual is the first body tab and the one both editors open on; the preview shows HTML for it', () => {
  const data = payload();
  const live = data.templates.find((t) => t.action === 'waitlist_released' && t.status === 'live');
  const { TemplateEditor, draftFrom } = load();
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const html = renderToHtml(createElement(TemplateEditor, {
    payload: data, action: live.action, isNew: false, canWrite: true, onDone() {}, onSaved() {}, onReload() {},
  }));
  const tabs = [...html.matchAll(/id="email-template-tab-(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ['visual', 'html', 'text']);
  assert.match(html, /aria-selected="true"[^>]*id="email-template-tab-visual"|id="email-template-tab-visual"[^>]*aria-selected="true"/);
  assert.match(html, /<iframe[^>]*title="Visual editor"[^>]*sandbox="allow-same-origin"/);
  assert.ok(!/id="email-template-html"/.test(html), 'the HTML textarea waits behind its tab');

  // The form's Visual tab edits draft.html, offers the action's placeholders and reverts to what was opened.
  const form = render('TemplateForm', {
    payload: data, draft: draftFrom(live), opened: draftFrom(live), isNew: false, canWrite: true, tab: 'visual',
    failure: null, saving: false, onChange() {}, onTab() {}, onSave() {}, onCancel() {}, onReload() {}, onRetry() {},
    preview: null,
  });
  assert.match(form, /aria-label="Revert to opened"/);
  const editor = read('frontend/src/features/admin/email-templates/editor.tsx');
  assert.match(editor, /useState<BodyTab>\('visual'\)/);
  assert.match(editor, /mode=\{tab === 'text' \? 'text' : 'html'\}/);
  assert.match(editor, /<VisualTab source=\{draft\.html\} opened=\{/);

  const layouts = read('frontend/src/features/admin/email-templates/layouts.tsx');
  assert.match(layouts, /useState<LayoutTab>\('visual'\)/);
  assert.match(layouts, /<VisualTab source=\{draft\.html\} opened=\{/);
  assert.match(layouts, /mode=\{tab === 'text' \? 'text' : 'html'\}/);
  const layoutHtml = render('LayoutEditor', {
    payload: data, familyId: data.layouts.find((l) => l.status === 'live' && !l.deleted_at).family_id, canWrite: true,
    onDone() {}, onSaved() {}, onReload() {},
  });
  assert.match(layoutHtml, /title="Visual editor"/);
});

test('the HTML tab offers Upload image to a full admin, beside the HTML', () => {
  const data = payload();
  const live = data.templates.find((t) => t.action === 'otp' && t.status === 'live');
  const form = render('TemplateForm', {
    payload: data, draft: load().draftFrom(live), isNew: false, canWrite: true, tab: 'html',
    failure: null, saving: false, onChange() {}, onTab() {}, onSave() {}, onCancel() {}, onReload() {}, onRetry() {},
    preview: null,
  });
  assert.match(form, /<button[^>]*>Upload image<\/button>/);
  assert.ok(form.indexOf('Upload image') > form.indexOf('id="email-template-html"'), 'under the HTML it inserts into');
});

// ── Translate (Task 13) ─────────────────────────────────────────────────

const noop = () => {};

test('list counts out-of-date languages: usable translations of the live version, and the layout where it differs', () => {
  const { translationSummary, languagesColumn } = load();
  const codes = OTHERS.map((l) => l.code);
  assert.equal(translationSummary({ locales: codes }, codes, false), '12 of 12');
  assert.equal(translationSummary({ locales: ['fr', 'de', 'es', 'it', 'nl', 'pl', 'ja', 'ko', 'tr'] }, codes, false), '9 of 12, 3 need translating');
  assert.equal(translationSummary({ locales: codes, unusableLocales: ['fr'] }, codes, false),
    '11 of 12, 1 needs translating', 'a translation that is not sent is not counted');
  assert.equal(translationSummary({ locales: [...codes.slice(1), 'xx', 'en'] }, codes, false), '11 of 12, 1 needs translating',
    'a language no longer offered, or English, does not count');
  assert.equal(translationSummary({ locales: [] }, codes, false), '0 of 12, 12 need translating');
  assert.equal(translationSummary({ locales: ['fr'] }, codes, true), 'English only');

  const data = payload();
  const otp = data.templates.find((t) => t.action === 'otp' && t.status === 'live');
  assert.equal(languagesColumn(data, false, otp), '12 of 12; layout: 0 of 12, 12 need translating', 'the layout is named when it says something else');
  const reset = data.templates.find((t) => t.action === 'password_reset' && t.status === 'live');
  assert.equal(languagesColumn(data, false, reset), '0 of 12, 12 need translating', 'no layout part when it is the same');
  assert.equal(languagesColumn(data, false, { ...reset, layout_family_id: null }), '0 of 12, 12 need translating');

  const html = render('TemplateList', {
    payload: data, canWrite: true, showArchived: false, now: Date.parse('2026-11-03T12:00:00Z'),
    onToggleArchived: noop, onNew: noop, onEdit: noop, onDelete: noop, onRestore: noop, onDeleteArchived: noop,
  });
  assert.match(html, /data-email-action="otp"[\s\S]*?12 of 12; layout: 0 of 12, 12 need translating/);
  assert.match(html, /md:hidden[^>]*>Languages: 12 of 12; layout: 0 of 12, 12 need translating · 2 days ago</, 'a phone names the column it folds in');
  assert.match(html, /data-email-action="admin_test"[\s\S]*?English only/);
  const layouts = render('LayoutList', {
    payload: data, canWrite: true, showArchived: false, now: Date.parse('2026-11-03T12:00:00Z'),
    onToggleArchived: noop, onNew: noop, onEdit: noop, onDelete: noop, onRestore: noop,
  });
  assert.match(layouts, /Used by 13 emails · 0 of 12, 12 need translating/);
});

test('shows per-language progress and failures, in words', () => {
  const { TranslateProgressView, jobSummary, stateWords } = load();
  const running = {
    state: 'running',
    perLanguage: { fr: 'saved', de: 'pending', es: 'failed: The HTML drops {{code}}', it: 'skipped: admin' },
    unusable: { ja: 'a link changed' },
  };
  const html = render('TranslateProgressView', { status: running, languages: LANGUAGES });
  assert.match(html, /Translating: 3 of 4 languages done\./);
  assert.match(html, /data-translate-language="fr"[^>]*>[\s\S]*?Français[\s\S]*?Translated and saved/);
  assert.match(html, /data-translate-language="de"[^>]*>[\s\S]*?Waiting to be translated/);
  assert.match(html, /data-translate-language="es"[^>]*>[\s\S]*?Failed: The HTML drops \{\{code\}\}/);
  assert.match(html, /data-translate-language="it"[^>]*>[\s\S]*?Skipped: an admin edited this language/);
  assert.match(html, /日本語 is not sent: a link changed\. It sends the English until it is fixed\./);
  assert.match(html, /aria-live="polite"/, 'progress is announced as it changes');
  assert.equal(jobSummary({ ...running, state: 'done', perLanguage: { fr: 'saved', de: 'saved', es: 'failed: x', it: 'skipped: admin' } }),
    'Finished: 2 translated, 1 failed, 1 skipped.');
  assert.match(jobSummary({ ...running, state: 'stopped' }), /stopped before it finished/);
  assert.equal(stateWords('failed:  model refused '), 'Failed: model refused');
  assert.equal(render('TranslateProgressView', { status: { state: 'none', perLanguage: {}, unusable: {} }, languages: LANGUAGES }), '');

  // Following a running job is the poller's: see the poller tests below.
});

test('Translate is disabled with its reason, and replacing admin edits is its own confirmed action', () => {
  const { translateBlocked } = load();
  assert.equal(translateBlocked({ englishOnly: false, dirty: true, versionId: 5 }), 'Save first, then translate');
  assert.equal(translateBlocked({ englishOnly: false, dirty: false, versionId: null }), 'Save first, then translate');
  assert.match(translateBlocked({ englishOnly: true, dirty: false, versionId: 5 }), /English only/);
  assert.equal(translateBlocked({ englishOnly: false, dirty: false, versionId: 5 }), null);

  const base = { status: null, failure: null, starting: false, canWrite: true, languages: LANGUAGES, onTranslate: noop, onReplace: noop };
  const dirty = render('TranslateControlsView', { ...base, blocked: 'Save first, then translate' });
  assert.match(dirty, /<button[^>]*id="email-translate"[^>]*disabled=""[^>]*>Translate<\/button>/);
  assert.match(dirty, /aria-describedby="email-translate-blocked"/);
  assert.match(dirty, /id="email-translate-blocked"[^>]*>Save first, then translate</);
  const ready = render('TranslateControlsView', { ...base, blocked: null });
  assert.match(ready, /<button[^>]*id="email-translate"[^>]*>Translate<\/button>/);
  assert.ok(!/id="email-translate"[^>]*disabled/.test(ready));
  assert.match(ready, />Translate again, replacing admin edits</);
  assert.match(ready, /into the other 12 languages/);
  const running = render('TranslateControlsView', { ...base, blocked: null, status: { state: 'running', perLanguage: { fr: 'pending' }, unusable: {} } });
  assert.match(running, /disabled=""[^>]*>Translating…</);
  const viewOnly = render('TranslateControlsView', { ...base, canWrite: false, blocked: null, status: { state: 'done', perLanguage: { fr: 'saved' }, unusable: {} } });
  assert.ok(!/<button/.test(viewOnly), 'a view-only admin sees the progress, not the buttons');
  assert.match(viewOnly, /Finished: 1 translated\./);

  assert.match(dirty, /id="email-translate-replace"[^>]*disabled=""[^>]*aria-describedby="email-translate-blocked"|aria-describedby="email-translate-blocked"[^>]*id="email-translate-replace"/,
    'the replace button says why it is disabled too');
  for (const file of ['editor.tsx', 'layouts.tsx']) {
    assert.match(read(`frontend/src/features/admin/email-templates/${file}`), /useEditorLanguages\(\{/, `${file} has the languages card`);
  }
});

test('replacing admin edits asks first, and Translate does not', async () => {
  const { TranslateControls } = load();
  const calls = [];
  const job = { status: null, failure: null, starting: false, start: async (body) => { calls.push(body); return true; } };
  const asked = [];
  const prior = globalThis.AdminConsole;
  try {
    const element = TranslateControls({ versionId: 5, englishOnly: false, dirty: false, canWrite: true, languages: LANGUAGES, job });
    globalThis.AdminConsole = { _confirm: async (opts) => { asked.push(opts); return false; } };
    await element.props.onReplace();
    assert.equal(calls.length, 0, 'declined: nothing starts');
    assert.equal(asked[0].title, 'Replace admin edits?');
    globalThis.AdminConsole = { _confirm: async () => true };
    await element.props.onReplace();
    assert.deepEqual(calls, [{ overwrite: true }]);
    element.props.onTranslate();
    assert.deepEqual(calls[1], {}, 'Translate keeps admin edits and asks nothing');
  } finally {
    globalThis.AdminConsole = prior;
  }
});

test('save offers translate, after a template save and a layout save, and names translations the save broke', () => {
  const data = payload();
  const html = render('SavedBanner', {
    text: 'Sign-in code v4 is live.', languages: LANGUAGES,
    translate: { base: '/api/admin/email-templates', versionId: 44 },
    unusable: [{ templateId: 44, action: 'otp', locale: 'fr', reason: 'x' }, { layoutId: 1, locale: 'de', reason: 'y' }],
    labelFor: (item) => load().unusableWhere(data, item),
  });
  assert.match(html, /Sign-in code v4 is live\./);
  assert.match(html, /<button[^>]*id="email-translate-offer"[^>]*>Translate the other languages now<\/button>/);
  assert.match(html, /no longer fit and send the English until they are fixed: Français \(Sign-in code \(OTP\)\), Deutsch \(layout Homeroom standard\)\./);
  const englishOnly = render('SavedBanner', { text: 'Saved.', languages: LANGUAGES, translate: null });
  assert.ok(!/Translate the other languages now/.test(englishOnly), 'an English-only email is not offered it');

  const section = read(SECTION);
  assert.match(section, /englishOnly \? null : \{ base: '\/api\/admin\/email-templates', versionId: row\.id \}/);
  assert.match(section, /\{ base: '\/api\/admin\/email-layouts', versionId: row\.id \}\)\(\)\} \/>/, 'a layout save offers it too');
  assert.match(section, /setBanner\(\{ kind: 'ok', text: done, unusable: unusableOf\(res\.data\) \}\);/, 'restores and deletes name them too');
  const { unusableOf } = load();
  assert.deepEqual(unusableOf({ template: {}, unusableTranslations: [{ locale: 'fr', reason: 'x' }] }), [{ locale: 'fr', reason: 'x' }]);
  assert.deepEqual(unusableOf({ template: {} }), [], 'an older answer without the list names none');
  assert.deepEqual(unusableOf(null), []);
  for (const file of ['editor.tsx', 'layouts.tsx']) {
    assert.match(read(`frontend/src/features/admin/email-templates/${file}`), /onSaved\(res\.data\.(template|layout), unusableOf\(res\.data\)\);/);
  }
  const once = render('SavedBanner', { text: 'Sign-in code v4 is live.', languages: LANGUAGES, translate: null, unusable: [{ locale: 'fr', reason: 'x' }] });
  assert.equal((once.match(/Saved\./g) || []).length, 0, 'the notice does not repeat "Saved."');
});

test('a language opens in the same tabs, with the English alongside, and its errors beside its fields', () => {
  const { LanguageForm, readFailure } = load();
  const english = { subject: 'Your code', preheader: 'Use it soon', why: 'You asked', html: '<p>Code: {{code}}</p>', text: 'Code: {{code}}' };
  const draft = { subject: 'Votre code', preheader: '', why: 'Vous l’avez demandé', html: '<p>Code : {{code}}</p>', text: 'Code : {{code}}' };
  const failure = readFailure(400, { code: 'invalid', errors: [
    { field: 'subject', message: 'The subject cannot be empty.' },
    { field: 'html', message: 'The HTML drops {{code}}.' },
  ] });
  const props = {
    language: 'Français', draft, opened: draft, english, parts: ['subject', 'preheader', 'why', 'html', 'text'],
    tab: 'html', onTab: noop, failure, saving: false, saved: null, unusable: null, canWrite: true, retranslating: false,
    placeholders: [{ name: 'code', description: 'The code' }], idPrefix: 'email-translation', backLabel: '‹ All templates',
    onBack: noop, onChange: noop, onSave: noop, onRevert: noop, onRetranslate: noop, languagesCard: null, preview: null, side: null,
    languages: LANGUAGES,
  };
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const html = renderToHtml(createElement(LanguageForm, props));
  assert.match(html, /data-email-language="Français"/);
  const subject = html.match(/<input[^>]*id="email-translation-subject"[^>]*>/)[0];
  assert.match(subject, /value="Votre code"/);
  assert.match(subject, /aria-invalid="true"/);
  assert.match(subject, /aria-describedby="email-translation-subject-error"/);
  assert.match(html, /id="email-translation-subject-error"[^>]*>The subject cannot be empty\./);
  assert.match(html, /id="email-translation-html"[\s\S]*?id="email-translation-html-error"[^>]*>The HTML drops \{\{code\}\}\./);
  assert.match(html, /role="tab" aria-selected="false" id="email-translation-tab-visual"[^>]*>Visual/);
  assert.match(html, /id="email-translation-tab-html"[^>]*>HTML/);
  assert.match(html, /<details open=""[^>]*id="email-translation-english"><summary[^>]*>English<\/summary>[\s\S]*?Your code[\s\S]*?&lt;p&gt;Code: \{\{code\}\}&lt;\/p&gt;/);
  assert.match(html, /<button[^>]*id="email-translation-save"[^>]*>Save Français<\/button>/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Undo changes<\/button>/, 'nothing to undo yet');
  assert.match(html, /Preview in Français/);

  const visual = renderToHtml(createElement(LanguageForm, { ...props, tab: 'visual', failure: null }));
  assert.match(visual, /role="tab" aria-selected="true" id="email-translation-tab-visual"/, 'the Visual tab works on the translated HTML');

  const viewOnly = renderToHtml(createElement(LanguageForm, { ...props, canWrite: false, failure: null }));
  assert.ok(!/Save Français/.test(viewOnly));
  assert.match(viewOnly, /id="email-translation-subject"[^>]*readonly=""/i);

  const saved = renderToHtml(createElement(LanguageForm, { ...props, failure: null,
    saved: { text: 'Français saved. Its readers get these words from now on.', unusable: [{ templateId: 3, action: 'otp', locale: 'fr', reason: 'x' }] } }));
  assert.match(saved, /Français saved\. Its readers get these words from now on\./);
  assert.match(saved, /no longer fit and send the English until they are fixed: Français\./);

  // A preview of a language is that language, its picker locked to it.
  const { PreviewPane, languageSaveRequest } = load();
  const pane = renderToHtml(createElement(PreviewPane, {
    base: '/api/admin/email-templates', body: { action: 'otp', fields: {} }, mode: 'html', languages: LANGUAGES,
    englishOnly: false, canWrite: true, onFieldFailure: noop, fixedLocale: 'fr',
  }));
  assert.match(pane, /<select[^>]*disabled=""[^>]*>[\s\S]*?<option value="fr" selected="">Français<\/option>/);
  // The save goes to the version the editor opened on, and says which one.
  assert.deepEqual(languageSaveRequest('/api/admin/email-templates', 41, 'pt-BR', { subject: 'Oi' }), {
    url: '/api/admin/email-templates/41/translations/pt-BR', method: 'PUT', body: { subject: 'Oi', expectedLiveId: 41 },
  });
});

test('an unusable language says why, that it sends the English, and offers Retranslate', () => {
  const html = render('UnusableLanguageNotice', { language: 'Deutsch', reason: 'A link differs from the English', canWrite: true, busy: false, onRetranslate: noop });
  assert.match(html, /Deutsch is not sent right now\./);
  assert.match(html, /Why: A link differs from the English/);
  assert.match(html, /This language sends the English until it&#x27;s fixed\./);
  assert.match(html, /<button[^>]*id="email-language-retranslate"[^>]*>Retranslate<\/button>/);
  const viewOnly = render('UnusableLanguageNotice', { language: 'Deutsch', reason: 'r', canWrite: false, busy: false, onRetranslate: noop });
  assert.ok(!/Retranslate/.test(viewOnly));
  const { retranslateBody } = load();
  assert.deepEqual(retranslateBody('de'), { languages: ['de'], overwrite: true }, 'Retranslate runs that one language');
  const src = read('frontend/src/features/admin/email-templates/translations.tsx');
  assert.match(src, /await job\.start\(retranslateBody\(lang\.locale\)\);/);
  assert.match(src, /if \(row && row\.origin === 'admin'\) \{[\s\S]*?_confirm\(/, 'and asks first when an admin wrote it');
});

test('the language switch names each language state, and waits for the English to be saved', () => {
  const rows = {
    fr: { locale: 'fr', html: '', text: '', origin: 'machine', unusable: null },
    de: { locale: 'de', html: '', text: '', origin: 'admin', unusable: null },
    es: { locale: 'es', html: '', text: '', origin: 'machine', unusable: 'x' },
  };
  const html = render('LanguageSwitch', { locale: 'en', languages: LANGUAGES, rows, blocked: null, onChange: noop, idPrefix: 'email-template' });
  assert.match(html, /<option value="en" selected="">English \(the original\)<\/option>/);
  assert.match(html, /<option value="fr">Français: translated<\/option>/);
  assert.match(html, /<option value="de">Deutsch: edited by an admin<\/option>/);
  assert.match(html, /<option value="es">Español: not sent, needs fixing<\/option>/);
  assert.match(html, /<option value="it">Italiano: not translated<\/option>/);
  assert.equal((html.match(/<option /g) || []).length, 13, 'English and the twelve');
  const blocked = render('LanguageSwitch', { locale: 'en', languages: LANGUAGES, rows, blocked: 'Save the English first, then edit another language.', onChange: noop, idPrefix: 'email-template' });
  assert.match(blocked, /<select[^>]*disabled=""[^>]*aria-describedby="email-template-language-blocked"/);
  assert.match(blocked, /Save the English first, then edit another language\./);

  const { languageMove, keptLanguage } = load();
  assert.equal(languageMove({ from: 'fr', to: 'fr', languageDirty: true }), 'stay');
  assert.equal(languageMove({ from: 'fr', to: 'de', languageDirty: true }), 'confirm', 'unsaved words are asked about');
  assert.equal(languageMove({ from: 'fr', to: 'en', languageDirty: false }), 'go');
  const words = { subject: 'Votre code' };
  assert.deepEqual(keptLanguage({ dirty: true, locale: 'fr', draft: words, opened: { subject: 'x' } }),
    { locale: 'fr', draft: words, opened: { subject: 'x' } }, 'a language\'s unsaved words are kept');
  assert.equal(keptLanguage({ dirty: false, locale: 'fr', draft: words, opened: words }), null);
  for (const file of ['editor.tsx', 'layouts.tsx']) {
    const editor = read(`frontend/src/features/admin/email-templates/${file}`);
    assert.match(editor, /const language = keptLanguage\(now\.lang\);/, `${file}: kept with the draft`);
    assert.match(editor, /initial: restore\?\.language \|\| null/, `${file}: and back with Continue editing`);
  }
  // After a move the switch is drawn in the other form; focus goes back to it.
  assert.match(read('frontend/src/features/admin/email-templates/translations.tsx'),
    /refocus\.current = true;\s*lang\.open\(code\);/);
});

test('the template editor shows the languages card on a saved version and not on a new one', () => {
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const { TemplateEditor } = load();
  const data = payload();
  const saved = renderToHtml(createElement(TemplateEditor, {
    payload: data, action: 'otp', isNew: false, canWrite: true, onDone: noop, onSaved: noop, onReload: noop,
  }));
  assert.match(saved, /id="email-languages"/);
  assert.match(saved, /id="email-template-language"/);
  assert.match(saved, /<button[^>]*id="email-translate"/);
  const fresh = renderToHtml(createElement(TemplateEditor, {
    payload: data, action: 'otp', isNew: true, canWrite: true, onDone: noop, onSaved: noop, onReload: noop,
  }));
  assert.ok(!/id="email-languages"/.test(fresh), 'a template not saved yet has nothing to translate');
  const englishOnly = renderToHtml(createElement(TemplateEditor, {
    payload: data, action: 'admin_test', isNew: false, canWrite: true, onDone: noop, onSaved: noop, onReload: noop,
  }));
  assert.ok(!/id="email-template-language"/.test(englishOnly), 'no language switch for an English-only email');
  assert.match(englishOnly, /This email is sent in English only, so there is nothing to translate\./);
});

// ── Translate fix round 1 ───────────────────────────────────────────────

function loadPoller() {
  const { loadTsx } = require('./lib/render-tsx');
  return loadTsx('frontend/src/features/admin/email-templates/translate-poller.ts');
}

// A poller with a hand-run clock and a queue of answers to its reads.
function steppedPoller(answers) {
  const { createPoller } = loadPoller();
  const timers = [];
  const seen = { statuses: [], failures: [], reads: 0 };
  const poller = createPoller({
    read: async () => { seen.reads += 1; return answers.shift(); },
    onStatus: (s) => seen.statuses.push(s.state),
    onFailure: (f) => seen.failures.push(f),
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
  });
  const tick = async () => {
    const next = timers.find((t) => !t.cleared && !t.ran);
    assert.ok(next, 'a read is scheduled');
    next.ran = true;
    next.fn();
    await new Promise((resolve) => setImmediate(resolve));
    return next.ms;
  };
  const pending = () => timers.filter((t) => !t.cleared && !t.ran);
  return { poller, seen, tick, pending };
}

const running = (n) => ({ ok: true, status: { state: 'running', perLanguage: { fr: n } } });
const failed = { ok: false, failure: 'network' };

test('the poller keeps following a running job through failed reads, backing off', async () => {
  const { nextDelay } = loadPoller();
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((n) => nextDelay(n)), [2000, 2000, 4000, 8000, 16000, 30000, 30000]);

  const { poller, seen, tick, pending } = steppedPoller([running('pending'), failed, failed, failed, running('saved'),
    { ok: true, status: { state: 'done', perLanguage: { fr: 'saved' } } }]);
  await poller.poll();
  assert.deepEqual(seen.statuses, ['running']);
  assert.equal(await tick(), 2000);
  assert.deepEqual(seen.failures, ['network'], 'a failed read is reported');
  assert.deepEqual(seen.statuses, ['running'], 'and the last status is left as it was');
  assert.equal(await tick(), 2000, 'first retry');
  assert.equal(await tick(), 4000, 'then longer');
  assert.equal(await tick(), 8000);
  assert.deepEqual(seen.statuses, ['running', 'running'], 'it carried on once a read worked');
  assert.equal(await tick(), 2000, 'and the pause went back to the start');
  assert.deepEqual(seen.statuses, ['running', 'running', 'done']);
  assert.equal(pending().length, 0, 'done: nothing more is read');
  assert.equal(seen.reads, 6);
});

test('the poller stops on a stopped job, on a failure with nothing running, and on unmount', async () => {
  const stoppedJob = steppedPoller([{ ok: true, status: { state: 'stopped', perLanguage: {} } }]);
  await stoppedJob.poller.poll();
  assert.equal(stoppedJob.pending().length, 0);

  const firstFails = steppedPoller([failed]);
  await firstFails.poller.poll();
  assert.equal(firstFails.pending().length, 0, 'nothing known to be running: no retry loop');
  assert.deepEqual(firstFails.seen.failures, ['network']);

  const unmounted = steppedPoller([running('pending'), running('saved')]);
  await unmounted.poller.poll();
  assert.equal(unmounted.pending().length, 1);
  unmounted.poller.stop();
  assert.equal(unmounted.pending().length, 0, 'stop clears the timer');
  await unmounted.poller.poll();
  assert.equal(unmounted.seen.reads, 1, 'and nothing reads after it');

  // A read in flight when the editor goes is dropped, not acted on.
  let release;
  const { createPoller } = loadPoller();
  const states = [];
  let scheduled = 0;
  const late = createPoller({
    read: () => new Promise((resolve) => { release = resolve; }),
    onStatus: (s) => states.push(s.state), onFailure: noop,
    setTimer: () => { scheduled += 1; return {}; }, clearTimer: noop,
  });
  const inFlight = late.poll();
  late.stop();
  release(running('pending'));
  await inFlight;
  assert.deepEqual(states, []);
  assert.equal(scheduled, 0);

  // A start that answers with a running job is followed from there.
  const started = steppedPoller([]);
  started.poller.seen({ state: 'running', perLanguage: {} });
  assert.equal(started.pending()[0].ms, 2000);

  const src = read('frontend/src/features/admin/email-templates/translations.tsx');
  assert.match(src, /return \(\) => \{ alive\.current = false; p\.stop\(\); poller\.current = null; \};/, 'the editor stops it when it goes');
});

test('a language\'s unusable reason comes from its row once there is one', () => {
  const { unusableReason } = load();
  const job = { fr: 'old reason from the job', de: 'job reason' };
  assert.equal(unusableReason({ locale: 'fr', html: '', text: '', origin: 'admin', unusable: null }, job, 'fr'), null,
    'a correction just saved cleared it, whatever the job said');
  assert.equal(unusableReason({ locale: 'fr', html: '', text: '', origin: 'machine', unusable: 'row reason' }, job, 'fr'), 'row reason');
  assert.equal(unusableReason(undefined, job, 'de'), 'job reason', 'the job stands in before the row is known');
  assert.equal(unusableReason(undefined, undefined, 'de'), null);
  assert.equal(unusableReason(undefined, job, 'en'), null);
  assert.match(read('frontend/src/features/admin/email-templates/translations.tsx'),
    /useLanguageEditor\(\{ base, versionId, english, parts, languages, initial, onSaved: job\.refresh \}\)/,
    'a language save reads the job again');
});

test('an untouched language cannot be saved, and a language with no translation offers Translate for it', () => {
  const { LanguageForm, readFailure } = load();
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const english = { subject: 'Your code', html: '<p>{{code}}</p>', text: '{{code}}' };
  const base = {
    language: 'Italiano', draft: english, opened: english, english, parts: ['subject', 'html', 'text'],
    tab: 'html', onTab: noop, failure: null, saving: false, saved: null, unusable: null, canWrite: true, retranslating: false,
    placeholders: [], idPrefix: 'email-translation', backLabel: '‹ All templates', onBack: noop, onChange: noop, onSave: noop,
    onRevert: noop, onRetranslate: noop, languagesCard: null, preview: null, side: null, languages: LANGUAGES,
  };
  const none = renderToHtml(createElement(LanguageForm, { ...base, hasRow: false, onTranslateOne: noop }));
  assert.match(none, /<button[^>]*id="email-translation-save"[^>]*disabled=""[^>]*>Save Italiano<\/button>/, 'the English cannot be saved as Italian by one click');
  assert.match(none, /aria-describedby="email-translation-save-why"/);
  assert.match(none, /No Italiano translation yet\./);
  assert.match(none, /show the English to start from/);
  assert.match(none, /<button[^>]*id="email-translation-translate-one"[^>]*>Translate Italiano<\/button>/);
  const edited = renderToHtml(createElement(LanguageForm, { ...base, hasRow: false, draft: { ...english, subject: 'Il tuo codice' } }));
  assert.ok(!/id="email-translation-save"[^>]*disabled/.test(edited), 'a changed word can be saved');
  const conflict = renderToHtml(createElement(LanguageForm, { ...base, onReload: noop,
    failure: readFailure(409, { code: 'conflict', error: 'Someone else changed this since you opened it. Reload to see their version, then make your change again.' }) }));
  assert.match(conflict, /Someone else changed this/);
  assert.match(conflict, /<button[^>]*>Reload<\/button>/, 'a correction to a version no longer live offers Reload');
  for (const file of ['editor.tsx', 'layouts.tsx']) {
    assert.match(read(`frontend/src/features/admin/email-templates/${file}`),
      /hasRow=\{languages\.hasRow\} onTranslateOne=\{languages\.translateOne\} onReload=\{reload\}/);
  }
});

test('a Translate started from the banner reloads the list when it finishes', () => {
  const src = read('frontend/src/features/admin/email-templates/translations.tsx');
  assert.match(src, /if \(wasRunning\.current && \(state === 'done' \|\| state === 'stopped'\)\) \{\s*wasRunning\.current = false;\s*if \(onFinished\) onFinished\(\);/);
  assert.match(read(SECTION), /labelFor=\{\(item\) => unusableWhere\(payload, item\)\} onFinished=\{load\} \/>/);
});

// ── Final review ────────────────────────────────────────────────────────

test('a preview in another language says when it shows the English words', () => {
  const props = {
    loading: false, failure: null, mode: 'html', languages: payload().languages, englishOnly: false,
    canWrite: true, testing: false, testResult: null, onLocale() {}, onSendTest() {},
  };
  const english = render('PreviewView', { ...props, locale: 'fr', result: { subject: 'S', html: '<p>x</p>', text: 'x', problems: [], untranslated: true } });
  assert.match(english, /id="email-template-preview-untranslated"[^>]*>Shows the English words as Français readers will get them after you save, until this version is translated\./);
  const saved = render('PreviewView', { ...props, locale: 'fr', result: { subject: 'S', html: '<p>x</p>', text: 'x', problems: [], untranslated: false } });
  assert.ok(!/email-template-preview-untranslated/.test(saved), 'the saved translation is shown as it is');
  const inEnglish = render('PreviewView', { ...props, locale: 'en', result: { subject: 'S', html: '<p>x</p>', text: 'x', problems: [], untranslated: true } });
  assert.ok(!/email-template-preview-untranslated/.test(inEnglish));
  const route = read('src/routes/admin-email-templates.js');
  assert.match(route, /untranslated: !!reader && !shown/, 'the server says which it showed');
});

test('an edit says other languages get the English until it is translated, in the editor and after the save', () => {
  const data = payload();
  const live = data.templates.find((t) => t.action === 'otp' && t.status === 'live');
  const { draftFrom } = load();
  const form = (extra) => render('TemplateForm', {
    payload: data, draft: draftFrom(live), opened: draftFrom(live), isNew: false, canWrite: true, tab: 'html', failure: null, saving: false,
    onChange() {}, onTab() {}, onSave() {}, onCancel() {}, onReload() {}, onRetry() {}, preview: null, ...extra,
  });
  const note = /id="email-template-english-note"[^>]*>Readers in other languages get the English of this email until it is translated\./;
  assert.match(form({ dirty: true }), note);
  assert.ok(!note.test(form({ dirty: false })), 'nothing changed yet');
  const report = data.templates.find((t) => t.action === 'content_report');
  assert.ok(!note.test(form({ dirty: true, draft: draftFrom(report) })), 'an English-only email has no other languages');
  const src = read(SECTION);
  assert.match(src, /is live\. \$\{ENGLISH_UNTIL_TRANSLATED\}/, 'the save banner says it too');
});
