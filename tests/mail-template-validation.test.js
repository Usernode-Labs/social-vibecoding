'use strict';

// src/services/mail/template-validation.js: what a template or layout must be
// before the store keeps it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateTemplate, validateLayout, validateTranslation } = require('../src/services/mail/template-validation');
const { SEEDS, englishTemplate } = require('../src/db/email-template-seeds');
const { ACTIONS } = require('../src/services/mail/actions');

const LAYOUT = { html: '<div>{{#if preheader}}<span>{{preheader}}</span>{{/if}}{{content}}<p>{{why}}</p></div>', text: '{{content}}' };
const otp = (extra) => ({ name: 'Code', subject: 'Your code', preheader: '', why: 'You asked', html: '<p>{{code}}</p>', text: 'Code: {{code}}', ...extra });
const errorsOf = (result) => (result.ok ? [] : result.errors);
const hasError = (result, field, pattern) => assert.ok(
  errorsOf(result).some((e) => e.field === field && pattern.test(e.message)),
  `expected a ${field} error matching ${pattern}, got ${JSON.stringify(errorsOf(result))}`);

test('every first template and the standard layout validate as seeded', () => {
  const layout = SEEDS.layouts[0];
  assert.deepEqual(validateLayout({ name: layout.name, html: layout.html, text: layout.text }, []), { ok: true });
  for (const kind of Object.keys(ACTIONS)) {
    const t = englishTemplate(kind);
    assert.deepEqual(validateTemplate(kind, t, layout), { ok: true }, kind);
  }
});

test('a valid template passes, with or without a layout', () => {
  assert.deepEqual(validateTemplate('otp', otp(), LAYOUT), { ok: true });
  assert.deepEqual(validateTemplate('otp', otp(), null), { ok: true });
});

test('an unknown action is refused', () => {
  hasError(validateTemplate('nope', otp(), LAYOUT), 'action', /what this email is for/);
});

test('empty subject, html or text is refused, and a blank name too', () => {
  hasError(validateTemplate('otp', otp({ subject: '  ' }), LAYOUT), 'subject', /cannot be empty/);
  hasError(validateTemplate('otp', otp({ text: '' }), LAYOUT), 'text', /cannot be empty/);
  hasError(validateTemplate('otp', otp({ html: undefined }), LAYOUT), 'html', /cannot be empty/);
  hasError(validateTemplate('otp', otp({ name: ' ' }), LAYOUT), 'name', /cannot be empty/);
});

test('a template that does not parse names the field and the problem', () => {
  hasError(validateTemplate('otp', otp({ html: '<p>{{#if code}}{{code}}</p>' }), LAYOUT), 'html', /never closed/);
  hasError(validateTemplate('otp', otp({ subject: 'Code {{code' }), LAYOUT), 'subject', /Unclosed/);
});

test('unknown placeholders are refused, naming what the email can use', () => {
  const result = validateTemplate('otp', otp({ html: '<p>{{code}} {{name}}</p>' }), LAYOUT);
  hasError(result, 'html', /\{\{name\}\}/);
  hasError(result, 'html', /\{\{code\}\}/);
});

test('a required placeholder must be printed in both forms, inside a condition or not', () => {
  hasError(validateTemplate('otp', otp({ html: '<p>Hello</p>' }), LAYOUT), 'html', /\{\{code\}\}/);
  hasError(validateTemplate('otp', otp({ text: 'Hello' }), LAYOUT), 'text', /\{\{code\}\}/);
  hasError(validateTemplate('otp', otp({ html: '<p>{{#if code}}yes{{/if}}</p>' }), LAYOUT), 'html', /\{\{code\}\}/);
  assert.deepEqual(validateTemplate('waitlist_joined', { ...otp(), html: '{{#if hasCode}}<p>{{code}}</p>{{/if}}', text: '{{#if hasCode}}{{code}}{{/if}}' }, LAYOUT), { ok: true });
});

test('required placeholders count across the template and the layout it wears', () => {
  const inWhy = { name: 'Opened', subject: 'Opened', preheader: '', why: 'Stop: <a href="{{unsubscribeUrl}}">here</a>', html: '<p>Opened</p>', text: 'Opened {{unsubscribeUrl}}' };
  assert.deepEqual(validateTemplate('project_opened', inWhy, LAYOUT), { ok: true });
  hasError(validateTemplate('project_opened', inWhy, { html: '{{content}}', text: '{{content}}' }), 'html', /\{\{unsubscribeUrl\}\}/);
  hasError(validateTemplate('project_opened', inWhy, null), 'html', /\{\{unsubscribeUrl\}\}/);
});

