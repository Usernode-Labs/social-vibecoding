// #4487: a Homeroom bot proposal's visible changes, for its before/after
// shots: derived from its HTML spec's `<ol data-changes>` when its build did
// not declare them, and the build's own declaration when it did.
//
// Run with: node --test tests/spec-visible-changes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const derive = require('../src/services/spec-visible-changes');
const contract = require('../src/services/visible-changes');
const live = require('../src/services/homeroom-bot-live');

const SPEC = `<article data-spec>
  <h1>Pin a list</h1>
  <section data-spec-tab="user">
    <figure data-screens>
      <ol data-changes>
        <li data-change="1" data-steps="Lists → open a list → ⋯ menu">A <strong>Pin to top</strong> item in the list&rsquo;s menu</li>
        <li data-change="2" data-steps="/lists -> Home">Pinned lists show first on Home, with a pin</li>
      </ol>
      <template data-screen data-size="desktop"><div class="x" data-change="1" data-side="after">Pin to top</div></template>
      <template data-screen data-size="phone"><div data-change="2">Home</div></template>
    </figure>
    <p>Words.</p>
  </section>
  <section data-spec-tab="tech"><p>Tech.</p></section>
</article>`;

test('a spec\'s numbered changes become a valid version-1 declaration', () => {
  const declared = derive.declarationFromSpec(SPEC);
  assert.ok(declared, 'derived');
  assert.deepEqual(contract.parseIntent(declared), declared, 'it is what the shared validator accepts');
  assert.equal(declared.version, 1);
  assert.equal(declared.impact, 'ui');
  assert.equal(declared.stories.length, 2);
  const [one, two] = declared.stories;
  assert.equal(one.id, 'change-1');
  assert.equal(one.claim, 'A Pin to top item in the list’s menu', 'the change\'s own words, entities decoded');
  assert.equal(one.persona, 'member');
  assert.deepEqual(one.viewports.map((v) => [v.name, v.width, v.height]), [['desktop', 1280, 800], ['phone', 390, 844]]);
  assert.equal(one.intent.startPath, '/');
  assert.deepEqual(one.intent.steps, ['Lists', 'open a list', '⋯ menu']);
  assert.equal(one.intent.checkpoint, one.claim);
  assert.equal(two.intent.startPath, '/lists', 'a first step that is an in-app path is where it starts');
  assert.deepEqual(two.intent.steps, ['Home']);
});

test('steps written with a spaced > are split too', () => {
  const declared = derive.declarationFromSpec('<ol data-changes><li data-change="1" data-steps="Settings &gt; Profile">A photo</li></ol>');
  assert.deepEqual(declared.stories[0].intent.steps, ['Settings', 'Profile']);
});

test('a change without steps is still declared, with its claim to look for', () => {
  const declared = derive.declarationFromSpec('<ol data-changes><li data-change="1">A bigger button</li></ol>');
  assert.equal(declared.stories.length, 1);
  assert.equal(declared.stories[0].intent.startPath, '/');
  assert.deepEqual(declared.stories[0].intent.steps, ['Find where this shows: A bigger button']);
});

test('the persona is member unless every screen says the same other one', () => {
  const screens = (a, b) => `<ol data-changes><li data-change="1" data-steps="Home">X</li></ol>
    <template data-screen ${a}>a</template><template data-screen ${b}>b</template>`;
  assert.equal(derive.declarationFromSpec(screens('data-persona="guest"', 'data-persona="guest"')).stories[0].persona, 'guest');
  assert.equal(derive.declarationFromSpec(screens('data-persona="guest"', '')).stories[0].persona, 'member');
  assert.equal(derive.declarationFromSpec(screens('data-persona="robot"', 'data-persona="robot"')).stories[0].persona, 'member');
});

test('at most three changes are declared', () => {
  const items = [1, 2, 3, 4].map((n) => `<li data-change="${n}" data-steps="Home">Change ${n}</li>`).join('');
  assert.equal(derive.declarationFromSpec(`<ol data-changes>${items}</ol>`).stories.length, 3);
});

