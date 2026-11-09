'use strict';

// Admin › Journey: how people came in. The waitlist row's facts, the
// "You're in" mail's own page, which admit mail led in, how the account
// signed up, and the "Invited, not let in yet" cohort. The SQL runs in the
// *-postgres suites; these pin the pure parts and the shapes the readers
// depend on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const journey = require('../src/services/journey');
const releaseLinks = require('../src/services/release-links');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const flat = (sql) => sql.replace(/\s+/g, ' ');
const at = (iso) => new Date(iso);

const admitted = (extra = {}) => ({
  released_at: '2026-11-06T14:35:00Z', mail_status: 'sent', mail_at: '2026-11-06T14:35:01Z',
  user_id: null, ...extra,
});

test('the mail\'s page is a step of its own, between the mail and following it', () => {
  assert.deepEqual(journey.FIRST_MILE_STEPS.slice(0, 4), ['admitted', 'mail_sent', 'mail_page', 'code_asked']);
  const now = at('2026-11-07T12:00:00Z');
  const since = '2026-11-01T00:00:00Z';

  const opened = journey.firstMileSteps(admitted({
    mail_page_since: since, mail_page_at: '2026-11-06T14:52:00Z', mail_page_outcome: 'link_used',
  }), now);
  const page = opened.steps.find((s) => s.key === 'mail_page');
  assert.equal(page.state, 'done');
  assert.equal(page.note, 'link already used');
  assert.equal(opened.stuckAt, 'code_asked', 'opened, then stopped: the link did not work');

  const never = journey.firstMileSteps(admitted({ mail_page_since: since }), now);
  assert.equal(never.stuckAt, 'mail_page');
  assert.equal(never.stuckReason, "Never opened the mail's page");

  // A mail sent before the page's opens were recorded says nothing either way.
  const before = journey.firstMileSteps(admitted({ mail_page_since: '2026-11-07T00:00:00Z' }), now);
  const unknown = before.steps.find((s) => s.key === 'mail_page');
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.unrecorded, true);
  assert.equal(before.stuckAt, 'code_asked', 'not where they stopped');
  // Nor for somebody who had an account when let in: their mail opens plain
  // sign-in, with no token to say so.
  const hadAccount = journey.firstMileSteps(admitted({ mail_page_since: since, user_id: 4, account_at: '2026-09-01T00:00:00Z' }), now)
    .steps.find((s) => s.key === 'mail_page');
  assert.deepEqual([hadAccount.state, hadAccount.note], ['unknown', 'Had an account: the mail opens sign-in']);
  const counts = journey.firstMileCounts([{ ...before }]);
  assert.equal(counts.find((c) => c.key === 'mail_page').passed, 0, 'and not counted as past it');
  assert.equal(counts.find((c) => c.key === 'mail_page').unrecorded, 1, 'but counted as not recorded');
  assert.equal(counts.find((c) => c.key === 'mail_sent').unrecorded, 0);

  assert.deepEqual(Object.keys(journey.MAIL_PAGE_NOTES).sort(),
    ['link_expired', 'link_used', 'opened', 'signed_in', 'welcome']);
});

test('how they came in: waitlist facts, the mail\'s page, which send, how they signed up', () => {
  const facts = journey.cameInFacts({
    released_at: '2026-11-06T14:35:00Z', waitlist_joined_at: '2026-08-14T10:00:00Z',
    waitlist_source: 'partner:landing', waitlist_discovery: 'friend', answered_follow_up: true,
    waitlist_referred: false, waitlist_project_invite: true,
    mail_page_at: '2026-11-08T09:10:00Z', mail_page_outcome: 'signed_in',
    mail_link_at: '2026-11-08T09:10:00Z', mail_sends_before_follow: 2, signup_method: 'mail_link',
  });
  assert.equal(facts.signupMethod, 'mail_link');
  assert.equal(facts.waitlist.waitedDays, 84);
  assert.equal(facts.waitlist.source, 'partner:landing');
  assert.equal(facts.waitlist.answeredFollowUp, true);
  assert.equal(facts.waitlist.projectInvite, true);
  assert.deepEqual(facts.mailPage, { at: at('2026-11-08T09:10:00Z'), outcome: 'signed_in' });
  assert.equal(facts.fromEmail, 2, 'the second send led in');
  assert.equal(facts.invite, null);

  const quiet = journey.cameInFacts({});
  assert.deepEqual(quiet, { signupMethod: null, waitlist: null, mailPage: null, fromEmail: null, invite: null },
    'nothing invented where nothing says');
  assert.equal(journey.cameInFacts({ mail_sends_before_follow: 1 }).fromEmail, null, 'no send led in until one was followed');
});

