'use strict';

// #2526: two unbounded topochain surfaces.
//
// 1. THE HEAVY MOBILE READS. Seven `/api/v4/mobile/**` GETs — `me`,
//    `me/ranking`, `me/breakdown`, `event/points`, `leaderboard`,
//    `challenges`, `seasons` — each run real aggregate queries over the
//    points ledger and carried NO limiter, while their own siblings in the
//    same file (`mobileWalletClaimLimiter`) do. This is per-principal abuse
//    rather than anonymous: the caller holds a valid mobile bearer, so the
//    limiter is a cost bound, not an auth gate.
//
//    Five of those handlers are ALSO mounted under `/challenges-api/**` for
//    the web session, as the same function objects. Limiting one line and
//    not the next would be a guard in appearance only, so both paths get it.
//
// 2. THE PARTNER POINT AWARD. `POST /api/v4/user-activities` is
//    non-idempotent BY CONTRACT (its own comment cites SPEC 1350 §4.8
//    "carried quirks": every call inserts a new `user_activities` row, so a
//    retry awards the points twice). That decision is deliberate and this
//    change does NOT touch it — an idempotency key would, and belongs to
//    whoever owns that spec. What it changes is that the double-award was
//    previously unbounded: a retry loop or a leaked key could inflate a
//    participant's points as fast as the socket allowed.
//
// Behaviour over real HTTP, like tests/rate-limits.test.js and
// tests/governance-vote-rate-limit.test.js: express-rate-limit hangs its
// accounting off response-finish, which stubbed req/res never emit. Each
// limiter is a module singleton with ONE shared in-memory bucket, so every
// test below uses its own principal.
//
// Run with: node --test tests/topochain-rate-limits.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const {
  topochainMobileReadLimiter, partnerActivityLimiter,
  partnerActivityParticipantLimiter,
} = require('../src/middleware/rate-limits');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const MOBILE_MAX = 120;
const PARTNER_ADDRESS_MAX = 600;
const PARTNER_PARTICIPANT_MAX = 60;

let base;
let server;

