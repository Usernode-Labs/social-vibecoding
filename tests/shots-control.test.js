'use strict';

// The run-scoped control plane behind the shots agent's shots tools
// (src/services/shots-control.js). It holds what one run saved and
// skipped, refuses anything outside the declared changes, and is reachable
// only by the session that owns the run while the run is live.

const test = require('node:test');
const assert = require('node:assert/strict');
const controlPlane = require('../src/services/shots-control');
const fixtures = require('./fixtures/shots');

const { RunControl } = controlPlane;

function control(overrides = {}) {
  return new RunControl({
    runId: 'a'.repeat(32),
    sessionId: 42,
    intent: fixtures.motionIntent(),
    context: { addresses: { before: 'http://base.test', after: 'http://head.test' } },
    expiresAt: Date.now() + 10_000,
    ...overrides,
  });
}

// Two still changes and one motion change: enough to show per-change reasons
// next to a reason that covers everything.
function threeChanges() {
  const raw = fixtures.motionIntent();
  raw.stories.push({
    ...structuredClone(raw.stories[0]),
    id: 'member-count',
    claim: 'The members list shows how many people have joined.',
  });
  return raw;
}

const statuses = (run) => run.progress().map((entry) => [entry.change, entry.status]);

// A before and an after that differ, as the shots of a real change do: the
// same image on both sides is its own case (see the tests at the end).
const sideShot = (side) => fixtures.png({ shade: side === 'after' ? 200 : 0 });

function shootBothSides(run, change) {
  for (const side of ['before', 'after']) {
    run.saveShot({ change, screen: 'desktop', side }, sideShot(side));
  }
}

test('a saved shot maps before/after to the stored sides and a retake replaces its slot', () => {
  const run = control();
  const first = run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'before' },
    fixtures.png({ shade: 1 }));
  assert.deepEqual({ ...first, progress: undefined }, {
    saved: true, change: 'invite-suggestions', screen: 'desktop', side: 'before', kind: 'screen',
    bytes: fixtures.png({ shade: 1 }).length, width: 4, height: 3, progress: undefined,
  });
  assert.equal(run.saved.size, 1);

  const retake = fixtures.png({ width: 6, height: 2, shade: 2 });
  assert.equal(run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'before' }, retake).width, 6);
  assert.equal(run.saved.size, 1, 'the same change, screen, side and kind is one slot');
  const [stored] = run.saved.values();
  assert.equal(stored.side, 'base');
  assert.equal(stored.variant, 'context');
  assert.equal(stored.data, retake);

  const element = run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'before', kind: 'element' },
    fixtures.png());
  assert.equal(element.kind, 'element');
  run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'after' }, fixtures.png());
  assert.equal(run.saved.size, 3);
  assert.deepEqual([...run.saved.values()].map((file) => [file.side, file.variant]),
    [['base', 'context'], ['base', 'focus'], ['head', 'context']]);
  assert.ok(run.summary().files.some((file) => file.data === retake), 'the retake is what gets published');
});

test('a clip is saved only for a motion change, and a refused file saves nothing', () => {
  const run = control();
  const clip = run.saveShot({ change: 'saved-toast', screen: 'desktop', side: 'after', kind: 'clip' },
    fixtures.webm());
  assert.equal(clip.kind, 'clip');
  assert.equal(clip.side, 'after');
  assert.equal(clip.bytes, 2048);
  assert.equal('width' in clip, false, 'a clip reports no dimensions');
  assert.equal([...run.saved.values()][0].contentType, 'video/webm');

  assert.throws(() => run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'after', kind: 'clip' },
    fixtures.webm()), { code: 'clip_not_needed', status: 400 });
  assert.throws(() => run.saveShot({ change: 'saved-toast', screen: 'desktop', side: 'before', kind: 'clip' },
    fixtures.png()), { code: 'invalid_clip', status: 400 });
  assert.throws(() => run.saveShot({ change: 'saved-toast', screen: 'desktop', side: 'before' },
    fixtures.webm()), { code: 'invalid_shot_image', status: 400 });
  assert.throws(() => run.saveShot({ change: 'saved-toast', screen: 'mobile', side: 'before' },
    fixtures.png()), { code: 'unknown_screen', status: 400 });
  assert.throws(() => run.saveShot({ change: 'not-declared', screen: 'desktop', side: 'before' },
    fixtures.png()), { code: 'unknown_change', status: 400 });
  assert.equal(run.saved.size, 1);
});