test('no changes list, empty or unreadable input gives nothing, never "none"', () => {
  assert.equal(derive.declarationFromSpec(null), null);
  assert.equal(derive.declarationFromSpec(''), null);
  assert.equal(derive.declarationFromSpec('# A markdown spec\n\n## User-facing changes\n'), null);
  assert.equal(derive.declarationFromSpec('<article><ol><li>Not a changes list</li></ol></article>'), null);
  assert.equal(derive.declarationFromSpec('<ol data-changes><li data-change="1">   </li></ol>'), null);
});

test('a declaration the validator refuses gives nothing rather than a broken one', () => {
  // The same validator submit_work uses has the last word.
  const orig = contract.safeParseIntent;
  contract.safeParseIntent = () => ({ ok: false, value: null, errors: [{ path: [], message: 'no' }] });
  try {
    assert.equal(derive.declarationFromSpec(SPEC), null);
  } finally {
    contract.safeParseIntent = orig;
  }
});

function fakePool(detail) {
  return { query: async (sql) => (/SELECT shots_detail/.test(sql) ? { rows: [{ shots_detail: detail }] } : { rows: [] }) };
}
const recorder = () => {
  const calls = [];
  return { calls, recordIntent: async (pool, sessionId, intent) => { calls.push({ sessionId, intent }); return { accepted: true }; } };
};
const ON = { shots: { collect: true } };

test('the build\'s own declaration wins over the spec\'s', async () => {
  const shotsState = recorder();
  const built = { version: 1, impact: 'none', rationale: 'Server only.', stories: [] };
  const out = await derive.recordForBotProposal({
    pool: fakePool({ intent: built }), config: ON, sessionId: 5, specHtml: SPEC, shotsState,
  });
  assert.equal(out.source, 'build');
  assert.equal(shotsState.calls.length, 0, 'nothing overwrites what the build declared');
});

test('without one, the spec\'s is recorded through recordIntent', async () => {
  const shotsState = recorder();
  // A placeholder from the changed-file backstop carries no intent.
  const out = await derive.recordForBotProposal({
    pool: fakePool({ required: true, intent: null }), config: ON, sessionId: 5, specHtml: SPEC, shotsState,
  });
  assert.equal(out.source, 'spec');
  assert.equal(shotsState.calls.length, 1);
  assert.equal(shotsState.calls[0].sessionId, 5);
  assert.deepEqual(shotsState.calls[0].intent, derive.declarationFromSpec(SPEC));
});

test('nothing is recorded when collecting is off, the spec lists nothing, or the store fails', async () => {
  const shotsState = recorder();
  assert.equal((await derive.recordForBotProposal({ pool: fakePool(null), config: {}, sessionId: 5, specHtml: SPEC, shotsState })).reason, 'collect_disabled');
  assert.equal((await derive.recordForBotProposal({ pool: fakePool(null), config: ON, sessionId: 5, specHtml: '# md', shotsState })).reason, 'no_changes_in_spec');
  assert.equal(shotsState.calls.length, 0);
  const failing = { query: async () => { throw new Error('db down'); } };
  const out = await derive.recordForBotProposal({ pool: failing, config: ON, sessionId: 5, specHtml: SPEC, shotsState });
  assert.equal(out.source, null);
  assert.equal(out.reason, 'error');
});

test('the bot\'s build is asked to declare what it built, except a first version', () => {
  const later = live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan' });
  assert.match(later, /declare_visible_changes/);
  assert.match(later, /impact "none" with a specific reason/);
  assert.doesNotMatch(live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', firstVersion: true }), /declare_visible_changes/);
});

test('the bot records its visible changes before it proposes, and not for a first version', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/homeroom-bot-live.js'), 'utf8');
  const record = src.indexOf('specVisibleChanges.recordForBotProposal(');
  const promote = src.indexOf('const promoted = await promoteAsBot(');
  assert.ok(record > 0 && promote > record, 'recorded before the proposal opens');
  assert.match(src.slice(record - 400, record), /if \(!firstVersion\) \{/);
});