test.before(async () => {
  const app = express();
  // Stand in for mobileTokenAuth / optionalSessionAuth (both set req.user)
  // and for the proxy hop that populates req.clientIp.
  app.use((req, _res, next) => {
    if (req.headers['x-user-id']) req.user = { id: req.headers['x-user-id'] };
    if (req.headers['x-client-ip']) req.clientIp = req.headers['x-client-ip'];
    next();
  });
  app.get('/mobile-read', topochainMobileReadLimiter, (_req, res) => res.json({ ok: true }));
  app.use(express.json());
  // `?fail=1` stands in for a route-level refusal: an unknown season event,
  // a challenge that is not available, a participant not enrolled.
  app.post('/user-activities', partnerActivityLimiter, partnerActivityParticipantLimiter,
    (req, res) => (req.query.fail === '1'
      ? res.status(422).json({ error: 'nope' })
      : res.json({ ok: true })));

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

// Sequential on purpose: the bucket is a counter, and firing 600 requests
// concurrently would race the assertion about WHICH one is refused.
async function hit(pathname, headers, times, body = {}) {
  let last;
  for (let i = 0; i < times; i += 1) {
    const post = pathname.startsWith('/user-activities');
    const res = await fetch(base + pathname, {
      method: post ? 'POST' : 'GET',
      headers: post ? { ...headers, 'content-type': 'application/json' } : headers,
      body: post ? JSON.stringify(body) : undefined,
    });
    // Read the body once, here: every response must be drained or the
    // sockets pile up and the run stalls, and a drained Response can no
    // longer be cloned by the caller.
    const text = await res.text();
    let parsed = {};
    try { parsed = JSON.parse(text); } catch { /* non-JSON is a failure the status will show */ }
    last = { status: res.status, body: parsed };
  }
  return last;
}

// ── 1. The heavy mobile reads ──────────────────────────────────────────

test('a mobile read is allowed up to the cap and refused after it', async () => {
  const headers = { 'x-user-id': 'mobile-cap-user', 'x-client-ip': '203.0.113.10' };
  const atCap = await hit('/mobile-read', headers, MOBILE_MAX);
  assert.equal(atCap.status, 200, `the ${MOBILE_MAX}th read must still be served`);

  const overCap = await hit('/mobile-read', headers, 1);
  assert.equal(overCap.status, 429);
  assert.match(overCap.body.error || '', /Too many requests/);
  assert.ok(Number.isFinite(overCap.body.retryAfterSeconds),
    'the client needs to be told how long to wait');
});

// The negative control. Without it this file would pass just as happily
// against a limiter that refused everyone once anyone hit the cap.
test('one phone hitting the cap does not throttle another user', async () => {
  const shared = '198.51.100.7';
  const noisy = { 'x-user-id': 'noisy-phone', 'x-client-ip': shared };
  await hit('/mobile-read', noisy, MOBILE_MAX + 1);
  assert.equal((await hit('/mobile-read', noisy, 1)).status, 429, 'precondition');

  // Same address — a carrier NAT or an office egress puts thousands of
  // unrelated phones behind one. Keying by IP here would have made one
  // user's loop everyone else's outage, which is why it keys by user.
  const quiet = { 'x-user-id': 'quiet-phone', 'x-client-ip': shared };
  assert.equal((await hit('/mobile-read', quiet, 1)).status, 200,
    'a second user behind the same address must be unaffected');
});

// ── 2. The partner point award ─────────────────────────────────────────

// A distinct participant per test: the participant limiter is a module
// singleton with one shared bucket, like every other limiter here.
const participant = (n) => ({
  identifier_type: 'email', participant_identifier: `p${n}@example.test`,
});

test('awards to one participant are refused past the participant cap', async () => {
  const headers = { 'x-client-ip': '203.0.113.40' };
  const who = participant('cap');
  const atCap = await hit('/user-activities', headers, PARTNER_PARTICIPANT_MAX, who);
  assert.equal(atCap.status, 200, `award ${PARTNER_PARTICIPANT_MAX} must still be served`);

  const overCap = await hit('/user-activities', headers, 1, who);
  assert.equal(overCap.status, 429);
  assert.match(overCap.body.error || '', /Too many activity submissions for this participant/);
});

// THE BYPASS THIS DESIGN EXISTS FOR, and the reason the participant bound is
// not keyed on the caller. In Kubernetes server.js sets `trustDirectPeer:
// true`, so a caller can supply its own single X-Forwarded-For and choose
// its address bucket — services/client-ip.js says so in its own TODO. If the
// only bound were per-address, rotating that header would defeat it outright.
test('rotating the apparent address does NOT buy more awards for a participant', async () => {
  const who = participant('rotate');
  await hit('/user-activities', { 'x-client-ip': '203.0.113.50' }, PARTNER_PARTICIPANT_MAX, who);

  // A brand-new address — a fresh bucket for limiter (2), and it must not help.
  const rotated = await hit('/user-activities', { 'x-client-ip': '203.0.113.51' }, 1, who);
  assert.equal(rotated.status, 429,
    'the participant bound must hold however the caller presents itself');
  assert.match(rotated.body.error || '', /for this participant/);

  // And the new address is otherwise healthy: it is the PARTICIPANT that is
  // capped, not the address. Without this the test above would also pass
  // against a limiter that simply refused everything.
  const other = await hit('/user-activities', { 'x-client-ip': '203.0.113.51' }, 1, participant('rotate-b'));
  assert.equal(other.status, 200, 'a different participant from that address is fine');
});

// Review's second finding, reproduced. The key used to be built by
// composing `type + ':' + identifier` and trimming the RESULT, so interior
// whitespace survived: " p@x" and "p@x" hashed to two buckets while the
// route's own `participant_identifier.trim()` resolved both to one user.
// Respelling the identifier therefore multiplied the cap at will.
test('respelling the identifier does not buy a fresh bucket', async () => {
  const headers = { 'x-client-ip': '203.0.113.80' };
  const id = 'respell@example.test';
  await hit('/user-activities', headers, PARTNER_PARTICIPANT_MAX,
    { identifier_type: 'email', participant_identifier: id });

  // Every one of these is the same participant once the route trims it.
  for (const spelling of [` ${id}`, `  ${id}`, `${id} `, `\t${id}`]) {
    const res = await hit('/user-activities', headers, 1,
      { identifier_type: 'email', participant_identifier: spelling });
    assert.equal(res.status, 429,
      `"${spelling}" trims to the capped participant and must share its bucket`);
  }
  // Case too: the limiter is deliberately stricter than the route's
  // case-sensitive column, because over-counting is the safe direction.
  const upper = await hit('/user-activities', headers, 1,
    { identifier_type: 'email', participant_identifier: id.toUpperCase() });
  assert.equal(upper.status, 429);

  // Still a negative control: a genuinely different participant is served.
  assert.equal((await hit('/user-activities', headers, 1, participant('respell-other'))).status, 200);
});

// Review's third finding. The key generator runs BEFORE the route's own
// `IDENTIFIER_COLUMNS[identifierType]` check, so if it normalised the type
// it would map " email" and "EMAIL" — both of which the route 422s — onto a
// REAL participant's bucket. Failures count, so 60 such requests would spend
// a participant's whole budget and deny them their legitimate awards, while
// awarding nothing. The type must therefore match exactly.
test('a malformed identifier_type cannot spend a real participant budget', async () => {
  const headers = { 'x-client-ip': '203.0.113.100' };
  const id = 'victim@example.test';

  // Exhaust the participant bucket using only malformed types.
  for (const bad of [' email', 'EMAIL', 'Email', 'email ', 'e-mail']) {
    for (let i = 0; i < 20; i += 1) {
      await hit('/user-activities', headers, 1,
        { identifier_type: bad, participant_identifier: id });
    }
  }

  // The real participant must be untouched.
  const real = await hit('/user-activities', headers, 1,
    { identifier_type: 'email', participant_identifier: id });
  assert.equal(real.status, 200,
    'a rejected type must not consume the bucket of the participant it names');
});

test('the accepted identifier types match the route exactly', () => {
  // Two copies on purpose — middleware importing a route module is the wrong
  // direction. This is what stops them drifting.
  const limits = read('src/middleware/rate-limits.js');
  const partner = read('src/routes/topochain/partner.js');
  const fromLimiter = /PARTNER_IDENTIFIER_TYPES = new Set\(\[([^\]]+)\]\)/.exec(limits);
  const fromRoute = /const IDENTIFIER_COLUMNS = \{([^}]+)\}/.exec(partner);
  assert.ok(fromLimiter && fromRoute, 'both declarations must still be findable');
  const names = (t) => (t.match(/[a-z]+/g) || []).filter((w, i, a) => a.indexOf(w) === i).sort();
  assert.deepEqual(names(fromLimiter[1]), names(fromRoute[1]),
    'the limiter would silently stop keying a type the route still accepts');
});

