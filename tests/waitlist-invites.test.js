// src/services/waitlist.js — the invite link and its attribution.
//
// The onboarding doc's "Bring someone you'd build with": "Share your invite
// link. If they join, we'll connect your applications so we can try to
// bring you in together." What shipped before this was five typed email
// addresses that sent nothing, attributed nothing and were never read back,
// so the invite rows were retired for a link that actually records who
// brought whom.
//
// The graph is recorded and shown. NOTHING consumes it to form a cohort —
// admitting people together is a separate, later decision.
//
// Contracts guarded here:
//
//   1. inviteCodeFor mints once and is idempotent. A signup's link is
//      stable, because by the second call it has already been shared.
//   2. Joining with a valid code records invited_by; joining with a bogus
//      one is a NORMAL join, never an error. Someone arriving on a stale or
//      mistyped ?ref= link must still be able to sign up.
//   3. Attribution is recorded only on a FIRST join, so re-submitting with
//      a different code cannot re-parent an existing row. This falls out of
//      ON CONFLICT DO NOTHING rather than being enforced separately.
//   4. invitedBySignup masks the addresses it reports. The inviter learns
//      how many people joined and enough to recognise a friend, not a
//      harvestable list.
//
// Service-level tests against a stateful in-memory mock pool — no live DB,
// same idiom as tests/onboarding-waitlist.test.js.
//
// Run with: node --test tests/waitlist-invites.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  joinWaitlist,
  inviteCodeFor,
  invitedBySignup,
  maskEmail,
} = require('../src/services/waitlist');

// ─── Stateful mock pool ───────────────────────────────────────────────

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function makeState() {
  return { signups: new Map(), nextSignupId: 1 };
}

function makePool(state) {
  async function query(rawSql, params = []) {
    const sql = collapse(rawSql);

    if (sql.includes('SELECT id FROM waitlist_signups WHERE invite_code = $1')) {
      const [code] = params;
      const s = [...state.signups.values()].find((r) => r.invite_code === code);
      return { rows: s ? [{ id: s.id }] : [] };
    }

    if (sql.startsWith('INSERT INTO waitlist_signups')) {
      const [email, , answers, moreToken, invitedBy] = params;
      if (state.signups.has(email)) return { rowCount: 0, rows: [] };
      state.signups.set(email, {
        id: state.nextSignupId++,
        email,
        answers: answers ? JSON.parse(answers) : null,
        more_token: moreToken || null,
        invite_code: null,
        invited_by: invitedBy ?? null,
        submitted_at: new Date(Date.now() + state.nextSignupId),
        confirmed_at: null,
        released_at: null,
        linked_user_id: null,
      });
      return { rowCount: 1, rows: [] };
    }

    if (sql.includes('SELECT invite_code FROM waitlist_signups WHERE id = $1')) {
      const [id] = params;
      const s = [...state.signups.values()].find((r) => r.id === id);
      return { rows: s ? [{ invite_code: s.invite_code }] : [] };
    }

    if (sql.includes('SET invite_code = COALESCE(invite_code, $1)')) {
      const [code, id] = params;
      const s = [...state.signups.values()].find((r) => r.id === id);
      if (!s) return { rowCount: 0, rows: [] };
      s.invite_code = s.invite_code || code;
      return { rowCount: 1, rows: [{ invite_code: s.invite_code }] };
    }

    if (sql.includes('WHERE invited_by = $1')) {
      const [id] = params;
      const rows = [...state.signups.values()]
        .filter((r) => r.invited_by === id)
        .sort((a, b) => a.submitted_at - b.submitted_at)
        .map((r) => ({ email: r.email }));
      return { rows };
    }

    throw new Error(`Unhandled mock query: ${sql}`);
  }
  return { query };
}

function fixture() {
  const state = makeState();
  return { state, pool: makePool(state) };
}

const idOf = (state, email) => state.signups.get(email).id;

// ─── 1. The link is minted once and is stable ─────────────────────────

