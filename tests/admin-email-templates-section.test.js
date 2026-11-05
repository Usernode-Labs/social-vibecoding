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
const PARTS = ['list', 'editor', 'layouts', 'replace-dialog', 'preview', 'shared']
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
      locales: action === 'otp' ? Array.from({ length: 12 }, (_, i) => `l${i}`) : [],
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
    languages: [{ code: 'en', label: 'English' }, { code: 'fr', label: 'Français' }],
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
  assert.match(html, /data-email-action="otp"[\s\S]*?Sign-in code \(OTP\)[\s\S]*?v3[\s\S]*?Live[\s\S]*?12 languages[\s\S]*?2 days ago/);
  assert.match(html, /data-email-action="password_reset"[\s\S]*?English only[\s\S]*?Original/);
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
  assert.match(src, /setBanner\(\{ kind: 'ok', text: deletedText\(dialog\.kind, gone, res\.data, fresh\) \}\)/);
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
    assert.match(src, /const dirty = isDirty\(draft, opened\);\s*useUnloadGuard\(dirty\);/, `${file}: closing the tab asks while dirty`);
    assert.match(src, /if \(dirty && !\(await confirmDiscard\('[^']+'\)\)\) return;\s*settled\.current = true;\s*onDone\(\);/, `${file}: Back and Cancel ask`);
    assert.match(src, /if \(dirty && !\(await confirmDiscard\('Reload discards your changes[^']*', 'Reload'\)\)\) return;/, `${file}: Reload asks`);
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
  assert.match(editor, /keepDraft\(\{ kind: 'template', action, isNew, label: name, draft: latest\.current\.draft, opened, openedLiveId: openedLive\.id \}\)/);
  assert.match(editor, /request\('\/api\/admin\/email-templates', 'POST', \{ \.\.\.draft, expectedLiveId \}\)/);
  const layouts = read('frontend/src/features/admin/email-templates/layouts.tsx');
  assert.match(layouts, /useState<number \| null>\(\(\) => \(restore \? restore\.openedLiveId : live \? live\.id : null\)\)/);
  assert.match(layouts, /expectedLiveId: openedLiveId,/);
  assert.match(layouts, /draft: latest\.current\.draft, opened, openedLiveId \}\)/);
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