// The address bound is not a security boundary, and an earlier draft of its
// comment said it capped volume and bucket growth. It does not: rotating
// X-Forwarded-For and the participant together defeats both limiters. A
// false claim on a money path reads like a guard, so the correction is
// pinned rather than trusted to survive the next edit.
test('the address bound does not claim to be what it is not', () => {
  const src = read('src/middleware/rate-limits.js');
  const block = src.slice(
    src.indexOf('// (2) PER ADDRESS'),
    src.indexOf('const partnerActivityLimiter = makeLimiter({'));
  assert.match(block, /NOT a security boundary/);
  assert.match(block, /does not bound a deliberate attacker|does NOT bound a deliberate attacker/i);
  assert.match(block, /per-partner API keys/,
    'what closing it actually requires has to be recorded');
  assert.doesNotMatch(block, /caps? (?:total )?volume\b/i,
    'the claim that was false must not creep back');
});

// Review's fourth finding, fixed. A request that names a real participant
// but fails on some other field awards nothing — so charging it to that
// participant's bucket would let a caller block their legitimate awards for
// the minute without inflating anything. Denial of service dressed as a
// limiter.
test('a rejected award does not spend the participant budget', async () => {
  const headers = { 'x-client-ip': '203.0.113.110' };
  const who = { identifier_type: 'email', participant_identifier: 'skip@example.test' };

  for (let i = 0; i < PARTNER_PARTICIPANT_MAX + 30; i += 1) {
    const res = await hit('/user-activities?fail=1', headers, 1, who);
    assert.equal(res.status, 422, `refused for the wrong reason at ${i + 1}`);
  }

  const real = await hit('/user-activities', headers, 1, who);
  assert.equal(real.status, 200,
    'failed submissions must not exhaust a real participant\'s allowance');
});

