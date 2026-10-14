'use strict';

// Run six (14 Oct 2026): the maker's first version as an iOS Live Activity.
//
// A first version takes about 23 minutes, so its maker puts the phone down
// while it builds. The Homeroom app (Usernode-Labs/flutter-mobile-app#609)
// shows it on the Lock Screen through the bridge's `setBuildActivity`. This
// pins the web half:
//
//   1. the wrapper, in both copies of the bridge (its boundary behaviour is
//      in tests/native-bridge-boundary.test.js);
//   2. the caller's pure parts (frontend/src/features/app-frame/
//      build-activity.ts): the arguments a payload makes, change detection,
//      ended once, never without the capability or for anyone but the maker;
//   3. its two doors: the App tab's every server answer
//      (public/js/app-view.js _noteAppRecordRead) and the made screen;
//   4. the words and the contract.
//
// Run with: node --test tests/build-live-activity.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

const activity = () => loadTsx('frontend/src/features/app-frame/build-activity.ts');

const MIN = 60000;
const NOW = Date.parse('2026-10-14T10:30:00Z');
const at = (min) => new Date(NOW + min * MIN).toISOString();
const ORIGIN = 'https://social.example';

/** The step list as the server answers it, with `key` under way since `since`, the steps before it done in `minutes` each. */
function stepsAt(key, since, minutes = {}) {
  const keys = ['plan', 'screens', 'build', 'check', 'test', 'live'];
  const i = keys.indexOf(key);
  return keys.map((k, j) => (j < i
    ? { key: k, state: 'done', ...(minutes[k] != null ? { minutes: minutes[k] } : {}) }
    : j === i ? { key: k, state: 'now', since } : { key: k, state: 'next' }));
}

/** What the App tab reads for the maker while it is built: drawing since 3 minutes ago, decided then. */
function building(fv = {}) {
  return {
    slug: 'club-votes',
    name: 'Club Votes',
    mine: true,
    line: 'building',
    phase: { key: 'drawing', since: at(-3) },
    steps: stepsAt('screens', at(-3)),
    estimate: { step: 'screens', stepEtaAt: at(2), etaAt: at(20), samples: 9, sameConfig: true },
    ...fv,
  };
}

// ── 1. The wrapper, in both copies ──────────────────────────────────────

test('both bridge copies carry the wrapper, privileged and with no session claim', () => {
  const canonical = read('public/usernode-bridge/v1/bridge.js');
  assert.equal(read('public/usernode-bridge.js'), canonical, 'the two copies stay byte for byte the same');
  const privileged = /_PRIVILEGED_NATIVE_METHODS\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(canonical);
  const session = /_REALM_SESSION_METHODS\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(canonical);
  assert.match(privileged[1], /\bsetBuildActivity: true,/, 'trusted top frame only');
  assert.doesNotMatch(session[1], /setBuildActivity/, 'it touches no native session');
  assert.match(canonical, /window\.usernode\.setBuildActivity = function \(activity\) \{/);
  assert.match(canonical, /capabilities\.indexOf\("setBuildActivity"\) === -1/, 'feature-detected');
  assert.match(canonical, /var _BUILD_ACTIVITY_TIMEOUT_MS = 10000;/, 'it races its own timeout');
  assert.match(canonical, /resolve\(\{ supported: false \}\);\n\s+\}, _BUILD_ACTIVITY_TIMEOUT_MS\);/, 'and the timeout is an answer');
});

// ── 2. The caller's pure parts ──────────────────────────────────────────