// A project's first version: the before address is the starter template's
// placeholder (services/shots-starter.js), so the run takes the after side
// only, and a before shot is refused while the agent can still move on.
test('a first version\'s run refuses a before shot and is ready with the after side alone', () => {
  const run = control({ intent: fixtures.intent(), afterOnly: true });
  assert.throws(() => run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'before' },
    sideShot('before')), (error) => {
    assert.equal(error.code, 'before_not_needed');
    assert.equal(error.status, 400);
    assert.match(error.message, /starter template's placeholder/);
    assert.match(error.message, /takes after shots only/);
    return true;
  });
  assert.equal(run.saved.size, 0, 'nothing from the before side is kept');
  assert.equal(run.lastToolFailure.operation, 'save-shot');
  run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'after' }, sideShot('after'));
  assert.deepEqual(statuses(run), [['invite-suggestions', 'ready']]);
  assert.equal(run.summary().verdict.afterOnly, true);
  // An ordinary run takes both sides, as before.
  assert.equal(control({ intent: fixtures.intent() }).saveShot(
    { change: 'invite-suggestions', screen: 'desktop', side: 'before' }, sideShot('before')).side, 'before');
});

test('progress reports each change as missing, ready or skipped', () => {
  const run = control();
  const initial = run.progress();
  assert.deepEqual(statuses(run), [['invite-suggestions', 'missing'], ['saved-toast', 'missing']]);
  assert.equal(initial[0].detail,
    'The shots agent did not save the before shot on desktop, the after shot on desktop.');
  assert.equal(initial[1].detail, 'The shots agent did not save the before shot on desktop, '
    + 'the before clip on desktop, the after shot on desktop, the after clip on desktop.');

  shootBothSides(run, 'invite-suggestions');
  assert.deepEqual(run.progress()[0], { change: 'invite-suggestions', status: 'ready' });

  const skipped = run.skipChange({
    change: 'saved-toast', reason: '  The toast needs a saved list, and members cannot create one.  ',
  });
  assert.equal(skipped.skipped, 'saved-toast');
  assert.deepEqual(skipped.progress, run.progress());
  assert.deepEqual(run.progress()[1], {
    change: 'saved-toast', status: 'skipped',
    detail: 'The toast needs a saved list, and members cannot create one.',
  });

  const summary = run.summary();
  assert.equal(summary.readyCount, 1);
  assert.deepEqual(summary.verdict, {
    passed: true, mode: 'shots', runs: 1,
    stories: [
      { id: 'invite-suggestions', status: 'ready', files: 2 },
      { id: 'saved-toast', status: 'skipped', reason: 'The toast needs a saved list, and members cannot create one.' },
    ],
  });
  // The agent may still come back to a change it skipped and shoot it.
  for (const side of ['before', 'after']) {
    run.saveShot({ change: 'saved-toast', screen: 'desktop', side }, sideShot(side));
    run.saveShot({ change: 'saved-toast', screen: 'desktop', side, kind: 'clip' }, fixtures.webm());
  }
  assert.deepEqual(statuses(run), [['invite-suggestions', 'ready'], ['saved-toast', 'ready']]);
});