test('the invited cohort: the invite link, not the admit mail', () => {
  assert.deepEqual(journey.INVITED_MILE_STEPS, ['invite_opened', 'signed_up', 'joined', 'opened', 'first_act', 'let_in']);
  const now = at('2026-11-07T12:00:00Z');
  const row = {
    user_id: 7, username: 'sample_invitee', account_at: '2026-11-02T19:58:00Z', invite_id: 3,
    invite_status: 'joined', invite_redeemed_at: '2026-11-02T19:58:00Z', invite_joined_at: '2026-11-02T19:58:05Z',
    invite_opened_at: '2026-11-02T19:57:00Z', invite_how: 'signed_up', invited_by: 'maker',
    invite_project: 'Space Shooter', invite_project_slug: 'space-shooter', opened_at: '2026-11-02T19:58:10Z',
    first_act_at: '2026-11-02T00:00:00Z', first_act_kind: 'app', has_platform_access: false,
  };
  const person = journey.invitedMilePerson(row, now);
  assert.equal(person.door, 'invite_link');
  assert.deepEqual(person.steps.map((s) => s.state), ['done', 'done', 'done', 'done', 'done', 'stuck']);
  assert.equal(person.stuckReason, 'Not let in yet');
  assert.equal(person.steps[1].note, 'from the invite');
  assert.equal(person.invite.by, 'maker');
  assert.equal(person.invite.project, 'Space Shooter');

  const queued = journey.invitedMileSteps({ ...row, invite_status: 'queued', invite_opened_at: null, opened_at: null, first_act_at: null }, now);
  assert.equal(queued.steps[0].state, 'unknown', 'an open in another browser was not seen');
  assert.equal(queued.stuckAt, 'joined');
  assert.equal(queued.stuckReason, 'Waiting for access to join');

  const sql = flat(journey.FIRST_MILE_INVITED_SQL);
  assert.match(sql, /u\.has_platform_access IS NOT TRUE/, 'only people not let in yet');
  assert.match(sql, /r\.status <> 'cancelled'/);
  assert.match(sql, /FROM community_invite_opens o WHERE o\.user_id = u\.id AND o\.app_id = ci\.app_id/,
    'the open their browser made, once it is theirs');
  assert.equal(journey.INVITED_DAYS, 90);
  assert.match(flat(journey.PERSON_SQL), /LEFT JOIN LATERAL \( SELECT ci\.id AS invite_id/, 'the person dialog knows the invite too');
});

test('the facts come from records that exist: identities, the mail log, the waitlist row', () => {
  const cte = flat(journey.ADMITTED_CTE);
  assert.match(cte, /w\.submitted_at, w\.source, w\.answers->'discovery'->>'source' AS discovery/);
  assert.match(cte, /\(w\.answers \?\| ARRAY\['made_url', 'made_note', 'group', 'loss', 'handles', 'followed_claim', 'verified'\]\) AS answered_follow_up/);
  assert.match(cte, /w\.release_page_opened_at, w\.release_page_outcome/);
  const facts = flat(journey.FIRST_MILE_ADMITTED_SQL);
  for (const piece of [
    /FROM user_phone_identities ph WHERE ph\.user_id = u\.id AND ph\.created_at <= u\.created_at \+ INTERVAL '10 minutes'\) THEN 'phone'/,
    /oi\.provider = 'apple'/, /oi\.provider = 'google'/,
    /THEN 'mail_link'/, /d\.kind = 'otp'[^)]*\) THEN 'email_code'/, /WHEN u\.password_set THEN 'password'/,
    /d\.kind = 'waitlist_released' AND d\.created_at <= COALESCE\(LEAST\(a\.release_link_followed_at, a\.release_code_asked_at, \(SELECT MIN\(d2\.created_at\) FROM mail_deliveries d2 WHERE d2\.recipient = a\.email AND d2\.kind = 'otp' AND d2\.created_at >= a\.released_at\)\), NOW\(\)\)\) AS mail_sends_before_follow/,
    /\(SELECT MIN\(w2\.release_page_opened_at\) FROM waitlist_signups w2\) AS mail_page_since/,
  ]) assert.match(facts, piece);
});

