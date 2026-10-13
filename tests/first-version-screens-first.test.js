'use strict';

// The first look, drawn first (newcomer run four, 12-13 October 2026).
//
// Club Votes' spec turn ran five and a half minutes and wrote 40,159
// characters, two drawn phone screens among them, and the first look was
// drawn from the spec only once all of it was in. Now a first version's spec
// draws its main screen before anything else and saves it with
// `usernode-screen 1` (worker/usernode-screen); the platform sees the command
// in the turn's own stream, reads the saved screen off the worker and draws
// the first look from it while the spec goes on
// (services/first-version-screens.js); the spec then writes an empty
// placeholder where the screen goes, and the saved screen is put there once
// the spec is in (homeroom-bot-live.js fillSavedScreens), so it is written
// once. A screen the command did not save is drawn in full, as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fvs = require('../src/services/first-version-screens');
const live = require('../src/services/homeroom-bot-live');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SCREEN = '<template data-screen data-size="phone" data-height="1400"><style>:root{--accent:37 99 235}</style>'
  + '<div data-side="after" data-change="1"><h2>Open polls</h2><button class="btn-primary">New poll</button></div></template>';
const SPEC = '<article data-spec><h1>Polls for the club</h1><section data-spec-tab="user"><h2>User-facing changes</h2>'
  + '<figure data-screens><template data-screen data-from="1"></template><ol data-changes><li>The open polls</li></ol></figure>'
  + '<h3>Assumptions</h3><p>Votes are anonymous.</p></section>'
  + '<section data-spec-tab="tech"><h2>Technical implementation</h2><p>public/app.js draws the list.</p></section></article>';

test('the stream shows a screen saved: the command, in either harness, or its answer', () => {
  assert.equal(fvs.savedScreenOf('$ usernode-screen 1 <<\'SCREEN\''), 1);
  assert.equal(fvs.savedScreenOf('$ /bin/bash -lc \'usernode-screen 2 <<SCREEN'), 2);
  assert.equal(fvs.savedScreenOf('  ⎿ Bash: Saved screen 1 (2048 characters). In the spec\'s screens figure, …'), 1);
  for (const line of ['$ usernode-screens 1', '$ usernode-screen 3', 'Reading usernode-screen 1', '… thinking about usernode-screen 1',
    'Saved screen 1', '$ usernode-screen', '$ usernode-screen 1.html']) {
    assert.equal(fvs.savedScreenOf(line), null, line);
  }
});

test('a saved screen is one whole <template data-screen>, and goes where the figure holds its placeholder', () => {
  assert.equal(fvs.savedTemplateOf(`noise\n${SCREEN}\ntail`), SCREEN);
  assert.equal(fvs.savedTemplateOf('<template data-screen data-from="1"></template>'), null, 'a placeholder is no screen');
  assert.equal(fvs.savedTemplateOf('<template data-screen>   </template>'), null, 'an empty one either');
  assert.equal(fvs.savedTemplateOf('<div>no template</div>'), null);
  assert.equal(fvs.savedTemplateOf('<template data-screen><div>never closed'), null);
  const filled = fvs.spliceSavedScreens(SPEC, new Map([[1, SCREEN]]));
  assert.ok(filled.includes(`<figure data-screens>${SCREEN}<ol data-changes>`));
  assert.doesNotMatch(filled, /data-from/);
  assert.equal(fvs.spliceSavedScreens(SPEC, new Map([[2, SCREEN]])), SPEC, 'a screen not saved leaves its placeholder');
  assert.equal(fvs.spliceSavedScreens(SPEC, new Map()), SPEC);
  // The first look is drawn from it as from a spec.
  assert.deepEqual(fvs.mainScreenOf(fvs.screenDocument(SCREEN)), {
    markup: '<style>:root{--accent:37 99 235}</style><div data-side="after" data-change="1"><h2>Open polls</h2><button class="btn-primary">New poll</button></div>',
    width: 390, height: 844,
  });
});