test('skipping every change keeps what was shot and closes the turn', () => {
  const run = control({ intent: threeChanges() });
  shootBothSides(run, 'invite-suggestions');
  run.skipChange({ change: 'saved-toast', reason: 'The toast is behind a paid plan.' });
  const all = run.skipChange({ reason: 'Every other screen shows a sign-in page.' });
  assert.equal(all.skipped, 'all');
  assert.deepEqual(all.progress, [
    { change: 'invite-suggestions', status: 'ready' },
    // A change's own reason wins over the one that covers everything.
    { change: 'saved-toast', status: 'skipped', detail: 'The toast is behind a paid plan.' },
    { change: 'member-count', status: 'skipped', detail: 'Every other screen shows a sign-in page.' },
  ]);
  assert.equal(run.summary().verdict.passed, true, 'the shot change is still published');

  const before = run.saved.size;
  assert.throws(() => run.saveShot({ change: 'member-count', screen: 'desktop', side: 'after' }, fixtures.png()),
    { code: 'shots_turn_finished', status: 409 });
  assert.throws(() => run.skipChange({ change: 'member-count', reason: 'Changed my mind.' }),
    { code: 'shots_turn_finished', status: 409 });
  assert.throws(() => run.skipChange({ reason: 'Again.' }), { code: 'shots_turn_finished' });
  assert.equal(run.saved.size, before);
  assert.equal(run.skippedAll, 'Every other screen shows a sign-in page.');
});

test('nothing shot and everything skipped is a run that does not pass', () => {
  const run = control();
  run.skipChange({ change: null, reason: 'The app does not start on either build.' });
  const summary = run.summary();
  assert.equal(summary.readyCount, 0);
  assert.equal(summary.verdict.passed, false);
  assert.deepEqual(summary.files, []);
  assert.deepEqual(summary.stories.map((story) => story.reason), [
    'The app does not start on either build.', 'The app does not start on either build.',
  ]);
});

test('a skip needs a reason and a declared change', () => {
  const run = control();
  assert.throws(() => run.skipChange({ change: 'invite-suggestions', reason: '   ' }),
    { code: 'reason_required', status: 400 });
  assert.throws(() => run.skipChange({ change: 'invite-suggestions' }), { code: 'reason_required' });
  assert.throws(() => run.skipChange(), { code: 'reason_required' });
  assert.throws(() => run.skipChange({ reason: '' }), { code: 'reason_required' },
    'an empty reason cannot close the whole turn');
  assert.throws(() => run.skipChange({ change: 'someone-elses-change', reason: 'Not reachable.' }),
    { code: 'unknown_change', status: 400 });
  assert.equal(run.skipped.size, 0);
  assert.equal(run.skippedAll, null);

  run.skipChange({ change: 'invite-suggestions', reason: 'y'.repeat(1500) });
  assert.equal(run.skipped.get('invite-suggestions').length, 1000);
});

test('skipping a change withdraws the shots saved for it, and saving again takes the skip back', () => {
  const run = control({ intent: threeChanges() });
  shootBothSides(run, 'invite-suggestions');
  shootBothSides(run, 'member-count');
  assert.deepEqual(statuses(run).slice(0, 1), [['invite-suggestions', 'ready']]);

  // The agent looks at its shots and finds they do not show the change.
  const withdrawn = run.skipChange({ change: 'invite-suggestions', reason: 'The suggestions never appeared.' });
  assert.equal(withdrawn.skipped, 'invite-suggestions');
  assert.deepEqual(withdrawn.progress[0],
    { change: 'invite-suggestions', status: 'skipped', detail: 'The suggestions never appeared.' });
  let summary = run.summary();
  assert.ok(summary.files.every((file) => file.storyId !== 'invite-suggestions'),
    'nothing of the withdrawn change is published');
  assert.equal(summary.verdict.passed, true, 'the other ready change still is');

  // A retake is the agent changing its mind again: the latest action wins.
  run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'after' }, fixtures.png({ shade: 9 }));
  assert.deepEqual(statuses(run)[0], ['invite-suggestions', 'ready']);
  summary = run.summary();
  assert.ok(summary.files.some((file) => file.storyId === 'invite-suggestions'));
});

