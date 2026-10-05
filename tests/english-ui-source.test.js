'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { englishUiSource } = require('./lib/english-ui-source');

test('English source projection resolves catalog copy while retaining handlers and refs', () => {
  const source = `<Localized element={<button ref={control} disabled={busy} onClick={() => save(draft)}><Message id="core:common.close" /></button>} messages={{title:'core:common.close'}} />`;
  const result = englishUiSource(source);
  assert.match(result, />Close<\/button>/);
  for (const unchanged of ['ref={control}', 'disabled={busy}', 'onClick={() => save(draft)}']) assert.ok(result.includes(unchanged));
});

test('source projection never rewrites a business getter or invents unknown messages', () => {
  const source = `const model = { get status() { send(); return value; }, label: tr('core:missing_for_test') };`;
  assert.equal(englishUiSource(source), source);
});
