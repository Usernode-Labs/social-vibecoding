'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { componentTags, requiredMessages } = require('../scripts/language-packs');
const { loadTsx, createElement: h, renderToHtml } = require('./lib/render-tsx');

test('plural completeness follows the target language, including Arabic and Japanese', () => {
  const source = { members_one: '{{count}} member', members_other: '{{count}} members', close: 'Close' };
  const ar = requiredMessages(source, 'ar').result;
  assert.deepEqual(Object.keys(ar).sort(), ['close', 'members_few', 'members_many', 'members_one', 'members_other', 'members_two', 'members_zero']);
  assert.equal(ar.members_few, '{{count}} members');
  assert.deepEqual(Object.keys(requiredMessages(source, 'ja').result).sort(), ['close', 'members_other']);
  assert.deepEqual(Object.keys(requiredMessages(source, 'en').result).sort(), ['close', 'members_one', 'members_other']);
});

test('rich-text catalogs can reorder components but cannot change tags or inject attributes', () => {
  assert.deepEqual(componentTags('<1>Privacy</1> and <0>terms</0>'), ['0', '1']);
  assert.throws(() => componentTags('<0>Unclosed'), /unclosed/);
  assert.throws(() => componentTags('<0><1>Wrong</0></1>'), /unbalanced/);
  assert.throws(() => componentTags('<0 href="javascript:alert(1)">Injected</0>'), /only numbered/);
});

function renderers(messages) {
  const translate = key => messages[key];
  return loadTsx('frontend/src/lib/i18n/react.tsx', { stubs: {
    'react-i18next': { useTranslation: () => ({ t: translate }) },
    './runtime': { i18n: { t: translate }, t: translate, registerNamespace: () => {} },
  } });
}

test('rich messages preserve links and render user parameters as escaped text', () => {
  const { RichMessage } = renderers({ 'core:test': '<0>Read the terms</0>, {{name}}.' });
  const html = renderToHtml(h(RichMessage, {
    id: 'core:test', values: { name: '<img src=x onerror=alert(1)>' },
    components: [h('a', { href: '/terms', className: 'existing-link' })],
  }));
  assert.equal(html, '<a href="/terms" class="existing-link">Read the terms</a>, &lt;img src=x onerror=alert(1)&gt;.');
});

test('opaque code and surrounding whitespace survive translation without extra elements', () => {
  const { RichMessage, Message } = renderers({ 'core:command': 'Run <0></0>.', 'core:close': 'Close' });
  assert.equal(renderToHtml(h(RichMessage, { id: 'core:command', components: [h('code', {}, 'npm test')] })), 'Run <code>npm test</code>.');
  assert.equal(renderToHtml(h(Message, { id: 'core:close', before: ' ', after: ' ' })), ' Close ');
});

test('fixed and computed translated props compose on the original input', () => {
  const { Localized, LocalizedDynamic } = renderers({ 'core:label': 'Search', 'core:hint': 'Find your apps' });
  const input = h('input', { id: 'search', defaultValue: 'a draft', className: 'same-field' });
  const nested = h(LocalizedDynamic, { element: input, resolve: () => ({ title: 'Computed hint' }) });
  const html = renderToHtml(h(Localized, { element: nested, messages: { 'aria-label': 'core:label', placeholder: 'core:hint' } }));
  assert.match(html, /id="search"/);
  assert.match(html, /value="a draft"/);
  assert.match(html, /title="Computed hint"/);
  assert.match(html, /aria-label="Search"/);
  assert.match(html, /placeholder="Find your apps"/);
  assert.equal((html.match(/<input/g) || []).length, 1);
});