test('a note on what a change\'s shots leave out is kept with the ready change', () => {
  const run = control({ intent: threeChanges() });
  shootBothSides(run, 'invite-suggestions');
  const noted = run.noteChange({ change: 'invite-suggestions', note: '  The fold needs a hidden app.  ' });
  assert.equal(noted.noted, 'invite-suggestions');
  assert.deepEqual(noted.progress[0],
    { change: 'invite-suggestions', status: 'ready', note: 'The fold needs a hidden app.' });
  run.noteChange({ change: 'invite-suggestions', note: 'A later note replaces it.' });
  assert.equal(run.summary().stories[0].note, 'A later note replaces it.');

  // A change that is not ready shows its reason, not a note.
  run.noteChange({ change: 'member-count', note: 'Only the count is shown.' });
  assert.equal(run.summary().stories.find((story) => story.id === 'member-count').status, 'skipped');
  assert.equal(Object.hasOwn(run.summary().stories.find((story) => story.id === 'member-count'), 'note'), false);

  assert.throws(() => run.noteChange({ change: 'invite-suggestions', note: ' ' }), { code: 'note_required', status: 400 });
  assert.throws(() => run.noteChange({ note: 'No change named.' }), { code: 'unknown_change', status: 400 });
  assert.throws(() => run.noteChange({ change: 'someone-elses-change', note: 'x' }), { code: 'unknown_change' });
  assert.equal(run.lastToolFailure.operation, 'note-change');

  run.skipChange({ reason: 'Nothing else loads.' });
  assert.throws(() => run.noteChange({ change: 'invite-suggestions', note: 'Too late.' }),
    { code: 'shots_turn_finished', status: 409 });
});

test('the brief\'s phone sign-in code never reaches a note or a skip reason', () => {
  // Homeroom's own copies hand the agent the run's code (the brief's
  // phoneSignIn); a note or a reason is shown on the proposal.
  const context = { addresses: { before: 'http://base.test', after: 'http://head.test' },
    phoneSignIn: { code: '048213' } };
  const run = control({ intent: threeChanges(), context });
  assert.equal(run.getContext().phoneSignIn.code, '048213', 'the agent reads it in its brief');
  shootBothSides(run, 'invite-suggestions');
  run.noteChange({ change: 'invite-suggestions', note: 'Typed 048213 for +1 415 555 0142; the next step is left out.' });
  run.skipChange({ change: 'member-count', reason: 'Code 048 213 and 048-213 both went to a blank page.' });
  run.skipChange({ reason: 'Everything else needs 048213.' });
  const stories = run.summary().stories;
  assert.equal(stories.find((story) => story.id === 'invite-suggestions').note,
    'Typed **** for +1 415 555 0142; the next step is left out.');
  assert.equal(stories.find((story) => story.id === 'member-count').reason,
    'Code **** and **** both went to a blank page.');
  assert.doesNotMatch(JSON.stringify(stories), /048[ -]?213/);

  // Only that code, standing on its own.
  const { maskPhoneTestCode } = controlPlane;
  assert.equal(maskPhoneTestCode('ids 10482130 and 0482131 stay', '048213'), 'ids 10482130 and 0482131 stay');
  assert.equal(maskPhoneTestCode('code 048213.', '048213'), 'code ****.');
  assert.equal(maskPhoneTestCode('code 048213', null), 'code 048213', 'no code for the run, nothing to mask');
  assert.equal(maskPhoneTestCode('code 048213', 'abc'), 'code 048213');
});

