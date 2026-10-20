'use strict';

// The made screen's moments (newcomer run five, 13 October 2026): when the
// screen after Make it first showed its questions, its "planning" line and
// its invite buttons, when Submit, Share invite and Invite people later were
// tapped, and the maker's tour after it (its start, each card, its end),
// told to the server as they happen (frontend/src/features/first-session/
// made-moments.ts → POST /api/apps/:slug/first-version/moments →
// services/first-session-moments.js), with the browser's clock and the
// server's. Run five could only piece these together from screenshots.
//
// The route itself, against the real schema: tests/first-session-moments-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const moments = require('../src/services/first-session-moments');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const DIR = 'frontend/src/features/first-session';

test('a moment is a known kind, when it happened, and a few small checked fields', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  const at = '2026-10-13T11:59:58.250Z';
  const parse = (body) => moments.parseMoment(body, { now });
  assert.deepEqual(parse({ kind: 'questions_shown', clientAt: at, count: 2 }), { kind: 'questions_shown', clientAt: at, count: 2 });
  assert.deepEqual(parse({ kind: 'tour_ended', clientAt: at, step: 3, steps: 9, how: 'skipped' }),
    { kind: 'tour_ended', clientAt: at, step: 3, steps: 9, how: 'skipped' });
  assert.deepEqual(parse({ kind: 'made_shown', clientAt: at, entry: 'create', note: 'typed words', count: null }),
    { kind: 'made_shown', clientAt: at, entry: 'create' }, 'anything else is left behind');
  for (const bad of [
    null, [], 'made_shown',
    { kind: 'made_up', clientAt: at },
    { kind: 'made_shown' },
    { kind: 'made_shown', clientAt: '2026-10-13 11:59' },
    { kind: 'made_shown', clientAt: '2026-10-11T11:59:58Z' },
    { kind: 'made_shown', clientAt: '2026-10-14T12:00:01Z' },
    { kind: 'submit_tapped', clientAt: at, count: 21 },
    { kind: 'submit_tapped', clientAt: at, count: 1.5 },
    { kind: 'tour_step_shown', clientAt: at, step: 0 },
    { kind: 'tour_step_shown', clientAt: at, steps: 101 },
    { kind: 'invite_sent', clientAt: at, how: 'texted' },
    { kind: 'made_shown', clientAt: at, entry: 'first-session' },
  ]) assert.equal(parse(bad), null, JSON.stringify(bad));
  assert.deepEqual(moments.KINDS, [
    'made_shown', 'planning_shown', 'questions_shown', 'submit_tapped', 'invite_shown', 'share_invite_tapped',
    'invite_sent', 'invite_later_tapped', 'continue_tapped', 'tour_started', 'tour_step_shown', 'tour_ended',
  ]);
});

test('kept with the server\'s receipt time beside the browser\'s, and never for an account that is not recorded', async () => {
  const queries = [];
  const pool = { async query(sql, params) { queries.push({ sql, params }); return { rows: [{ id: 1 }] }; } };
  const now = new Date('2026-10-13T12:00:01.000Z');
  const moment = { kind: 'submit_tapped', clientAt: '2026-10-13T11:59:58.000Z', count: 1 };
  const recordable = { uiTelemetry: { isRecordable: async () => true } };
  assert.equal(await moments.record(pool, { user: { id: 7, username: 'alex' }, appId: 3, moment, now, deps: recordable }), true);
  assert.match(queries[0].sql, /INSERT INTO events \(user_id, app_id, event_type, metadata, created_at\)/);
  assert.deepEqual(queries[0].params.slice(0, 3), [7, 3, 'first_session_moment']);
  assert.deepEqual(JSON.parse(queries[0].params[3]), { ...moment, receivedAt: now.toISOString() });
  assert.equal(queries[0].params[4], now);
  // A service account, or somebody who objected to being recorded.
  assert.equal(await moments.record(pool, { user: { id: 8 }, appId: 3, moment, deps: { uiTelemetry: { isRecordable: async () => false } } }), false);
  assert.equal(queries.length, 1);
  // A failed write is a missing row, never a thrown error.
  assert.equal(await moments.record({ async query() { throw new Error('down'); } }, { user: { id: 7 }, appId: 3, moment, deps: recordable }), false);
});

