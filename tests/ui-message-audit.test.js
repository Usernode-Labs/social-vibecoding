'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scanFile } = require('../scripts/check-ui-messages');

test('message IDs cannot be assembled in templates that bypass catalog validation', () => {
  const catalogs = { workshop: { who_members_both: 'both active members' } };
  const findings = scanFile('frontend/src/example.tsx', 'tr(`workshop:who_${kind}_both`);', catalogs);
  assert.equal(findings.length, 1);
  assert.match(findings[0].kind, /computed message key/);
  assert.match(scanFile('frontend/src/example.tsx', 'const id = `workshop:who_${kind}_both`;', catalogs)[0].kind,
    /computed message key/, 'storing the key in a variable cannot hide it');
  const explicit = scanFile('frontend/src/example.tsx',
    "tr(member ? 'workshop:who_members_both' : 'workshop:who_approvers_both');", catalogs);
  assert.deepEqual(explicit.map(f => f.text), ['workshop:who_approvers_both']);
});

test('the platform tree contains no uncatalogued ordinary UI text', () => {
  const root = require('node:path').join(__dirname, '..');
  require('../scripts/check-ui-messages').checkMessages(root);
  require('../scripts/server-messages').checkServerMessages(root);
});

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

test('menu-row subtitles require catalog entries too', () => {
  const findings = scanFile('frontend/src/example.tsx', '<MenuRow sub="Build with a coding agent" />');
  assert.deepEqual(findings.map(f => f.text), ['Build with a coding agent']);
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

test('dynamic UI branches and message properties cannot introduce untranslated text', () => {
  const findings = scanFile('frontend/src/new-page.tsx', `
    const view = <button title={busy ? 'Working now' : 'Try again'}>{busy ? 'Wait' : 'Continue'}</button>;
    const item = { label: ready ? 'Ready to go' : 'Wait here' };
    toast('Failed to save');
    status.textContent = count + ' open requests';
  `);
  for (const expected of ['Working now', 'Try again', 'Wait', 'Continue', 'Ready to go', 'Wait here', 'Failed to save', 'open requests']) {
    assert.ok(findings.some(item => item.text === expected), expected);
  }
});

test('HTML entities and technical selectors are not untranslated UI', () => {
  assert.deepEqual(scanFile('frontend/src/example.tsx', `
    const close = <span>&times;</span>;
    const path = <span>{'/app/' + slug}</span>;
    const ids = { error: 'attachment-error' };
  `), []);
});

test('legacy HTML text and accessibility labels require catalog entries', () => {
  const findings = scanFile('public/js/example.js', `
    host.innerHTML = '<button aria-label="Open menu">Options</button>';
    const prompt = 'Create a proposal for <app name> that <does something>';
    throw new Error('<Tabs> must be rendered inside <TabsRoot>');
  `);
  assert.deepEqual(findings.map(f => f.text).sort(), ['Open menu', 'Options']);
});

test('localized render functions and English fragments in message parameters are audited', () => {
  const findings = scanFile('frontend/src/example.tsx', `
    const node = <LocalizedValue render={() => (ready ? 'Ready now' : user.content)} />;
    tr('core:requests', { value1: count === 1 ? 'request' : 'requests' });
  `);
  assert.deepEqual(findings.map(f => f.text), ['Ready now', 'request', 'requests']);
});

test('public consent pages require explicit catalog owners', () => {
  const { scanHtml } = require('../scripts/check-ui-messages');
  const catalogs = { authorization: { approve: 'Approve' } };
  assert.deepEqual(scanHtml('consent.html', '<h1 data-message="authorization:approve">Approve</h1>', catalogs), []);
  assert.equal(scanHtml('consent.html', '<button>New action</button>', catalogs)[0].kind, 'HTML text');
  assert.equal(scanHtml('consent.html', '<button data-message="authorization:missing">Approve</button>', catalogs)[0].kind, 'unknown message key');
});

test('a misspelled namespace cannot bypass the message-key check', () => {
  const findings = scanFile('frontend/src/example.tsx', `
    tr('corre:save');
    const node = <RichMessage id={ready ? 'corre:ready' : 'core:save'} />;
    const protocolValue = 'custom:value';
  `, { core: { save: 'Save' } });
  assert.deepEqual(findings.map(f => f.text), ['corre:save', 'corre:ready']);
  assert.ok(findings.every(f => f.kind === 'unknown message key'));
});