test('a problem noticed on the after build is kept with the run, capped, and changes no result', () => {
  const run = control({ intent: threeChanges() });
  shootBothSides(run, 'invite-suggestions');
  const before = run.summary();
  const first = run.noteProblem({
    change: 'invite-suggestions', screen: 'desktop', problem: '  The table is cut off at the right edge. ',
    alsoBefore: false, shot: 'screen',
  });
  assert.deepEqual(first, { noticed: 'invite-suggestions', screen: 'desktop', alsoBefore: false, notices: 1, remaining: 4 });
  // The same problem at the same place again updates it rather than adding one.
  const again = run.noteProblem({
    change: 'invite-suggestions', screen: 'desktop', problem: 'the table is cut off at the right edge.', alsoBefore: true,
  });
  assert.equal(again.notices, 1);
  assert.deepEqual(run.notices, [{
    text: 'the table is cut off at the right edge.', change: 'invite-suggestions', screen: 'desktop',
    shot: null, alsoBefore: true,
  }]);
  // A change that is not ready can still be where a problem shows.
  run.noteProblem({ change: 'member-count', screen: 'desktop', problem: 'An error banner is on screen.' });

  const summary = run.summary();
  assert.deepEqual(summary.stories, before.stories, 'notices never change a change\'s status or note');
  assert.equal(summary.verdict.passed, before.verdict.passed);
  assert.deepEqual(summary.verdict.notices.map((entry) => [entry.change, entry.alsoBefore]),
    [['invite-suggestions', true], ['member-count', 'unknown']]);
  assert.doesNotMatch(JSON.stringify(run.progress()), /cut off|error banner/,
    'the brief\'s progress reports the changes, not the notices');

  // Five at most: the sixth is refused, and the agent is told why.
  for (const text of ['One.', 'Two.', 'Three.']) {
    run.noteProblem({ change: 'invite-suggestions', screen: 'desktop', problem: text });
  }
  assert.equal(run.notices.length, 5);
  assert.throws(() => run.noteProblem({ change: 'invite-suggestions', screen: 'desktop', problem: 'Six.' }),
    { code: 'too_many_notices', status: 409 });
  assert.equal(run.lastToolFailure.operation, 'note-problem');
  // Updating one already noted still works at the cap.
  assert.equal(run.noteProblem({ change: 'invite-suggestions', screen: 'desktop', problem: 'One.', alsoBefore: true }).notices, 5);

  assert.throws(() => run.noteProblem({ change: 'invite-suggestions', screen: 'tablet', problem: 'x' }),
    { code: 'unknown_screen', status: 400 });
  assert.throws(() => run.noteProblem({ change: 'nobody', screen: 'desktop', problem: 'x' }), { code: 'unknown_change' });
  assert.throws(() => run.noteProblem({ change: 'invite-suggestions', screen: 'desktop', problem: '' }),
    { code: 'problem_required' });

  run.skipChange({ reason: 'Nothing else loads.' });
  assert.throws(() => run.noteProblem({ change: 'invite-suggestions', screen: 'desktop', problem: 'Too late.' }),
    { code: 'shots_turn_finished', status: 409 });
});

// Every problem noted in the proposals merged 2026-10-09 to 10-12 said
// "unknown", though the agent shoots the before side of every screen.
test('a problem noted without saying whether the before build has it asks the agent to look', () => {
  const run = control({ intent: threeChanges() });
  run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'after' }, sideShot('after'));
  const early = run.noteProblem({ change: 'invite-suggestions', screen: 'desktop', problem: 'The table is cut off.' });
  assert.equal(early.alsoBefore, 'unknown');
  assert.match(early.hint, /^Once you have shot the before side of this screen, look at it and note this problem again with alsoBefore true or false/);

  run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'before' }, sideShot('before'));
  const later = run.noteProblem({ change: 'invite-suggestions', screen: 'desktop', problem: 'The table is cut off.', alsoBefore: 'unknown' });
  assert.match(later.hint, /^You saved the before shot of this screen: look at it and note this problem again/);
  assert.match(later.hint, /Noting the same problem at the same place updates it\.$/);

  const said = run.noteProblem({ change: 'invite-suggestions', screen: 'desktop', problem: 'The table is cut off.', alsoBefore: false });
  assert.equal(Object.hasOwn(said, 'hint'), false, 'a notice that says true or false is not asked again');
  assert.deepEqual(run.notices.map((entry) => entry.alsoBefore), [false], 'noting it again updated the one notice');
});