test('a building payload makes the whole activity: the screen\'s stage, the build\'s start, the estimate, the App tab', () => {
  const m = activity();
  const planned = m.planBuildActivity(building(), null, { now: NOW, origin: ORIGIN });
  assert.deepEqual(plain(planned.args), {
    activityId: 'first-version:club-votes',
    state: 'active',
    title: 'Club Votes',
    stage: 'Working out the details',
    startedAt: NOW - 3 * MIN,
    etaAt: NOW + 20 * MIN,
    deepLink: 'https://social.example/app/club-votes',
  });
  // The stage is the build line's own words, never the activity's.
  const stage = (fv) => m.planBuildActivity(building(fv), null, { now: NOW, origin: ORIGIN }).args.stage;
  assert.equal(stage({ phase: { key: 'checking', since: at(-1), round: 1, rounds: 2 } }), 'Checking the screens · round 1 of 2');
  assert.equal(stage({ phase: { key: 'starting', since: null } }), 'Starting the build');
  assert.equal(stage({ phase: null }), 'Building it');
  assert.equal(stage({ line: 'testing', phase: { key: 'testing', since: at(-1) } }), 'Testing it');
  // The build started when its plan was decided: the step under way, less the steps done since.
  const later = m.planBuildActivity(building({
    phase: { key: 'checking', since: at(-2), round: 1, rounds: 2 },
    steps: stepsAt('check', at(-2), { plan: 4, screens: 5, build: 9 }),
  }), null, { now: NOW, origin: ORIGIN });
  assert.equal(later.args.startedAt, NOW - 16 * MIN, 'the plan\'s own minutes are not the build\'s');
  // No time to go on: from now.
  assert.equal(m.planBuildActivity(building({ steps: null }), null, { now: NOW }).args.startedAt, NOW);
  // Served over plain http (a local stack): no link, which the app would refuse.
  assert.equal('deepLink' in m.planBuildActivity(building(), null, { now: NOW, origin: 'http://localhost:3000' }).args, false);
});

test('the countdown runs only while the screen counts down', () => {
  const m = activity();
  const eta = (fv, now = NOW) => m.planBuildActivity(building(fv), null, { now }).args.etaAt;
  assert.equal(eta({}), NOW + 20 * MIN);
  assert.equal(eta({ estimate: null }), null, 'no estimate: the stage only');
  // Run seven: past the step's own estimate the line goes on counting the
  // later steps' usual time (18 min here), as if the step ended now, so
  // the activity's end moves out with the clock.
  assert.equal(eta({}, NOW + 2 * MIN), NOW + 2 * MIN + 18 * MIN);
  assert.equal(eta({}, NOW + 9 * MIN), NOW + 9 * MIN + 18 * MIN);
  // Only once no later step is left to count does the screen say "taking a
  // little longer than usual", and the activity stops counting with it.
  const last = { step: 'live', stepEtaAt: at(2), etaAt: new Date(NOW + 2 * MIN + 30000).toISOString() };
  assert.equal(eta({ estimate: last }, NOW + MIN), NOW + 2 * MIN + 30000);
  assert.equal(eta({ estimate: last }, NOW + 2 * MIN), null);
  assert.equal(eta({ estimate: { step: 'screens', stepEtaAt: at(2), etaAt: at(-10) } }), null, 'never at or before its start');
  assert.equal(m.etaOf('ready', building().estimate, NOW - MIN, NOW), null, 'Ready to try counts nothing down');
});

test('only the maker\'s, only from Building it or Testing it, and only what the contract carries', () => {
  const m = activity();
  const plan = (fv, record = null) => m.planBuildActivity(building(fv), record, { now: NOW, origin: ORIGIN });
  assert.equal(plan({ mine: false }), null, 'a member is not told');
  for (const line of ['planning', 'plan', 'question', 'ready', 'working', 'nonsense', null]) {
    assert.equal(plan({ line, phase: null }), null, `${line} starts nothing`);
  }
  // With an activity running, any line updates its stage in the line's words.
  const record = { id: 'first-version:club-votes', startedAt: NOW - 3 * MIN, sig: 'x', ended: false, started: true, at: NOW - MIN };
  assert.equal(plan({ line: 'question', phase: null }, record).args.stage, 'Homeroom bot has a question for you');
  assert.equal(plan({ line: 'question', phase: null }, record).args.startedAt, NOW - 3 * MIN, 'the start it began with');
  // A slug the id cannot carry makes no activity.
  assert.equal(m.activityIdOf('club votes'), null);
  assert.equal(m.activityIdOf('a'.repeat(115)), null, '128 characters at most');
  assert.equal(m.activityIdOf('club-votes-b7cc89'), 'first-version:club-votes-b7cc89');
  // Long words are one line, cut to the limit.
  assert.equal(m.oneLine('  Club\n\tVotes  ', 80), 'Club Votes');
  const long = m.oneLine('x'.repeat(100), 80);
  assert.equal(long.length, 80);
  assert.ok(long.endsWith('…'));
  assert.equal(plan({ name: `A ${'very '.repeat(30)}long name` }).args.title.length, 80);
});