test('unsafe HTML is refused on the field that carries it', () => {
  hasError(validateTemplate('otp', otp({ html: '<p onclick="x">{{code}}</p>' }), LAYOUT), 'html', /onclick/);
  hasError(validateTemplate('otp', otp({ why: '<script>x</script>' }), LAYOUT), 'why', /script/);
  hasError(validateTemplate('otp', otp({ preheader: '<a href="javascript:x">a</a>' }), LAYOUT), 'preheader', /script or data/);
});

test('placeholders in attributes: links only in quoted href and src, never code wording or HTML', () => {
  const opened = (html) => ({ name: 'Opened', subject: 'Opened', preheader: '', why: '', html: `${html}<a href="{{unsubscribeUrl}}">stop</a>`, text: '{{unsubscribeUrl}}' });
  assert.deepEqual(validateTemplate('project_opened', opened('<a href="{{url}}" title="{{app}}">go</a>'), LAYOUT), { ok: true });
  hasError(validateTemplate('project_opened', opened('<a href={{url}}>go</a>'), LAYOUT), 'html', /quoted/);
  hasError(validateTemplate('project_opened', opened('<a href="{{app}}">go</a>'), LAYOUT), 'html', /not a link/);
  hasError(validateTemplate('project_opened', opened('<p style="color:{{app}}">x</p>'), LAYOUT), 'html', /style/);
  hasError(validateTemplate('project_opened', opened('<p {{app}}>x</p>'), LAYOUT), 'html', /inside a tag/);
  hasError(validateTemplate('project_opened', opened('<p {{#if hasApp}}hidden{{/if}}>x</p>'), LAYOUT), 'html', /inside a tag/);
  hasError(validateTemplate('project_opened', opened('<p title="{{#if hasApp}}x{{/if}}">x</p>'), LAYOUT), 'html', /condition/);
  hasError(validateTemplate('project_opened', opened('<{{#if hasApp}}b{{/if}}>x'), LAYOUT), 'html', /tag/);
  hasError(validateTemplate('project_opened', opened('<style>p{color:{{app}}}</style>'), LAYOUT), 'html', /style/);
  const ready = (html) => ({ name: 'Ready', subject: '{{subject}}', preheader: '', why: '', html: `${html}<a href="{{unsubscribeUrl}}">stop</a>`, text: '{{unsubscribeUrl}}' });
  assert.deepEqual(validateTemplate('build_ready', ready('<p>{{lead}} {{app}}</p>'), LAYOUT), { ok: true });
  hasError(validateTemplate('build_ready', ready('<img src="https://x.example/a.png" alt="{{app}}">'), LAYOUT), 'html', /inserted as HTML/);
  hasError(validateTemplate('build_ready', ready('<p title="{{lead}}">x</p>'), LAYOUT), 'html', /inserted as HTML/);
  hasError(validateTemplate('build_ready', ready('<p title="{{subject}}">x</p>'), LAYOUT), 'html', /built in code/);
});

test('a layout needs {{content}} in both forms, outside any condition, and only its own placeholders', () => {
  assert.deepEqual(validateLayout({ name: 'L', ...LAYOUT }, []), { ok: true });
  hasError(validateLayout({ name: 'L', html: '<div></div>', text: '{{content}}' }, []), 'html', /\{\{content\}\}/);
  hasError(validateLayout({ name: 'L', html: '{{content}}', text: 'x' }, []), 'text', /\{\{content\}\}/);
  hasError(validateLayout({ name: 'L', html: '{{#if why}}{{content}}{{/if}}', text: '{{content}}' }, []), 'html', /outside/);
  hasError(validateLayout({ name: 'L', html: '{{content}}{{code}}', text: '{{content}}' }, []), 'html', /\{\{code\}\}/);
  hasError(validateLayout({ name: 'L', html: '<a href="{{why}}">x</a>{{content}}', text: '{{content}}' }, []), 'html', /attribute/);
  hasError(validateLayout({ name: 'L', html: '<iframe></iframe>{{content}}', text: '{{content}}' }, []), 'html', /iframe/);
  hasError(validateLayout({ name: '', ...LAYOUT }, []), 'name', /cannot be empty/);
});

