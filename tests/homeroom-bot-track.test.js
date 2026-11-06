'use strict';

// One track per request (src/services/homeroom-bot-track.js). 5 Nov 2026
// (docs/plans/bot-one-model.md, step 3): where a request stands is its
// stored work state (services/work-state.js), the same one every screen
// draws; a track is that state with what a request's card draws around it:
// the step its bar lights, its try and clock, its place in a line, who
// shipped it, its links. Pure parts here; the reads against PostgreSQL in
// homeroom-bot-slots-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const track = require('../src/services/homeroom-bot-track');
const ws = require('../src/services/work-state');
const bot = require('../src/services/homeroom-bot');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const NOW = Date.parse('2026-10-16T10:35:00Z');
const ago = (minutes) => new Date(NOW - minutes * 60 * 1000).toISOString();
const job = (fields = {}) => ({ key: 'homeroom#5210', appSlug: 'homeroom', appName: 'Homeroom', issueNumber: 5210, title: 'Fix translation context', ...fields });
const work = (stage, extra = {}) => ({ stage, why: null, reason: null, line: null, whoseMove: null, since: null, ...extra });

test('every stage lights one step of the bar, or none before the work starts', () => {
  assert.deepEqual(track.STEPS, ['plan', 'build', 'checks', 'vote', 'live']);
  for (const stage of ws.STAGES) {
    assert.ok(Object.prototype.hasOwnProperty.call(track.STEP_OF_STAGE, stage), `stage ${stage}`);
    const step = track.STEP_OF_STAGE[stage];
    assert.ok(step === null || track.STEPS.includes(step), `${stage} → ${step}`);
  }
  const step = (w) => track.trackOf({ job: job(), work: w }).step;
  assert.equal(step(work('reading', { line: { code: 'queued', place: 2 } })), null, 'waiting in line: no step yet');
  assert.equal(step(work('reading', { line: { code: 'reply' } })), 'plan', 'reading a reply');
  assert.equal(step(work('building', { line: { code: 'held_builds' } })), 'build');
  assert.equal(step(work('up_for_vote')), 'vote');
  assert.equal(step(work('closed')), null);
});

test('a track is a loop: failing checks or asked-for changes go back to building as the next try', () => {
  const runs = [
    { verdict: 'ready', created_at: ago(300) }, // the first build
    { verdict: 'answer', proposal_session_id: 9, created_at: ago(100) }, // answered a question: no try
  ];
  const fixing = track.trackOf({ job: job(), work: work('building', { line: { code: 'fixing' }, since: ago(4) }), runs });
  assert.equal(fixing.try, 2, 'the fix under way is the second try');
  assert.deepEqual(fixing.work.line, { code: 'fixing' });
  const revised = [{ verdict: 'revise', proposal_session_id: 9, created_at: ago(2) }, ...runs];
  assert.equal(track.trackOf({ job: job(), work: work('checking', { since: ago(1) }), runs: revised }).try, 2,
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
    job: job(),
    work: work('building', { since: ago(15) }),
    runs: [{ verdict: 'ready', created_at: ago(16) }, { verdict: 'ready', created_at: ago(16 * 60 + 31) }],
  });
  assert.equal(t.work.stage, 'building');
  assert.equal(t.step, 'build');
  assert.equal(t.try, 2);
  assert.equal(t.tryStartedAt, ago(15));
  assert.equal(t.busy, true);
  const held = track.trackOf({ job: job(), work: work('building', { line: { code: 'held_waiting' }, since: ago(15) }) });
  assert.deepEqual([held.busy, held.tryStartedAt], [false, null], 'a build waiting its turn has no clock');
});

test('waiting is on the person whose move it is', () => {
  const yours = (why) => track.trackOf({ job: job(), work: work('waiting_for_you', { why, whoseMove: 'requester' }) });
  for (const why of ['question', 'plan', 'decide', 'already_works', 'needs_detail']) {
    assert.equal(yours(why).waitingOn, 'you', why);
    assert.equal(yours(why).work.why, why);
  }
  assert.equal(track.trackOf({ job: job(), work: work('up_for_vote', { whoseMove: 'group' }) }).waitingOn, 'group');
  assert.equal(track.trackOf({ job: job(), work: work('building', { whoseMove: 'bot' }) }).waitingOn, null);
  // The stored state says it, from the bot's records: a question asked.
  const asked = ws.derive({ app_id: 1, issue_number: 5210, mode: 'live', verdict: 'question', run_at: ago(9), question_at: ago(5) }, { now: new Date(NOW) });
  assert.equal(track.trackOf({ job: job(), work: asked }).waitingOn, 'you');
});

