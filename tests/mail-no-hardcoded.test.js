'use strict';

// "There should not be any hard coded template." Every email's words are the
// stored templates, written and translated in the admin console. The code keeps
// only what the owner decided stays there:
//   - the plain message of the failure order, just the code or the link
//     (src/services/mail/plain-message.js);
//   - the words build_ready and invite_activity build from what their sender
//     hands over (src/services/mail/actions.js, from the email catalog);
//   - content_report's subject, built from the report (actions.js).
// The first templates a fresh database gets are data
// (src/db/email-template-seeds.js), not code that renders.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const MARKUP = /<(p|a|table|tr|td|div|br|strong|img|body|html|!doctype|h[1-6]|span|b|em|ul|li)\b/i;
// Line and block comments may name tags; only the code is scanned.
const codeOf = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
const mailFiles = (dir = 'src/services/mail') => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
  .flatMap((entry) => (entry.isDirectory() ? mailFiles(`${dir}/${entry.name}`) : entry.name.endsWith('.js') ? [`${dir}/${entry.name}`] : []));
const EMAIL_ID = /['"`]email:[A-Za-z0-9_.-]+['"`]/g;

const ALLOWED_IDS = [
  'buildReady.lead.notWorking', 'buildReady.lead.ready', 'buildReady.subject.notWorking', 'buildReady.subject.ready', 'buildReady.unnamedProject',
  'inviteActivity.firstMessage', 'inviteActivity.joined', 'inviteActivity.joinedSomeone', 'inviteActivity.joinedUnnamed',
];

test('templates.js renders the stored templates and writes no markup or words of its own', () => {
  const source = read('src/services/mail/templates.js');
  assert.ok(!MARKUP.test(source), 'markup in templates.js');
  assert.deepEqual(source.match(EMAIL_ID) || [], [], 'a catalog id in templates.js');
  for (const gone of ['TEMPLATES', 'ENGLISH_ONLY_KINDS', 'wordedTemplate', 'lastResort', 'HTML_SHELL']) {
    assert.ok(!source.includes(gone), gone);
  }
});

test('the code that renders and sends has no markup but the plain message\'s', () => {
  // Tracking's own: the link rewrite reads anchors, and the open pixel is an image,
  // neither of them words a mail.
  const ALLOWED = {
    'src/services/mail/tracking.js': [/\/\(<a\\b\[\^>\]\*\\bhref="\)/, /`<img src="\$\{PRODUCTION_ORIGIN\}\/mail\/o\/[^`]*`/],
  };
  const files = [...mailFiles().filter((file) => !file.endsWith('/plain-message.js')), 'src/services/activity-mail.js'];
  assert.ok(files.includes('src/services/mail/templates.js') && files.includes('src/services/mail/transports/brevo.js'));
  for (const file of files) {
    let code = codeOf(read(file));
    for (const allowed of ALLOWED[file] || []) {
      assert.match(code, allowed, `${file} still has what it is allowed`);
      code = code.replace(allowed, '');
    }
    assert.ok(!MARKUP.test(code), file);
  }
  const plain = read('src/services/mail/plain-message.js');
  assert.deepEqual(plain.match(EMAIL_ID) || [], [], 'the plain message reads no catalog');
  // Its only words are the brand's: the code and the links are the message.
  const code = plain.replace(/^\s*\/\/.*$/gm, '');
  const strings = [...code.matchAll(/'([^'\\\n]*)'/g)].map((m) => m[1]).filter((s) => /[A-Za-z]{3}/.test(s) && !/^\.\/|^use strict$/.test(s));
  assert.deepEqual(strings.filter((s) => !/^(Homeroom|#[0-9a-f]{6}|&amp;|&lt;|&gt;|&quot;|unsubscribeUrl)$/.test(s)), []);
});

test('the only email catalog ids in the code are the words built in code', () => {
  const ids = new Set();
  for (const file of ['src/services/mail/actions.js', 'src/services/activity-mail.js', 'src/services/mail/render.js', 'src/services/mail/index.js']) {
    for (const match of read(file).match(EMAIL_ID) || []) ids.add(match.slice(7, -1));
  }
  assert.deepEqual([...ids].sort(), ALLOWED_IDS);
  const catalog = JSON.parse(read('frontend/locales/en/email.json'));
  assert.deepEqual(Object.keys(catalog).sort(), ALLOWED_IDS, 'the email catalog holds those and nothing else');
});

test('the seeds are words, with no catalog reference left to expand', () => {
  const source = read('src/db/email-template-seeds.js');
  assert.deepEqual(source.match(/\{\{t:/g) || [], []);
  assert.deepEqual(source.match(EMAIL_ID) || [], []);
});
