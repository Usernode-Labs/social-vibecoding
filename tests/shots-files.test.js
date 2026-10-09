'use strict';

// Before/after shots: the pure checks behind every file the shots agent
// saves (src/services/shots-files.js), and the fold of everything
// saved into one result per declared change. Nothing here touches a
// database, a browser or the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const contract = require('../src/services/visible-changes');
const shots = require('../src/services/shots-files');
const fixtures = require('./fixtures/shots');

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

// The stored intent is always the parsed one (defaults filled in), exactly as
// RunControl holds it.
const stillIntent = () => contract.parseIntent(fixtures.intent());
const motionIntent = () => contract.parseIntent(fixtures.motionIntent());

// A still change declared on two screens, so "every screen" means something.
function twoScreenIntent() {
  const raw = fixtures.intent();
  raw.stories[0].viewports.push({ name: 'mobile', width: 390, height: 844 });
  return contract.parseIntent(raw);
}

// A before and an after that differ, as the shots of a real change do: the
// same image on both sides is its own case (see the tests at the end).
const sideShot = (side) => fixtures.png({ shade: side === 'after' ? 200 : 0 });

// Save one file into a slot map the way RunControl does.
function save(saved, intent, raw, buffer) {
  const target = shots.shotTarget(intent, raw);
  const info = target.media === 'webm' ? shots.inspectClip(buffer) : shots.inspectImage(buffer);
  saved.set(shots.slotKey(target), shots.stored(target, buffer, info));
  return target;
}

function refusal(code, status = 400) {
  return (error) => {
    assert.ok(error instanceof shots.ShotError, `expected a ShotError, got ${error?.name}`);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  };
}

test('one complete PNG is accepted with its dimensions, size and digest', () => {
  const image = fixtures.png({ width: 7, height: 5 });
  assert.deepEqual(shots.inspectImage(image), {
    width: 7, height: 5, bytes: image.length, sha256: sha256(image),
  });
  // The edge limit is inclusive; a real 8192-wide PNG still passes.
  const wide = fixtures.png({ width: 8192, height: 1 });
  assert.equal(shots.inspectImage(wide).width, 8192);
});

test('anything but one whole PNG within bounds is refused with a code', () => {
  const image = fixtures.png();
  assert.throws(() => shots.inspectImage(image.subarray(0, image.length - 1)), refusal('invalid_shot_image'),
    'a truncated PNG has no terminator');
  assert.throws(() => shots.inspectImage(image.subarray(0, 40)), refusal('invalid_shot_image'));
  assert.throws(() => shots.inspectImage(Buffer.from('x'.repeat(64))), refusal('invalid_shot_image'));
  assert.throws(() => shots.inspectImage(fixtures.webm()), refusal('invalid_shot_image'));
  assert.throws(() => shots.inspectImage(image.toString('latin1')), refusal('invalid_shot_image'),
    'only a Buffer is read');
  assert.throws(() => shots.inspectImage(Buffer.alloc(0)), refusal('invalid_shot_image'));
  assert.throws(() => shots.inspectImage(fixtures.png({ width: 8193, height: 1 })), (error) => {
    refusal('invalid_shot_image')(error);
    assert.match(error.message, /unsupported dimensions/);
    return true;
  });
  const zeroWide = Buffer.from(image);
  zeroWide.writeUInt32BE(0, 16);
  assert.throws(() => shots.inspectImage(zeroWide), refusal('invalid_shot_image'));
  // Size is checked before anything is parsed, and it is its own code so the
  // agent knows to shoot the visible screen rather than the full page.
  assert.throws(() => shots.inspectImage(Buffer.alloc(shots.MAX_IMAGE_BYTES + 1)),
    refusal('shot_too_large', 413));
  assert.equal(shots.MAX_IMAGE_BYTES, 6 * 1024 * 1024);
});

test('a clip must be a browser WebM between 1 KB and 20 MB', () => {
  const clip = fixtures.webm();
  assert.deepEqual(shots.inspectClip(clip), {
    width: null, height: null, bytes: clip.length, sha256: sha256(clip),
  });
  assert.equal(shots.inspectClip(fixtures.webm(1024)).bytes, 1024);
  assert.throws(() => shots.inspectClip(fixtures.webm(1023)), refusal('invalid_clip'));
  assert.throws(() => shots.inspectClip(Buffer.alloc(4096, 7)), refusal('invalid_clip'),
    'no EBML header means it is not the recording');
  assert.throws(() => shots.inspectClip(fixtures.png({ width: 64, height: 64 })), refusal('invalid_clip'));
  assert.throws(() => shots.inspectClip('not a buffer'), refusal('invalid_clip'));
  assert.equal(shots.inspectClip(fixtures.webm(shots.MAX_CLIP_BYTES)).bytes, shots.MAX_CLIP_BYTES);
  assert.throws(() => shots.inspectClip(fixtures.webm(shots.MAX_CLIP_BYTES + 1)),
    refusal('clip_too_large', 413));
  assert.equal(shots.MAX_CLIP_BYTES, 20 * 1024 * 1024);
});