// control_request and upload_file record what they are about to do to both
// builds before they do it; it goes on the change's result, whatever its
// status, so the card can say so beside the shots.
test('what the agent did to both builds is kept with its change, once each, and only in a fixed shape', () => {
  const run = control({ intent: threeChanges() });
  shootBothSides(run, 'invite-suggestions');
  const before = run.summary();
  assert.deepEqual(run.noteCondition({ change: 'invite-suggestions', kind: 'request_held', request: '/api/items?page=1' }),
    { recorded: 'invite-suggestions', conditions: 1 });
  // The same again is recorded once.
  assert.equal(run.noteCondition({ change: 'invite-suggestions', kind: 'request_held', request: '/api/items?page=1' }).conditions, 1);
  run.noteCondition({ change: 'invite-suggestions', kind: 'sample_file', files: ['landscape.png', 'table.csv'] });
  run.noteCondition({ change: 'member-count', kind: 'request_failed', request: '/api/members' });

  const summary = run.summary();
  const ready = summary.stories.find((story) => story.id === 'invite-suggestions');
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.conditions, [
    { kind: 'request_held', request: '/api/items?page=1' },
    { kind: 'sample_file', files: ['landscape.png', 'table.csv'] },
  ]);
  // A change that is not ready keeps its conditions too; one with none has no key.
  assert.deepEqual(summary.stories.find((story) => story.id === 'member-count').conditions,
    [{ kind: 'request_failed', request: '/api/members' }]);
  assert.equal('conditions' in summary.stories.find((story) => story.id === 'saved-toast'), false);
  assert.equal(summary.manifestHash, before.manifestHash, 'the published files are the same files');
  assert.deepEqual(summary.verdict.stories, summary.stories);

  for (const [raw, code] of [
    [{ change: 'nobody', kind: 'request_held', request: '/api/items' }, 'unknown_change'],
    [{ change: 'invite-suggestions', kind: 'evaluate', request: '/api/items' }, 'invalid_condition'],
    [{ change: 'invite-suggestions', kind: 'request_held', request: '/lists' }, 'invalid_condition'],
    [{ change: 'invite-suggestions', kind: 'request_held', request: '/api/items/*' }, 'invalid_condition'],
    [{ change: 'invite-suggestions', kind: 'request_held', request: 'https://evil.example/api/items' }, 'invalid_condition'],
    [{ change: 'invite-suggestions', kind: 'request_failed', request: '/api/items?token=abc' }, 'invalid_condition'],
    [{ change: 'invite-suggestions', kind: 'sample_file', files: [] }, 'invalid_condition'],
    [{ change: 'invite-suggestions', kind: 'sample_file', files: ['/etc/passwd'] }, 'invalid_condition'],
    [{ change: 'invite-suggestions', kind: 'sample_file', files: ['table.csv', 'table.csv'] }, 'invalid_condition'],
  ]) {
    assert.throws(() => run.noteCondition(raw), { code, status: 400 }, JSON.stringify(raw));
  }
  assert.equal(run.lastToolFailure.operation, 'note-condition');
  // Four a change at most.
  run.noteCondition({ change: 'invite-suggestions', kind: 'request_failed', request: '/api/items?page=1' });
  run.noteCondition({ change: 'invite-suggestions', kind: 'sample_file', files: ['portrait.png'] });
  assert.throws(() => run.noteCondition({ change: 'invite-suggestions', kind: 'request_held', request: '/api/other' }),
    { code: 'too_many_conditions', status: 409 });
  // What it already holds is still recorded once, at the cap.
  assert.equal(run.noteCondition({ change: 'invite-suggestions', kind: 'sample_file', files: ['portrait.png'] }).conditions, 4);

  run.skipChange({ reason: 'Nothing else loads.' });
  assert.throws(() => run.noteCondition({ change: 'member-count', kind: 'request_held', request: '/api/members' }),
    { code: 'shots_turn_finished', status: 409 });
});