test('the mail\'s page is recorded by its own read and the link\'s spend, never undoing a sign-in', async () => {
  const calls = [];
  const pool = { async query(sql, params) { calls.push({ sql: flat(sql), params }); return { rows: [], rowCount: 1 }; } };
  await releaseLinks.notePageOpened(pool, 12);
  await releaseLinks.notePageOutcome(pool, 12, 'welcome');
  await releaseLinks.notePageOutcome(pool, 12, 'something else');
  await releaseLinks.notePageOutcome(pool, null, 'signed_in');
  assert.equal(calls.length, 2, 'an unknown outcome or no row writes nothing');
  assert.match(calls[0].sql, /SET release_page_opened_at = COALESCE\(release_page_opened_at, NOW\(\)\), release_page_outcome = COALESCE\(release_page_outcome, 'opened'\)/);
  assert.match(calls[1].sql, /AND release_page_outcome IS DISTINCT FROM 'signed_in'/);
  assert.deepEqual(calls[1].params, [12, 'welcome']);

  const src = read('src/services/release-links.js');
  assert.match(src, /return \{ invalid: true, signupId: link\.signup_id, outcome: 'link_expired' \};/);
  assert.equal((src.match(/outcome: 'link_used'/g) || []).length, 2);
  assert.match(src, /if \(error && error\.code === 'account_set_up'\) await notePageOutcome\(pool, signupId, 'welcome'\);/);
  assert.match(src, /await noteFollowed\(pool, signupId\);\n  await notePageOutcome\(pool, signupId, 'signed_in'\);/);
  const api = read('src/routes/public-api.js');
  assert.match(api, /if \(req\.query\.from === 'admit' && row\.released_at\) await releaseLinks\.notePageOpened\(pool, row\.id\);/);
  assert.match(read('frontend/src/features/auth/landing.tsx'), /releaseAccountFromToken\(token, \{ fromAdmitMail: true \}\)/,
    'only the mail\'s own page says so');
});

test('every waitlist row says which form it came from', () => {
  assert.match(read('src/routes/public-api.js'),
    /source: req\.waitlistIntegrator \? `partner:\$\{req\.waitlistIntegrator\.label \|\| 'unknown'\}` : 'form',/);
  const members = read('src/services/member-waitlist.js');
  assert.match(members, /waitlist\.joinWaitlist\(pool, \{ email, ip, source: 'app' \}\)/);
  assert.match(members, /VALUES \(NULL, \$2, \$1, NOW\(\), \$3, 'app'\)/);
  assert.match(read('src/services/waitlist.js'), /SELECT LOWER\(TRIM\(u\.email\)\), u\.id, NOW\(\), \$2, 'account'/);
  assert.match(read('src/services/test-accounts.js'), /VALUES \(\$1, NOW\(\), NOW\(\), \$2, 'test'\)/);
});

test('signing up carrying an invite link claims the open that browser made', () => {
  const invites = read('src/services/community-invites.js');
  assert.match(invites, /await require\('\.\/invite-activity'\)\.claimOpen\(pool, \{ token, userId: user\.id, browser \}\);\n    const result = await redeem/);
  assert.match(invites, /claimOpen\(pool, \{ token, userId, browser: require\('\.\/invite-activity'\)\.browserFrom\(req\) \}\)/);
  const activity = read('src/services/invite-activity.js');
  assert.match(activity, /settleOpen\(pool, \{ makerId: invite\.created_by, appId: invite\.app_id, userId, browser, keepNotice: true \}\)/,
    'merged onto the account, but still on the maker\'s open notice: it is not a join');
  assert.match(activity, /if \(!keepNotice && rows\[0\]\.notification_id != null\)/);
});