test('a layout change that breaks a template using it names that template', () => {
  const inWhy = { id: 7, action: 'project_opened', name: 'Opened, stop link in why', subject: 'Opened', preheader: '', why: '<a href="{{unsubscribeUrl}}">stop</a>', html: '<p>Opened</p>', text: '{{unsubscribeUrl}}' };
  const result = validateLayout({ name: 'L', html: '{{content}}', text: '{{content}}' }, [inWhy]);
  assert.equal(result.ok, false);
  hasError(result, 'html', /Opened, stop link in why/);
  hasError(result, 'html', /\{\{unsubscribeUrl\}\}/);
  assert.deepEqual(result.templates, [{ id: 7, action: 'project_opened', name: 'Opened, stop link in why' }]);
});

test('a template whose framed result is over the size limit is refused', () => {
  const big = { html: `<div>${'x'.repeat(90 * 1024)}{{content}}</div>`, text: '{{content}}' };
  hasError(validateTemplate('otp', otp({ html: `<p>{{code}}${'y'.repeat(20 * 1024)}</p>` }), big), 'html', /100 KB/);
});

test('a translation is held to the same rules as its template', () => {
  assert.deepEqual(validateTranslation('otp', otp({ name: undefined }), LAYOUT), { ok: true });
  hasError(validateTranslation('otp', otp({ subject: '' }), LAYOUT), 'subject', /cannot be empty/);
  hasError(validateTranslation('otp', otp({ text: 'Votre code' }), LAYOUT), 'text', /\{\{code\}\}/);
});

test('a condition cannot open or close a raw-text element in one branch only', () => {
  const opened = (html) => ({ name: 'Opened', subject: 'Opened', preheader: '', why: '', html: `${html}<a href="{{unsubscribeUrl}}">stop</a>`, text: '{{unsubscribeUrl}}' });
  hasError(validateTemplate('project_opened', opened('<style>p{}{{#if hasApp}}</style>{{/if}}<p>x</p>'), LAYOUT), 'html', /condition|style/);
  hasError(validateTemplate('project_opened', opened('<title>{{#if hasApp}}x{{/if}}</title>'), LAYOUT), 'html', /condition/);
  hasError(validateTemplate('project_opened', opened('<textarea>{{else}}</textarea>'), LAYOUT), 'html', /./);
  hasError(validateTemplate('project_opened', opened('{{#if hasApp}}<style>{{/if}}<p>x</p></style>'), LAYOUT), 'html', /style/);
  hasError(validateTemplate('project_opened', opened('{{#unless hasApp}}</title>{{/unless}}'), LAYOUT), 'html', /title/);
  assert.deepEqual(validateTemplate('project_opened', opened('<title>Opened</title>{{#if hasApp}}<p>{{app}}</p>{{/if}}'), LAYOUT), { ok: true });
});

test('every branch of the conditions renders to safe HTML', () => {
  const opened = (html) => ({ name: 'Opened', subject: 'Opened', preheader: '', why: '', html: `${html}<a href="{{unsubscribeUrl}}">stop</a>`, text: '{{unsubscribeUrl}}' });
  // Only the path with hasApp true closes the title early and lets a tag out.
  hasError(validateTemplate('project_opened', opened('<title>x{{#if hasApp}}</title><iframe>{{/if}}</title>'), LAYOUT), 'html', /./);
  hasError(validateTemplate('project_opened', opened('<a href="https://x.example/{{#if hasApp}}a{{/if}}">x</a>'), LAYOUT), 'html', /condition/);
  const { branchProblem } = require('../src/services/mail/template-validation');
  assert.match(branchProblem('{{#if a}}<style>{{/if}}<p>x</p>{{#unless a}}</style>{{/unless}}@import "y";'), /@import/);
  assert.equal(branchProblem('{{#if a}}<p>{{a}}</p>{{else}}<i>none</i>{{/if}}'), null);
  hasError(validateLayout({ name: 'L', html: '{{content}}{{#if why}}<style>{{/if}}', text: '{{content}}' }, []), 'html', /style/);
});