test('an invite code is minted once and stays stable', async () => {
  const { pool, state } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });
  const id = idOf(state, 'a@example.com');

  const first = await inviteCodeFor(pool, id);
  assert.match(first, /^[a-z0-9]{10}$/);
  assert.equal(await inviteCodeFor(pool, id), first);
  assert.equal(await inviteCodeFor(pool, id), first);
});

test('asking an unknown signup for a code returns null, not a fresh one', async () => {
  const { pool } = fixture();
  assert.equal(await inviteCodeFor(pool, 999), null);
});

// ─── 2. Attribution, and a bogus code that must not block a join ──────

test('joining with a valid code records who invited you', async () => {
  const { pool, state } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });
  const inviter = idOf(state, 'a@example.com');
  const code = await inviteCodeFor(pool, inviter);

  const { created } = await joinWaitlist(pool, { email: 'b@example.com', inviteCode: code });
  assert.equal(created, true);
  assert.equal(state.signups.get('b@example.com').invited_by, inviter);
});

test('a bogus invite code is ignored, not rejected', async () => {
  const { pool, state } = fixture();
  const { created } = await joinWaitlist(pool, { email: 'b@example.com', inviteCode: 'nonsense99' });
  assert.equal(created, true);
  assert.equal(state.signups.get('b@example.com').invited_by, null);
});

test('a malformed invite code never reaches the database', async () => {
  const { pool, state } = fixture();
  for (const bad of ['', 'TOOLONGCODE', 'UPPER12345', 'has-dash12', null, undefined, 42, {}]) {
    // eslint-disable-next-line no-await-in-loop
    const { created } = await joinWaitlist(pool, { email: `x${String(bad)}@example.com`, inviteCode: bad });
    assert.equal(created, true);
    assert.equal(state.signups.get(`x${String(bad)}@example.com`).invited_by, null);
  }
});

test('joining with no code at all is unchanged', async () => {
  const { pool, state } = fixture();
  const { created, moreToken } = await joinWaitlist(pool, { email: 'b@example.com' });
  assert.equal(created, true);
  assert.match(moreToken, /^[a-f0-9]{48}$/);
  assert.equal(state.signups.get('b@example.com').invited_by, null);
});

// ─── 3. No re-parenting ───────────────────────────────────────────────

test('re-joining with a code cannot re-parent an existing row', async () => {
  const { pool, state } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });
  const code = await inviteCodeFor(pool, idOf(state, 'a@example.com'));

  await joinWaitlist(pool, { email: 'b@example.com' });
  const again = await joinWaitlist(pool, { email: 'b@example.com', inviteCode: code });
  assert.equal(again.created, false, 'a re-join is still a no-op');
  assert.equal(state.signups.get('b@example.com').invited_by, null);
});

// ─── 4. What the inviter is told ──────────────────────────────────────

test('the inviter is told a count and masked addresses', async () => {
  const { pool, state } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });
  const inviter = idOf(state, 'a@example.com');
  const code = await inviteCodeFor(pool, inviter);

  await joinWaitlist(pool, { email: 'alice@example.com', inviteCode: code });
  await joinWaitlist(pool, { email: 'bob@other.test', inviteCode: code });

  const invited = await invitedBySignup(pool, inviter);
  assert.equal(invited.count, 2);
  assert.deepEqual(invited.emails, ['al***@example.com', 'bo***@other.test']);
});

test('an inviter nobody used gets a zero, not an error', async () => {
  const { pool, state } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });
  const invited = await invitedBySignup(pool, idOf(state, 'a@example.com'));
  assert.deepEqual(invited, { count: 0, emails: [] });
});

test('maskEmail keeps the domain and a hint, never the whole local part', () => {
  assert.equal(maskEmail('alice@example.com'), 'al***@example.com');
  // A one-character local part must not become an unmasked address.
  assert.equal(maskEmail('a@example.com'), 'a***@example.com');
  // Garbage in the column cannot produce something that looks like an address.
  assert.equal(maskEmail('not-an-email'), '***');
  assert.equal(maskEmail(''), '***');
});
