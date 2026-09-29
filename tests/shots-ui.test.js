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

test('verified cards flip a screen and list the declared change, escaped, authenticated, and never autoplay', () => {
  const value = shots();
  value.artifacts.push(legacyPaired());
  const html = AppView.shotsHtml(value, { sessionId: 42 });
  assert.match(html, /Typing shows &lt;matching&gt; users &amp; keeps &quot;Invite&quot; visible/);
  assert.doesNotMatch(html, /<matching>|evil\.example|\/visuals\//);
  assert.ok(html.indexOf('class="shots-flip') < html.indexOf('class="shots-claims"'), 'the screens lead, the numbered changes follow');
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
  const change = /<li data-shots-story="dialog"[\s\S]*?<\/li>/.exec(html)[0];
  assert.match(change, /data-shots-clips="1"/, 'the clips sit with their change');
  const players = change.match(/<video [^>]*>/g) || [];
  assert.equal(players.length, 2);
  assert.match(players[0], new RegExp(`src="${url('7')}"`));
  assert.match(players[0], new RegExp(`poster="${url('3')}"`), 'the before screen shot is the before poster');
  assert.match(players[1], new RegExp(`src="${url('8')}"`));
  assert.match(players[1], new RegExp(`poster="${url('4')}"`));
  for (const player of players) {
    assert.match(player, / controls preload="none" muted playsinline/);
    assert.doesNotMatch(player, /\bautoplay\b/);
  }
  assert.match(change, /Before clip/);
  assert.match(change, /After clip/);
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

test('each screen flips between its after and before screen shots, with no script and no ids', () => {
  const html = AppView.shotsHtml(shots(), { sessionId: 42 });
  const figure = /<figure class="shots-flip"[\s\S]*?<\/figure>/.exec(html)[0];
  // After first, as the proposal would leave it; the checkbox shows before.
  assert.deepEqual([...figure.matchAll(/<img src="([^"]+)"/g)].map((match) => match[1]), [url('4'), url('3')]);
  assert.match(figure, /<label class="shots-flip-frame"[^>]*>\s*<input type="checkbox" class="shots-flip-toggle" aria-label="Show the desktop screen before the change">/);
  assert.match(figure, /shots-flip-chip-after">After</);
  assert.match(figure, /shots-flip-chip-before">Before</);
  assert.doesNotMatch(figure, /\bid="|\bfor="|onchange|onclick="AppView\.flip/, 'the flip is the checkbox inside its label');
  assert.match(figure, /data-shots-open="1"[^>]*onclick="AppView\.openShotsScreen\(this\)">Open full screen</);
  // The same markup on every render, so a repaint does not rebuild it.
  assert.equal(AppView.shotsHtml(shots(), { sessionId: 42 }), html);
});

test('the run\'s screens outline each change where it differs, numbered as in the list', () => {
  const value = shots({
    claims: [
      shots().claims[0],
      { id: 'list', claim: 'The list has a new first row.', persona: 'member',
        viewports: ['desktop'], steps: ['Open the list'], baseState: 'present', animation: 'none' },
    ],
    shotResults: [{ id: 'dialog', status: 'ready' }, { id: 'list', status: 'ready' }],
    screens: [{
      viewport: 'desktop', shot: 'dialog', stories: ['dialog', 'list'],
      width: 1000, heightBefore: 500, heightAfter: 500,
      regions: [
        { story: 'dialog', b: [100, 50, 200, 40], a: [100, 50, 250, 40], bMark: null, aMark: null },
        { story: 'list', b: null, a: [0, 300, 1000, 50], bMark: [0, 300, 1000], aMark: null },
        { story: null, b: [0, 0, 1000, 20], a: [0, 0, 1000, 10], bMark: null, aMark: null },
      ],
    }],
  });
  const html = AppView.shotsHtml(value, { sessionId: 42 });
  assert.equal((html.match(/<figure class="shots-flip/g) || []).length, 1, 'two changes on one screen share it');
  const after = /<span class="shots-flip-side shots-flip-after">([\s\S]*?)<\/span>\s*<span class="shots-flip-side shots-flip-before">/.exec(html)[1];
  const before = /<span class="shots-flip-side shots-flip-before">([\s\S]*?)<\/label>/.exec(html)[1];
  assert.match(after, /class="shots-box" style="left:10\.000%;top:10\.000%;width:25\.000%;height:8\.000%"><span class="shots-box-n">1<\/span>/);
  assert.match(after, /class="shots-box" style="left:0\.000%;top:60\.000%;width:100\.000%;height:10\.000%"><span class="shots-box-n">2<\/span>/);
  assert.match(before, /class="shots-box" style="left:10\.000%;top:10\.000%;width:20\.000%;height:8\.000%"><span class="shots-box-n">1<\/span>/);
  assert.match(before, /class="shots-mark" style="left:0\.000%;top:60\.000%;width:100\.000%"><span class="shots-box-n">2<\/span>/,
    'where the new row appears, on the side it was not on');
  assert.match(after, /class="shots-box shots-box-other"/, 'an undeclared difference is outlined, unnumbered');
  assert.doesNotMatch(after, /shots-box-other"[^>]*><span class="shots-box-n"/);
  assert.match(html, /<li data-shots-story="dialog" data-shots-shot-status="ready" class="shots-claim">\s*<span class="shots-claim-n">1<\/span>/);
  assert.match(html, /<li data-shots-story="list" data-shots-shot-status="ready" class="shots-claim">\s*<span class="shots-claim-n">2<\/span>/);

  // A run from before the outlines: a screen per change and size, nothing outlined.
  const legacy = AppView.shotsHtml({ ...value, screens: [] }, { sessionId: 42 });
  assert.doesNotMatch(legacy, /shots-box|shots-mark/);
  assert.equal((legacy.match(/<figure class="shots-flip/g) || []).length, 1, 'only the change with shots gets a screen');
  // A screen whose shots are not in this card's artifacts is not drawn.
  const orphan = AppView.shotsHtml({ ...value, screens: [{ ...value.screens[0], shot: 'list' }] }, { sessionId: 42 });
  assert.doesNotMatch(orphan, /shots-box/);
});

test('ready shots can be taken again from the card', () => {
  // After better steps or hints, or to outline a run from before outlines
  // were worked out. Only failed and never-started runs offered it before.
  const html = AppView.shotsHtml(shots(), { sessionId: 42 });
  assert.match(html, /<button type="button" data-shots-retake="1"[^>]*onclick="AppView\.rerunShots\(42, this\)">Take the shots again<\/button>/);
  assert.doesNotMatch(AppView.shotsHtml(shots(), {}), /data-shots-retake/, 'no proposal id, nothing to take again');
});

test('several screens step with arrows, one at a time, with no script', () => {
  const value = shots({
    claims: [{ ...shots().claims[0], viewports: ['desktop', 'phone'] }],
    artifacts: [
      ...shots().artifacts,
      { id: id('a'), storyId: 'dialog', viewport: 'phone', side: 'base', variant: 'context', media: 'png', url: url('a') },
      { id: id('b'), storyId: 'dialog', viewport: 'phone', side: 'head', variant: 'context', media: 'png', url: url('b') },
    ],
  });
  const html = AppView.shotsHtml(value, { sessionId: 42 });
  const radios = html.match(/<input type="radio" class="shots-screen-pick"[^>]*>/g) || [];
  assert.equal(radios.length, 2);
  assert.match(radios[0], /name="shots-42-screen-pick" id="shots-42-screen-0" aria-label="Screen 1 of 2: desktop" checked/);
  assert.match(radios[1], /id="shots-42-screen-1" aria-label="Screen 2 of 2: phone">/);
  assert.ok(html.indexOf('class="shots-screen-pick"') < html.indexOf('<figure class="shots-flip'), 'the radios precede the screens they show');
  const [desktop, phone] = html.match(/<figure class="shots-flip[\s\S]*?<\/figure>/g);
  assert.match(desktop, /shots-screen-step-off" aria-hidden="true">‹<\/span><span class="shots-screen-count">1 of 2<\/span><label for="shots-42-screen-1" class="shots-screen-step" title="Next screen"/);
  assert.match(phone, /<label for="shots-42-screen-0" class="shots-screen-step" title="Previous screen"[^>]*>‹<\/label><span class="shots-screen-count">2 of 2<\/span><span class="shots-screen-step shots-screen-step-off"/);
  // One screen needs no arrows.
  const single = AppView.shotsHtml(shots(), { sessionId: 42 });
  assert.doesNotMatch(single, /shots-screen-pick|shots-screen-nav|shots-screens/);
});

test('the Workshop picture\'s element shot must be readable on both sides', () => {
  const sized = (dims) => shots({
    artifacts: shots().artifacts.map((artifact) => (artifact.variant === 'focus' ? { ...artifact, ...dims(artifact) } : artifact)),
  });
  // A 46×28 crop of a corner badge: the screens lead instead, on both sides.
  assert.deepEqual(AppView._workshopVisuals(null, sized(() => ({ width: 46, height: 28 }))),
    { ...AppView._workshopVisuals(null, sized(() => ({ width: 352, height: 61 }))), before: url('3'), after: url('4') });
  assert.equal(AppView._workshopVisuals(null, sized(() => ({ width: 352, height: 61 }))).after, url('2'));
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
  assert.doesNotMatch(ordinary, /not there yet/i);

  withoutBase.claims = [{ ...withoutBase.claims[0], baseState: 'not_present' }];
  const absent = AppView.shotsHtml(withoutBase, { sessionId: 42 });
  assert.match(absent, /shots-flip-chip-before">Before · not there yet</);
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
  const skipped = /<li data-shots-story="empty" data-shots-shot-status="skipped"[\s\S]*?<\/li>/.exec(html);
  assert.ok(skipped, 'the skipped change is marked');
  assert.match(skipped[0], /An empty &lt;search&gt; says no users match\./);
  assert.match(skipped[0], />Skipped</);
  assert.match(skipped[0], /The member fixture has no &lt;list&gt; to search\./);
  assert.doesNotMatch(skipped[0], /<img|<video|Open full screen|Shots ready/);
  assert.match(html, new RegExp(`<img src="${url('3')}"`), 'the ready change still shows its shots');
  assert.match(html, new RegExp(`<img src="${url('4')}"`));
  assert.match(html, /data-shots-story="dialog" data-shots-shot-status="ready"/);

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
  const change = /<li data-shots-story="dialog"[\s\S]*?<\/li>/.exec(noted)[0];
  assert.match(change, /<p data-shots-shot-note="1"[^>]*>.*Not in these shots:<\/span> The &lt;b&gt;Show more&lt;\/b&gt; fold needs a hidden app\.<\/p>/);
  assert.match(noted, /<img /, 'the shots are still shown above the note');
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