test('the browser sends each moment as it happens, and a shown one once', async () => {
  const real = globalThis.fetch;
  const sent = [];
  globalThis.fetch = (url, opts) => { sent.push({ url, opts }); return Promise.resolve({ ok: true }); };
  const realApp = globalThis.App;
  try {
    const m = loadTsx(`${DIR}/made-moments.ts`);
    m.resetMomentsForTests();
    // #5097: nothing goes for somebody who does not share usage analytics,
    // or before the server has said they do.
    globalThis.App = { user: { id: 7, uiTelemetryEligible: false } };
    assert.equal(m.noteMoment('club-votes', 'made_shown'), false);
    globalThis.App = undefined;
    assert.equal(m.noteMoment('club-votes', 'made_shown'), false);
    assert.equal(sent.length, 0, 'not shared: nothing sent');
    globalThis.App = { user: { id: 7, uiTelemetryEligible: true } };
    assert.equal(m.momentsUrl('club votes'), '/api/apps/club%20votes/first-version/moments');
    assert.equal(m.noteMoment('club-votes', 'questions_shown', { count: 2 }, { once: true }), true);
    assert.equal(m.noteMoment('club-votes', 'questions_shown', { count: 2 }, { once: true }), false, 'drawn again: not sent again');
    assert.equal(m.noteMoment('club-votes', 'invite_shown', { how: 'after_questions' }, { once: true }), true);
    assert.equal(m.noteMoment('club-votes', 'submit_tapped', { count: 2 }), true);
    assert.equal(m.noteMoment('club-votes', 'submit_tapped', { count: 2 }), true, 'a tap is every tap');
    assert.equal(m.noteMoment(null, 'made_shown'), false, 'no project, nothing sent');
    assert.equal(m.noteMoment('', 'made_shown'), false);
    assert.equal(sent.length, 4);
    const [first] = sent;
    assert.equal(first.url, '/api/apps/club-votes/first-version/moments');
    assert.equal(first.opts.method, 'POST');
    assert.equal(first.opts.credentials, 'same-origin');
    assert.equal(first.opts.keepalive, true, 'a tap that leaves the page still goes');
    const body = JSON.parse(first.opts.body);
    assert.equal(body.kind, 'questions_shown');
    assert.equal(body.count, 2);
    assert.ok(Math.abs(Date.parse(body.clientAt) - Date.now()) < 5000, 'the browser\'s own clock');
    // What the server takes, the browser sends (and the other way round).
    const now = Date.now();
    for (const s of sent) assert.ok(moments.parseMoment(JSON.parse(s.opts.body), { now }), s.opts.body);
    // Never thrown, and never waited on.
    globalThis.fetch = () => { throw new Error('offline'); };
    assert.equal(m.noteMoment('club-votes', 'made_shown'), false);
    globalThis.fetch = () => Promise.reject(new Error('offline'));
    assert.equal(m.noteMoment('club-votes', 'made_shown'), true);
    // The client's kinds are the server's.
    const src = read(`${DIR}/made-moments.ts`);
    for (const kind of moments.KINDS) assert.match(src, new RegExp(`'${kind}'`), kind);
  } finally {
    globalThis.fetch = real;
    globalThis.App = realApp;
  }
});