test('read off the worker: the saved file, never anything else', async () => {
  const asked = [];
  const worker = { async runLiveScript(container, script, opts) { asked.push({ container, script, opts }); return SCREEN; } };
  assert.equal(await fvs.readSavedScreen(worker, 'w-1', 1), SCREEN);
  assert.deepEqual(asked[0].opts.args, ['/tmp/usernode-screens/1.html']);
  assert.equal(asked[0].script, 'cat "$1" 2>/dev/null || true');
  assert.equal(await fvs.readSavedScreen(worker, 'w-1', 3), null);
  assert.equal(await fvs.readSavedScreen({ async runLiveScript() { throw new Error('gone'); } }, 'w-1', 1), null, 'never throws');
  assert.equal(await fvs.readSavedScreen({ async runLiveScript() { return 'cat: no such file'; } }, 'w-1', 1), null);
  assert.equal(await fvs.readSavedScreen({}, 'w-1', 1), null);
});

test('the watcher reads a saved screen as soon as the stream shows it, tries again a moment later, and hands each change on once', async () => {
  let calls = 0;
  const seen = [];
  const watch = fvs.screenWatcher({
    delayMs: 1,
    read: async (n) => { calls += 1; return calls < 2 ? null : (n === 1 ? SCREEN : null); },
    onScreen: (s) => seen.push(s),
  });
  watch('$ usernode-screen 1 <<\'SCREEN\'');
  watch('$ usernode-screen 1 <<\'SCREEN\''); // already being read
  await watch.idle();
  assert.deepEqual(seen, [{ n: 1, markup: SCREEN }]);
  assert.equal(calls, 2, 'not there yet, then there');
  watch('  ⎿ Bash: Saved screen 1 (300 characters).');
  await watch.idle();
  assert.equal(seen.length, 1, 'the same screen again is no change');
  assert.deepEqual([...watch.saved().keys()], [1]);
});

test('drawn as the first look while the spec goes on, from the saved screen', async () => {
  const sent = [];
  const worker = {
    async runBenchCapture(container, opts) {
      sent.push({ container, ...opts });
      return `${fvs.MARKER} ${JSON.stringify({ ok: true, png: PNG.toString('base64') })}\n`;
    },
  };
  const calls = [];
  const pool = { async query(sql, params) { calls.push({ sql: String(sql), params }); return { rows: [] }; } };
  assert.equal(await fvs.renderSavedFirstLook({ pool, worker, containerName: 'w-1', runId: 9, markup: SCREEN }), true);
  assert.match(sent[0].source, /Open polls/);
  assert.ok(calls.some((c) => /INSERT INTO first_version_screens/.test(c.sql) && c.params[2] === 'first_look'));
  assert.equal(await fvs.renderSavedFirstLook({ pool, worker, containerName: 'w-1', runId: 9, markup: '<div/>' }), false);
});

