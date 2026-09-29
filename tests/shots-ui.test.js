'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AppView = require('../public/js/app-view.js');

const id = (char) => char.repeat(32);
const url = (char) => `/api/apps/demo/proposals/42/shots/${id(char)}`;

function shots(overrides = {}) {
  return {
    state: 'verified',
    required: true,
    claims: [{
      id: 'dialog',
      claim: 'Typing shows <matching> users & keeps "Invite" visible.',
      persona: 'member',
      viewports: ['desktop'],
      steps: ['Open <Members>', 'Type ma'],
      baseState: 'present',
      animation: 'steps',
    }],
    baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), planHash: 'c'.repeat(64),
    shotResults: [{ id: 'dialog', status: 'ready', reason: null }],
    verifiedReason: null,
    artifacts: [
      { id: id('1'), storyId: 'dialog', viewport: 'desktop', side: 'base', variant: 'focus', media: 'png', url: url('1') },
      { id: id('2'), storyId: 'dialog', viewport: 'desktop', side: 'head', variant: 'focus', media: 'png', url: url('2') },
      { id: id('3'), storyId: 'dialog', viewport: 'desktop', side: 'base', variant: 'context', media: 'png', url: url('3') },
      { id: id('4'), storyId: 'dialog', viewport: 'desktop', side: 'head', variant: 'context', media: 'png', url: url('4') },
      // A server bug or injected object cannot turn an absolute URL into media.
      { id: id('6'), storyId: 'dialog', viewport: 'desktop', side: 'head', variant: 'focus', media: 'png', url: 'https://evil.example/x.png' },
    ],
    ...overrides,
  };
}

// A run from before shots: one paired before/after recording per viewport.
function legacyPaired() {
  return { id: id('5'), storyId: 'dialog', viewport: 'desktop', side: 'paired', variant: 'animation', media: 'webm', url: url('5') };
}

function clipArtifacts(storyId = 'dialog') {
  return [
    { id: id('7'), storyId, viewport: 'desktop', side: 'base', variant: 'animation', media: 'webm', url: url('7') },
    { id: id('8'), storyId, viewport: 'desktop', side: 'head', variant: 'animation', media: 'webm', url: url('8') },
  ];
}

