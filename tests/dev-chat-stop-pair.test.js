'use strict';

// THE STOP PAIR: a stop that is not landing, and a stop that landed.
//
// Both are "the run did not finish", and until this change both wore the
// pipeline's green ✓ — the same bug tests/dev-chat-turn-failure.test.js
// pins for a failed turn, in its two remaining corners:
//
//   * #937's escalation ladder ("Stopping…", then a Force stop button) was a
//     STATUS row, whose icon is `msg._active ? 'spinner' : 'check'`. The
//     moment the turn went inactive — which is exactly the state the ladder
//     exists for — the one row telling the user they are stuck settled to a
//     green tick.
//   * A stop that LANDED said so only in prose: "Claude Code stopped by
//     @evan, but it had already committed 2 changes to the branch
//     (7c41ab90, pushed); no pull request was opened." — one sentence, in a
//     ✓ row, carrying the fact that the user's branch has moved.
//
// The pair is deliberately NOT one tone. `stopping` is red, because the user
// is stuck and needs the button. `stopped` is not, because the user asked for
// it: painting someone's own decision as an error is the green tick's mistake
// run in reverse. What this file pins is that split, and the data path that
// lets the landing be chips rather than prose the client has to parse.
//
// Run with: node --test tests/dev-chat-stop-pair.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const DEV_CHAT = read('frontend/src/features/dev-chat/dev-chat.js');
const SESSIONS = read('src/routes/sessions.js');
const SERVER = read('server.js');
const APP_CSS = read('public/css/app.css');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const render = (r) => renderToHtml(createElement(
  loadTsx('frontend/src/features/dev-chat/transcript.tsx').Row, { r }
));

test('stopLandingMeta is the sentence\'s facts, as data', () => {
  const { stopLandingMeta } = require('../src/routes/sessions');

  // Nothing landed: no sha, so no count and no push claim.
  assert.deepEqual(
    stopLandingMeta({ headline: 'Scout stopped' }),
    { headline: 'Scout stopped', commits: 0, sha: null, pushOk: false },
  );
  // A sha with ahead: 0 is "nothing landed" — the same reading
  // describeStoppedLanding has always had, so the two cannot disagree.
  assert.equal(stopLandingMeta({ headline: 'x', sha: 'deadbeefcafe', ahead: 0 }).sha, null);

  // A count, and the sha short.
  assert.deepEqual(
    stopLandingMeta({ headline: 'Claude Code stopped', sha: '7c41ab90de', ahead: 2, pushOk: true }),
    { headline: 'Claude Code stopped', commits: 2, sha: '7c41ab90', pushOk: true },
  );

  // `ahead: null` is the RECOVERED path: durable tail milestones carry a sha
  // and a push flag but no commit COUNT. It must survive as null rather than
  // collapse to a number nobody measured.
  const countless = stopLandingMeta({ headline: 'Stopped', sha: 'deadbeefcafe', ahead: null, pushOk: false });
  assert.equal(countless.commits, null);
  assert.equal(countless.sha, 'deadbeef');
});