test('a shot is addressed to a declared change, one of its screens, a side and a kind', () => {
  const intent = motionIntent();
  const target = (raw) => shots.shotTarget(intent, raw);
  // People and the agent say before/after; the stored sides stay base/head.
  // A look left out is light.
  assert.deepEqual(target({ change: 'invite-suggestions', screen: 'desktop', side: 'before' }), {
    storyId: 'invite-suggestions', viewport: 'desktop', theme: 'light', side: 'base', variant: 'context', media: 'png',
  });
  assert.deepEqual(target({ change: 'invite-suggestions', screen: 'desktop', side: 'after', kind: 'screen' }), {
    storyId: 'invite-suggestions', viewport: 'desktop', theme: 'light', side: 'head', variant: 'context', media: 'png',
  });
  assert.deepEqual(target({ change: 'invite-suggestions', screen: 'desktop', side: 'after', kind: 'element' }), {
    storyId: 'invite-suggestions', viewport: 'desktop', theme: 'light', side: 'head', variant: 'focus', media: 'png',
  });
  assert.deepEqual(target({ change: 'saved-toast', screen: 'desktop', side: 'before', kind: 'clip' }), {
    storyId: 'saved-toast', viewport: 'desktop', theme: 'light', side: 'base', variant: 'animation', media: 'webm',
  });
  assert.deepEqual(target({ change: 'invite-suggestions', screen: 'desktop', side: 'after', look: 'dark' }), {
    storyId: 'invite-suggestions', viewport: 'desktop', theme: 'dark', side: 'head', variant: 'context', media: 'png',
  });
  assert.throws(() => target({ change: 'invite-suggestions', screen: 'desktop', side: 'after', look: 'sepia' }),
    refusal('invalid_look'));

  assert.throws(() => target({ change: 'someone-elses-change', screen: 'desktop', side: 'after' }),
    refusal('unknown_change'));
  assert.throws(() => target({ screen: 'desktop', side: 'after' }), refusal('unknown_change'));
  assert.throws(() => target({ change: 'invite-suggestions', screen: 'phone', side: 'after' }), (error) => {
    refusal('unknown_screen')(error);
    assert.match(error.message, /use desktop/, 'the refusal names the declared screens');
    return true;
  });
  assert.throws(() => target({ change: 'invite-suggestions', side: 'after' }), refusal('unknown_screen'));
  assert.throws(() => target({ change: 'invite-suggestions', screen: 'desktop', side: 'middle' }),
    refusal('invalid_side'));
  assert.throws(() => target({ change: 'invite-suggestions', screen: 'desktop' }), refusal('invalid_side'));
  assert.throws(() => target({ change: 'invite-suggestions', screen: 'desktop', side: 'after', kind: 'video' }),
    refusal('invalid_kind'));
  // A clip only for a change declared as motion.
  assert.throws(() => target({ change: 'invite-suggestions', screen: 'desktop', side: 'after', kind: 'clip' }),
    refusal('clip_not_needed'));
});

test('a slot is one change, screen, look, side and kind', () => {
  const intent = motionIntent();
  const keys = new Set([
    { change: 'invite-suggestions', screen: 'desktop', side: 'before' },
    { change: 'invite-suggestions', screen: 'desktop', side: 'after' },
    { change: 'invite-suggestions', screen: 'desktop', side: 'after', kind: 'element' },
    { change: 'saved-toast', screen: 'desktop', side: 'after' },
    { change: 'saved-toast', screen: 'desktop', side: 'after', kind: 'clip' },
    { change: 'invite-suggestions', screen: 'desktop', side: 'after', look: 'dark' },
  ].map((raw) => shots.slotKey(shots.shotTarget(intent, raw))));
  assert.equal(keys.size, 6, 'a dark slot does not overwrite the light one');
  assert.equal(
    shots.slotKey(shots.shotTarget(intent, { change: 'saved-toast', screen: 'desktop', side: 'before' })),
    shots.slotKey(shots.shotTarget(intent, { change: 'saved-toast', screen: 'desktop', side: 'base', kind: 'screen' })),
  );
  // A look left out counts as light.
  assert.equal(shots.slotKey({ storyId: 'x', viewport: 'desktop', side: 'base', variant: 'context' }),
    shots.slotKey({ storyId: 'x', viewport: 'desktop', theme: 'light', side: 'base', variant: 'context' }));
  assert.notEqual(shots.slotKey({ storyId: 'x', viewport: 'desktop', theme: 'dark', side: 'base', variant: 'context' }),
    shots.slotKey({ storyId: 'x', viewport: 'desktop', theme: 'light', side: 'base', variant: 'context' }));
});

