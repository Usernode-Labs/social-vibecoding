'use strict';

// src/services/mail/template-language.js: the logic-less renderer behind
// admin-editable email templates.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, render, placeholdersIn, TemplateSyntaxError } = require('../src/services/mail/template-language');

test('escapes in html, not in text', () => {
  assert.equal(render('{{a}}', { a: '<b>&"' }, { mode: 'html' }), '&lt;b&gt;&amp;&quot;');
  assert.equal(render('{{a}}', { a: '<b>&"' }, { mode: 'text' }), '<b>&"');
});

test('is a single pass: a value is never parsed again', () => {
  assert.equal(render('{{a}}', { a: '{{b}}', b: 'x' }, { mode: 'text' }), '{{b}}');
});

test('dollar patterns are literal', () => {
  assert.equal(render('{{a}}', { a: '$&' }, { mode: 'text' }), '$&');
  assert.equal(render('x{{a}}y', { a: "$1$'$`" }, { mode: 'text' }), "x$1$'$`y");
});

test('conditionals: empty, null, false, undefined are false; 0 is true', () => {
  const t = '{{#if a}}Y{{else}}N{{/if}}';
  for (const a of ['', null, false, undefined]) assert.equal(render(t, { a }, { mode: 'text' }), 'N');
  for (const a of [0, 'x', true]) assert.equal(render(t, { a }, { mode: 'text' }), 'Y');
  assert.equal(render('{{#unless a}}U{{/unless}}', { a: '' }, { mode: 'text' }), 'U');
  assert.equal(render('{{#unless a}}U{{else}}V{{/unless}}', { a: 1 }, { mode: 'text' }), 'V');
});

test('nested if works', () => {
  const t = '{{#if a}}A{{#if b}}B{{else}}b{{/if}}{{else}}n{{/if}}';
  assert.equal(render(t, { a: 1, b: 1 }, { mode: 'text' }), 'AB');
  assert.equal(render(t, { a: 1 }, { mode: 'text' }), 'Ab');
  assert.equal(render(t, { b: 1 }, { mode: 'text' }), 'n');
});

test('raw names are unescaped in html', () => {
  assert.equal(render('{{content}}|{{a}}', { content: '<p>x</p>', a: '<' }, { mode: 'html', raw: ['content'] }), '<p>x</p>|&lt;');
});

test('unknown value renders empty', () => {
  assert.equal(render('a{{zzz}}b', {}, { mode: 'html' }), 'ab');
  assert.equal(render('a{{n}}b', { n: null }, { mode: 'html' }), 'ab');
  assert.equal(render('{{n}}', { n: 0 }, { mode: 'html' }), '0');
});

test('syntax errors throw with offsets', () => {
  assert.throws(() => parse('hi {{#if a}}x'), (e) => e instanceof TemplateSyntaxError && typeof e.offset === 'number');
  assert.throws(() => parse('ab{{/if}}'), (e) => e instanceof TemplateSyntaxError && e.offset === 2);
  assert.throws(() => parse('x{{a b}}'), (e) => e instanceof TemplateSyntaxError && e.offset === 1);
  assert.throws(() => parse('{{else}}'), TemplateSyntaxError);
  assert.throws(() => parse('{{#if a}}{{/unless}}'), TemplateSyntaxError);
  assert.throws(() => parse('{{{a}}}'), TemplateSyntaxError);
  assert.throws(() => parse('{{a.b}}'), TemplateSyntaxError);
  assert.throws(() => parse('{{a'), TemplateSyntaxError);
  assert.throws(() => parse('{{#if a}}{{else}}{{else}}{{/if}}'), TemplateSyntaxError);
});

test('placeholdersIn includes names used only in conditions', () => {
  assert.deepEqual([...placeholdersIn('{{x}}{{#if c}}{{y}}{{/if}}{{#unless d}}z{{/unless}}')].sort(), ['c', 'd', 'x', 'y']);
});

test('lookups read own properties only', () => {
  assert.equal(render('a{{constructor}}b', {}, { mode: 'text' }), 'ab');
  assert.equal(render('{{#if toString}}Y{{else}}N{{/if}}', {}, { mode: 'text' }), 'N');
  assert.equal(render('{{constructor}}', { constructor: 'own' }, { mode: 'text' }), 'own');
});