test('it ends once: live, gone from a running app, or waiting for a Yes', () => {
  const m = activity();
  const record = { id: 'first-version:club-votes', startedAt: NOW - 20 * MIN, sig: 'x', ended: false, started: true, at: NOW - MIN };
  const ended = (input) => m.planBuildActivity(input, record, { now: NOW, origin: ORIGIN });
  const live = ended(building({ line: 'live', phase: null }));
  assert.deepEqual(plain(live.args), {
    activityId: 'first-version:club-votes',
    state: 'ended',
    title: 'Club Votes',
    startedAt: NOW - 20 * MIN,
    etaAt: null,
    deepLink: 'https://social.example/app/club-votes',
    endedTitle: 'Club Votes is live',
  });
  // The App tab's answer once it merged: no first version on a running app.
  const gone = m.inputOfRecord({ slug: 'club-votes', name: 'Club Votes', status: 'running', first_version: null });
  assert.equal(gone.gone, true);
  assert.equal(ended(gone).args.endedTitle, 'Club Votes is live');
  assert.equal(m.inputOfRecord({ slug: 'club-votes', name: 'Club Votes', status: 'creating', first_version: null }).gone, false);
  // Ready to try, waiting for somebody's approval: it says so and ends.
  const waits = ended(building({ line: 'ready', phase: null, approval: { sessionId: 7, noVote: false, mustApprove: true, missing: 1 } }));
  assert.equal(waits.args.state, 'ended');
  assert.equal(waits.args.endedTitle, 'Club Votes is ready to try');
  // Ready to try, going live on its own (D1, or nothing more needed): still on its way.
  for (const approval of [{ noVote: true, soon: true }, { noVote: false, soon: true }, null]) {
    const on = ended(building({ line: 'ready', phase: null, approval }));
    assert.equal(on.args.state, 'active', JSON.stringify(approval));
    assert.equal(on.args.stage, 'Ready to try');
    assert.equal(on.args.etaAt, null);
  }
  // Nothing of ours on the Lock Screen: nothing to end.
  assert.equal(m.planBuildActivity(building({ line: 'live' }), null, { now: NOW }), null);
  assert.equal(m.planBuildActivity(gone, null, { now: NOW }), null);
  // Once ended, never again for that build.
  const done = { ...record, ended: true };
  for (const input of [building(), building({ line: 'live' }), gone]) {
    assert.equal(m.planBuildActivity(input, done, { now: NOW }), null);
  }
  // Another project's record is not this one's.
  assert.equal(m.planBuildActivity(gone, { ...record, id: 'first-version:other' }, { now: NOW }), null);
});

test('the App tab reads the record as its screen does', () => {
  const m = activity();
  const app = { slug: 'club-votes', name: 'Club Votes', status: 'running', first_version: { building: true, mine: true, line: 'testing', phase: { key: 'testing' }, steps: [], estimate: null, approval: null } };
  assert.deepEqual(plain(m.inputOfRecord(app)), {
    slug: 'club-votes', name: 'Club Votes', mine: true, line: 'testing', phase: { key: 'testing' }, steps: [], estimate: null, approval: null,
  });
  assert.equal(m.inputOfRecord({ ...app, first_version: { ...app.first_version, line: null, ready: true } }).line, 'ready', 'as _firstVersionThumb falls back');
  assert.equal(m.inputOfRecord({ ...app, first_version: { ...app.first_version, line: null } }).line, 'planning');
  assert.equal(m.inputOfRecord({ ...app, first_version: { ...app.first_version, mine: false } }).mine, false);
  assert.equal(m.inputOfRecord({ ...app, name: '  ' }).name, 'club-votes');
  for (const bad of [null, 'club-votes', {}, { slug: '' }]) assert.equal(m.inputOfRecord(bad), null);
});