test('a required placeholder counts only where it is sure to print', () => {
  const t = (o) => ({ name: 'n', subject: 's', preheader: '', why: '', ...o });
  hasError(validateTemplate('project_opened', t({ html: '<p>Hi</p>{{#if hasApp}}<a href="{{unsubscribeUrl}}">Unsub</a>{{/if}}', text: 'Hi {{#if hasApp}}{{unsubscribeUrl}}{{/if}}' }), null), 'html', /\{\{unsubscribeUrl\}\}/);
  hasError(validateTemplate('otp', t({ html: '<p>{{#unless code}}{{code}}{{/unless}}</p>', text: '{{#unless code}}{{code}}{{/unless}}' }), null), 'html', /\{\{code\}\}/);
  const gated = { html: '<div>{{content}}{{#if preheader}}{{why}}{{/if}}</div>', text: '{{content}}\n{{#if preheader}}{{why}}{{/if}}' };
  hasError(validateTemplate('project_opened', t({ html: '<p>Hi</p>', text: 'Hi {{unsubscribeUrl}}', why: '<a href="{{unsubscribeUrl}}">u</a>' }), gated), 'html', /\{\{unsubscribeUrl\}\}/);
  hasError(validateTemplate('otp', t({ html: '<!-- {{code}} --><p>x</p>', text: '{{code}}' }), null), 'html', /comment/);
  // The same name, a flag that means the same, or both branches: sure.
  assert.deepEqual(validateTemplate('otp', t({ html: '{{#if code}}<p>{{code}}</p>{{/if}}', text: '{{code}}' }), null), { ok: true });
  assert.deepEqual(validateTemplate('project_opened', t({ html: '{{#if hasUnsubscribeUrl}}<a href="{{unsubscribeUrl}}">u</a>{{/if}}', text: '{{unsubscribeUrl}}' }), null), { ok: true });
  assert.deepEqual(validateTemplate('project_opened', t({ html: '{{#if hasApp}}<a href="{{unsubscribeUrl}}">u</a>{{else}}<a href="{{unsubscribeUrl}}">stop</a>{{/if}}', text: '{{unsubscribeUrl}}' }), null), { ok: true });
  assert.deepEqual(validateTemplate('project_opened', t({ html: '<p>Hi</p>', text: 'Hi {{unsubscribeUrl}}', why: '<a href="{{unsubscribeUrl}}">u</a>' }), { html: '{{content}}{{#if why}}<p>{{why}}</p>{{/if}}', text: '{{content}}' }), { ok: true });
});

test('conditions can hide nothing from the check: no markers in comments, and at most 8 names a field', () => {
  const names = ['url', 'hasAccount', 'hasSignInLink', 'needsCodeNote', 'hasIos', 'iosLink', 'hasAndroid', 'androidLink', 'hasMobile'];
  assert.equal(names.length, 9);
  const openers = '{{#if hasAccount}}<!x{{/if}}{{#unless hasSignInLink}}<!x{{/unless}}{{#if needsCodeNote}}<!x{{/if}}{{#unless hasIos}}<!x{{/unless}}'
    + '{{#if url}}{{/if}}{{#if iosLink}}{{/if}}{{#if hasAndroid}}{{/if}}{{#if androidLink}}{{/if}}{{#if hasMobile}}{{/if}}';
  const html = '<p><a href="{{url}}">Sign in</a></p>' + openers + ' <img src="https://x.test/a.png" onerror="alert(1)">';
  const result = validateTemplate('waitlist_released', { name: 'n', subject: 's', preheader: '', why: '', html, text: '{{url}}' }, null);
  hasError(result, 'html', /comment/);
  const many = names.map((n) => `{{#if ${n}}}<b>${n}</b>{{/if}}`).join('');
  hasError(validateTemplate('waitlist_released', { name: 'n', subject: 's', preheader: '', why: '', html: `<a href="{{url}}">x</a>${many}`, text: '{{url}}' }, null), 'html', /more than 8/);
});

test('nothing in a title or textarea may be a placeholder', () => {
  const opened = (html) => ({ name: 'n', subject: 's', preheader: '', why: '', html: `${html}<a href="{{unsubscribeUrl}}">stop</a>`, text: '{{unsubscribeUrl}}' });
  hasError(validateTemplate('project_opened', opened('<title>x</tit{{app}}<img src=x onerror=1></title>'), LAYOUT), 'html', /title/);
  hasError(validateTemplate('project_opened', opened('<textarea>{{app}}</textarea>'), LAYOUT), 'html', /textarea/);
});

test('an error that is not a template mistake is not shown to the admin', (t) => {
  const render = require('../src/services/mail/render');
  const log = require('../src/services/logger');
  const logged = t.mock.method(log, 'error', () => {});
  t.mock.method(render, 'renderMessage', () => { throw new Error('internal detail /srv/app'); });
  const result = validateTemplate('otp', otp(), LAYOUT);
  assert.equal(result.ok, false);
  assert.ok(result.errors.every((e) => !e.message.includes('internal detail')));
  assert.equal(logged.mock.callCount(), 1);
});
