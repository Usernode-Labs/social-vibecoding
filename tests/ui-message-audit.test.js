'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scanFile } = require('../scripts/check-ui-messages');

test('UI audit detects JSX text, accessibility attributes and legacy text writers', () => {
  const findings = scanFile('frontend/src/example.tsx', `
    const view = <><button title="Save changes">Save</button><input placeholder="Your name" aria-label="Name" /></>;
    status.textContent = 'Please try again';
    confirm('Remove this app?');
  `);
  assert.deepEqual(findings.map(finding => finding.text), [
    'Save changes', 'Save', 'Your name', 'Name', 'Please try again', 'Remove this app?',
  ]);
});

test('UI audit preserves data, program values and user-generated content', () => {
  assert.deepEqual(scanFile('frontend/src/example.tsx', `
    const route = '/home';
    const type = 'community';
    const userText = <div className="text-sm font-medium">{message.content}</div>;
    const translated = <button aria-label={t('common.save')}>{t('common.save')}</button>;
    const program = <pre><code>npm run dev</code></pre>;
  `), []);
});

test('adding a new JSX text expression is covered without a baseline update', () => {
  const findings = scanFile('frontend/src/new-page.tsx', `<p>{'A newly added sentence'}</p>`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].text, 'A newly added sentence');
});