test('a request closed by somebody else\'s change says who shipped it; one just closed, nothing more', () => {
  const shipped = track.trackOf({ job: job(), work: work('closed'), doneBy: { username: 'snait', prNumber: 5247 } });
  assert.deepEqual(shipped.doneBy, { username: 'snait', prNumber: 5247 });
  assert.equal(track.trackOf({ job: job(), work: work('closed') }).doneBy, undefined);
  assert.equal(track.trackOf({ job: job(), work: work('building'), doneBy: { username: 'snait' } }).doneBy, undefined,
    'only a closed request names who shipped it');
});

test('held says which line it waits in, its place there, and for the week\'s building time when it lifts', () => {
  const slots = track.trackOf({ job: job(), work: work('building', { line: { code: 'held_waiting' } }), held: { position: 2 } });
  assert.deepEqual(slots.held, { limit: 'slots', position: 2, until: null });
  // #6156: held because the project's builds are all under way: it waits for
  // the bot's turn.
  assert.equal(track.CAP_LIMITS.builds_per_app, 'builds');
  const turn = track.trackOf({ job: job(), work: work('building', { line: { code: 'held_builds' } }), held: { position: 1 } });
  assert.deepEqual(turn.held, { limit: 'builds', position: 1, until: null });
  const week = track.trackOf({ job: job(), work: work('reading', { line: { code: 'on_hold' } }), until: '2026-10-19T00:00:00.000Z' });
  assert.deepEqual(week.held, { limit: 'allowance', position: null, until: '2026-10-19T00:00:00.000Z' });
  // #6357: paused a day after repeated errors: no limit held, no week, but
  // when it is tried again, its hold's own end.
  const cool = track.trackOf({ job: job(), work: work('reading', { line: { code: 'cooldown' } }), until: '2026-10-13T09:41:00.000Z' });
  assert.equal(cool.held, undefined);
  assert.equal(cool.retryAt, '2026-10-13T09:41:00.000Z');
  assert.equal(cool.step, null, 'not started');
  assert.equal(cool.busy, false);
  assert.equal(track.standingOf(cool).say, 'builds', 'the bot still has it in hand');
  // In the bot's line: how many are ahead.
  assert.deepEqual(track.trackOf({ job: job(), work: work('reading', { line: { code: 'queued', place: 3 } }) }).queue, { ahead: 2 });
  // 16 Oct 2026: a person has it now: theirs, with no place in a line.
  const claimed = track.trackOf({ job: job(), work: work('building', { line: { code: 'claimed', by: 'snait' }, whoseMove: 'builder' }) });
  assert.deepEqual([claimed.held, claimed.busy, claimed.work.line.by], [undefined, false, 'snait']);
});

test('a row of the slots page quotes its request: the asker\'s first line, not what Homeroom wrote around it', () => {
  assert.equal(track.requestExcerpt('**Source:** Suggest an improvement on Homeroom\n\n![screenshot](x.png)\n\nChallenges still refers to season 2\n\nPinned with Comment mode'),
    'Challenges still refers to season 2');
  assert.equal(track.requestExcerpt('## Make it *darker* at `night`'), 'Make it darker at night');
  assert.equal(track.requestExcerpt(`${'word '.repeat(60)}`, 20), 'word word word word…');
  assert.equal(track.requestExcerpt(''), null);
  assert.equal(track.requestExcerpt('**Source:** a comment pin'), null, 'nothing of their own: no line');
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
  const stopped = track.trackOf({
    job: job(),
    work: work('stopped', { reason: 'build_failed' }),
    runs: [{ id: 3, verdict: 'ready', build_error: 'the build produced no change to propose', no_change_said: 'That is already in place.' }],
  });
  assert.equal(stopped.cause, 'no_change_already');
  assert.doesNotMatch(JSON.stringify(stopped), /already in place/);
  assert.equal(track.trackOf({ job: job(), work: work('stopped', { reason: 'fix_stopped' }), runs: [{ id: 3 }] }).cause, undefined,
    'only a build that did not finish says a cause');
});