test('the last refused tool call is kept for the owner\'s diagnostics', () => {
  const run = control();
  assert.equal(run.lastToolFailure, null);
  assert.throws(() => run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'after' },
    Buffer.from('not an image')));
  assert.equal(run.lastToolFailure.operation, 'save-shot');
  assert.equal(run.lastToolFailure.error.code, 'invalid_shot_image');

  assert.throws(() => run.skipChange({ change: 'invite-suggestions', reason: '' }));
  assert.equal(run.lastToolFailure.operation, 'skip-change');
  assert.equal(run.lastToolFailure.error.code, 'reason_required');

  // A later success does not erase the refusal the owner may need to read.
  shootBothSides(run, 'invite-suggestions');
  assert.equal(run.lastToolFailure.operation, 'skip-change');
});

test('an expired run refuses its brief, shots and skips with 410', () => {
  const run = control({ expiresAt: Date.now() - 1 });
  const expired = { code: 'shots_control_expired', status: 410 };
  assert.throws(() => run.getContext(), expired);
  assert.throws(() => run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'after' },
    fixtures.png()), expired);
  assert.throws(() => run.skipChange({ change: 'invite-suggestions', reason: 'Too late.' }), expired);
  assert.equal(run.saved.size, 0);
  assert.equal(run.skipped.size, 0);
  assert.equal(run.lastToolFailure.error.code, 'shots_control_expired');
});

test('the brief is a copy of the context with progress attached', () => {
  const context = { runId: 'a'.repeat(32), addresses: { before: 'http://base.test', after: 'http://head.test' } };
  const run = control({ context });
  context.addresses.before = 'http://elsewhere.test';
  const brief = run.getContext();
  assert.deepEqual(brief, {
    runId: 'a'.repeat(32),
    addresses: { before: 'http://base.test', after: 'http://head.test' },
    progress: run.progress(),
  });
  brief.addresses.after = 'http://elsewhere.test';
  assert.equal(run.getContext().addresses.after, 'http://head.test');
});

test('a control only accepts an intent the author could have declared', () => {
  assert.throws(() => control({ intent: fixtures.intent({ impact: 'none' }) }), { code: 'invalid_visible_changes' });
  assert.throws(() => control({ intent: { version: 1, impact: 'ui', rationale: 'x', stories: [] } }),
    { code: 'invalid_visible_changes' });
  // The stored intent is the parsed one, with its defaults.
  assert.equal(control({ intent: fixtures.intent() }).intent.stories[0].intent.baseState, 'present');
});

test('a run\'s workspace is made only for a run id, and a lapsed one answers nothing', async () => {
  // The workspace lives in Postgres (shot_run_control): which process
  // serves a call does not matter, and the routes reach it only through
  // withControl, which checks the run's session and that it is current
  // (tests/shots-run-steps-postgres.test.js).
  const pool = { query: async () => { throw new Error('nothing is written for an invalid run'); } };
  await assert.rejects(controlPlane.create(pool, { runId: 'not-a-run', sessionId: 42, intent: fixtures.intent(), context: {}, expiresAt: Date.now() }),
    { code: 'invalid_shots_run', status: 400 });
  await assert.rejects(controlPlane.create(pool, { runId: 'B'.repeat(32), sessionId: 42, intent: fixtures.intent(), context: {}, expiresAt: Date.now() }),
    { code: 'invalid_shots_run' });
  await assert.rejects(controlPlane.withControl(pool, { runId: 'nope', sessionId: 42 }, () => {}),
    { code: 'shots_control_not_found', status: 410 });
  const lapsed = new controlPlane.RunControl({
    runId: 'e'.repeat(32), sessionId: 42, intent: fixtures.intent(), context: {}, expiresAt: Date.now() - 1,
  });
  assert.throws(() => lapsed.getContext(), { code: 'shots_control_expired', status: 410 });
  assert.equal(controlPlane.dbSlot({ storyId: 'c1', viewport: 'desktop', side: 'base', variant: 'context' }), 'c1/desktop/base/context',
    'a slot Postgres can hold (the in-memory key separates with NUL)');
  assert.equal(controlPlane.dbSlot({ storyId: 'c1', viewport: 'desktop', side: 'base', variant: 'context', theme: 'dark' }),
    'c1/desktop/base/context/dark', 'a dark slot is a light slot with /dark at its end (#4459)');
});