test('a skip reason is trimmed, bounded and required', () => {
  assert.equal(shots.reason('  The list needs an owner.  '), 'The list needs an owner.');
  assert.equal(shots.reason('x'.repeat(1500)).length, 1000);
  for (const empty of ['', '   ', null, undefined, 42, { reason: 'x' }]) {
    assert.throws(() => shots.reason(empty), refusal('reason_required'));
  }
});

test('a stored file carries its slot, type, bytes and digest', () => {
  const intent = motionIntent();
  const image = fixtures.png({ width: 5, height: 2 });
  const shot = shots.stored(
    shots.shotTarget(intent, { change: 'invite-suggestions', screen: 'desktop', side: 'after' }),
    image, shots.inspectImage(image));
  assert.deepEqual({ ...shot, data: shot.data === image }, {
    storyId: 'invite-suggestions', viewport: 'desktop', theme: 'light', side: 'head', variant: 'context', media: 'png',
    contentType: 'image/png', data: true, width: 5, height: 2, bytes: image.length, sha256: sha256(image),
    focusRect: null, stageLabels: null,
  });
  const clip = fixtures.webm();
  const recording = shots.stored(
    shots.shotTarget(intent, { change: 'saved-toast', screen: 'desktop', side: 'before', kind: 'clip' }),
    clip, shots.inspectClip(clip));
  assert.equal(recording.contentType, 'video/webm');
  assert.equal(recording.width, null);
  assert.equal(recording.sha256, sha256(clip));
});

test('a change is ready only with a before and an after screen shot on every screen', () => {
  const intent = twoScreenIntent();
  const saved = new Map();
  const shot = (screen, side, kind) => save(saved, intent,
    { change: 'invite-suggestions', screen, side, kind }, fixtures.png({ shade: saved.size }));

  let summary = shots.summarize(intent, saved);
  assert.deepEqual(summary.stories, [{
    id: 'invite-suggestions',
    status: 'skipped',
    reason: 'The shots agent did not save the before shot on desktop, the after shot on desktop, '
      + 'the before shot on mobile, the after shot on mobile.',
  }]);
  assert.equal(summary.readyCount, 0);
  assert.deepEqual(summary.files, []);
  assert.deepEqual(summary.verdict, { passed: false, mode: 'shots', runs: 1, stories: summary.stories });

  shot('desktop', 'before');
  shot('desktop', 'after');
  shot('mobile', 'after');
  // An element shot is an optional extra; it never stands in for a screen.
  shot('mobile', 'before', 'element');
  summary = shots.summarize(intent, saved);
  assert.equal(summary.stories[0].status, 'skipped');
  assert.equal(summary.stories[0].reason, 'The shots agent did not save the before shot on mobile.');
  assert.deepEqual(summary.files, []);

  shot('mobile', 'before');
  summary = shots.summarize(intent, saved);
  assert.deepEqual(summary.stories, [{ id: 'invite-suggestions', status: 'ready', files: 5 }]);
  assert.equal(summary.readyCount, 1);
  assert.equal(summary.files.length, 5);
  assert.deepEqual(summary.verdict, { passed: true, mode: 'shots', runs: 1, stories: summary.stories });
});

test('a motion change also needs a before and an after clip', () => {
  const intent = motionIntent();
  const saved = new Map();
  for (const side of ['before', 'after']) {
    save(saved, intent, { change: 'saved-toast', screen: 'desktop', side }, sideShot(side));
  }
  let toast = shots.summarize(intent, saved).stories.find((story) => story.id === 'saved-toast');
  assert.deepEqual(toast, {
    id: 'saved-toast',
    status: 'skipped',
    reason: 'The shots agent did not save the before clip on desktop, the after clip on desktop.',
  });
  save(saved, intent, { change: 'saved-toast', screen: 'desktop', side: 'before', kind: 'clip' }, fixtures.webm());
  save(saved, intent, { change: 'saved-toast', screen: 'desktop', side: 'after', kind: 'clip' }, fixtures.webm(4096));
  toast = shots.summarize(intent, saved).stories.find((story) => story.id === 'saved-toast');
  assert.deepEqual(toast, { id: 'saved-toast', status: 'ready', files: 4 });
});