test('a track carries codes and links, never words', () => {
  const t = track.trackOf({
    job: job({ cardId: 44, proposalId: 9, links: { request: '/r', proposal: '/p', project: '/x' } }),
    work: work('up_for_vote', { whoseMove: 'group' }),
  });
  assert.deepEqual(Object.keys(t).sort(), ['appName', 'appSlug', 'askId', 'askThreadId', 'busy', 'firstVersion', 'iconEmoji', 'iconUrl', 'issueNumber',
    'key', 'links', 'proposalId', 'rootId', 'sessionId', 'since', 'step', 'title', 'try', 'tryStartedAt', 'tryStarts',
    'waitingOn', 'work'].sort());
  assert.deepEqual(Object.keys(t.work).sort(), ['line', 'reason', 'since', 'stage', 'why']);
  assert.equal(t.sessionId, 9, 'its plan and change: the change');
  assert.equal(t.rootId, 44, 'the thread to open: its card');
  assert.equal(t.waitingOn, 'group');
  assert.deepEqual(track.linksFor('notes', 5, 9, 12), { request: '#app/notes/dev/issues/5', proposal: track.linksFor('notes', 5, 9, 12).proposal, project: null });
  assert.equal(track.linksFor('notes', null, null).project, '#app/notes/app', 'with no request, its project');
  // A fresh request with no stored row yet reads as not started.
  const fresh = track.trackOf({ job: job() });
  assert.deepEqual([fresh.work.stage, fresh.work.line], ['reading', { code: 'waiting' }]);
});

test('the demo slots and the demo request carry tracks', () => {
  const slots = track.demoSlots({ slug: 'staging-demo', name: 'Staging demo' }, NOW);
  // #6156: its builds all in use, three changes waiting for votes, and the
  // requests waiting for the bot's turn; the caps are the bot's own.
  assert.deepEqual([slots.buildCap, slots.waitCap], [bot.BUILDS_PER_APP, bot.WAITING_PER_APP]);
  assert.deepEqual(slots.slots.map((s) => s.kind), ['build', 'build', 'build', 'build', 'build', 'proposal', 'proposal', 'proposal']);
  assert.equal(slots.slots.filter((s) => s.kind === 'build').length, slots.buildCap, 'the builds are full');
  assert.deepEqual(slots.slots.map((s) => s.track.work.stage),
    ['building', 'building', 'building', 'building', 'building', 'up_for_vote', 'checking', 'waiting_for_you']);
  assert.deepEqual(slots.slots.map((s) => s.track.work.line?.code || null),
    [null, 'fixing', 'reviewing', 'queued', 'queued', null, null, null]);
  assert.equal(slots.slots[1].track.try, 2, 'its fix is the second try');
  assert.equal(slots.waiting[0].track.held.position, 1);
  assert.deepEqual(slots.waiting.map((w) => [w.limit, w.track.held.limit]), [['builds', 'builds'], ['builds', 'builds']]);
  // Its rows are staging's mock requests when it has them, so a tap opens
  // one; each says who asked, and one a person took is listed apart.
  const mocked = track.demoSlots({ slug: 'staging-demo', name: 'Staging demo' }, NOW, [
    { number: 900009, title: '[Mock] Newly filed issue', body: 'Staging-only mock issue.' },
  ]);
  assert.deepEqual([mocked.waiting[0].issueNumber, mocked.waiting[0].title, mocked.waiting[0].excerpt], [900009, '[Mock] Newly filed issue', 'Staging-only mock issue.']);
  assert.ok(mocked.slots.every((s) => s.askedBy), 'every row says who asked');
  assert.deepEqual(mocked.taken.map((s) => [s.issueNumber, s.by, s.track.work.line.code]), [[900014, 'maya-builder', 'claimed']]);
  // And every other open request, by where the bot is on it.
  assert.deepEqual(mocked.waitingOn.map((s) => s.track.work.why), ['plan', 'question']);
  assert.deepEqual(mocked.upNext.map((s) => [s.kind, s.position ?? null, s.trial ?? null]), [['queued', null, null], ['older', 1, 'ready'], ['older', 2, null]]);
  assert.deepEqual(mocked.stopped.map((s) => s.track.work.reason), ['build_failed']);
  assert.deepEqual(mocked.leftToPeople.map((s) => s.track.work.why), ['decide']);
  assert.equal(mocked.withPeople, 3);
  const rest = (stage, extra = {}) => track.restSection({ work: work(stage, extra) });
  assert.deepEqual(
    [rest('waiting_for_you', { why: 'question' }), rest('reading'), rest('planning'), rest('stopped', { reason: 'build_failed' })],
    ['waitingOn', 'upNext', 'upNext', 'stopped'],
  );
  assert.equal(rest('waiting_for_you', { why: 'decide' }), 'leftToPeople', 'a person decides it');
  assert.equal(rest('up_for_vote'), null, 'a change up for a vote holds a slot');
  const request = track.demoRequestTrack({ slug: 'staging-demo' }, 900018, 'Staging demo request', NOW);
  assert.equal(request.work.stage, 'building');
  assert.equal(request.try, 2);
});