test('the sentence still ships — this is a second channel, not a replacement', () => {
  // A notification, a plain-text export and a shared transcript all show the
  // prose. Dropping it to save a duplication would take the landing away
  // from every surface that is not this one component.
  assert.match(SESSIONS, /await sendStatus\(`\$\{executionAgentName\} stopped\$\{byStr\}\$\{landed\}\.`/);
  assert.match(SERVER, /const text = `Stopped\$\{by \? ` by @\$\{by\}` : ''\}\$\{landed\}\.`;/);
});

test('all three stop producers send the landing', () => {
  // The execution agent, the scout, and the recovered-turn stop in server.js.
  // A producer that forgets it puts its row back on the green tick.
  assert.match(SESSIONS, /stopLanding: stopLandingMeta\(\{\n\s+headline: `\$\{executionAgentName\} stopped\$\{byStr\}`/);
  assert.match(SESSIONS, /stopLanding: stopLandingMeta\(\{ headline: `Scout stopped\$\{byStr\}` \}\)/);
  assert.match(SERVER, /const stopLanding = stopLandingMeta\(\{/);
  // Persisted AND emitted, or a reload and a live turn would disagree.
  assert.match(SERVER, /recovered: true, stopped: true, stopLanding,/);
  assert.match(SERVER, /emit\('status', \{ text, quickReplies: pills, stopLanding \}\)/);
});

test('both client channels carry it — live and after a reload', () => {
  const live = DEV_CHAT.match(/content: data\.text, turnError: data\.turnError, stopLanding: data\.stopLanding,/g) || [];
  assert.equal(live.length, 2, 'both live status handlers');
  assert.match(DEV_CHAT, /if \(m\.metadata\.stopLanding\) m\.stopLanding = m\.metadata\.stopLanding;/);
});

test('the chips say what landed, and never invent a count', () => {
  const chips = (l) => {
    const s = l || {};
    if (!s.sha) return ['nothing committed'];
    const out = [s.commits == null
      ? 'changes committed'
      : `${s.commits} change${s.commits === 1 ? '' : 's'} committed`];
    out.push(s.sha, s.pushOk ? 'pushed' : 'not pushed');
    return out;
  };
  // Pinned against the shipped implementation, not just against itself.
  const at = DEV_CHAT.indexOf('_stopLandingChips(landing) {');
  const body = DEV_CHAT.slice(at, DEV_CHAT.indexOf('\n  },', at));
  assert.match(body, /if \(!s\.sha\) return \['nothing committed'\];/);
  assert.match(body, /s\.commits == null\n\s+\? 'changes committed'/);
  assert.match(body, /s\.pushOk \? 'pushed' : 'not pushed'/);

  assert.deepEqual(chips({ sha: null, commits: 0 }), ['nothing committed']);
  assert.deepEqual(chips({ sha: '7c41ab90', commits: 1, pushOk: false }),
    ['1 change committed', '7c41ab90', 'not pushed']);
  assert.deepEqual(chips({ sha: '7c41ab90', commits: null, pushOk: true }),
    ['changes committed', '7c41ab90', 'pushed']);
});

test('#937\'s escalation is a failure card now, and keeps its button', () => {
  const at = DEV_CHAT.indexOf('if (msg._stopping && msg._forceOffered) {');
  assert.ok(at > 0);
  const branch = DEV_CHAT.slice(at, at + 220);
  assert.match(branch, /t: 'failure'/);
  assert.match(branch, /tone: 'stopping'/);
  assert.match(branch, /forceStop: true/);
  // The bug in one line: it used to take the ladder's icon.
  assert.doesNotMatch(branch, /msg\._active \? 'spinner' : 'check'/);

  const html = render({
    t: 'failure', key: 'x', tone: 'stopping', text: 'Stopping…',
    elapsed: { kind: 'fixed', label: '(42s)' }, forceStop: true, stamp: '#1',
  });
  assert.match(html, /dc-failure-stopping/);
  assert.match(html, /dc-force-stop-btn/);
  assert.doesNotMatch(html, /dc-status-check/);
  assert.doesNotMatch(html, /✓/);
});

test('a stop that landed is neutral, with its facts in chips', () => {
  const html = render({
    t: 'failure', key: 'x', tone: 'stopped', text: 'Claude Code stopped by @evan',
    chips: ['2 changes committed', '7c41ab90', 'pushed'], stamp: '#1',
  });
  assert.match(html, /dc-failure-stopped/);
  assert.match(html, /class="dc-failure-chips"/);
  for (const c of ['2 changes committed', '7c41ab90', 'pushed']) assert.ok(html.includes(c));
  // Not the tick, and not the alarm glyph either.
  assert.doesNotMatch(html, /dc-status-check/);
  assert.ok(!html.includes('⊗'), 'the stopped tone must not wear the blocked glyph');
  assert.ok(html.includes('■'));
});

test('the stopped tone is NOT red — that is the whole distinction', () => {
  const at = APP_CSS.indexOf('.dc-failure-stopped {');
  assert.ok(at > 0, 'the stopped tone needs its own surface');
  const rule = APP_CSS.slice(at, APP_CSS.indexOf('}', at));
  assert.doesNotMatch(rule, /--state-blocked/);
  assert.match(rule, /var\(--dc-raised\)/);
  assert.match(rule, /var\(--border-light\)/);

  // …and `stopping` keeps the base card's red, by having no override of it.
  assert.equal(APP_CSS.indexOf('.dc-failure-stopping {'), -1);
});

test('the landed-stop branch precedes the generic system row', () => {
  const at = DEV_CHAT.indexOf('if (msg.stopLanding) {');
  assert.ok(at > 0);
  const fallback = DEV_CHAT.indexOf(
    "t: 'status', key, icon: msg._active ? 'spinner' : 'check',\n          html: msg.content");
  assert.ok(fallback > at, 'otherwise the fallback claims it and the tick comes back');

  // The headline, not the whole sentence: the chips beside it already say
  // the landing, and saying it twice is what the row is fixing.
  const branch = DEV_CHAT.slice(at, at + 320);
  assert.match(branch, /msg\.stopLanding\.headline \|\| msg\.content/);
});

test('a declared check guards the pair in a browser', () => {
  const dapp = JSON.parse(read('dapp.json'));
  const check = dapp.tests.find((t) => (t.expectSelector || '').includes('.dc-failure-stopped'));
  assert.ok(check, 'the stopped card must be guarded on a real route');
  assert.match(check.path, /sessions\/990412/, 'on the transcript fixture');
});
