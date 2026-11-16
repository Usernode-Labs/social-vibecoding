// The models a person may pick, as the browser seeds them:
// frontend/src/lib/platform-models.js (`window.PlatformModels`).
//
// The seeded map exists only for the paint before GET /api/models resolves,
// and it DUPLICATES the `changeSize` copy in src/services/models.js, which is
// authoritative. The Workshop's ask box reads it (AppView._workshopModels).
// Nothing else would notice the two diverging, and a drift would show people
// one string, then silently swap it for another mid-load.
//
// What must hold:
//   1. No price and no measured figure is seeded (#800): spend is shown by
//      the allowance, and Haiku is never offered, even before the load.
//   2. The seeded map matches the server's allowlist exactly.
//   3. The positioning the copy encodes: Sonnet is simple and small, Opus
//      the general coding pick, Fable design and taste plus the most
//      difficult coding; no size ladder between Opus and Fable (#809).
//   4. The ask box reads the same short guidance, not a second copy.
//
// Same approach as the other classic-script suites: the file is evaluated in
// a vm context with no `window`, so it publishes nothing and loads nothing.
//
// Run with: node --test tests/model-selector-ui.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'lib', 'platform-models.js'), 'utf8');

function loadPlatformModels() {
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__PlatformModels = PlatformModels;`, sandbox);
  return sandbox.__PlatformModels;
}

test('the seeded map carries no price and no measured figures', () => {
  const { MODELS } = loadPlatformModels();
  for (const [id, meta] of Object.entries(MODELS)) {
    assert.equal(meta.outputCostPerMTok, undefined, `${id} still seeds a price`);
    assert.equal(meta.stats, undefined, `${id} still seeds a stats block`);
  }
  // And Haiku is gone from the seed set too, so no picker offers it even
  // before /api/models resolves.
  assert.ok(!('claude-haiku-4-5' in MODELS));
  assert.doesNotMatch(SRC, /MTok|\$\d/, 'no price text in the module at all');
});

test('the seeded map matches src/services/models.js exactly', () => {
  const server = require('../src/services/models');
  const { MODELS } = loadPlatformModels();

  assert.deepEqual(
    Object.keys(MODELS).sort(),
    Object.keys(server.MODELS).sort(),
    'seed map and allowlist offer different models'
  );

  for (const [id, serverMeta] of Object.entries(server.MODELS)) {
    const seedMeta = MODELS[id];
    assert.ok(seedMeta, `${id} missing from the seeded map`);
    assert.equal(seedMeta.label, serverMeta.label, `${id} label drifted`);
    assert.equal(
      seedMeta.changeSize.short, serverMeta.changeSize.short,
      `${id} changeSize.short drifted between models.js and platform-models.js`
    );
    assert.equal(
      seedMeta.changeSize.long, serverMeta.changeSize.long,
      `${id} changeSize.long drifted between models.js and platform-models.js`
    );
  }
});

test('the guidance keeps Opus the general pick and gives Fable design and difficult coding', () => {
  // The trio's positioning: Sonnet = simple/small, Opus = general coding,
  // Fable = design/taste plus the MOST difficult coding. Fable gaining
  // "difficult coding" must not revert Opus to a big-or-tricky framing.
  const { MODELS } = loadPlatformModels();
  const short = (id) => `${MODELS[id].label}: ${MODELS[id].changeSize.short}`;
  assert.equal(short('claude-sonnet-5-5'), 'Sonnet 5.5: simple, small changes');
  assert.equal(short('claude-opus-5-5'), 'Opus 5.5: general coding work');
  assert.equal(short('claude-fable-5-1'), 'Fable 5.1: design, taste, and difficult coding');
});

test('no guidance implies a size ladder between Opus and Fable', () => {
  // The superseded copy positioned Fable as the "bigger" model, and Opus as
  // one reserved for big or tricky changes (#809): neither may come back.
  const { MODELS } = loadPlatformModels();
  const all = Object.values(MODELS)
    .map((m) => `${m.label}: ${m.changeSize.short} ${m.changeSize.long}`).join(' | ');
  assert.ok(!all.includes('big or tricky'));
  assert.ok(!all.includes('a few files'));
  assert.ok(!/Bigger models/i.test(all));
});

test('the Workshop ask box reads the same short guidance from the one map', () => {
  const APP_VIEW = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app-view.js'), 'utf8');
  const fn = APP_VIEW.slice(APP_VIEW.indexOf('  _workshopModels() {'));
  const body = fn.slice(0, fn.indexOf('\n  },'));
  assert.match(body, /PlatformModels\.MODELS/);
  assert.match(body, /note: \(src\[id\] && src\[id\]\.changeSize && src\[id\]\.changeSize\.short\) \|\| ''/,
    'the summary reads the authoritative short guidance');
  assert.match(body, /PlatformModels\.defaultModel/);
});
