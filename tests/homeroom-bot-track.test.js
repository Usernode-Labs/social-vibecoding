'use strict';

// One track per request (src/services/homeroom-bot-track.js): the one place
// the people-facing state of a request the Homeroom bot has is decided, and
// what every surface draws. Pure parts here; the reads against PostgreSQL in
// homeroom-bot-slots-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const track = require('../src/services/homeroom-bot-track');
const tray = require('../src/services/homeroom-bot-tray');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const NOW = Date.parse('2026-10-16T10:35:00Z');
const ago = (minutes) => new Date(NOW - minutes * 60 * 1000).toISOString();
const job = (fields = {}) => ({ key: 'homeroom#5210', appSlug: 'homeroom', appName: 'Homeroom', issueNumber: 5210, title: 'Fix translation context', ...fields });

test('every stage the progress answer knows is a track state, and every one of the tray\'s outcomes', () => {
  const progress = read('src/services/homeroom-bot-progress.js');
  const block = progress.slice(progress.indexOf('const STEP_OF_STAGE = Object.freeze({'), progress.indexOf('});', progress.indexOf('const STEP_OF_STAGE')));
  const stages = [...block.matchAll(/^\s+([a-z_]+): '/gm)].map((m) => m[1]);
  assert.ok(stages.length >= 20, 'the stages were read');
  for (const stage of stages) {
    const t = track.fromStage(stage);
    assert.ok(t, `stage ${stage}`);
    assert.ok(track.STATES.includes(t.state), `${stage} → ${t.state}`);
    assert.ok(t.step === null || track.STEPS.includes(t.step), `${stage} step ${t.step}`);
  }
  for (const outcome of tray.OUTCOMES) {
    const t = track.fromOutcome(outcome);
    assert.ok(t && track.STATES.includes(t.state), `outcome ${outcome}`);
  }
});

test('a track is a loop: failing checks or asked-for changes go back to building as the next try', () => {
  for (const stage of ['fix_queued', 'fixing', 'followup_queued', 'revising']) {
    assert.equal(track.fromStage(stage).state, 'building', stage);
    assert.equal(track.fromStage(stage).loop, true, stage);
  }
  const runs = [
    { verdict: 'ready', created_at: ago(300) }, // the first build
    { verdict: 'answer', proposal_session_id: 9, created_at: ago(100) }, // answered a question: no try
  ];
  const fixing = track.trackOf({ job: job({ stage: 'fixing', since: ago(4) }), runs });
  assert.equal(fixing.try, 2, 'the fix under way is the second try');
  assert.equal(fixing.why, 'fixing');
  const revised = [{ verdict: 'revise', proposal_session_id: 9, created_at: ago(2) }, ...runs];
  assert.equal(track.trackOf({ job: job({ stage: 'checks', since: ago(1) }), runs: revised }).try, 2,
    'a revision that landed counts once, and the change is back in its checks');
  assert.equal(track.triesOf([{ verdict: 'failed', error: 'revise: its change could not be pushed' }, ...runs]), 2,
    'a revision that failed was a try too');
  assert.equal(track.triesOf([{ verdict: 'ready', cap_suppressed: 'proposals_per_app' }]), 1, 'a hold is no try, but there is always one');
});

test('a thread marks where each try began', () => {
  assert.deepEqual(track.tryStartsOf([{ verdict: 'ready', created_at: ago(30) }]), [], 'one try: nothing to mark');
  assert.deepEqual(track.tryStartsOf([
    { verdict: 'revise', proposal_session_id: 9, created_at: ago(10) },
    { verdict: 'answer', proposal_session_id: 9, created_at: ago(20) },
    { verdict: 'ready', created_at: ago(30) },
  ]), [ago(30), ago(10)]);
  assert.deepEqual(track.tryStartsOf([{ verdict: 'ready', created_at: ago(30) }], { underWay: ago(5) }), [ago(30), ago(5)]);
});

test('#5210: the clock times the try under way, not the first one', () => {
  const t = track.trackOf({
    job: job({ stage: 'building', since: ago(15) }),
    runs: [{ verdict: 'ready', created_at: ago(16) }, { verdict: 'ready', created_at: ago(16 * 60 + 31) }],
  });
  assert.equal(t.state, 'building');
  assert.equal(t.step, 'build');
  assert.equal(t.try, 2);
  assert.equal(t.tryStartedAt, ago(15));
  assert.equal(t.busy, true);
});

test('waiting is only on the person: a question, a plan, more detail, a look', () => {
  assert.equal(track.trackOf({ job: job({ stage: 'question', since: ago(5) }) }).waitingOn, 'you');
  assert.equal(track.trackOf({ job: job({ outcome: 'blocked' }) }).why, 'detail');
  assert.equal(track.trackOf({ job: job({ outcome: 'needs_look' }) }).why, 'look');
  // Answered: it waits on the bot again.
  const answered = track.trackOf({ job: job({ outcome: 'question', answered: true }) });
  assert.equal(answered.state, 'planning');
  assert.equal(answered.waitingOn, null);
  // "Needs a person" (snait's twenty) is a stop, not a wait on whoever reads it.
  const person = track.trackOf({ job: job({ outcome: 'person' }) });
  assert.equal(person.state, 'stopped');
  assert.equal(person.why, 'needs_person');
  assert.equal(person.waitingOn, null);
  assert.equal(track.trackOf({ job: job({ outcome: 'empty' }) }).state, 'stopped', 'nothing to build is a stop too');
});

test('a request closed some other way is done elsewhere, by whom, or just closed', () => {
  const shipped = track.trackOf({
    job: job({ outcome: 'build_failed', requestClosed: true }),
    doneBy: { username: 'snait', prNumber: 5247 },
  });
  assert.equal(shipped.state, 'done_elsewhere');
  assert.deepEqual(shipped.doneBy, { username: 'snait', prNumber: 5247 });
  assert.equal(track.trackOf({ job: job({ outcome: 'blocked', requestClosed: true }) }).state, 'closed',
    '#4752: closed, never "Add detail"');
  // A change of the bot's still up for a vote shows itself until it is withdrawn.
  assert.equal(track.trackOf({ job: job({ outcome: 'proposed', requestClosed: true }) }).state, 'vote');
});

test('held says which limit, its place in line, and for an allowance when it lifts', () => {
  const slots = track.trackOf({ job: job({ outcome: 'held' }), runs: [{ id: 7, verdict: 'ready', cap_suppressed: 'proposals_per_app' }], held: { position: 2 } });
  assert.equal(slots.state, 'held');
  assert.deepEqual(slots.held, { limit: 'slots', position: 2, until: null });
  const wide = track.trackOf({ job: job({ outcome: 'held', id: 8 }), runs: [{ id: 8, verdict: 'ready', cap_suppressed: 'proposals_total' }] });
  assert.equal(wide.held.limit, 'bot_wide');
  const week = track.trackOf({ job: job({ stage: 'on_hold', since: ago(60) }), until: '2026-10-19T00:00:00.000Z' });
  assert.deepEqual(week.held, { limit: 'allowance', position: null, until: '2026-10-19T00:00:00.000Z' });
});

test('a stopped build says why, in codes, never the agent\'s words', () => {
  const why = (error, said) => track.buildStopWhy(error, { said });
  assert.equal(why('the build ran past its time limit'), 'time');
  assert.equal(why('couldn\'t push the build\'s commit'), 'not_pushed');
  assert.equal(why('the build produced no change to propose', 'The tier list already supports drag and drop, so nothing to change.'), 'no_change_already');
  assert.equal(why('the build produced no change to propose', 'It is unclear which screen this means.'), 'no_change_unclear');
  assert.equal(why('the build produced no change to propose', 'I cannot reach the payments API from here.'), 'no_change_could_not');
  assert.equal(why('the build produced no change to propose', 'Here is the plan again.'), 'no_change');
  assert.equal(why('the platform restarted in the middle of each of its last 2 tries at building this'), 'restarts');
  assert.equal(why('something else'), 'build_failed');
  const stopped = track.trackOf({ job: job({ outcome: 'build_failed', id: 3 }), runs: [{ id: 3, verdict: 'ready', build_error: 'the build produced no change to propose', no_change_said: 'That is already in place.' }] });
  assert.equal(stopped.why, 'no_change_already');
  assert.doesNotMatch(JSON.stringify(stopped), /already in place/);
});

test('a track carries codes and links, never words', () => {
  const t = track.trackOf({ job: job({ stage: 'vote', cardId: 44, proposalId: 9, links: { request: '/r', proposal: '/p', project: '/x' } }) });
  assert.deepEqual(Object.keys(t).sort(), ['appName', 'appSlug', 'askId', 'busy', 'firstVersion', 'iconEmoji', 'iconUrl', 'issueNumber',
    'key', 'links', 'proposalId', 'rootId', 'sessionId', 'since', 'state', 'step', 'title', 'try', 'tryStartedAt', 'tryStarts',
    'waitingOn', 'why'].sort());
  assert.equal(t.sessionId, 9, 'its plan and change: the change');
  assert.equal(t.rootId, 44, 'the thread to open: its card');
  assert.equal(t.waitingOn, 'group');
});

test('the demo tray, the demo slots and the demo request carry tracks', async () => {
  const pool = { async query() { return { rows: [] }; } };
  const work = await tray.demoWorkFor(pool, null, NOW);
  assert.ok(Array.isArray(work.tracks) && work.tracks.length >= 5);
  for (const t of work.tracks) assert.ok(track.STATES.includes(t.state), t.key);
  const held = work.tracks.find((t) => t.state === 'held');
  assert.deepEqual([held.issueNumber, held.why, held.held.position], [16, 'slots', 1], 'the drawer\'s On hold group can be seen');
  const slots = track.demoSlots({ slug: 'staging-demo', name: 'Staging demo' }, NOW);
  assert.equal(slots.slots.length, 5);
  assert.deepEqual(slots.slots.map((s) => s.track.state), ['building', 'building', 'vote', 'checks', 'waiting']);
  assert.equal(slots.slots[1].track.try, 2, 'its fix is the second try');
  assert.equal(slots.waiting[0].track.held.position, 1);
  const request = track.demoRequestTrack({ slug: 'staging-demo' }, 900018, 'Staging demo request', NOW);
  assert.equal(request.state, 'building');
  assert.equal(request.try, 2);
});

test('the tray answers with its tracks; the request page and the slots route read them', () => {
  assert.match(read('src/services/homeroom-bot-tray.js'), /trackSvc\(\)\.withTracks\(pool, settled, \{ entries: shown, rows: rows\.filter/);
  const issues = read('src/routes/issues.js');
  assert.match(issues, /trackSvc\.tracksForRequests\(pool, \{ appId: app\.id, numbers: \[number\] \}\)/);
  assert.match(issues, /router\.get\('\/api\/apps\/:slug\/homeroom-bot\/slots'/);
  // An open request's page draws from the board's list, not from the one
  // request's route: the list carries each request's track too (the
  // declared check on #900018 found the card missing without it).
  assert.match(issues, /const tracks = await trackSvc\.tracksForRequests\(pool, \{ appId: app\.id, numbers: \(result\.issues \|\| \[\]\)\.map\(\(i\) => i\.number\) \}\);/);
  assert.match(issues, /bot: botAsked\(issue\.number\),\s*track: tracks\.get\(issue\.number\) \|\| null,/);
  assert.match(issues, /if \(issue\.number === 900018 && !issue\.track\) issue\.track = trackSvc\.demoRequestTrack\(app, 900018, issue\.title\);/);
  // A whole list is narrowed first to the requests the bot has touched.
  assert.match(read('src/services/homeroom-bot-track.js'), /\? \(await pool\.query\(TOUCHED_SQL, \[Number\(appId\), asked\]\)\)\.rows\.map/);
  // The staging demo's ?demo=1 rides on every messages read already
  // (api.ts demoQuery): the slots read must not add it twice, which the
  // server reads as a list and answers with the real, empty view.
  const api = read('frontend/src/features/messages/api.ts');
  const slotsRead = api.slice(api.indexOf('export async function getBotSlots'), api.indexOf('export async function getBotSlots') + 400);
  assert.doesNotMatch(slotsRead, /demo=1/);
  assert.match(api, /function demoQuery\(path: string\): string \{[\s\S]*?demo=1`;/);
});