// ...but junk is not free: the ADDRESS bound counts failures, so the volume
// of it is still capped. Without this the fix above would be a hole.
test('the address bound still counts failed requests', () => {
  const src = read('src/middleware/rate-limits.js');
  const pStart = src.indexOf('const partnerActivityParticipantLimiter = makeLimiter({');
  const participant = src.slice(pStart, src.indexOf('});', pStart));
  assert.match(participant, /skipFailedRequests: true/);

  const aStart = src.indexOf('const partnerActivityLimiter = makeLimiter({');
  const address = src.slice(aStart, src.indexOf('});', aStart));
  assert.doesNotMatch(address, /skipFailedRequests/,
    'if the volume bound skipped failures too, junk would cost the caller nothing');
});

// The ceiling this design does NOT close, recorded so it is not mistaken for
// a tighter bound than it is. One human reachable on three channels holds
// three buckets.
test('the per-participant bound is per spelling, and says so', async () => {
  const headers = { 'x-client-ip': '203.0.113.120' };
  const id = 'multi@example.test';
  await hit('/user-activities', headers, PARTNER_PARTICIPANT_MAX,
    { identifier_type: 'email', participant_identifier: id });
  assert.equal(
    (await hit('/user-activities', headers, 1,
      { identifier_type: 'email', participant_identifier: id })).status, 429,
    'precondition: the email bucket is spent');

  // The same string as a telegram handle is a different bucket. That is
  // correct — they are different participants — and it is also why one
  // HUMAN on three channels gets 3 x 60.
  const viaTelegram = await hit('/user-activities', headers, 1,
    { identifier_type: 'telegram', participant_identifier: id });
  assert.equal(viaTelegram.status, 200);

  const src = read('src/middleware/rate-limits.js');
  assert.match(src, /KNOWN CEILING/,
    'the limit of the guard has to be written down where the guard is');
  assert.match(src, /3 x 60 = 180/, 'and quantified, not gestured at');
  assert.match(src, /RESOLVED user id/, 'with what closing it actually requires');
});

// The key generator runs BEFORE the route validates anything, so it sees
// whatever JSON the caller sent. It must not throw — a throwing keyGenerator
// would turn a malformed body into a 500, or worse.
test('a hostile body cannot break the key generator', async () => {
  const headers = { 'x-client-ip': '203.0.113.90' };
  const hostile = [
    {},
    { identifier_type: 'email' },
    { participant_identifier: 'x@example.test' },
    { identifier_type: 'email', participant_identifier: null },
    { identifier_type: 'email', participant_identifier: 12345 },
    { identifier_type: 'email', participant_identifier: { toString: 'not-callable' } },
    { identifier_type: 'email', participant_identifier: ['a', 'b'] },
    { identifier_type: ['email'], participant_identifier: 'x@example.test' },
    { identifier_type: 'email', participant_identifier: '   ' },
  ];
  for (const body of hostile) {
    const res = await hit('/user-activities', headers, 1, body);
    assert.notEqual(res.status, 500,
      `a crafted body 500d the limiter: ${JSON.stringify(body)}`);
    assert.equal(res.status, 200,
      'an unkeyable body falls through to the address bucket, not to a refusal');
  }
});

test('a partner awarding many different participants is never throttled', async () => {
  const headers = { 'x-client-ip': '203.0.113.60' };
  for (let i = 0; i < PARTNER_PARTICIPANT_MAX + 20; i += 1) {
    const res = await hit('/user-activities', headers, 1, participant(`fanout-${i}`));
    assert.equal(res.status, 200, `a legitimate batch stalled at award ${i + 1}`);
  }
});