test('verified cards lead with the declared change, escaped, authenticated, and never autoplay', () => {
  const value = shots();
  value.artifacts.push(legacyPaired());
  const html = AppView.shotsHtml(value, { sessionId: 42 });
  assert.match(html, /Typing shows &lt;matching&gt; users &amp; keeps &quot;Invite&quot; visible/);
  assert.doesNotMatch(html, /<matching>|evil\.example|\/visuals\//);
  assert.ok(html.indexOf('Typing shows') < html.indexOf('<img src='), 'the declared change precedes the shots');
  assert.match(html, /aria-label="Before &amp; after"/);
  assert.match(html, /<video[^>]* controls[^>]*preload="none"[^>]* muted[^>]*playsinline/);
  assert.doesNotMatch(html, /<video[^>]*\bautoplay\b/);
  assert.match(html, /before <code>aaaaaaaa<\/code>/);
  assert.match(html, /after <code>bbbbbbbb<\/code>/);
  assert.match(html, /shots <code>cccccccccccc<\/code>/);
  assert.match(html, /Shots ready/);
  assert.match(html, /Shot details/);
  assert.match(html, /taken by the shots agent/);
  assert.match(html, /Open full screen/);
  assert.match(html, /Look at the shots and clips to decide whether they show the change\./);
  // The retired replay vocabulary is gone.
  assert.doesNotMatch(html, /Visual change preview|clean replays|bounded repair|relative-pointer|Captured/);
});

test('a legacy paired recording still plays, labelled by what the change declared', () => {
  const steps = shots();
  steps.artifacts.push(legacyPaired());
  const interaction = AppView.shotsHtml(steps, { sessionId: 42 });
  assert.match(interaction, /Play interaction/);
  assert.match(interaction, new RegExp(`<video src="${url('5')}"`));
  assert.doesNotMatch(interaction, /data-shots-clips/);

  const motion = shots();
  motion.claims[0].animation = 'motion';
  motion.artifacts.push(legacyPaired());
  const html = AppView.shotsHtml(motion, { sessionId: 42 });
  assert.match(html, /Play animation/);
  assert.doesNotMatch(html, /Play interaction/);
});

test('a motion change with a clip per side shows a before and an after player', () => {
  const value = shots();
  value.claims[0].animation = 'motion';
  value.artifacts.push(...clipArtifacts());
  const html = AppView.shotsHtml(value, { sessionId: 42 });
  const clips = /<div data-shots-clips="1"[^>]*>([\s\S]*?)<\/div>\s*<div class="mt-2 flex/.exec(html);
  assert.ok(clips, 'the clips sit in their own block');
  const players = clips[1].match(/<video [^>]*>/g) || [];
  assert.equal(players.length, 2);
  assert.match(players[0], new RegExp(`src="${url('7')}"`));
  assert.match(players[0], new RegExp(`poster="${url('3')}"`), 'the before screen shot is the before poster');
  assert.match(players[1], new RegExp(`src="${url('8')}"`));
  assert.match(players[1], new RegExp(`poster="${url('4')}"`));
  for (const player of players) {
    assert.match(player, / controls preload="none" muted playsinline/);
    assert.doesNotMatch(player, /\bautoplay\b/);
  }
  assert.match(clips[1], /Before clip/);
  assert.match(clips[1], /After clip/);
  // Side-by-side clips replace the legacy paired player.
  assert.doesNotMatch(html, /Play animation|Play interaction/);
  assert.match(html, /Look at the shots and clips/);

  // A clip missing on one side says so rather than hiding the other.
  const oneSided = shots();
  oneSided.claims[0].animation = 'motion';
  oneSided.artifacts.push(clipArtifacts()[1]);
  const partial = AppView.shotsHtml(oneSided, { sessionId: 42 });
  assert.match(partial, /data-shots-clips="1"/);
  assert.match(partial, /No clip/);
  assert.equal((partial.match(/<video /g) || []).length, 1);

  // A clip URL for another proposal is never played.
  const foreign = shots();
  foreign.claims[0].animation = 'motion';
  foreign.artifacts.push(...clipArtifacts().map((clip) => ({ ...clip, url: clip.url.replace('/42/', '/43/') })));
  assert.doesNotMatch(AppView.shotsHtml(foreign, { sessionId: 42 }), /<video|data-shots-clips/);
});

test('the element shot leads over the screen shot, and full screen opens the screen shots', () => {
  const html = AppView.shotsHtml(shots(), { sessionId: 42 });
  const images = [...html.matchAll(/<img src="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(images, [url('1'), url('2')]);
  assert.match(html, new RegExp(`data-before-url="${url('3')}" data-head-url="${url('4')}"`));

  // Without an element shot the screen shot stands in.
  const screens = shots({ artifacts: shots().artifacts.filter((artifact) => artifact.variant === 'context') });
  const fallback = AppView.shotsHtml(screens, { sessionId: 42 });
  assert.deepEqual([...fallback.matchAll(/<img src="([^"]+)"/g)].map((match) => match[1]), [url('3'), url('4')]);
});

test('an element shot too small to read does not lead, on either side', () => {
  const sized = (dims) => shots({
    artifacts: shots().artifacts.map((artifact) => (artifact.variant === 'focus' ? { ...artifact, ...dims(artifact) } : artifact)),
  });
  // A 46×28 crop of a corner badge: the screens lead instead, on both sides.
  const tiny = AppView.shotsHtml(sized(() => ({ width: 46, height: 28 })), { sessionId: 42 });
  assert.deepEqual([...tiny.matchAll(/<img src="([^"]+)"/g)].map((match) => match[1]), [url('3'), url('4')]);
  // One small side is enough to keep the pair comparable.
  const oneSmall = AppView.shotsHtml(
    sized((artifact) => (artifact.side === 'base' ? { width: 352, height: 61 } : { width: 90, height: 30 })), { sessionId: 42 });
  assert.deepEqual([...oneSmall.matchAll(/<img src="([^"]+)"/g)].map((match) => match[1]), [url('3'), url('4')]);
  // A readable crop still leads.
  const readable = AppView.shotsHtml(sized(() => ({ width: 352, height: 61 })), { sessionId: 42 });
  assert.deepEqual([...readable.matchAll(/<img src="([^"]+)"/g)].map((match) => match[1]), [url('1'), url('2')]);
  // The Workshop thumbnail follows the same rule.
  assert.deepEqual(AppView._workshopVisuals(null, sized(() => ({ width: 46, height: 28 }))),
    { ...AppView._workshopVisuals(null, sized(() => ({ width: 352, height: 61 }))), before: url('3'), after: url('4') });
});

test('a privileged declared change is explicitly labelled as full admin', () => {
  const value = shots();
  value.claims[0].persona = 'full_admin';
  const html = AppView.shotsHtml(value, { sessionId: 42 });
  assert.match(html, /desktop · full admin/);
});

test('a still change shows before and after PNGs without suggesting a video', () => {
  const value = shots();
  value.claims[0].animation = 'none';
  const html = AppView.shotsHtml(value, { sessionId: 42 });
  assert.match(html, /Look at the shots to decide whether they show the change\./);
  assert.match(html, /<img src=/);
  assert.doesNotMatch(html, /<video|Play interaction|Play animation|shots and clips|data-shots-clips/);
});

test('absence is labelled only when the author explicitly declared a new before state', () => {
  const withoutBase = shots({ artifacts: shots().artifacts.filter((a) => a.side !== 'base') });
  const ordinary = AppView.shotsHtml(withoutBase, { sessionId: 42 });
  assert.match(ordinary, /No shot/);
  assert.doesNotMatch(ordinary, /Not there yet/);

  withoutBase.claims = [{ ...withoutBase.claims[0], baseState: 'not_present' }];
  const absent = AppView.shotsHtml(withoutBase, { sessionId: 42 });
  assert.match(absent, /Before · Not there yet/);
});

test('a skipped change shows its reason and no media, beside a ready one', () => {
  const value = shots({
    claims: [
      { ...shots().claims[0], animation: 'none' },
      { id: 'empty', claim: 'An empty <search> says no users match.', persona: 'member',
        viewports: ['desktop'], steps: ['Type zz'], baseState: 'present', animation: 'none' },
    ],
    shotResults: [
      { id: 'dialog', status: 'ready', reason: null },
      { id: 'empty', status: 'skipped', reason: 'The member fixture has no <list> to search.' },
    ],
    // A run may publish only the screen shots; thumbnails use them.
    artifacts: shots().artifacts.filter((artifact) => artifact.variant === 'context'),
  });
  const html = AppView.shotsHtml(value, { sessionId: 42 });
  const skipped = /<article data-shots-story="empty" data-shots-shot-status="skipped"[\s\S]*?<\/article>/.exec(html);
  assert.ok(skipped, 'the skipped change is marked');
  assert.match(skipped[0], /An empty &lt;search&gt; says no users match\./);
  assert.match(skipped[0], />Skipped</);
  assert.match(skipped[0], /The member fixture has no &lt;list&gt; to search\./);
  assert.doesNotMatch(skipped[0], /<img|<video|Open full screen|Shots ready/);
  assert.match(html, new RegExp(`<img src="${url('3')}"`), 'the ready change still shows its shots');
  assert.match(html, new RegExp(`<img src="${url('4')}"`));
  assert.doesNotMatch(html, /data-shots-story="dialog" data-shots-shot-status/);

  const unexplained = AppView.shotsHtml({
    ...value, shotResults: [value.shotResults[0], { id: 'empty', status: 'skipped', reason: null }],
  }, { sessionId: 42 });
  assert.match(unexplained, /The shots agent could not get to this change\./);

  const summary = AppView._workshopVisuals(null, {
    ...value,
    claims: [value.claims[1], value.claims[0]],
  });
  assert.equal(summary.claim, value.claims[0].claim, 'the feed skips a change with no shots');
  assert.equal(summary.before, url('3'));
  assert.equal(summary.after, url('4'));
});

test('a ready change shows the shots agent\'s note on what its shots leave out, as text', () => {
  const noted = AppView.shotsHtml(shots({
    shotResults: [{ id: 'dialog', status: 'ready', reason: null, note: 'The <b>Show more</b> fold needs a hidden app.' }],
  }), { sessionId: 42 });
  const article = /<article data-shots-story="dialog"[\s\S]*?<\/article>/.exec(noted)[0];
  assert.match(article, /<p data-shots-shot-note="1"[^>]*>.*Not in these shots:<\/span> The &lt;b&gt;Show more&lt;\/b&gt; fold needs a hidden app\.<\/p>/);
  assert.match(article, /<img /, 'the shots are still shown beside the note');
  // No note, a skipped change's note, or a non-string note renders nothing.
  for (const shotResults of [
    [{ id: 'dialog', status: 'ready', reason: null }],
    [{ id: 'dialog', status: 'ready', reason: null, note: null }],
    [{ id: 'dialog', status: 'ready', reason: null, note: { html: '<b>x</b>' } }],
  ]) {
    assert.doesNotMatch(AppView.shotsHtml(shots({ shotResults }), { sessionId: 42 }), /data-shots-shot-note/);
  }
});

test('pending or failed shots show the declared changes and status but no media or legacy fallback', () => {
  for (const state of ['planned', 'failed', 'stale']) {
    const html = AppView.shotsHtml(shots({
      state,
      failureReason: state === 'failed' ? 'The dialog could not be reached.' : null,
      repairAvailable: state === 'failed',
    }), { sessionId: 42 });
    assert.match(html, new RegExp(`data-shots-state="${state}"`));
    assert.doesNotMatch(html, /<img|<video|\/visuals\//);
    assert.match(html, /<li>Typing shows &lt;matching&gt;/);
  }
  assert.equal(AppView._workshopVisuals({ after: { png: id('a') } }, shots({ state: 'failed' })), null);
});

test('the workshop summary uses protected element shots only after verification', () => {
  const summary = AppView._workshopVisuals(null, shots());
  assert.equal(summary.protected, true);
  assert.equal(summary.before, url('1'));
  assert.equal(summary.after, url('2'));
  assert.equal(summary.claim, shots().claims[0].claim);
});

test('running shots offer Stop, and a stopped or failed set offers to take them again', () => {
  const running = AppView.shotsHtml(shots({ state: 'exploring', artifacts: [] }), { sessionId: 42 });
  assert.match(running, /Taking the shots/);
  assert.match(running, /data-shots-stop="1"[^>]*onclick="AppView\.stopShots\(42, this\)">Stop</);
  assert.match(AppView.shotsHtml(shots({ state: 'provisioning', artifacts: [] }), { sessionId: 42 }),
    /Building before and after/);
  assert.match(AppView.shotsHtml(shots({ state: 'reviewing', artifacts: [] }), { sessionId: 42 }),
    /Saving the shots/);
  const notStarted = AppView.shotsHtml(shots({ state: 'planned', artifacts: [] }), { sessionId: 42 });
  assert.doesNotMatch(notStarted, /data-shots-stop/, 'nothing is running to stop');

  const stopped = AppView.shotsHtml(shots({
    state: 'failed', artifacts: [], failureCode: 'shots_stopped', repairAvailable: false,
    failureReason: 'Stopped before it finished.',
  }), { sessionId: 42 });
  assert.match(stopped, /Shots stopped/);
  assert.doesNotMatch(stopped, /bg-red-500\/10/, 'a stop is not a failure');
  assert.match(stopped, /onclick="AppView\.rerunShots\(42, this\)">Take the shots again</);
  assert.doesNotMatch(stopped, /data-shots-stop/);

  const failed = AppView.shotsHtml(shots({
    state: 'failed', artifacts: [], failureCode: 'shots_capture_incomplete', repairAvailable: true,
    failureReason: 'The shots agent could not reach the dialog.',
  }), { sessionId: 42 });
  assert.match(failed, /Couldn’t take the shots/);
  assert.match(failed, /The shots agent could not reach the dialog\./);
  assert.match(failed, /bg-red-500\/10/);
  assert.match(failed, />Take the shots again</);

  const conflict = AppView.shotsHtml(shots({
    state: 'failed', artifacts: [], failureCode: 'visible_changes_conflict', repairAvailable: false,
    failureReason: 'The declaration says nothing visible changed.',
  }), { sessionId: 42 });
  assert.doesNotMatch(conflict, /Take the shots again/, 'a retry that would repeat the failure is not offered');
});

test('an interrupted run the platform is starting again reads as under way, not as a failure', () => {
  const retrying = AppView.shotsHtml(shots({
    state: 'failed', artifacts: [], failureCode: 'shots_run_interrupted', repairAvailable: false,
    automaticRetryPending: true,
    failureReason: 'Homeroom restarted while these before & after shots were being taken. You can take them again.',
  }), { sessionId: 42 });
  assert.match(retrying, /Trying the shots again/);
  assert.match(retrying, /starts them again on its own in a moment/);
  assert.doesNotMatch(retrying, /Couldn’t take the shots|You can take them again/);
  assert.doesNotMatch(retrying, /bg-red-500\/10/, 'nothing has failed that needs anyone');
  assert.doesNotMatch(retrying, /Take the shots again/, 'the retry is already coming');

  const view = AppView._shotsView(shots({
    state: 'failed', artifacts: [], failureCode: 'shots_run_interrupted', automaticRetryPending: true,
  }));
  assert.equal(view.retrying, true);
  assert.equal(view.label, 'Trying the shots again');

  // Once the retries are used up, the stored reason and the manual retry are back.
  const spent = AppView.shotsHtml(shots({
    state: 'failed', artifacts: [], failureCode: 'shots_run_interrupted', repairAvailable: true,
    automaticRetryPending: false,
    failureReason: 'Homeroom restarted while these before & after shots were being taken. You can take them again.',
  }), { sessionId: 42 });
  assert.match(spent, /Couldn’t take the shots/);
  assert.match(spent, />Take the shots again</);
});

test('a change not yet up for a vote shows its shots on its page and in the feed', () => {
  // The shots are taken once the preview is up, before anyone promotes the
  // change, so a draft is where the author first looks at them.
  const draft = { id: 42, source: 'cli_handoff', status: 'paused', shots: shots(), visuals: null };
  const view = AppView._detailActionsView('session', draft);
  assert.ok(view && view.visuals, 'the page carries the before & after');
  assert.match(view.visuals.tilesHtml, /data-shots="1"/);
  assert.match(view.visuals.tilesHtml, /\/api\/apps\/demo\/proposals\/42\/shots\//);
  // Without shots, a session still shows no legacy route capture.
  const legacyOnly = AppView._detailActionsView('session', { ...draft, shots: null, visuals: legacyPaired() });
  assert.ok(!legacyOnly || !legacyOnly.visuals, 'legacy captures stay on proposals and imported pull requests');
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/js/app-view.js'), 'utf8');
  assert.match(source, /\(kind === 'session' && item && item\.shots \? AppView\._workshopVisuals\(null, item\.shots\) : null\)/,
    'the feed picture follows the same rule, from the shots alone');
});

test('no state of the card says "Visual change preview"', () => {
  const states = ['planned', 'provisioning', 'exploring', 'replaying', 'reviewing', 'verified',
    'failed', 'stale', 'cancelled', 'not_required', 'overridden'];
  for (const state of states) {
    for (const extra of [{}, { failureCode: 'shots_stopped' }, { notStartedReason: 'Switched off here.' }]) {
      const html = AppView.shotsHtml(shots({ state, ...extra }), { sessionId: 42 });
      assert.doesNotMatch(html, /visual change preview/i, `${state} ${JSON.stringify(extra)}`);
    }
  }
});
