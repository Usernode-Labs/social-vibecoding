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
  assert.match(rowHtml(low), /text-emerald-700 dark:text-emerald-400">\$1\.00/);

  const mid = await publish(budget({ spentCents: 1200, remainingCents: 800 }));
  assert.equal(mid.view.parts[0].runs[1].tone, 'mid');
  assert.match(rowHtml(mid), /text-amber-800 dark:text-amber-400">\$12\.00/);

  const high = await publish(budget({ spentCents: 1900, remainingCents: 100 }));
  assert.equal(high.view.parts[0].runs[1].tone, 'high');
  assert.match(rowHtml(high), /text-red-700 dark:text-red-400">\$19\.00/);

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
  assert.match(html, /<span class="drawer-meter-part"><span class="drawer-meter-dim">· <\/span><span class="text-emerald-700 dark:text-emerald-400">your key \$4\.50<\/span><\/span>/);
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
  assert.match(html, /class="ai-budget-meter drawer-meter text-amber-800 dark:text-amber-400"/);
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

// ── #1788: the row now describes whichever window is binding ────────────
//
// The server sends ONE set of headline figures plus the name of the window
// they came from, and the row's job is to not lie about which boundary the
// user has to wait for. The figures are rendered identically either way —
// what changes is every word around them.

test('a weekly-bound row says "weekly" and points at Monday, not midnight', async () => {
  const s = await publish(budget({
    limitCents: 5000, spentCents: 4800, remainingCents: 200,
    capWindow: 'weekly', windowLabel: 'This week', resetLabel: 'Monday 00:00 UTC',
  }));
  const html = rowHtml(s);
  // Same meter, same tone rules — the figures are the figures.
  assert.match(html, /\$48\.00/);
  assert.match(html, /drawer-meter-dim">\/\$50\.00/);
  assert.match(html, /\$2\.00 left/);
  assert.match(html, /text-red-700 dark:text-red-400">\$48\.00/, '96% used is still "high"');
  // But the words are the week's.
  assert.match(s.view.title, /of your \$50\.00 weekly AI allowance used/);
  assert.match(s.view.title, /Free credits reset Monday 00:00 UTC/);
  assert.doesNotMatch(s.view.title, /daily/);
  assert.doesNotMatch(s.view.title, /at Monday/, '"resets at Monday" is not English');
});

test('an exhausted weekly window tells the user it was the week that ran out', async () => {
  const s = await publish(budget({
    limitCents: 5000, spentCents: 5000, remainingCents: 0,
    capWindow: 'weekly', windowLabel: 'This week', resetLabel: 'Monday 00:00 UTC',
  }));
  const left = s.view.parts.find((p) => p.remaining);
  assert.equal(left.runs[1].text, 'none left');
  assert.match(s.view.title, /You have used all \$50\.00 of this week’s AI allowance/);
  assert.doesNotMatch(s.view.title, /of today’s/);
});

test('a weekly window with a key on file names the weekly allowance as the one spent', async () => {
  const s = await publish(budget({
    limitCents: 5000, spentCents: 5000, remainingCents: 0, hasByokKey: true,
    capWindow: 'weekly', windowLabel: 'This week', resetLabel: 'Monday 00:00 UTC',
  }));
  assert.match(s.view.title, /\$50\.00 weekly allowance is used up/);
  assert.match(s.view.title, /billed to the Anthropic key you saved in Settings/);
});

test('the daily row is untouched: still "daily", still local-time-aware', async () => {
  const s = await publish(budget({ spentCents: 640, remainingCents: 1360 }));
  assert.match(s.view.title, /of your \$20\.00 daily AI allowance used/);
  assert.match(s.view.title, /Free credits reset at midnight UTC/);
});

// The window words live in ONE place each, for the same reason the reset
// sentence does: a second copy is a second thing to forget.
test('the window wording is derived from capWindow, never retyped per state', () => {
  assert.match(CREDIT_SRC, /var windowAdj = weeklyWindow \? 'weekly' : 'daily';/);
  assert.match(CREDIT_SRC, /var windowWhen = weeklyWindow \? 'this week’s' : 'today’s';/);
  assert.ok(!/weekly allowance is used up|of this week’s AI allowance/.test(
    CREDIT_OPTIONS_SRC), 'the tooltip copy has one home, and it is ai-credit.js');
  // And the reset sentence drops the "at" for a weekday boundary: in the
  // viewer's clock through ResetTime (#3230), or in the server's UTC words
  // where it is absent.
  assert.match(CREDIT_OPTIONS_SRC, /var weekly = s\.capWindow === 'weekly';/);
  assert.match(CREDIT_OPTIONS_SRC, /RT\.resetWhen\(weekly \? 'weekly' : 'daily'/);
  assert.match(CREDIT_OPTIONS_SRC, /weekly\s*\n?\s*\? 'Free credits reset ' \+ resetLabel/);
});

// ── #3998: the reset time is visible, not tooltip-only ──────────────────
//
// The row told you how much was left and kept "when you get it back" on a
// hover tooltip, which nobody on a phone ever opens. The note rides as one
// final dim part so the row reads as one line: figures first, reset last.

test('the weekly row shows its reset time as a trailing dim part', async () => {
  const s = await publish(budget({
    limitCents: 5000, spentCents: 4800, remainingCents: 200,
    capWindow: 'weekly', windowLabel: 'This week', resetLabel: 'Monday 00:00 UTC',
  }));
  // The store's parts stay exactly the figures; the note rides separately.
  assert.equal(s.view.reset, 'Resets Monday 00:00 UTC');
  const html = rowHtml(s);
  // One final part of its own, dim, with the separator travelling with it
  // so a wrap drops the whole note rather than splitting it.
  assert.match(html,
    /<span class="drawer-meter-part"><span class="drawer-meter-dim">· <\/span><span class="drawer-meter-dim">Resets Monday 00:00 UTC<\/span><\/span>/);
  // The hooks the declared checks aim at still resolve beside it.
  assert.match(html, /data-credits-remaining="1"/);
  assert.match(html, /id="ai-budget-slot"/);
  // The tooltip keeps the full sentence; the visible note stays short.
  assert.doesNotMatch(s.view.reset, /\.\s*$|UTC instant/);
});

test('a payload with no weekly window words the daily reset', async () => {
  const s = await publish(budget({ capWindow: 'none' }));
  assert.equal(s.view.reset, 'Resets at midnight UTC');
  assert.match(rowHtml(s), /drawer-meter-dim">Resets at midnight UTC/);
});

test('the reset note wraps as one part, the only place the row may break', async () => {
  const s = await publish(budget({ capWindow: 'weekly', resetLabel: 'Monday 00:00 UTC' }));
  const html = rowHtml(s);
  // A real space BEFORE the note's part, never inside it.
  assert.match(html, /<\/span> <span class="drawer-meter-part"><span class="drawer-meter-dim">· <\/span><span class="drawer-meter-dim">Resets /);
});

test('exhausted or not, the note is there; the special states carry none', async () => {
  // Exhausted is exactly when the reset time matters most.
  const out = await publish(budget({ spentCents: 2000, remainingCents: 0 }));
  assert.equal(out.view.reset, 'Resets at midnight UTC');
  // The locked and unavailable views publish no reset, and none renders.
  const locked = await publish(budget({
    limitCents: 0, remainingCents: 0, spentCents: 0, verificationRequired: true,
  }));
  assert.ok(!locked.view.reset);
  assert.doesNotMatch(rowHtml(locked), /Resets /);
  const unavailable = await publish(budget({ limitCents: 0, entitlementAvailable: false }));
  assert.ok(!unavailable.view.reset);
  assert.doesNotMatch(rowHtml(unavailable), /Resets /);
});

test('with ResetTime published, the note is worded in the viewer’s own clock', async () => {
  // The bundle publishes window.ResetTime (frontend/src/lib/reset-time.ts);
  // the sandbox above has none, which is what the fallback wordings pin.
  // Here the real module is published, so the note must read "Resets" plus
  // a weekday and a time in whatever clock this process has — a shape, not
  // a literal time, which is timezone-dependent.
  const rt = loadTsx('frontend/src/lib/reset-time.ts');
  const g = globalThis;
  g.window.ResetTime = rt.default;
  try {
    const s = await publish(budget({
      capWindow: 'weekly', resetsAt: '2026-10-12T00:00:00Z',
    }));
    assert.match(s.view.reset, /^Resets [A-Za-z]+ at \d{1,2}:\d{2}/);
    assert.doesNotMatch(s.view.reset, /UTC/, 'the viewer’s clock, not the server’s');
    assert.match(rowHtml(s), /drawer-meter-dim">Resets [A-Za-z]+ at \d{1,2}:\d{2}/);
  } finally {
    delete g.window.ResetTime;
  }
});