/** An instance over a fake app: what it was asked, and what it answered. */
function harness({ capabilities = ['setBuildActivity'], isNative = true, reply = { supported: true, started: true }, info = null, stored = null } = {}) {
  const m = activity();
  const calls = [];
  const warnings = [];
  let saved = stored;
  let clock = NOW;
  const bridge = {
    isNative,
    async setBuildActivity(args) {
      calls.push(plain(args));
      if (typeof reply === 'function') return reply(args);
      return reply;
    },
  };
  let probes = 0;
  const instance = m.createBuildActivity({
    bridge: () => bridge,
    info: async () => {
      probes += 1;
      return info ? info(probes) : { version: 5, capabilities };
    },
    now: () => clock,
    origin: () => ORIGIN,
    load: () => saved,
    save: (value) => { saved = value; },
    warn: (...args) => warnings.push(args.join(' ')),
  });
  return {
    m, instance, calls, warnings, bridge,
    probes: () => probes,
    saved: () => saved,
    tick(ms) { clock += ms; },
  };
}

test('it calls the app only on a change: the line, the stage, or the minute it ends', async () => {
  const h = harness();
  assert.equal((await h.instance.sync(building())).started, true);
  await h.instance.sync(building());
  h.tick(10000);
  await h.instance.sync(building({ estimate: { step: 'screens', stepEtaAt: at(2), etaAt: new Date(NOW + 20 * MIN + 20000).toISOString() } }));
  assert.equal(h.calls.length, 1, 'the same thing, and the same minute: nothing');
  await h.instance.sync(building({ estimate: { step: 'screens', stepEtaAt: at(2), etaAt: at(22) } }));
  assert.equal(h.calls.length, 2, 'a new minute');
  // Run seven: the spec's two stages say the same words, so its second is no change.
  await h.instance.sync(building({ phase: { key: 'writing', since: at(0) }, estimate: { step: 'screens', stepEtaAt: at(2), etaAt: at(22) } }));
  assert.equal(h.calls.length, 2, 'the same words: nothing');
  await h.instance.sync(building({ phase: { key: 'building', since: at(0) } }));
  assert.equal(h.calls.length, 3, 'a new stage');
  assert.equal(h.calls[2].stage, 'Building it');
  assert.equal(h.calls[2].startedAt, NOW - 3 * MIN, 'the start it began with, every time');
  await h.instance.sync(building({ line: 'testing', phase: { key: 'testing', since: at(1) } }));
  assert.equal(h.calls.length, 4, 'a new line');
  assert.equal(h.probes(), 1, 'the capability is asked once per page');
});

test('ended is sent once, and nothing for that build after it', async () => {
  const h = harness({ reply: (args) => ({ supported: true, started: args.state === 'active' }) });
  await h.instance.sync(building());
  await h.instance.sync(building({ line: 'live', phase: null }));
  await h.instance.sync(building({ line: 'live', phase: null }));
  await h.instance.syncRecord({ slug: 'club-votes', name: 'Club Votes', status: 'running', first_version: null });
  await h.instance.sync(building());
  assert.deepEqual(h.calls.map((c) => c.state), ['active', 'ended']);
  assert.equal(h.calls[1].endedTitle, 'Club Votes is live');
  assert.equal(h.instance.record().ended, true);
});

