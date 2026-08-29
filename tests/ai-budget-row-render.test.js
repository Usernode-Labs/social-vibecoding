// The AI-credit row's four states, end to end: the view model
// features/header/ai-credit.js publishes and the markup
// features/header/ai-budget.tsx renders from it.
//
// Before the conversion this row had NO rendered coverage — three source
// greps and two declared browser checks. What that missed is exactly the
// class of bug the migration notes warn about: the row is a run of coloured
// fragments where the colour IS the message ("$19.00 left" in amber means
// something different from the same string in grey), and a threshold that
// resolved to the wrong literal would have looked fine to every gate.
//
// Run with: node --test tests/ai-budget-row-render.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const CREDIT_SRC = fs.readFileSync(
  path.join(root, 'frontend/src/features/header/ai-credit.js'), 'utf8');
const CREDIT_OPTIONS_SRC = fs.readFileSync(
  path.join(root, 'public/js/credit-options.js'), 'utf8');

let api = null;
const mod = () => (api || (api = loadTsx('tests/fixtures/ai-budget-api.ts')));

/**
 * ai-credit.js is an ES module now (it imports the store), so it cannot be
 * `vm.runInContext`ed as a script. Import it for real, and give it the one
 * global it reads — `window.CreditOptions` — through the same `globalThis`
 * the bundle would. It exports nothing; `window.AiCredit` is its publication.
 *
 * The STORE is read from Node's copy, not from the loadTsx bundle: esbuild
 * gives each entry point its own module graph, so the bundled store is a
 * different object from the one this module publishes into. The view crosses
 * as plain data — which is all it ever is — and the component renders it
 * from the bundle.
 */
const importOnce = require('./lib/import-once');

async function loadCredit() {
  const g = globalThis;
  if (!g.window) g.window = g;
  if (!g.CreditOptions) {
    const sandbox = { module: { exports: {} }, window: {}, console };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(CREDIT_OPTIONS_SRC, sandbox);
    g.CreditOptions = sandbox.module.exports;
    g.window.CreditOptions = g.CreditOptions;
  }
  await importOnce(path.join(root, 'frontend/src/features/header/ai-credit.js'));
  const store = await importOnce(
    path.join(root, 'frontend/src/features/header/ai-budget-store.js'),
  );
  return { AiCredit: g.window.AiCredit, aiBudgetStore: store.aiBudgetStore };
}

const budget = (over) => ({
  limitCents: 2000, spentCents: 100, remainingCents: 1900, byokCents: 0,
  hasByokKey: false, ...over,
});

/** Publish a budget through the real renderer and read the store back. */
async function publish(state) {
  const { AiCredit, aiBudgetStore } = await loadCredit();
  aiBudgetStore.set({ view: null, hidden: false });
  AiCredit.Budget.state = state;
  AiCredit.Budget._render();
  return JSON.parse(JSON.stringify(aiBudgetStore.get()));
}

function rowHtml(s) {
  const m = mod();
  m.aiBudgetStore.set(s);
  return renderToHtml(createElement(m.AiBudgetRow));
}