test('the spec turn: the saved screen drawn while it runs, and put into the spec once it is in', async () => {
  const screens = [];
  const persisted = [];
  const deps = {
    worker: {
      async execInWorker(_id, { onProgress }) {
        onProgress('Reading public/index.html');
        onProgress('$ usernode-screen 1 <<\'SCREEN\'');
        onProgress('  ⎿ Bash: Saved screen 1 (300 characters).');
        await new Promise((r) => setTimeout(r, 1700));
        return { lastResultText: SPEC };
      },
      async runLiveScript(_c, _s, { args }) { return args[0].endsWith('/1.html') ? SCREEN : ''; },
      async stopTurn() {},
    },
    sessions: {
      async runCodexAttemptLoop({ dispatchOnce }) { return { result: await dispatchOnce({}), estimatedCostUsd: 0.4 }; },
      async persistScoutPublication(args) { persisted.push(args); return { specVersion: 1 }; },
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
    activeWorkers: new Set(),
  };
  const spec = await live.draftSpec({
    pool: {}, config: {}, bot: { id: 1 }, session: { id: 5, app_slug: 'club-votes', branch_name: 'b' }, containerName: 'w-5',
    seed: 'seed', buildNote: 'note', turnBudgetMs: 60000, model: 'm', deps, firstVersion: true,
    onScreen: (s) => screens.push(s),
  });
  assert.equal(spec.ok, true, spec.error);
  assert.deepEqual(screens, [{ n: 1, markup: SCREEN, containerName: 'w-5' }], 'handed on while the spec ran');
  assert.ok(spec.specHtml.includes('<h2>Open polls</h2>'), 'the saved screen is in the spec');
  assert.doesNotMatch(spec.specHtml, /data-from/);
  assert.ok(persisted[0].contentHtml.includes('<h2>Open polls</h2>'), 'and in the spec the group reads');

  // A later change's spec is not watched, and its figure is its own.
  const later = await live.fillSavedScreens({
    fvScreens: fvs, screens: null, worker: { async runLiveScript() { return SCREEN; } }, containerName: 'w', result: { lastResultText: '# Plain spec' },
  });
  assert.equal(later.lastResultText, '# Plain spec');
});

test('the spec is told to draw the main screen first and save it; the command only writes the screen', () => {
  const prompt = live.specPrompt({ seed: 'S', buildNote: 'p', firstVersion: true, html: true });
  assert.ok(prompt.includes(live.FIRST_VERSION_SCREENS_FIRST));
  assert.match(live.FIRST_VERSION_SCREENS_FIRST, /BEFORE you write anything else of the\nspec, draw the main screen and save it/);
  assert.match(live.FIRST_VERSION_SCREENS_FIRST, /usernode-screen 1 <<'SCREEN'/);
  assert.match(live.FIRST_VERSION_SCREENS_FIRST, /<template data-screen data-from="N"><\/template>/);
  assert.match(live.FIRST_VERSION_SCREENS_FIRST, /If the command is missing or\ndoes not answer "Saved screen N", draw that screen in the figure in full instead\./);
  assert.ok(!live.specPrompt({ seed: 'S', buildNote: 'p', html: true }).includes('usernode-screen'), 'a later change is not asked');
  assert.doesNotMatch(live.FIRST_VERSION_SCREENS_FIRST, /—/);
  const script = read('worker/usernode-screen');
  assert.match(script, /^#!\/bin\/sh/);
  assert.match(script, /dir=\/tmp\/usernode-screens/);
  assert.match(script, /head -c 200000 > "\$part"/);
  assert.match(script, /mv -f "\$part" "\$dir\/\$n\.html"/, 'written aside, then moved: never read half written');
  assert.match(script, /echo "Saved screen \$n/);
  assert.doesNotMatch(script, /curl|wget|git /, 'nothing is sent from it');
  assert.equal(fs.statSync(path.join(ROOT, 'worker/usernode-screen')).mode & 0o111, 0o111, 'executable');
  const dockerfile = read('worker/Dockerfile');
  assert.match(dockerfile, /COPY usernode-screen \/usr\/local\/bin\/usernode-screen/);
  assert.match(dockerfile, /\/usr\/local\/bin\/usernode-screen \\/);
});

test('the live build draws the first look from the saved screen, and from the whole spec only when that did not happen', () => {
  const src = read('src/services/homeroom-bot.js');
  assert.match(src, /onScreen: \(\{ n, markup, containerName \}\) => \{\s+if \(Number\(n\) !== 1\) return;\s+void firstVersionScreens\(\)\.renderSavedFirstLook\(\{/);
  assert.match(src, /onFirstLook: \(\{ specHtml, containerName \}\) => \(drewEarly \? false : firstVersionScreens\(\)\.renderFirstLook\(\{/);
  assert.match(src, /onFirstLook: null, onScreen: null,/, 'the retry drew none');
  // A spec a restart caught gets its saved screens back off its worker too.
  assert.match(src, /plan\.result = await live\.fillSavedScreens\(\{\s+fvScreens: firstVersionScreens\(\), screens: null, worker,\s+containerName: typeof worker\.workerRuntimeName === 'function' \? worker\.workerRuntimeName\(Number\(sessionId\)\) : null,/);
  assert.ok(src.indexOf('plan.result = await live.fillSavedScreens(') < src.indexOf('const specRead = plan.mode === \'scout\''));
  const liveSrc = read('src/services/homeroom-bot-live.js');
  assert.match(liveSrc, /locale, onScreen,/);
});