test('saving the same image on both sides warns the agent while it can still retake them', () => {
  const run = control();
  const before = run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'before' }, fixtures.png());
  assert.equal(Object.hasOwn(before, 'sameAsOtherSide'), false, 'nothing to compare with yet');
  const after = run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'after' }, fixtures.png());
  assert.equal(after.sameAsOtherSide, true);
  assert.match(after.warning, /same image/);
  assert.deepEqual(after.progress.find((entry) => entry.change === 'invite-suggestions'),
    { change: 'invite-suggestions', status: 'ready', note: 'any visible difference. The before and after screens came out the same, so these shots cannot show this change.' });

  const retake = run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'after' }, sideShot('after'));
  assert.equal(Object.hasOwn(retake, 'warning'), false);
  assert.deepEqual(retake.progress.find((entry) => entry.change === 'invite-suggestions'),
    { change: 'invite-suggestions', status: 'ready' });
});

test('an element shot wider than its screen is refused and saves nothing', () => {
  const run = control();
  run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'before' }, fixtures.png({ width: 1280, height: 800 }));
  assert.throws(() => run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'before', kind: 'element' },
    fixtures.png({ width: 1300, height: 40 })), { code: 'element_shot_too_wide', status: 400 });
  assert.equal(run.saved.size, 1);
  assert.equal(run.lastToolFailure.operation, 'save-shot');
});

// A dark shot only earns its place when the screen looks different in dark
// mode (#4459): one identical to its light copy is not kept, and the answer
// tells the agent it can leave out the rest of this app's dark shots.
test('a dark shot that matches its light copy answers sameAsLight and stores nothing', () => {
  const run = control();
  const light = run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'after' },
    fixtures.png({ shade: 5 }));
  assert.equal(light.saved, true);

  const same = run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'after', theme: 'dark' },
    fixtures.png({ shade: 5 }));
  assert.equal(same.saved, false, 'nothing was stored for the dark shot');
  assert.equal(same.sameAsLight, true);
  assert.equal(same.kind, 'screen');
  assert.match(same.hint, /leave out the rest of the dark shots/);
  assert.equal(run.saved.size, 1, 'the dark copy is not in the run\'s saved files');
  assert.equal(run.lastToolFailure, null, 'not an error, so no refusal is recorded');

  // The comparison is against this slot's own light shot, not another
  // change's, and a dark shot that differs is kept as its own slot.
  const different = run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'after', theme: 'dark' },
    fixtures.png({ shade: 9 }));
  assert.equal(different.saved, true);
  assert.equal(run.saved.size, 2);
  const [lightFile, darkFile] = [...run.saved.values()];
  assert.equal(lightFile.theme, 'light');
  assert.equal(darkFile.theme, 'dark');
  assert.ok(darkFile.sha256 !== lightFile.sha256);

  // A dark shot with no light counterpart yet is kept whatever it shows:
  // the light one may come later, or never (the agent shoots light first,
  // but no rule here depends on that order).
  const beforeDark = run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'before', theme: 'dark' },
    fixtures.png());
  assert.equal(beforeDark.saved, true);
});