test('the request page and the slots route read the tracks, from the stored work states', () => {
  const issues = read('src/routes/issues.js');
  assert.match(issues, /trackSvc\.tracksForRequests\(pool, \{ appId: app\.id, numbers: \[number\] \}\)/);
  assert.match(issues, /router\.get\('\/api\/apps\/:slug\/homeroom-bot\/slots'/);
  // An open request's page draws from the board's list, not from the one
  // request's route: the list carries each request's track too (the
  // declared check on #900018 found the card missing without it).
  assert.match(issues, /const tracks = await trackSvc\.tracksForRequests\(pool, \{ appId: app\.id, numbers: \(result\.issues \|\| \[\]\)\.map\(\(i\) => i\.number\) \}\);/);
  // Papote #3: as the viewer reads it (forViewer, below).
  assert.match(issues, /bot: botAsked\(issue\.number\),\s*track: trackSvc\.forViewer\(tracks\.get\(issue\.number\) \|\| null, askers\.get\(issue\.number\), req\.user\.id\),/);
  assert.match(issues, /if \(issue\.number === 900018 && !issue\.track\) issue\.track = trackSvc\.demoRequestTrack\(app, 900018, issue\.title\);/);
  // A whole list is narrowed first to the requests the bot has touched,
  // and the rows it reads are the stored ones, made for any that have none.
  const src = read('src/services/homeroom-bot-track.js');
  assert.match(src, /\? \(await pool\.query\(TOUCHED_SQL, \[Number\(appId\), asked\]\)\)\.rows\.map/);
  assert.match(src, /await workState\.ensure\(pool, items\);/);
  assert.match(src, /workState\.forRequests\(pool, Number\(appId\), wanted\)/);
  assert.doesNotMatch(src, /stageOf|outcomeOf/, 'no decider of its own');
  // The staging demo's ?demo=1 rides on every messages read already
  // (api.ts demoQuery): the slots read must not add it twice, which the
  // server reads as a list and answers with the real, empty view.
  const api = read('frontend/src/features/messages/api.ts');
  const slotsRead = api.slice(api.indexOf('export async function getBotSlots'), api.indexOf('export async function getBotSlots') + 400);
  assert.doesNotMatch(slotsRead, /demo=1/);
  assert.match(api, /function demoQuery\(path: string\): string \{[\s\S]*?demo=1`;/);
});

// Papote #3 (18 Oct 2026): the request's page said "Waiting on you: Its plan
// is ready for you to say Build it" to every member, beside a button that
// said the plan waited for somebody else's OK.
test('papote #3: a track waiting on its requester names them to anybody else', () => {
  const plan = { work: work('waiting_for_you', { why: 'plan' }), waitingOn: 'you' };
  const snait = { userId: 7, username: 'snait' };
  assert.deepEqual(track.forViewer(plan, snait, 12), { ...plan, waitingFor: 'snait' });
  assert.equal(track.forViewer(plan, snait, 7), plan, 'its requester reads it as theirs');
  assert.equal(track.forViewer(plan, snait, '7'), plan, 'whatever type the id came as');
  assert.equal(track.forViewer(plan, null, 12), plan, 'nobody to name: as before');
  const building = { work: work('building'), waitingOn: null };
  assert.equal(track.forViewer(building, snait, 12), building, 'only a wait on them is named');
  assert.equal(track.forViewer(null, snait, 12), null);
  const routes = fs.readFileSync(path.join(__dirname, '..', 'src/routes/issues.js'), 'utf8');
  assert.match(routes, /track: trackSvc\.forViewer\(tracks\.get\(issue\.number\) \|\| null, askers\.get\(issue\.number\), req\.user\.id\),/,
    'the board list');
  assert.match(routes, /track = trackSvc\.forViewer\(track, asker, req\.user\.id\);/, 'and a request opened on its own');
});

test('B02: a filed first version waiting on its creator\'s plan is waiting on them, never "Stopped"', () => {
  const plan = ws.derive({
    app_id: 3, issue_number: 1, first_version: true, mode: 'live', verdict: 'ready', run_at: ago(6), plan_waiting_at: ago(5),
  }, { now: new Date(NOW) });
  const first = track.trackOf({ job: job({ key: 'flat-chores#1', appSlug: 'flat-chores', issueNumber: 1, firstVersion: true }), work: plan });
  assert.deepEqual([first.work.stage, first.work.why, first.waitingOn, first.firstVersion], ['waiting_for_you', 'plan', 'you', true]);
  // The request rows say which requests are a project's first version.
  assert.match(read('src/services/homeroom-bot-track.js'),
    /COALESCE\(\(SELECT rq\.first_version FROM homeroom_bot_requesters rq\s+WHERE rq\.app_id = a\.id AND rq\.issue_number = w\.n\), FALSE\) AS first_version,/);
  assert.equal(track.jobOfRow({ slug: 'flat-chores', issue_number: 1, first_version: true }).firstVersion, true);
});

test('B23: a request its own change made live reads live once it closed, whatever a later look said', () => {
  const live = ws.derive({
    app_id: 3, issue_number: 1, mode: 'live', verdict: 'empty', run_at: ago(5), request_closed: true,
    proposal_session_id: 9, proposal_status: 'merged', merged_at: ago(10),
  }, { now: new Date(NOW) });
  assert.equal(track.trackOf({ job: job(), work: live }).work.stage, 'live');
  const closed = ws.derive({
    app_id: 3, issue_number: 1, mode: 'live', verdict: 'empty', run_at: ago(5), request_closed: true,
  }, { now: new Date(NOW) });
  assert.equal(closed.stage, 'closed', 'a request closed with no change of its own live is just closed');
});

test('a plan said in a private thread names that thread on its track, for its doors; one in Main names none', () => {
  const inThread = track.trackOf({ job: job({ ask: { messageId: 62, kind: 'plan', threadRootId: 58 } }), work: work('waiting_for_you', { why: 'plan' }) });
  assert.deepEqual([inThread.askId, inThread.askThreadId], [62, 58]);
  const inMain = track.trackOf({ job: job({ ask: { messageId: 62, kind: 'plan' } }), work: work('waiting_for_you', { why: 'plan' }) });
  assert.deepEqual([inMain.askId, inMain.askThreadId], [62, null]);
});

// #6228 (3 Nov 2026): the read the bot started after somebody's reply is
// still the reading stage, with the reply's own line.
test('#6228: a read of somebody\'s reply is reading, its line "reply"', () => {
  const replied = track.trackOf({ job: job(), work: work('reading', { line: { code: 'reply' }, since: ago(2) }) });
  assert.deepEqual([replied.work.stage, replied.step, replied.work.line, replied.busy], ['reading', 'plan', { code: 'reply' }, true]);
  // The stored state reads it from the records (stageOf's reply).
  const stored = ws.derive({
    app_id: 1, issue_number: 6228, mode: 'live', verdict: 'person', run_at: ago(10), reply_at: ago(1), queue_id: 3, enqueued_at: ago(2),
  }, { now: new Date(NOW) });
  assert.deepEqual([stored.stage, stored.line], ['reading', { code: 'reply' }]);
});

// #6313 (4 Nov 2026): a request queued again after a plan that could not be
// written says it is trying the plan again, not merely that it waits.
test('#6313: a read queued after a plan that could not be written says it is retrying the plan', () => {
  const row = {
    app_id: 1, issue_number: 6313, run_id: 9, mode: 'live', verdict: 'ready',
    run_at: ago(20), build_ok: false, build_error: 'no plan could be written (timeout)',
    queue_id: 44, started_at: null, enqueued_at: ago(1), request_closed: false,
  };
  const retry = ws.derive(row, { now: new Date(NOW) });
  assert.deepEqual([retry.stage, retry.line], ['planning', { code: 'retry_plan' }]);
  assert.equal(track.trackOf({ job: job(), work: retry }).busy, false, 'it waits its turn');
  const other = ws.derive({ ...row, build_error: 'the build turn failed (exit 1)' }, { now: new Date(NOW) });
  assert.deepEqual([other.stage, other.line.code], ['reading', 'queued']);
  const reading = ws.derive({ ...row, queue_id: 44, started_at: ago(1) }, { now: new Date(NOW) });
  assert.equal(reading.stage, 'reading');
  assert.equal(reading.line, null, 'a read under way is reading the request, not retrying anything');
});