test('no call without the capability, outside the app, or for anyone but the maker', async () => {
  for (const options of [{ capabilities: ['privilegedBridgeCapability'] }, { isNative: false }]) {
    const h = harness(options);
    assert.equal(await h.instance.sync(building()), null);
    assert.equal(h.calls.length, 0, JSON.stringify(options));
    assert.equal(h.saved(), null, 'and nothing remembered');
  }
  const member = harness();
  await member.instance.sync(building({ mine: false }));
  await member.instance.syncRecord({ slug: 'club-votes', name: 'Club Votes', status: 'running', first_version: { building: true, mine: false, line: 'building' } });
  assert.equal(member.calls.length, 0);
  assert.equal(member.probes(), 0, 'nothing to send: the app is not even asked');
  // A probe that came back degraded is "don't know", asked again next time.
  const flaky = harness({ info: (n) => (n === 1 ? { version: 0, capabilities: [], degraded: true } : { version: 5, capabilities: ['setBuildActivity'] }) });
  await flaky.instance.sync(building());
  assert.equal(flaky.calls.length, 0);
  await flaky.instance.sync(building());
  assert.equal(flaky.calls.length, 1);
});

test('a refusal is logged, never thrown, and not sent again until something changes', async () => {
  const h = harness({
    reply: () => {
      const err = new Error('The build activity could not be shown.');
      err.usernodeCode = 'failed';
      throw err;
    },
  });
  assert.equal(await h.instance.sync(building()), null);
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /failed/);
  await h.instance.sync(building());
  assert.equal(h.calls.length, 1);
  await h.instance.sync(building({ phase: { key: 'building', since: at(0) } }));
  assert.equal(h.calls.length, 2);
  // An answer that is not an object is no activity.
  const odd = harness({ reply: 'yes' });
  assert.deepEqual(plain(await odd.instance.sync(building())), { supported: false });
});

test('a start the app refused is tried again when the page comes back, not on every poll', async () => {
  let started = false;
  const h = harness({ reply: () => ({ supported: true, started }) });
  await h.instance.sync(building());
  h.tick(10000);
  await h.instance.sync(building());
  assert.equal(h.calls.length, 1, 'not on the next poll');
  h.tick(10000);
  h.instance.noteReturn();
  started = true;
  await h.instance.sync(building());
  assert.equal(h.calls.length, 2, 'back in the foreground: once more');
  h.tick(10000);
  h.instance.noteReturn();
  await h.instance.sync(building());
  assert.equal(h.calls.length, 2, 'it is showing now: nothing to retry');
});

test('a page loaded later ends the activity a former page started', async () => {
  const first = harness();
  await first.instance.sync(building());
  const stored = first.saved();
  assert.equal(JSON.parse(stored).id, 'first-version:club-votes');
  const next = harness({ stored });
  await next.instance.syncRecord({ slug: 'club-votes', name: 'Club Votes', status: 'running', first_version: null });
  assert.deepEqual(next.calls.map((c) => [c.state, c.endedTitle, c.startedAt]), [['ended', 'Club Votes is live', NOW - 3 * MIN]]);
  // A record from another day, or one that is not a record, is forgotten.
  const m = activity();
  assert.equal(m.recordOf({ ...JSON.parse(stored), at: NOW - 13 * 60 * MIN }, NOW), null);
  assert.equal(m.recordOf({ id: 'something-else', startedAt: NOW, at: NOW }, NOW), null);
  const broken = harness({ stored: '{not json' });
  assert.equal(broken.instance.record(), null);
});

// ── 3. The two doors ─────────────────────────────────────────────────────

function appView() {
  const records = [];
  const sandbox = {
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1 }, currentApp: null, currentTab: null },
    document: {
      visibilityState: 'visible',
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      removeEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      body: { appendChild() {} },
    },
    fetch: () => Promise.resolve({ ok: true, json: async () => ({}) }),
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval,
    clearInterval,
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    UsernodeReact: { buildActivity: { syncRecord: (record) => records.push(record) } },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(`${read('public/js/app-view.js')}\n;globalThis.__AppView = AppView;`, sandbox);
  return { AppView: sandbox.__AppView, sandbox, records };
}

