'use strict';

// The VERIFIED-IDENTITY rule's routes and shell: the vote routes refuse an
// unverified vote on a public app before anything is recorded, the Vote
// buttons open the verify sheet instead of a toast, and Admin, Limits holds
// the switch and the phone tier's cap. The rule itself, against the full
// schema, is tests/verified-identity-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('the vote routes refuse an unverified vote on a public app, after the private-member refusal', () => {
  const votes = read('src/routes/votes.js');
  const sessionVote = votes.slice(votes.indexOf("router.post('/api/sessions/:id/vote'"));
  assert.match(sessionVote, /if \(privateRefusal\) return res\.status\(403\)\.json\(privateRefusal\);\s+\/\/ A public app's vote counts from a verified account \(communities\.js\)\.\s+const identityRefusal = await communities\.identityVoteRefusal\(pool, session\.app_id, req\.user\?\.id\);\s+if \(identityRefusal\) return res\.status\(403\)\.json\(identityRefusal\);/);
  const issues = read('src/routes/issues.js');
  const issueVote = issues.slice(issues.indexOf("router.post('/api/issues/:id/vote'"));
  assert.match(issueVote, /if \(privateRefusal\) return res\.status\(403\)\.json\(privateRefusal\);\s+\/\/ A public app's vote counts from a verified account \(communities\.js\)\.\s+const identityRefusal = await communities\.identityVoteRefusal\(pool, issue\.app_id, req\.user\?\.id\);\s+if \(identityRefusal\) return res\.status\(403\)\.json\(identityRefusal\);/);
});

test('identityVoteRefusal asks the schema, and says what verifies', async () => {
  const communities = require('../src/services/communities');
  const asked = [];
  const pool = (needs) => ({ query: async (sql, params) => { asked.push({ sql, params }); return { rows: [{ needs }] }; } });
  assert.equal(await communities.identityVoteRefusal(pool(false), 7, 3), null);
  assert.deepEqual(asked[0].params, [3, 7]);
  assert.match(asked[0].sql, /public_vote_needs_identity\(\$1, \$2\)/);
  const refusal = await communities.identityVoteRefusal(pool(true), 7, 3);
  assert.equal(refusal.code, 'identity_required');
  assert.match(refusal.error, /Verify your phone number, or link both GitHub and X in Settings\./);
  // Nobody signed in, or no app: nothing to ask.
  assert.equal(await communities.identityVoteRefusal(pool(true), 7, null), null);
  assert.equal(asked.length, 2);
});

test('the Vote buttons open the verify sheet on identity_required, and vote again once verified', () => {
  const src = read('public/js/app-view.js');
  assert.match(src, /_verifyThenVote\(again\) \{\s+const ask = window\.UsernodeReact\?\.verifyIdentity\?\.ask;\s+if \(typeof ask !== 'function'\) return false;\s+void Promise\.resolve\(ask\(\)\)\.then\(\(verified\) => \{ if \(verified\) again\(\); \}\);\s+return true;\s+\},/);
  const castVote = src.slice(src.indexOf('async castVote('), src.indexOf('async castIssueVote('));
  assert.match(castVote, /await AppView\.refreshDevData\('vote'\);\s+\/\/ A public app's vote[^\n]*\n[^\n]*\n\s+if \(data\.code === 'identity_required' && AppView\._verifyThenVote\(\s+\(\) => AppView\.castVote\(sessionId, vote, expectedEpoch, opts\)\)\) return false;/);
  const castIssueVote = src.slice(src.indexOf('async castIssueVote('));
  assert.match(castIssueVote, /finish\(\);\s+\/\/ A public app's vote counts from a verified account \(castVote\)\.\s+if \(data\.code === 'identity_required' && AppView\._verifyThenVote\(\s+\(\) => AppView\.castIssueVote\(issueId, vote, opts\)\)\) \{\s+AppView\.refreshDevData\('vote'\);\s+return;\s+\}/);
  // The bridge is published at module scope, imported by the entry.
  assert.match(read('frontend/src/main.tsx'), /\nimport '\.\/features\/auth\/verify-identity';/);
  assert.match(read('frontend/src/features/auth/verify-identity.tsx'), /bridge\.verifyIdentity = \{ ask: askToVerifyIdentity \};/);
});

test('the verify sheet: the phone where it is offered, GitHub and X in Settings always', () => {
  const mod = loadTsx('frontend/src/features/auth/verify-identity.tsx');
  const withPhone = renderToHtml(createElement(mod.VerifyIdentityBody, { phoneOffered: true, onVerified() {}, onSettings() {} }));
  assert.match(withPhone, /data-add-phone="phone"/);
  assert.match(withPhone, />Verify to vote on public apps</);
  assert.match(withPhone, /Add your phone number to vote now\. Nobody sees your number\./);
  assert.match(withPhone, /Or link both GitHub and X in <a href="#settings" data-verify-identity-settings=""[^>]*>Settings<\/a>/);
  const without = renderToHtml(createElement(mod.VerifyIdentityBody, { phoneOffered: false, onVerified() {}, onSettings() {} }));
  assert.doesNotMatch(without, /data-add-phone/);
  assert.match(without, />Verify to vote on public apps</);
  assert.match(without, /Link both GitHub and X in <a href="#settings"/);
  // No kit, no sheet: the caller toasts the server's words instead.
  return mod.askToVerifyIdentity().then((verified) => assert.equal(verified, false));
});

test('the add-phone card keeps its own words unless the verify sheet passes others', () => {
  const { AddPhoneCard } = loadTsx('frontend/src/features/auth/add-phone.tsx');
  const join = renderToHtml(createElement(AddPhoneCard, { groups: ['Best brunch spots'], onJoined() {} }));
  assert.match(join, />Join Best brunch spots now</);
  const verify = renderToHtml(createElement(AddPhoneCard, { groups: [], title: 'T', lead: 'L', onJoined() {} }));
  assert.match(verify, />T<\/h2>/);
  assert.match(verify, />L<\/p>/);
});

test('Admin, Limits: the switch records its time once, and the phone tier has a cap', () => {
  const admin = read('src/routes/admin.js');
  assert.match(admin, /const \{ user, weekly, global, system, weeklySocial, weeklyZk, weeklyPhone, identityRule \} = req\.body \|\| \{\};/);
  assert.match(admin, /if \(identityRule !== undefined && typeof identityRule !== 'boolean'\) \{\s+return res\.status\(400\)/);
  assert.match(admin, /if \(identityRule === false\) clears\.push\(limits\.KEY_IDENTITY_RULE_SINCE\);/);
  // A second "on" must not move the date that decides who is exempt.
  assert.match(admin, /if \(identityRule === true\) \{\s+await pool\.query\(\s+`INSERT INTO platform_settings \(key, value, updated_at, updated_by\)\s+VALUES \(\$1, \$2, NOW\(\), \$3\)\s+ON CONFLICT \(key\) DO NOTHING`,\s+\[limits\.KEY_IDENTITY_RULE_SINCE, new Date\(\)\.toISOString\(\), req\.user\.id\]/);
  assert.match(admin, /user_weekly_limit_phone_cents: weeklyPhone,\s+identity_rule_since: identityRuleSince,/);
  const ui = read('frontend/src/features/admin/admin-limits.tsx');
  assert.match(ui, /id="admin-limit-weekly-phone"/);
  assert.match(ui, /id="admin-identity-rule"/);
  // Only a change of the switch is sent, so saving a cap never re-dates it.
  assert.match(ui, /if \(ruleOn !== !!ruleSince\) body\.identityRule = ruleOn;/);
});