test('the agent\'s own skip reason is shown instead of the list of what is missing', () => {
  const intent = motionIntent();
  const saved = new Map();
  save(saved, intent, { change: 'saved-toast', screen: 'desktop', side: 'after' }, fixtures.png());
  const reasons = new Map([
    ['saved-toast', 'Members cannot save a list on these builds.'],
    ['invite-suggestions', 'The invite dialog needs a second member.'],
  ]);
  for (const side of ['before', 'after']) {
    save(saved, intent, { change: 'invite-suggestions', screen: 'desktop', side }, sideShot(side));
  }
  const summary = shots.summarize(intent, saved, reasons);
  assert.deepEqual(summary.stories, [
    // Skipping a change by name withdraws what was saved for it: this is how
    // the agent keeps shots it found do not show the change off the proposal.
    { id: 'invite-suggestions', status: 'skipped', reason: 'The invite dialog needs a second member.' },
    { id: 'saved-toast', status: 'skipped', reason: 'Members cannot save a list on these builds.' },
  ]);
  assert.equal(summary.verdict.passed, false);
  assert.deepEqual(summary.files, [], 'nothing of a skipped change is published');

  // One unreachable change never hides the ones that were shot.
  const oneSkipped = shots.summarize(intent, saved, new Map([['saved-toast', 'No list.']]));
  assert.deepEqual(oneSkipped.stories.map(({ id, status }) => [id, status]),
    [['invite-suggestions', 'ready'], ['saved-toast', 'skipped']]);
  assert.equal(oneSkipped.verdict.passed, true);
  assert.equal(oneSkipped.readyCount, 1);
});

test('a skip of everything explains only the changes that are not ready', () => {
  const intent = motionIntent();
  const saved = new Map();
  for (const side of ['before', 'after']) {
    save(saved, intent, { change: 'invite-suggestions', screen: 'desktop', side }, sideShot(side));
  }
  const summary = shots.summarize(intent, saved, new Map(), { fallbackReason: 'Every other screen is a sign-in page.' });
  assert.deepEqual(summary.stories, [
    { id: 'invite-suggestions', status: 'ready', files: 2 },
    { id: 'saved-toast', status: 'skipped', reason: 'Every other screen is a sign-in page.' },
  ]);
});

test('a ready change carries the agent\'s note on what its shots leave out', () => {
  const intent = motionIntent();
  const saved = new Map();
  for (const side of ['before', 'after']) {
    save(saved, intent, { change: 'invite-suggestions', screen: 'desktop', side }, sideShot(side));
  }
  const notes = new Map([
    ['invite-suggestions', 'The "Show more" fold needs a member with a hidden app.'],
    ['saved-toast', 'Not shot, so this is never shown.'],
  ]);
  const summary = shots.summarize(intent, saved, new Map(), { notes });
  assert.deepEqual(summary.stories[0],
    { id: 'invite-suggestions', status: 'ready', files: 2, note: 'The "Show more" fold needs a member with a hidden app.' });
  assert.equal(summary.stories[1].status, 'skipped');
  assert.equal(Object.hasOwn(summary.stories[1], 'note'), false, 'a change that is not ready has no note');
  assert.equal(shots.note('  Leaves out the fold.  '), 'Leaves out the fold.');
  assert.equal(shots.note('x'.repeat(900)).length, 500);
  for (const empty of ['', '   ', null, 42]) {
    assert.throws(() => shots.note(empty), { code: 'note_required', status: 400 });
  }
});