test('the App tab hands it every answer the server gave, never the worker\'s copy', () => {
  const { AppView, sandbox, records } = appView();
  const fresh = { slug: 'club-votes', first_version: { building: true, mine: true, line: 'building' } };
  AppView._noteAppRecordRead(fresh, null, Date.now());
  assert.deepEqual(records, [fresh]);
  const cached = { slug: 'club-votes', first_version: { building: true, mine: true, line: 'building' } };
  AppView._noteAppRecordRead(cached, { headers: { get: (n) => (n === 'sw-cached-at' ? '1' : null) } }, Date.now());
  assert.equal(records.length, 1, 'a copy from before it went live would start one');
  // A failure in there never reaches the screen.
  sandbox.UsernodeReact.buildActivity.syncRecord = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => AppView._noteAppRecordRead({ slug: 'x' }, null, Date.now()));
  delete sandbox.UsernodeReact;
  assert.doesNotThrow(() => AppView._noteAppRecordRead({ slug: 'x' }, null, Date.now()));
  // Every read path stands its record up through it: the open, the recheck and the recovery poll.
  const src = read('public/js/app-view.js');
  assert.ok((src.match(/AppView\._noteAppRecordRead\(/g) || []).length >= 4);
  assert.match(src, /if \(!cached\) AppView\._syncBuildActivity\(record\);/);
});

test('the made screen says the same, from Submit on, through the same function', () => {
  const made = read('frontend/src/features/first-session/made.tsx');
  assert.match(made, /import \{ syncBuildActivity \} from '\.\.\/app-frame\/build-activity';/);
  assert.match(made, /const phase = fv\?\.phase \|\| \(answered && line === 'building' \? \{ key: 'starting' \} : null\);\n\s+const named = phaseLine\(line, phase, now, null, left\);/);
  assert.match(made, /syncBuildActivity\(\{\s+slug: made\.slug,\s+name: made\.name,\s+mine: fv \? fv\.mine === true : false,\s+line,\s+phase,/);
  const mount = read('frontend/src/features/app-frame/mount.ts');
  assert.match(mount, /bridge\.buildActivity = \{ sync: syncBuildActivity, syncRecord: syncBuildActivityRecord \};/);
  // Its words are the screens' own tables, never its own stage words.
  const src = read('frontend/src/features/app-frame/build-activity.ts');
  assert.match(src, /import \{ BUILD_LINE_WORDS, buildLineOf, phaseLine \} from '\.\.\/first-session\/build-line';/);
  assert.doesNotMatch(src, /'onboarding:buildLine\.(?!activity\.)/, 'no line or stage id of its own');
});

// ── 4. The words and the contract ───────────────────────────────────────

test('the ended headlines are whole catalog entries, with descriptions and no em dash', () => {
  const onboarding = JSON.parse(read('frontend/locales/en/onboarding.json'));
  assert.equal(onboarding['buildLine.activity.live'].text, '{{name}} is live');
  assert.equal(onboarding['buildLine.activity.readyToTry'].text, '{{name}} is ready to try');
  for (const key of ['buildLine.activity.live', 'buildLine.activity.readyToTry']) {
    assert.ok(onboarding[key].description.length > 80, key);
    assert.match(onboarding[key].description, /\{\{name\}\} is the project's name/);
    assert.doesNotMatch(`${onboarding[key].text} ${onboarding[key].description}`, /\u2014/);
  }
});

test('NATIVE-BRIDGE.md carries the contract', () => {
  const doc = read('NATIVE-BRIDGE.md');
  assert.match(doc, /- `setBuildActivity`: /, 'listed with the additive capabilities');
  assert.match(doc, /### Build Live Activity \(additive; `setBuildActivity`\)/);
  assert.match(doc, /#### `setBuildActivity\(activity\)` → `\{ supported, started\?, pushToken\? \}`/);
  for (const field of ['activityId', 'state', 'title', 'stage', 'detail', 'startedAt', 'etaAt', 'deepLink', 'endedTitle']) {
    assert.match(doc, new RegExp(`\\| \`${field}\` \\|`), field);
  }
  assert.match(doc, /`invalid_args`/);
  assert.match(doc, /\*\*`ended` once\*\*/);
  const section = doc.slice(doc.indexOf('### Build Live Activity'), doc.indexOf('### Native sign-in'));
  assert.doesNotMatch(section, /\u2014/);
});