test('the made screen tells each moment where it happens, never changing what it does', () => {
  const made = read(`${DIR}/made.tsx`);
  assert.match(made, /import \{ noteMoment \} from '\.\/made-moments';/);
  assert.match(made, /noteMoment\(made\.slug, 'made_shown', \{ entry: fromCreate \? 'create' : 'first_session' \}, \{ once: true \}\);/);
  assert.match(made, /const planningShown = line === 'planning';\s+useEffect\(\(\) => \{\s+if \(planningShown\) noteMoment\(made\.slug, 'planning_shown', \{\}, \{ once: true \}\);/);
  assert.match(made, /const questionsShown = asked && !stalled \? asked\.length : 0;/);
  assert.match(made, /noteMoment\(made\.slug, 'questions_shown', \{ count: questionsShown \}, \{ once: true \}\);/);
  assert.match(made, /const inviteShown = !questionsShown;\s+useEffect\(\(\) => \{\s+if \(inviteShown\) noteMoment\(made\.slug, 'invite_shown', askedHere \? \{ how: 'after_questions' \} : \{\}, \{ once: true \}\);/);
  assert.match(made, /if \(answering\) return;\s+noteMoment\(made\.slug, 'submit_tapped', \{ count: answers\.length \}\);/);
  assert.match(made, /if \(inviting\) noteMoment\(made\.slug, 'share_invite_tapped', sentRef\.current \? \{ how: 'again' \} : \{\}\);/);
  assert.match(made, /if \(sentHow\) noteMoment\(made\.slug, 'invite_sent', \{ how: sentHow \}\);/);
  // The buttons are as they were.
  assert.match(made, /onClick=\{\(\) => onContinue\(true, stage\)\}/);
  assert.match(made, /onSent=\{\(how\) => setSentHow\(how\)\}/);

  const index = read(`${DIR}/index.tsx`);
  assert.match(index, /noteMoment\(made\.slug, skipped \? 'invite_later_tapped' : 'continue_tapped'\);/);
  // The maker's walk after it, and only that one: run now while the app is
  // built, or on the first Home after the app (the walk owed with `maker`);
  // never a screenshot state's, nor an invited person's.
  assert.match(index, /setMode\(\{ kind: 'tour', info: \{ slug, name \}, path: 'walk', moments: true \}\);/);
  assert.match(index, /if \(oweWalk\(uid, \{ slug, name, maker: true \}\)\) legacy\(\)\.App\?\._noteHomeWalk\?\.\('owed'\);/);
  assert.match(index, /path: 'walk', moments: !!walk\.maker \}/);
  assert.match(index, /if \(\(privateMember \|\| info\.newAccount\) && oweWalk\(uid, \{ slug, name, privateMember \}\)\) app\?\._noteHomeWalk\?\.\('owed'\);/);
  assert.match(index, /<Tour info=\{mode\.info\} steps=\{steps\} onEnd=\{end\} start=\{mode\.start\} moments=\{!!mode\.moments\} numbered=\{mode\.path === 'walk'\} \/>/);
  assert.doesNotMatch(index.slice(index.indexOf('async function openTourShot'), index.indexOf('const MAKE_FLAG')), /moments/);
  assert.match(index, /if \(momentsRef\.current\) noteMoment\(info\.slug, 'tour_started', \{ steps: steps\.length \}\);/);
  assert.match(index, /if \(momentsRef\.current\) noteMoment\(info\.slug, 'tour_step_shown', \{ step: index \+ 1, steps: steps\.length \}\);\s+\}, \[index\]\);/);
  assert.match(index, /noteMoment\(info\.slug, 'tour_ended', \{ step: indexRef\.current \+ 1, steps: steps\.length, how \}\);/);
  assert.match(index, /const onEnd = useCallback\(\(\) => finish\('done'\), \[finish\]\);/);
  assert.match(index, /enterScreen\(steps\[steps\.length - 1\]\.screen, info\.slug, info\.conversationId\);\s+finish\('skipped'\);/);
});

test('the route: same-origin, rate-limited, a member\'s own, and no Join offered', () => {
  const apps = read('src/routes/apps.js');
  const at = apps.indexOf("router.post('/api/apps/:slug/first-version/moments'");
  assert.ok(at > 0);
  const route = apps.slice(at, apps.indexOf('router.', at + 10));
  // The limiter, then the same-origin guard (tests/same-site-browser.test.js).
  assert.match(route, /router\.post\('\/api\/apps\/:slug\/first-version\/moments', firstSessionMomentLimiter, sameOriginBrowserOnly, async \(req, res\) => \{/);
  assert.match(route, /if \(!req\.user\?\.id\) return res\.status\(401\)/);
  assert.match(route, /if \(!app \|\| !\(await communities\.isMember\(pool, app\.id, req\.user\.id\)\)\) return res\.status\(404\)/);
  assert.doesNotMatch(route, /requireAppMembership/, 'a 403 join_required would offer them Join (lib/join-required.ts)');
  assert.match(route, /if \(!moment\) return res\.status\(400\)/);

  const limits = read('src/middleware/rate-limits.js');
  const decl = limits.slice(limits.indexOf('const firstSessionMomentLimiter = makeLimiter({'), limits.indexOf('});', limits.indexOf('const firstSessionMomentLimiter')));
  assert.match(decl, /windowMs: 60 \* 1000,\s+max: 60,/);
  assert.match(decl, /keyByUser: true,/);
  assert.match(decl, /skipFailedRequests: true,/);
  assert.equal(typeof require('../src/middleware/rate-limits').firstSessionMomentLimiter, 'function');
});