test('only the files of ready changes are published, and the manifest hash names them', () => {
  const intent = motionIntent();
  const entries = [
    [{ change: 'invite-suggestions', screen: 'desktop', side: 'before' }, fixtures.png({ shade: 1 })],
    [{ change: 'invite-suggestions', screen: 'desktop', side: 'after' }, fixtures.png({ shade: 2 })],
    [{ change: 'invite-suggestions', screen: 'desktop', side: 'after', kind: 'element' }, fixtures.png({ shade: 3 })],
  ];
  const build = (list) => {
    const saved = new Map();
    for (const [raw, buffer] of list) save(saved, intent, raw, buffer);
    return saved;
  };
  const forward = shots.summarize(intent, build(entries));
  assert.deepEqual(forward.files.map((file) => [file.storyId, file.side, file.variant]), [
    ['invite-suggestions', 'base', 'context'],
    ['invite-suggestions', 'head', 'context'],
    ['invite-suggestions', 'head', 'focus'],
  ]);
  assert.match(forward.manifestHash, /^[0-9a-f]{64}$/);
  assert.equal(shots.summarize(intent, build([...entries].reverse())).manifestHash, forward.manifestHash,
    'the order files were saved in does not change the hash');

  // A skipped change's partial files are not published and do not move the hash.
  const partial = build([...entries,
    [{ change: 'saved-toast', screen: 'desktop', side: 'before' }, fixtures.png({ shade: 4 })],
    [{ change: 'saved-toast', screen: 'desktop', side: 'after' }, fixtures.png({ shade: 5 })],
    [{ change: 'saved-toast', screen: 'desktop', side: 'after', kind: 'clip' }, fixtures.webm()],
  ]);
  const withPartial = shots.summarize(intent, partial);
  assert.equal(withPartial.files.length, 3);
  assert.ok(withPartial.files.every((file) => file.storyId === 'invite-suggestions'));
  assert.equal(withPartial.manifestHash, forward.manifestHash);

  // A retaken shot with different bytes is a different manifest.
  const retaken = build([entries[0], [entries[1][0], fixtures.png({ shade: 9 })], entries[2]]);
  assert.notEqual(shots.summarize(intent, retaken).manifestHash, forward.manifestHash);
  // So is a published file more or fewer.
  assert.notEqual(shots.summarize(intent, build(entries.slice(0, 2))).manifestHash, forward.manifestHash);
  // And the same files published against a different declaration.
  const reworded = contract.parseIntent(fixtures.motionIntent({ rationale: 'A different rationale.' }));
  const rewordedSaved = new Map();
  for (const [raw, buffer] of entries) save(rewordedSaved, reworded, raw, buffer);
  assert.notEqual(shots.summarize(reworded, rewordedSaved).manifestHash, forward.manifestHash);
});

test('a shots verdict is recognised by its mode alone', () => {
  const verdict = shots.summarize(stillIntent(), new Map()).verdict;
  assert.equal(shots.SHOTS_MODE, 'shots');
  assert.equal(shots.isShotsVerdict(verdict), true);
  assert.equal(shots.isShotsVerdict({ ...verdict, passed: true }), true);
  for (const other of [null, undefined, 'shots', { passed: true }, { mode: 'replay', passed: true }]) {
    assert.equal(shots.isShotsVerdict(other), false);
  }
});

test('a ready change whose before and after are the same image says so in its note', () => {
  const intent = twoScreenIntent();
  const saved = new Map();
  for (const screen of ['desktop', 'mobile']) {
    for (const side of ['before', 'after']) {
      save(saved, intent, { change: 'invite-suggestions', screen, side }, fixtures.png());
    }
  }
  let story = shots.summarize(intent, saved).stories[0];
  assert.deepEqual(story, {
    id: 'invite-suggestions', status: 'ready', files: 4, unchanged: true, note: shots.UNCHANGED_NOTE,
  }, 'still published, people judge the shots, but the card says they show no difference');

  // The agent's own note is kept, with the sentence after it.
  const notes = new Map([['invite-suggestions', 'The fold needs a hidden app.']]);
  story = shots.summarize(intent, saved, new Map(), { notes }).stories[0];
  assert.equal(story.note, 'The fold needs a hidden app. The before and after screens came out the same.');

  // One screen size that differs is enough: the change shows there.
  save(saved, intent, { change: 'invite-suggestions', screen: 'mobile', side: 'after' }, fixtures.png({ shade: 9 }));
  story = shots.summarize(intent, saved).stories[0];
  assert.deepEqual(story, { id: 'invite-suggestions', status: 'ready', files: 4 });
});

test('markUnchanged only marks ready changes, once', () => {
  const stories = [
    { id: 'a', status: 'ready', files: 2 },
    { id: 'b', status: 'skipped', reason: 'No data.' },
  ];
  const marked = shots.markUnchanged(stories, new Set(['a', 'b']));
  assert.deepEqual(marked, [
    { id: 'a', status: 'ready', files: 2, unchanged: true, note: shots.UNCHANGED_NOTE },
    { id: 'b', status: 'skipped', reason: 'No data.' },
  ]);
  assert.deepEqual(shots.markUnchanged(marked, new Set(['a'])), marked, 'a second pass adds nothing');
  assert.deepEqual(shots.markUnchanged(stories, new Set()), stories);
});

