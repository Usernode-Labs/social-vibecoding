'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { languageFromCookie, createErrorTranslator, languageErrors } = require('../src/middleware/language-errors');

test('only supported host language cookies select a translation', () => {
  assert.equal(languageFromCookie('session=secret; homeroom_language=pt-BR'), 'pt-BR');
  assert.equal(languageFromCookie('homeroom_language=../../private'), 'en');
  assert.equal(languageFromCookie('homeroom_language=%broken'), 'en');
  assert.equal(languageFromCookie(''), 'en');
});

test('registered HTTP messages preserve parameters, while unknown and user content remain data', () => {
  const translate = createErrorTranslator({ invalid: 'Invalid request.', name: 'No user named {{value1}} was found.' }, () => ({
    invalid: 'Solicitud no válida.', name: 'No se encontró ningún usuario llamado {{value1}}.',
  }));
  assert.equal(translate('Invalid request.', 'es'), 'Solicitud no válida.');
  assert.equal(translate('No user named <script>{{value1}}</script> was found.', 'es'), 'No se encontró ningún usuario llamado <script>{{value1}}</script>.');
  assert.equal(translate('A user wrote their own message.', 'es'), 'A user wrote their own message.');
  assert.equal(translate('Invalid request.', 'en'), 'Invalid request.');
});

test('admin and machine integration responses keep their established contract', () => {
  for (const pathname of ['/api/admin/users', '/api/v4/admin/users', '/api/internal/job', '/mcp']) {
    const json = () => {};
    const res = { json };
    let next = false;
    languageErrors({ path: pathname, headers: { cookie: 'homeroom_language=es' } }, res, () => { next = true; });
    assert.equal(res.json, json);
    assert.equal(next, true);
  }
});

test('template boundaries stay bounded for long repeated input and preserve each parameter', () => {
  const translate = createErrorTranslator({
    pair: 'Cannot move {{name}} from {{from}} to {{to}}.',
    repeated: 'Invalid {{a}} x {{b}} x {{c}} x {{d}} x {{e}} x {{f}} x {{g}} end.',
  }, () => ({ pair: '{{name}}: {{from}} → {{to}}', repeated: 'Invalid {{a}}' }));
  assert.equal(translate('Cannot move My app from Draft to Done.', 'es'), 'My app: Draft → Done');
  const unknown = 'Invalid ' + ' x '.repeat(1000) + 'missing terminator';
  assert.equal(translate(unknown, 'es'), unknown);
});

test('successful JSON payloads are never passed through translation', () => {
  const body = { error: 'Invalid request.', title: 'Save', content: 'Sign in' };
  let sent;
  const res = { statusCode: 200, json(value) { sent = value; return this; } };
  languageErrors({ path: '/api/user-content', headers: { cookie: 'homeroom_language=es' } }, res, () => {});
  res.json(body);
  assert.equal(sent, body);
});
