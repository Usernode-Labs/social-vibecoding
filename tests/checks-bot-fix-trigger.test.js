// The checks-verdict hook that tells the Homeroom bot (#checks fix).
//
// visuals.noteBotChecksAfterChecks runs beside maybeAutoMergeAfterChecks at
// each place a check verdict settles: the live capture (settleCaptureRun),
// the preview lifecycle wrapper (captureForSession), and check-harvest for
// an adopted run. It acts only on 'failing', calls the bot once, and never
// throws into the capture pipeline.
//
// Run with: node --test tests/checks-bot-fix-trigger.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const visuals = require('../src/services/visuals');
const bot = require('../src/services/homeroom-bot');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('only a failing verdict reaches the bot, once', async (t) => {
  const real = bot.noteProposalChecks;
  const calls = [];
  t.after(() => { bot.noteProposalChecks = real; });
  bot.noteProposalChecks = async (pool, session) => { calls.push(session.id); return true; };

  for (const state of ['passing', 'skipped', 'pending', 'error', null, undefined]) {
    visuals.noteBotChecksAfterChecks({}, { id: 5 }, state);
  }
  await tick();
  assert.deepEqual(calls, [], 'nothing for any other verdict');

  visuals.noteBotChecksAfterChecks({}, { id: 5 }, 'failing');
  await tick();
  assert.deepEqual(calls, [5], 'called once, with the session');
});

test('a bot that throws or rejects never breaks the capture pipeline', async (t) => {
  const real = bot.noteProposalChecks;
  t.after(() => { bot.noteProposalChecks = real; });

  bot.noteProposalChecks = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => visuals.noteBotChecksAfterChecks({}, { id: 5 }, 'failing'));

  bot.noteProposalChecks = async () => { throw new Error('later boom'); };
  assert.doesNotThrow(() => visuals.noteBotChecksAfterChecks({}, { id: 5 }, 'failing'));
  await tick();
});

test('the hook runs beside maybeAutoMergeAfterChecks at all three settle sites', () => {
  const visualsSrc = read('src/services/visuals.js');
  const harvestSrc = read('src/services/check-harvest.js');
  const sites = [...visualsSrc.matchAll(/maybeAutoMergeAfterChecks\(config, [^)]*\)/g)]
    .filter((m) => !/function\s+$/.test(visualsSrc.slice(Math.max(0, m.index - 20), m.index)))
    .map((m) => ({ src: visualsSrc, at: m.index }));
  sites.push(...[...harvestSrc.matchAll(/maybeAutoMergeAfterChecks\(config, [^)]*\)/g)]
    .map((m) => ({ src: harvestSrc, at: m.index })));
  assert.equal(sites.length, 3, 'the live capture, the lifecycle wrapper and check-harvest');
  for (const site of sites) {
    const after = site.src.slice(site.at, site.at + 220);
    assert.match(after, /noteBotChecksAfterChecks\(/, `no hook beside the call at ${site.src === visualsSrc ? 'visuals.js' : 'check-harvest.js'}:${site.at}`);
  }
  assert.match(visualsSrc, /noteBotChecksAfterChecks,\n/, 'exported');
});