test('an element shot must fit the screen it was taken on', () => {
  const intent = twoScreenIntent();
  const story = intent.stories[0];
  const target = (screen, kind = 'element') => shots.shotTarget(intent,
    { change: 'invite-suggestions', screen, side: 'before', kind });
  const size = (width, height) => ({ width, height });

  assert.doesNotThrow(() => shots.checkElementSize(story, target('mobile'), size(390, 1688)));
  // Wider than the phone: a page laid out at desktop size, then resized.
  assert.throws(() => shots.checkElementSize(story, target('mobile'), size(1206, 640)),
    refusal('element_shot_too_wide'));
  // More than two screens tall: a tiled capture of a whole grid.
  assert.throws(() => shots.checkElementSize(story, target('desktop'), size(1206, 3679)),
    refusal('element_shot_too_tall'));
  // A screen shot taken at 2x says the element may be twice as large too.
  const doubled = { width: 780, height: 1688 };
  assert.doesNotThrow(() => shots.checkElementSize(story, target('mobile'), size(760, 2000), doubled));
  // A screen shot at some other width is the wrong size, not a scale.
  assert.throws(() => shots.checkElementSize(story, target('mobile'), size(1206, 640), { width: 1280, height: 800 }),
    refusal('element_shot_too_wide'));
  // Screen shots and clips are not element shots.
  assert.doesNotThrow(() => shots.checkElementSize(story, target('mobile', 'screen'), size(390, 5000)));
});

test('a ready change takes its dark shots along only where they differ from light', () => {
  const intent = motionIntent();
  const lightBase = fixtures.png({ shade: 1 });
  const lightHead = fixtures.png({ shade: 2 });
  const darkBase = fixtures.png({ width: 5, height: 5, shade: 3 });
  const darkHead = fixtures.png({ width: 5, height: 5, shade: 4 });
  const build = (list) => {
    const saved = new Map();
    for (const [raw, buffer] of list) save(saved, intent, raw, buffer);
    return saved;
  };
  const lightEntries = [
    [{ change: 'invite-suggestions', screen: 'desktop', side: 'before' }, lightBase],
    [{ change: 'invite-suggestions', screen: 'desktop', side: 'after' }, lightHead],
  ];
  // Light alone is ready, and everything published reads light.
  const lightOnly = shots.summarize(intent, build(lightEntries));
  assert.equal(lightOnly.stories[0].status, 'ready');
  assert.ok(lightOnly.files.every((file) => file.theme === 'light'));

  // An app with one fixed look: dark comes out the same on both sides, so
  // the dark copy is dropped.
  const sameDark = build([...lightEntries,
    [{ change: 'invite-suggestions', screen: 'desktop', side: 'before', look: 'dark' }, lightBase],
    [{ change: 'invite-suggestions', screen: 'desktop', side: 'after', look: 'dark' }, lightHead],
  ]);
  const dropped = shots.summarize(intent, sameDark);
  assert.ok(dropped.files.every((file) => file.theme === 'light'));

  // One dark side missing is the agent's dark pass cut short: light only.
  const halfDark = build([...lightEntries,
    [{ change: 'invite-suggestions', screen: 'desktop', side: 'after', look: 'dark' }, darkHead],
  ]);
  assert.ok(shots.summarize(intent, halfDark).files.every((file) => file.theme === 'light'));

  // A dark copy that differs is published with the light ones, and a dark
  // element shot rides along. The manifest hash moves with the look.
  const withDark = build([...lightEntries,
    [{ change: 'invite-suggestions', screen: 'desktop', side: 'before', look: 'dark' }, darkBase],
    [{ change: 'invite-suggestions', screen: 'desktop', side: 'after', look: 'dark' }, darkHead],
    [{ change: 'invite-suggestions', screen: 'desktop', side: 'after', kind: 'element', look: 'dark' },
      fixtures.png({ width: 5, height: 5, shade: 5 })],
  ]);
  const published = shots.summarize(intent, withDark);
  assert.deepEqual(published.files.map((file) => [file.side, file.theme]), [
    ['base', 'light'], ['head', 'light'], ['base', 'dark'], ['head', 'dark'], ['head', 'dark'],
  ]);
  assert.notEqual(published.manifestHash, lightOnly.manifestHash, 'the manifest carries the look');
});
