'use strict';

// A PRIVATE MEMBER against the full schema (users.private_member_since):
// an invite link lets somebody still waiting into its community (once they
// have a verified phone, while phone sign-in is offered), they may
// not make apps of their own, and their Home's waitlist card joins them to
// the waitlist with an email that is theirs — the account's own, or one a
// code confirms — and never one another account holds. Letting them in ends
// the tier. Skipped when no server is reachable, and required when
// TEST_DATABASE_URL is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('private members, against the full schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'private_member_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const invites = require('../src/services/community-invites');
  const appAllowance = require('../src/services/app-allowance');
  const memberWaitlist = require('../src/services/member-waitlist');
  const waitlist = require('../src/services/waitlist');

  let seq = 0;
  async function account({ access = false, email = null } = {}) {
    const n = ++seq;
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, email, email_confirmed)
       VALUES ($1, 'x', $2, $3::varchar, $3::varchar IS NOT NULL) RETURNING id, username`,
      [`person_${n}`, access, email]
    );
    return { id: rows[0].id, username: rows[0].username, isAdmin: false, hasPlatformAccess: access };
  }
  const tier = async (id) => (await pool.query(
    'SELECT has_platform_access, private_member_since IS NOT NULL AS private FROM users WHERE id = $1', [id])).rows[0];

  // Jordan's private group, and a link to it.
  const jordan = await account({ access: true });
  // The community is the AFTER INSERT trigger's (create_app_community), so
  // the row is read back rather than taken from RETURNING.
  await pool.query(
    `INSERT INTO apps (name, slug, created_by, view_visibility, collab_visibility)
     VALUES ('Best brunch spots', 'best-brunch', $1, 'private', 'private')`,
    [jordan.id]
  );
  const { rows: [group] } = await pool.query(
    `SELECT id, slug, name, created_by, self_hosted, collab_visibility, view_visibility, community_id
       FROM apps WHERE slug = 'best-brunch'`
  );
  await pool.query(
    "INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING",
    [group.id, jordan.id]
  );
  await pool.query(
    'INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [group.community_id, jordan.id]
  );
  const made = await invites.createInvite(pool, { app: group, user: jordan });
  assert.ok(made.ok, 'Jordan can make a link to his own group');

  await t.test('a link lets somebody still waiting into the group, as a private member', async () => {
    const lina = await account({ email: 'lina@example.com' });
    const joined = await invites.redeem(pool, { token: made.link.token, user: lina });
    assert.deepEqual([joined.status, joined.slug, joined.privateMember], ['joined', 'best-brunch', true]);
    assert.deepEqual(await tier(lina.id), { has_platform_access: false, private: true });
    const { rows } = await pool.query(
      'SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2', [group.community_id, lina.id]);
    assert.equal(rows.length, 1, 'a member of the community');
  });

  await t.test('while phone sign-in is offered, a private member is one with a verified phone', async () => {
    const uses = async () => (await pool.query(
      'SELECT uses FROM community_invites WHERE token = $1', [made.link.token])).rows[0].uses;
    const inGroup = async (id) => (await pool.query(
      'SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2', [group.community_id, id])).rows.length === 1;
    // An account made by email: the link holds its place and lets it in no further.
    const pia = await account({ email: 'pia@example.com' });
    const waiting = await invites.redeem(pool, { token: made.link.token, user: pia, requirePhone: true });
    assert.deepEqual([waiting.status, waiting.slug, waiting.privateMember], ['queued', null, false]);
    assert.deepEqual(await tier(pia.id), { has_platform_access: false, private: false });
    assert.equal(await inGroup(pia.id), false, 'not in the group');
    // With a verified phone (services/firebase-phone-auth.js signIn), the same
    // link joins them, on the use the first follow spent.
    const spent = await uses();
    await pool.query(
      `INSERT INTO user_phone_identities (user_id, firebase_uid, phone_e164) VALUES ($1, 'uid-pia', '+15550001111')`,
      [pia.id]
    );
    const joined = await invites.redeem(pool, { token: made.link.token, user: pia, requirePhone: true });
    assert.deepEqual([joined.status, joined.slug, joined.privateMember], ['joined', 'best-brunch', true]);
    assert.deepEqual(await tier(pia.id), { has_platform_access: false, private: true });
    assert.equal(await inGroup(pia.id), true);
    assert.equal(await uses(), spent, 'no second use');
    // Somebody with access is not asked for one.
    const sam = await account({ access: true });
    const member = await invites.redeem(pool, { token: made.link.token, user: sam, requirePhone: true });
    assert.deepEqual([member.status, member.privateMember], ['joined', false]);
  });

  await t.test('a phone sign-up gives a name: it is the display name, and the handle is picked from it', async () => {
    const phoneAuth = require('../src/services/firebase-phone-auth');
    const { createSession } = require('../src/routes/auth');
    const made = await phoneAuth.signIn(pool, { uid: 'uid-name-1', phoneNumber: '+15550002001' }, { createSession });
    assert.equal(made.next, 'username', 'new: the continuation the username step would spend');
    const done = await phoneAuth.finishWithName(pool, { signupToken: made.signupToken, name: 'Lina Park', createSession });
    assert.equal(done.user.username, 'lina_park');
    assert.match(done.session.token, /\S{20,}/, 'signed in, no username step');
    const { rows: [row] } = await pool.query(
      `SELECT username, display_name, needs_username_choice,
              username_provisional_since IS NOT NULL AS provisional
         FROM users WHERE id = $1`, [done.user.id]);
    assert.deepEqual(row, { username: 'lina_park', display_name: 'Lina Park', needs_username_choice: false, provisional: true },
      'a handle for the private group only, until they pick one');
    // Somebody with the same name gets the same handle with digits.
    const again = await phoneAuth.signIn(pool, { uid: 'uid-name-2', phoneNumber: '+15550002002' }, { createSession });
    const second = await phoneAuth.finishWithName(pool, { signupToken: again.signupToken, name: 'Lina Park', createSession });
    assert.match(second.user.username, /^lina_park_[0-9]{3,4}$/);
    // The continuation is spent: the same token finishes nothing twice.
    await assert.rejects(
      phoneAuth.finishWithName(pool, { signupToken: made.signupToken, name: 'Lina Park', createSession }),
      (err) => err.code === 'invalid_signup_session'
    );
  });

  await t.test('a provisional handle stays out of public places until the person picks a username', async () => {
    const phoneAuth = require('../src/services/firebase-phone-auth');
    const usernames = require('../src/services/usernames');
    const { createSession } = require('../src/routes/auth');
    const made = await phoneAuth.signIn(pool, { uid: 'uid-prov-1', phoneNumber: '+15550005001' }, { createSession });
    const done = await phoneAuth.finishWithName(pool, { signupToken: made.signupToken, name: 'Mia Chen', createSession });
    const mia = { id: done.user.id, isAdmin: false, hasPlatformAccess: false };
    assert.equal(await usernames.isProvisional(pool, mia.id), true);
    // Their private group's link: fine.
    const privateLink = (await invites.createInvite(pool, { app: group, user: jordan })).link;
    const inPrivate = await invites.redeem(pool, { token: privateLink.token, user: mia, requirePhone: true });
    assert.deepEqual([inPrivate.status, inPrivate.public], ['joined', false]);
    // A public community's link: refused, and nothing spent.
    await pool.query(
      `INSERT INTO apps (name, slug, created_by, view_visibility, collab_visibility)
       VALUES ('Open garden', 'open-garden', $1, 'public', 'public')`, [jordan.id]);
    const { rows: [garden] } = await pool.query(
      `SELECT id, slug, name, created_by, self_hosted, collab_visibility, view_visibility, community_id
         FROM apps WHERE slug = 'open-garden'`);
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [garden.community_id, jordan.id]);
    const gardenLink = (await invites.createInvite(pool, { app: garden, user: jordan })).link;
    assert.equal((await invites.preview(pool, gardenLink.token)).project.public, true, 'its Join asks for a username');
    const refused = await invites.redeem(pool, { token: gardenLink.token, user: mia, requirePhone: true });
    assert.deepEqual(refused, { ok: false, status: 409, reason: 'username_required' });
    const { rows: [{ uses }] } = await pool.query('SELECT uses FROM community_invites WHERE token = $1', [gardenLink.token]);
    assert.equal(uses, 0, 'no use spent');
    // Somebody else holds a handle: refused there too.
    const taken = await usernames.checkAvailability(pool, 'lina_park', mia.id);
    assert.equal(taken.available, false);
    // They pick one: the provisional handle is gone, and public places open.
    const chosen = await usernames.replaceProvisionalUsername(pool, mia.id, 'mia_gardens');
    assert.deepEqual(chosen, { username: 'mia_gardens' });
    assert.equal(await usernames.isProvisional(pool, mia.id), false);
    assert.equal(await usernames.replaceProvisionalUsername(pool, mia.id, 'again'), null, 'once');
    const joined = await invites.redeem(pool, { token: gardenLink.token, user: mia, requirePhone: true });
    assert.deepEqual([joined.status, joined.public], ['joined', true]);
    // Keeping the provisional handle is a choice too.
    const other = await phoneAuth.signIn(pool, { uid: 'uid-prov-2', phoneNumber: '+15550005002' }, { createSession });
    const noa = await phoneAuth.finishWithName(pool, { signupToken: other.signupToken, name: 'Noa', createSession });
    assert.equal((await usernames.checkAvailability(pool, noa.user.username, noa.user.id)).available, true);
    assert.deepEqual(await usernames.replaceProvisionalUsername(pool, noa.user.id, noa.user.username), { username: noa.user.username });
  });

  await t.test('an account made by email adds a phone, and its queued link lets it in', async () => {
    const phoneAuth = require('../src/services/firebase-phone-auth');
    const rae = await account({ email: 'rae@example.com' });
    const queued = await invites.redeem(pool, { token: made.link.token, user: rae, requirePhone: true });
    assert.equal(queued.status, 'queued');
    assert.deepEqual(await invites.joinQueued(pool, rae.id), [], 'no phone yet: still queued');
    const linked = await phoneAuth.linkPhone(pool, { uid: 'uid-rae', phoneNumber: '+15550003001' }, rae.id);
    assert.deepEqual(linked, { linked: true, already: false });
    assert.deepEqual(await invites.joinQueued(pool, rae.id), [{ slug: 'best-brunch', name: 'Best brunch spots' }]);
    assert.deepEqual(await tier(rae.id), { has_platform_access: false, private: true });
    assert.deepEqual(await invites.joinQueued(pool, rae.id), [], 'nothing left queued');
    // The same number again is fine; another is refused, and so is a number
    // another account holds.
    assert.deepEqual(await phoneAuth.linkPhone(pool, { uid: 'uid-rae', phoneNumber: '+15550003001' }, rae.id),
      { linked: true, already: true });
    await assert.rejects(phoneAuth.linkPhone(pool, { uid: 'uid-rae-2', phoneNumber: '+15550003002' }, rae.id),
      (err) => err.code === 'phone_already_linked' && err.status === 409);
    const ted = await account();
    await assert.rejects(phoneAuth.linkPhone(pool, { uid: 'uid-ted', phoneNumber: '+15550003001' }, ted.id),
      (err) => err.code === 'phone_in_use');
    await assert.rejects(phoneAuth.linkPhone(pool, { uid: 'uid-rae', phoneNumber: '+15550003009' }, ted.id),
      (err) => err.code === 'phone_in_use', 'the Firebase identity is another account\'s too');
    // Somebody with access joins nothing this way: they joined on the spot.
    const una = await account({ access: true });
    assert.deepEqual(await invites.joinQueued(pool, una.id), []);
  });

  await t.test('a private member makes no apps, whatever their quota says, until they are let in', async () => {
    const mo = await account();
    await invites.redeem(pool, { token: made.link.token, user: mo });
    await pool.query('UPDATE users SET app_quota = 5 WHERE id = $1', [mo.id]);
    // The flag is read from the row: a CLI or Homeroom bot caller carries none.
    const refused = await appAllowance.read(pool, { id: mo.id, canAdminWrite: false });
    assert.equal(refused.canCreateApps, false);
    assert.deepEqual([refused.quota.limit, refused.quota.remaining], [0, 0]);
    await waitlist.grantPlatformAccess(pool, mo.id);
    assert.deepEqual(await tier(mo.id), { has_platform_access: true, private: true }, 'the mark stays; access ends the tier');
    const allowed = await appAllowance.read(pool, { id: mo.id, canAdminWrite: false });
    assert.equal(allowed.canCreateApps, true, 'let in: their own quota again');
  });

  await t.test('the waitlist card: the account\'s own confirmed address joins with one press', async () => {
    const ana = await account({ email: 'Ana@Example.com' });
    await invites.redeem(pool, { token: made.link.token, user: ana });
    const before = await memberWaitlist.stateFor(pool, ana.id);
    assert.deepEqual(before, { state: 'none', email: null, accountEmail: 'ana@example.com', moreToken: null, hasPhone: false });
    const sent = [];
    const joined = await memberWaitlist.join(pool, { userId: ana.id, rawEmail: 'ana@example.com', send: (...a) => sent.push(a) });
    assert.equal(joined.next, 'listed');
    assert.equal(joined.state, 'listed');
    assert.equal(joined.email, 'ana@example.com');
    assert.match(joined.moreToken, /^[a-f0-9]{48}$/, 'the "Want in sooner?" questions\' link');
    assert.deepEqual(sent, [], 'nothing mailed: the account confirmed it already');
    const { rows } = await pool.query(
      'SELECT linked_user_id::int AS linked_user_id, confirmed_at IS NOT NULL AS confirmed FROM waitlist_signups WHERE email = $1', ['ana@example.com']);
    assert.deepEqual(rows, [{ linked_user_id: ana.id, confirmed: true }]);
    // Released from the waitlist the ordinary way, the account is let in.
    const { rows: [{ id: signupId }] } = await pool.query('SELECT id FROM waitlist_signups WHERE email = $1', ['ana@example.com']);
    await waitlist.releaseWaitlistSignup(pool, signupId);
    assert.deepEqual(await tier(ana.id), { has_platform_access: true, private: true });
  });

  await t.test('another address is confirmed with a code first', async () => {
    const ben = await account();
    await invites.redeem(pool, { token: made.link.token, user: ben });
    const sent = [];
    const asked = await memberWaitlist.join(pool, { userId: ben.id, rawEmail: ' Ben@Example.com ', send: (...a) => sent.push(a) });
    assert.deepEqual(asked, { next: 'code', email: 'ben@example.com' });
    assert.equal(sent.length, 1);
    const [to, code] = sent[0];
    assert.equal(to, 'ben@example.com');
    assert.match(code, /^[0-9]{6}$/);
    assert.equal((await memberWaitlist.stateFor(pool, ben.id)).state, 'none', 'not on it until the code is in');
    await assert.rejects(
      memberWaitlist.verify(pool, { userId: ben.id, rawEmail: 'ben@example.com', code: code === '000000' ? '111111' : '000000' }),
      (err) => err.code === 'invalid_code'
    );
    const done = await memberWaitlist.verify(pool, { userId: ben.id, rawEmail: 'ben@example.com', code });
    assert.deepEqual([done.next, done.state, done.email], ['listed', 'listed', 'ben@example.com']);
    const { rows } = await pool.query('SELECT email, email_confirmed FROM users WHERE id = $1', [ben.id]);
    assert.deepEqual(rows, [{ email: 'ben@example.com', email_confirmed: true }], 'an account with no address takes it');
  });

  await t.test('a verified phone joins with one tap, no address asked for', async () => {
    // No phone identity yet: refused, and nothing written.
    const val = await account();
    await invites.redeem(pool, { token: made.link.token, user: val });
    await assert.rejects(
      memberWaitlist.joinWithPhone(pool, { userId: val.id }),
      (err) => err.code === 'no_phone' && err.status === 422 && /phone/.test(err.message)
    );
    assert.equal((await memberWaitlist.stateFor(pool, val.id)).state, 'none', 'still not on it');
    // The verified phone (services/firebase-phone-auth.js signIn made it)
    // is the confirmation: one tap, one row, no address at all.
    await pool.query(
      `INSERT INTO user_phone_identities (user_id, firebase_uid, phone_e164) VALUES ($1, 'uid-val', '+15550004001')`,
      [val.id]
    );
    assert.deepEqual(await memberWaitlist.stateFor(pool, val.id),
      { state: 'none', email: null, accountEmail: null, moreToken: null, hasPhone: true });
    const joined = await memberWaitlist.joinWithPhone(pool, { userId: val.id, ip: '127.0.0.1' });
    assert.deepEqual([joined.next, joined.state, joined.email], ['listed', 'listed', null]);
    assert.match(joined.moreToken, /^[a-f0-9]{48}$/, 'the "Want in sooner?" questions ride the row too');
    const { rows: [row] } = await pool.query(
      `SELECT email, linked_user_id::int AS linked_user_id,
              confirmed_at IS NOT NULL AS confirmed,
              more_token, submitted_at IS NOT NULL AS submitted
         FROM waitlist_signups WHERE linked_user_id = $1`, [val.id]);
    assert.deepEqual(row, {
      email: null, linked_user_id: val.id, confirmed: true,
      more_token: joined.moreToken, submitted: true,
    });
    // A second tap is idempotent: the same row, confirmed in place, never
    // a second one (the one-row-per-account index would refuse it).
    const again = await memberWaitlist.joinWithPhone(pool, { userId: val.id });
    assert.deepEqual([again.next, again.state, again.email], ['listed', 'listed', null]);
    const { rows: [{ count }] } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM waitlist_signups WHERE linked_user_id = $1', [val.id]);
    assert.equal(count, 1);
    // An old row linked to the account but never confirmed (the schema's
    // legacy backfill shape) is phone-confirmed in place, not doubled.
    const kim = await account();
    await pool.query(
      `INSERT INTO waitlist_signups (email, ip, linked_user_id, submitted_at)
       VALUES ('kim@example.com', NULL, $1, NOW())`, [kim.id]);
    await pool.query(
      `INSERT INTO user_phone_identities (user_id, firebase_uid, phone_e164) VALUES ($1, 'uid-kim', '+15550004002')`,
      [kim.id]
    );
    const kimJoin = await memberWaitlist.joinWithPhone(pool, { userId: kim.id });
    assert.deepEqual([kimJoin.next, kimJoin.state, kimJoin.email], ['listed', 'listed', 'kim@example.com']);
    const { rows: kimRows } = await pool.query(
      'SELECT confirmed_at IS NOT NULL AS confirmed FROM waitlist_signups WHERE linked_user_id = $1', [kim.id]);
    assert.deepEqual(kimRows, [{ confirmed: true }]);
    // Released the ordinary way: the account is let in, with no message —
    // mail_deliveries records every send attempt, and none happened.
    const { rows: [{ id: signupId }] } = await pool.query(
      'SELECT id FROM waitlist_signups WHERE linked_user_id = $1', [val.id]);
    await waitlist.releaseWaitlistSignup(pool, signupId);
    assert.deepEqual(await tier(val.id), { has_platform_access: true, private: true });
    const { rows: [{ mails }] } = await pool.query(
      "SELECT COUNT(*)::int AS mails FROM mail_deliveries WHERE kind = 'waitlist_released'");
    assert.equal(mails, 0, 'a phone row is released without a message');
  });

  await t.test('a private member uses public apps but never votes on one, even one that invited them', async () => {
    const communities = require('../src/services/communities');
    const kay = await account();
    // Their own private group: their vote counts there.
    await invites.redeem(pool, { token: made.link.token, user: kay });
    assert.equal(await communities.privateVoteRefusal(pool, group.id, kay.id), null);
    const counts = async (appId, userId) => (await pool.query(
      'SELECT counts_toward_outcome($1, $2) AS c', [userId, appId])).rows[0].c;
    assert.equal(await counts(group.id, kay.id), true);
    // A public community whose link brought them in too.
    await pool.query(
      `INSERT INTO apps (name, slug, created_by, view_visibility, collab_visibility)
       VALUES ('Town square', 'town-square', $1, 'public', 'public')`, [jordan.id]);
    const { rows: [square] } = await pool.query(
      `SELECT id, slug, name, created_by, self_hosted, collab_visibility, view_visibility, community_id
         FROM apps WHERE slug = 'town-square'`);
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [square.community_id, jordan.id]);
    const squareLink = (await invites.createInvite(pool, { app: square, user: jordan })).link;
    const joined = await invites.redeem(pool, { token: squareLink.token, user: kay });
    assert.deepEqual([joined.status, joined.privateMember], ['joined', true], 'they can join it and use it');
    const refused = await communities.privateVoteRefusal(pool, square.id, kay.id);
    assert.equal(refused.code, 'private_member_public_vote');
    assert.match(refused.error, /let in off the waitlist/);
    assert.equal(await counts(square.id, kay.id), false, 'and a vote of theirs would count toward nothing');
    // Let in, they vote there like anybody.
    await waitlist.grantPlatformAccess(pool, kay.id);
    assert.equal(await communities.privateVoteRefusal(pool, square.id, kay.id), null);
    assert.equal(await counts(square.id, kay.id), true);
    // Somebody with access was never held to it.
    assert.equal(await communities.privateVoteRefusal(pool, square.id, jordan.id), null);
  });

  await t.test('an address another account holds is refused, whichever way it arrives', async () => {
    await account({ email: 'taken@example.com' });
    const cal = await account();
    await invites.redeem(pool, { token: made.link.token, user: cal });
    const sent = [];
    await assert.rejects(
      memberWaitlist.join(pool, { userId: cal.id, rawEmail: 'TAKEN@example.com', send: (...a) => sent.push(a) }),
      (err) => err.code === 'email_in_use' && err.status === 409 && /another Homeroom account/.test(err.message)
    );
    assert.deepEqual(sent, [], 'and no code is mailed to it');
    // An address another account's waitlist row is linked to counts too.
    await assert.rejects(
      memberWaitlist.join(pool, { userId: cal.id, rawEmail: 'ana@example.com', send: () => {} }),
      (err) => err.code === 'email_in_use'
    );
    await assert.rejects(
      memberWaitlist.join(pool, { userId: cal.id, rawEmail: 'not an email', send: () => {} }),
      (err) => err.code === 'invalid_email'
    );
  });
});
