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
  assert.match(withPhone, /Or link both GitHub and X in <a href="#settings\/linked-accounts" data-verify-identity-settings=""[^>]*>Settings<\/a>/);
  // "Not now" is the first-run step's, never the vote's.
  assert.doesNotMatch(withPhone, /data-verify-identity-not-now/);
  const without = renderToHtml(createElement(mod.VerifyIdentityBody, { phoneOffered: false, onVerified() {}, onSettings() {} }));
  assert.doesNotMatch(without, /data-add-phone/);
  assert.match(without, />Verify to vote on public apps</);
  assert.match(without, /Link both GitHub and X in <a href="#settings\/linked-accounts"/);
  assert.match(without, /Votes on public apps count from verified accounts, so each person votes once\./);
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

test('the first-run phone step: on a phone, with "Not now", before the make screen and the join screen', () => {
  const step = read('frontend/src/features/auth/phone-first-run.tsx');
  // Who: held to the rule (`phoneAsk`), let in, and on a phone.
  assert.match(step, /export function comesFirst\(user: AskUser\): boolean \{\s+return !!user && user\.phoneAsk === true && user\.hasPlatformAccess !== false && onPhone\(\);/);
  assert.match(step, /if \(isNative\(\)\) return true;\s+return typeof window\.matchMedia === 'function' && window\.matchMedia\(MOBILE_PAGE_QUERY\)\.matches;/);
  // After the terms, with "Not now"; any answer but a phone is recorded.
  assert.match(step, /inFlight = true;\s+await afterTerms\(\);/);
  assert.match(step, /openVerifySheet\(\{ copy: PHONE_STEP_COPY, notNow: true \}\)/);
  assert.match(step, /\} else if \(outcome !== 'unavailable'\) \{\s+noteAnswered\(\);\s+void recordAnswered\(\);/);
  // The join screen and the story's make flag wait on it.
  const join = read('frontend/src/features/auth/communities-first-run.js');
  assert.match(join, /&& !CommunitiesFirstRun\._phoneFirst\(user\)\s+&& !CommunitiesFirstRun\._onInvitePath\(\)\);/);
  assert.match(join, /const phone = window\.PhoneFirstRun;\s+if \(phone && typeof phone\.settled === 'function'\) \{\s+try \{ await phone\.settled\(\); \}/);
  const make = read('frontend/src/features/first-session/index.tsx');
  assert.match(make, /if \(now && phone\?\.comesFirst\?\.\(legacy\(\)\.App\?\.user\)\) \{\s+void phone\.settled\(\)\.then\(\(\) => check\(false\)\);\s+return;\s+\}/);
  // Imported before the join screen, and asked again after a snapshot boot.
  const main = read('frontend/src/main.tsx');
  assert.ok(main.indexOf("import './features/auth/phone-first-run';") < main.indexOf("import './features/auth/communities-first-run.js';"));
  assert.match(read('public/js/app.js'), /window\.TermsFirstRun\?\.maybePrompt\?\.\(\);[\s\S]{0,400}window\.PhoneFirstRun\?\.maybePrompt\?\.\(\);[\s\S]{0,900}window\.CommunitiesFirstRun\?\.maybePrompt\?\.\(\);/);
  // The server: who is asked, and the answer.
  const auth = read('src/routes/auth.js');
  assert.match(auth, /identityNeeded = rows\[0\]\?\.identity_needed === true && !!req\.user\.hasPlatformAccess;\s+phoneAsk = identityNeeded && rows\[0\]\?\.phone_ask_answered !== true && phoneAuth\.offered\(config\);/);
  assert.match(read('src/routes/onboarding.js'), /router\.post\('\/api\/me\/phone-ask\/answered', drainGuard, sameOriginBrowserOnly, async[\s\S]{0,200}SET phone_ask_answered_at = COALESCE\(phone_ask_answered_at, NOW\(\)\)/);
});

test('the step asks only on a phone, and the bodies say why', () => {
  const saved = { window: global.window, document: global.document };
  let phone = true;
  const listeners = { addEventListener() {}, removeEventListener() {} };
  global.window = { ...listeners, matchMedia: () => ({ matches: phone, ...listeners }) };
  global.document = { ...listeners, documentElement: { classList: { contains: () => false } } };
  try {
    // browser-scroll installs its scroll controller on import; the query is all this needs.
    const mod = loadTsx('frontend/src/features/auth/phone-first-run.tsx', {
      stubs: { '../../lib/browser-scroll': { MOBILE_PAGE_QUERY: '(max-width: 767px), (hover: none) and (pointer: coarse)' } },
    });
    assert.match(read('frontend/src/lib/browser-scroll.ts'), /export const MOBILE_PAGE_QUERY = '\(max-width: 767px\), \(hover: none\) and \(pointer: coarse\)';/);
    assert.equal(typeof global.window.PhoneFirstRun.settled, 'function', 'published for the legacy steps');
    assert.equal(mod.comesFirst({ phoneAsk: true, hasPlatformAccess: true }), true);
    assert.equal(mod.comesFirst({ phoneAsk: false, hasPlatformAccess: true }), false);
    assert.equal(mod.comesFirst({ phoneAsk: true, hasPlatformAccess: false }), false);
    assert.equal(mod.comesFirst(null), false);
    phone = false;
    assert.equal(mod.comesFirst({ phoneAsk: true, hasPlatformAccess: true }), false, 'a computer gets the Home card instead');
    global.window.usernode = { isNative: true };
    assert.equal(mod.comesFirst({ phoneAsk: true, hasPlatformAccess: true }), true, 'the native app is a phone');
    const verify = loadTsx('frontend/src/features/auth/verify-identity.tsx');
    const html = renderToHtml(createElement(verify.VerifyIdentityBody, {
      phoneOffered: true, copy: mod.PHONE_STEP_COPY, onVerified() {}, onSettings() {}, onNotNow() {},
    }));
    assert.match(html, />Add your phone number</);
    assert.match(html, /Verified accounts vote on public apps and get the full AI budget, so each person counts once\. Nobody sees your number\./);
    assert.match(html, /<button type="button" data-verify-identity-not-now=""[^>]*>Not now<\/button>/);
  } finally {
    if (saved.window === undefined) delete global.window; else global.window = saved.window;
    if (saved.document === undefined) delete global.document; else global.document = saved.document;
  }
});

test('Home\'s card: for a member held to the rule, after the shell knows, hidden here by "Not now"', () => {
  const card = read('frontend/src/features/home/verify-card.tsx');
  assert.match(card, /const \{ identityNeeded \} = useStoreState\(navStore\);/);
  assert.match(card, /if \(!identityNeeded \|\| hidden \|\| phoneOffered === null\) return null;/);
  assert.match(card, /<section id="home-verify-card"/);
  assert.match(card, /onVerified=\{noteVerified\}/);
  assert.match(read('frontend/src/features/home/index.tsx'), /<WaitlistCard \/>[\s\S]{0,300}<VerifyCard \/>/);
  assert.match(read('public/js/app.js'), /window\.UsernodeReact\?\.nav\?\.setIdentityNeeded\?\.\(!!App\.user\?\.identityNeeded\);/);
  const { VerifyCard } = loadTsx('frontend/src/features/home/verify-card.tsx');
  assert.equal(renderToHtml(createElement(VerifyCard)), '', 'nothing in the prerender');
});

test('the rollout: production only, once, and the tiers first', () => {
  const rollout = require('../src/services/identity-rollout');
  assert.equal(rollout.applies({ NODE_ENV: 'production' }), true);
  assert.equal(rollout.applies({ NODE_ENV: 'production', USERNODE_ENV: 'staging' }), false);
  assert.equal(rollout.applies({ NODE_ENV: 'test' }), false);
  assert.equal(rollout.applies({}), false);
  assert.equal(rollout.UNVERIFIED_WEEKLY_CENTS, 2000);
  assert.match(read('src/db/migrate.js'), /await require\('\.\.\/services\/identity-rollout'\)\.applyIdentityRollout\(pool\);/);
});