test('the address bound still caps total volume, whatever the participants', async () => {
  // Limiter (2)'s job: a caller rotating the participant on every request
  // would otherwise mint unbounded in-memory buckets. Already 80 deep from
  // the fan-out test above? No — that used a different address.
  const headers = { 'x-client-ip': '203.0.113.70' };
  for (let i = 0; i < PARTNER_ADDRESS_MAX; i += 1) {
    await hit('/user-activities', headers, 1, participant(`vol-${i}`));
  }
  const over = await hit('/user-activities', headers, 1, participant('vol-last'));
  assert.equal(over.status, 429, 'the volume cap must still bite');
  assert.match(over.body.error || '', /Too many activity submissions\./,
    'and it is the address bound talking, not the participant one');
});

// Why address and not key, pinned so the next reader does not "correct" it.
// `partnerApiKey` compares X-API-Key against ONE shared secret — there are
// no per-partner keys yet — so a key-derived bucket would be a single global
// one, and any partner's retry storm would refuse every other partner.
test('neither partner limiter keys off the shared API key', () => {
  const src = read('src/middleware/rate-limits.js');
  // The makeLimiter CALLS, not the comments above them — those have to name
  // X-API-Key to explain why the key is unusable, so a pattern over the whole
  // block would match the very explanation it is checking.
  for (const name of ['partnerActivityLimiter', 'partnerActivityParticipantLimiter']) {
    const start = src.indexOf(`const ${name} = makeLimiter({`);
    assert.ok(start > 0, `${name} is gone`);
    const call = src.slice(start, src.indexOf('});', start));
    assert.doesNotMatch(call, /api-key|apiKey/i,
      'every partner presents the same secret, so it identifies nobody');
    assert.doesNotMatch(call, /keyByUser/, 'there is no req.user on a partner call');
  }

  // The participant bound keys on the body, and on BOTH fields: the same
  // string can be a valid email and a valid telegram handle.
  const pStart = src.indexOf('const partnerActivityParticipantLimiter = makeLimiter({');
  const pCall = src.slice(pStart, src.indexOf('});', pStart));
  assert.match(pCall, /identifier_type/);
  assert.match(pCall, /participant_identifier/);
  assert.match(pCall, /identifierKey\(/, 'reuse the file\'s own hashing helper, do not re-roll it');

  // The two reasons the caller cannot be the key must travel with the code.
  const auth = read('src/middleware/topochain-auth.js')
    .replace(/^\s*\/\/ ?/gm, '').replace(/\s+/g, ' ');
  assert.match(auth,
    /compared X-API-Key against one shared secret with no per-client keys or scopes/,
    'if partner keys become per-client, the caller bound should move to the key');
  assert.match(read('server.js'), /trustDirectPeer: config\.appRuntime === 'kubernetes'/,
    'the address is caller-supplied in production, which is why it is not the boundary');
  const clientIpSrc = read('src/services/client-ip.js')
    .replace(/^\s*\/\/ ?/gm, '').replace(/\s+/g, ' ');
  assert.match(clientIpSrc, /deliberately forge a single forwarding header/,
    'and client-ip.js is where that is admitted');
});

// ── 3. Every route the issue names actually carries one ────────────────

const MOBILE_JS = read('src/routes/topochain/mobile.js');

test('all seven heavy v4 mobile reads are limited, after their auth', () => {
  for (const route of ['me', 'me/ranking', 'me/breakdown', 'event/points',
    'leaderboard', 'challenges', 'seasons']) {
    const decl = new RegExp(
      `router\\.get\\('/api/v4/mobile/${route}', mobileTokenAuth\\(config\\), topochainMobileReadLimiter`);
    assert.match(MOBILE_JS, decl, `/api/v4/mobile/${route} is still unlimited`);
  }
});

test('the /challenges-api twins of those handlers are limited too', () => {
  // These are the SAME handler function objects, one screen over. A limiter
  // on the mobile mount alone would leave the identical aggregate query
  // reachable and unbounded.
  for (const [route, handler] of [
    ['seasons', 'seasonsHandler'], ['challenges', 'challengesHandler'],
    ['leaderboard', 'leaderboardHandler'], ['me/ranking', 'meRankingHandler'],
    ['me/breakdown', 'meBreakdownHandler'],
  ]) {
    assert.match(MOBILE_JS, new RegExp(
      `router\\.get\\('/challenges-api/${route}', webSessionAuth, requireSessionUser, `
      + `topochainMobileReadLimiter, ${handler}\\)`),
      `/challenges-api/${route} shares ${handler} and must share its limiter`);
  }
});

test('the limiter runs AFTER auth, because the key is the authenticated user', () => {
  // keyByUser reads req.user.id, which mobileTokenAuth sets. Mounted first
  // it would silently fall back to the IP bucket — and collapse every phone
  // behind a carrier NAT into one.
  assert.doesNotMatch(MOBILE_JS, /topochainMobileReadLimiter, mobileTokenAuth/);
  assert.doesNotMatch(MOBILE_JS, /topochainMobileReadLimiter, webSessionAuth/);
});

// Review's finding, and why it resolves to a comment fix rather than a wiring
// one. `POST /api/v4/mobile/zkpassport/complete` is the other unlimited v4
// mobile route, and an earlier draft of the limiter's comment claimed to
// cover it. It does not, deliberately — and the comment was the bug.
test('zkpassport/complete is excluded, and cannot inflate points anyway', () => {
  const decl = /router\.post\('\/api\/v4\/mobile\/zkpassport\/complete', mobileTokenAuth\(config\), async/;
  assert.match(MOBILE_JS, decl,
    'if this route gains a limiter, it needs its own number, not the read budget');

  // The three guards that make it idempotent, which is why it is not the
  // "point inflation" this issue names. A limiter would bound its query
  // cost; it would not be fixing this issue.
  //
  // Bounded to THIS route's body — from its declaration to the next
  // top-level `router.` — so a guard that belongs to some other endpoint
  // cannot satisfy the assertion by accident.
  const from = MOBILE_JS.search(decl);
  const after = MOBILE_JS.slice(from + 1).search(/\n  router\.(get|post|put|patch|delete)\(/);
  const body = MOBILE_JS.slice(from, after === -1 ? undefined : from + 1 + after);
  assert.match(body, /already_recorded: true/,
    'a repeat completion returns the first result instead of awarding again');
  assert.match(body, /This zkPassport session has already been used\./);
  assert.match(body, /This proof has already been claimed for this challenge\./);

  // And the limiter must not silently claim otherwise.
  const limits = read('src/middleware/rate-limits.js');
  const block = limits.slice(
    limits.indexOf('// #2526: the heavy topochain mobile reads.'),
    limits.indexOf('const topochainMobileReadLimiter'));
  assert.match(block, /NOT `POST \/api\/v4\/mobile\/zkpassport\/complete`/,
    'the exclusion has to be stated where the limiter is defined');
});

test('the partner award is limited, after its key check', () => {
  const src = read('src/routes/topochain/partner.js');
  assert.match(src,
    /const activityLimiters = \[partnerActivityLimiter, partnerActivityParticipantLimiter\];/,
    'both bounds must be in the chain');
  assert.match(src,
    /router\.post\('\/api\/v4\/user-activities', partnerApiKey\(config\), \.\.\.activityLimiters,/,
    'a caller refused for a bad key must not consume a real partner budget');
});

// The spec'd quirk this change deliberately leaves alone. If someone later
// adds an idempotency key, that is a spec decision and this comment — and
// this test — should be revisited with it, not quietly deleted.
test('the non-idempotency is still documented as contractual, not fixed here', () => {
  const src = read('src/routes/topochain/partner.js');
  assert.match(src, /NON-IDEMPOTENT BY CONTRACT \(SPEC 1350/);
  assert.match(src, /no longer UNBOUNDED/,
    'the limiter bounds the quirk; it does not remove it');
});