test('the ordinary meter: spend-first, the remainder beside it, one tooltip', async () => {
  const s = await publish(budget({ spentCents: 640, remainingCents: 1360 }));
  assert.equal(s.hidden, false);
  const html = rowHtml(s);
  assert.match(html, /id="drawer-row-ai-budget"/);
  assert.match(html, /id="ai-budget-slot"[^>]*class="ml-auto grow min-w-0 text-right"/);
  assert.match(html, /class="ai-budget-meter drawer-meter"/);
  assert.match(html, /drawer-meter-dim">limit /);
  assert.match(html, /\$6\.40/);
  assert.match(html, /drawer-meter-dim">\/\$20\.00/);
  assert.match(html, /data-credits-remaining="1"/);
  assert.match(html, /\$13\.60 left/);
  assert.match(html, /title="[^"]*of your \$20\.00 daily AI allowance used/);
});

test('the parts are separated by a real space, because each one is nowrap', async () => {
  // .drawer-meter-part is `white-space: nowrap`, so the space BETWEEN parts
  // is the only place "limit $6.40/$20.00 · $13.60 left" may break. A
  // separator moved inside a part would make the whole value unbreakable.
  const s = await publish(budget({ spentCents: 640, remainingCents: 1360 }));
  const html = rowHtml(s);
  assert.match(html, /<\/span> <span class="drawer-meter-part"/);
});

test('the spend threshold picks the tone, and the tone is a class the row owns', async () => {
  const low = await publish(budget({ spentCents: 100, remainingCents: 1900 }));
  assert.equal(low.view.parts[0].runs[1].tone, 'low');
  // meadow is the product's ONE green (stock emerald is gone), and it takes
  // the same 700/200 shape its red and amber neighbours do — the -400 dark
  // halves were WCAG-era and read as non-content ink under APCA. The TONE
  // table in frontend/src/features/header/ai-budget.tsx carries the numbers.
  assert.match(rowHtml(low), /text-meadow-700 dark:text-meadow-200">\$1\.00/);

  const mid = await publish(budget({ spentCents: 1200, remainingCents: 800 }));
  assert.equal(mid.view.parts[0].runs[1].tone, 'mid');
  assert.match(rowHtml(mid), /text-amber-800 dark:text-amber-200">\$12\.00/);

  const high = await publish(budget({ spentCents: 1900, remainingCents: 100 }));
  assert.equal(high.view.parts[0].runs[1].tone, 'high');
  assert.match(rowHtml(high), /text-red-700 dark:text-red-200">\$19\.00/);

  // The thresholds themselves stay in the module, where the budget is.
  assert.match(CREDIT_SRC, /pct > 80 \? 'high' : pct > 50 \? 'mid' : 'low'/);
});

test('exhausted with no key reads "none left", in red', async () => {
  const s = await publish(budget({ spentCents: 2000, remainingCents: 0 }));
  const left = s.view.parts.find((p) => p.remaining);
  assert.equal(left.runs[1].text, 'none left');
  assert.equal(left.runs[1].tone, 'high');
  assert.match(rowHtml(s), /title="You have used all \$20\.00 of today/);
});

test('exhausted WITH a key drops the remainder and says where turns bill now', async () => {
  const s = await publish(budget({ spentCents: 2000, remainingCents: 0, hasByokKey: true }));
  assert.ok(!s.view.parts.some((p) => p.remaining), 'no "0 left" on a row that can keep going');
  assert.match(s.view.title, /billed to the Anthropic key you saved in Settings/);
});

test('a BYOK figure is its own part, so the "·" wraps with it', async () => {
  const s = await publish(budget({ byokCents: 450 }));
  const byok = s.view.parts[s.view.parts.length - 1];
  assert.deepEqual(byok.runs.map((r) => r.text), ['· ', 'your key $4.50']);
  assert.equal(byok.runs[1].tone, 'byok');
  const html = rowHtml(s);
  assert.match(html, /<span class="drawer-meter-part"><span class="drawer-meter-dim">· <\/span><span class="text-meadow-700 dark:text-meadow-200">your key \$4\.50<\/span><\/span>/);
  assert.match(s.view.title, /does not count against the allowance/);
});

test('a locked tier offers the unlock instead of dividing by a zero cap', async () => {
  // `locked` is CreditOptions.creditState's name for a zero tier behind an
  // unverified identity — a real state, not an unknown cap.
  const s = await publish(budget({
    limitCents: 0, remainingCents: 0, spentCents: 0, verificationRequired: true,
  }));
  const html = rowHtml(s);
  assert.match(html, /verify account · unlock \$10\/day/);
  assert.doesNotMatch(html, /\$0\.00\/\$0\.00/, 'no misleading meter, no NaN');
  assert.doesNotMatch(html, /NaN/);
  assert.match(html, /title="Connect GitHub or X in Settings to unlock \$10\/day\./);
});

test('a locked tier with a key still says the key is available', async () => {
  const s = await publish(budget({
    limitCents: 0, remainingCents: 0, spentCents: 0,
    verificationRequired: true, hasByokKey: true,
  }));
  assert.match(rowHtml(s), /your key available/);
  assert.match(s.view.title, /Your own Anthropic key remains available/);
});

test('an unverifiable eligibility says so, in one flat amber run', async () => {
  const s = await publish(budget({ limitCents: 0, entitlementAvailable: false }));
  const html = rowHtml(s);
  assert.match(html, /class="ai-budget-meter drawer-meter text-amber-800 dark:text-amber-200"/);
  assert.match(html, />credits temporarily unavailable</, 'bare text, no wrapper span');
  assert.match(html, /title="Credit eligibility could not be verified/);
});

test('no budget data hides the row rather than leaving an empty one', async () => {
  const s = await publish(null);
  assert.equal(s.view, null);
  assert.equal(s.hidden, true);
  const html = rowHtml(s);
  assert.match(html, /id="drawer-row-ai-budget"[^>]*class="[^"]* hidden"/);
  assert.doesNotMatch(html, /ai-budget-meter/);
});

test('the UNFETCHED row is visible and empty — what the shell prerenders', () => {
  // A declared check resolves `#drawer-row-ai-budget #ai-budget-slot` on a
  // plain /#settings/api-key, before any fetch has answered.
  const html = rowHtml({ view: null, hidden: false });
  assert.match(html, /id="drawer-row-ai-budget"/);
  assert.doesNotMatch(html, /class="[^"]*hidden/);
  assert.match(html, /<span id="ai-budget-slot" class="ml-auto grow min-w-0 text-right"><\/span>/);
});

test('the reset sentence comes from CreditOptions, not a second copy here', () => {
  assert.match(CREDIT_SRC, /CO\.resetSentence\(state\)/);
  assert.ok(!/Resets at midnight UTC/.test(CREDIT_SRC));
});
