'use strict';

// Homeroom bot → Calls (frontend/src/features/admin/admin-homeroom-bot-calls.tsx):
// the helper calls per helper and first model, read off the LLM telemetry
// (GET /api/admin/homeroom-bot/calls, llm-telemetry.js helperCallsReport,
// whose SQL tests/helper-calls-report-postgres.test.js runs). Pins the
// tab's wiring, its words and its numbers' formatting, and that the route
// is a read any admin may make.
//
// Run with: node --test tests/admin-homeroom-bot-calls.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const TSX = 'frontend/src/features/admin/admin-homeroom-bot-calls.tsx';

function loadCalls() {
  globalThis.window = globalThis.window || globalThis;
  const { loadTsx } = require('./lib/render-tsx');
  return loadTsx(TSX, {
    stubs: {
      './admin-console.js': {
        AdminUI: new Proxy({}, {
          get: (_t, key) => (['btn', 'badge'].includes(key) ? new Proxy({}, { get: (_u, k) => `${key}-${String(k)}` }) : String(key)),
        }),
      },
    },
  });
}

const PAYLOAD = {
  days: 7,
  helperModel: 'deepseek/deepseek-v4.1-flash-1017',
  totals: { calls: 1203, costUsd: 0.21 },
  helpers: [{
    component: 'quick_replies', calls: 1200, costUsd: 0.2, limitMs: 2500,
    models: [
      {
        model: 'deepseek/deepseek-v4.1-flash-1017', calls: 1000, firstOkRate: 0.996, lateRate: 0.003, fallbackRate: 0.004, unanswered: 0,
        firstMs: { p50: 600, p90: 900 }, totalMs: { p50: 610, p90: 950 }, avgCostUsd: 0.00009, costUsd: 0.09,
      },
      {
        model: 'z-ai/glm-5.3-flash', calls: 200, firstOkRate: 0.9, lateRate: 0.08, fallbackRate: 0.1, unanswered: 2,
        firstMs: { p50: 800, p90: 2500 }, totalMs: { p50: 820, p90: 3400 }, avgCostUsd: 0.0001, costUsd: 0.02,
      },
    ],
  }, {
    component: 'small_change', calls: 3, costUsd: 0.01, limitMs: null,
    models: [{ model: 'z-ai/glm-5.3-flash', calls: 3, firstOkRate: 1, lateRate: 0, fallbackRate: 0, unanswered: 0, firstMs: { p50: 12000, p90: 15000 }, totalMs: { p50: 12000, p90: 15000 }, avgCostUsd: 0.003, costUsd: 0.01 }],
  }],
};

test('the helper calls, per helper and the model asked first, in words', () => {
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const { HelperCallsView, seconds, percent, callCost, shortModel, helperLabel } = loadCalls();
  const html = renderToHtml(createElement(HelperCallsView, { payload: PAYLOAD, days: 7, onDays() {} }));
  assert.match(html, /id="admin-homeroom-bot-calls-table"/);
  assert.match(html, /1203 calls in the last 7 days, \$0\.21/);
  assert.match(html, /\(deepseek-v4\.1-flash-1017 now\)/);
  assert.match(html, /Quick replies/);
  assert.match(html, /Time limit 2\.5 s/);
  assert.match(html, /data-calls-model="z-ai\/glm-5\.3-flash"/, 'a switch of the helper model reads as a second row');
  assert.match(html, /2 not answered/);
  assert.match(html, /Small-change tag/);
  assert.match(html, /12 s \/ 15 s/);
  assert.match(html, /aria-pressed="true" class="btn-primarySm"[^>]*>Last 7 days</);
  const empty = renderToHtml(createElement(HelperCallsView, { payload: { ...PAYLOAD, helpers: [], totals: { calls: 0, costUsd: 0 } }, days: 1, onDays() {} }));
  assert.match(empty, /id="admin-homeroom-bot-calls-empty"/);
  assert.equal(seconds(600), '0.6 s');
  assert.equal(seconds(25000), '25 s');
  assert.equal(seconds(null), '');
  assert.equal(percent(0.996), '100%');
  assert.equal(percent(0.004), '<1%');
  assert.equal(percent(0), '0%');
  assert.equal(callCost(0.00009), '$0.000090');
  assert.equal(callCost(0.21), '$0.21');
  assert.equal(shortModel('z-ai/glm-5.3-flash'), 'glm-5.3-flash');
  assert.equal(shortModel('claude-haiku-5-5'), 'claude-haiku-5-5');
  assert.equal(helperLabel('first_version_plan'), 'Plan at Make it');
  assert.equal(helperLabel('some_new_helper'), 'some new helper');
});

test('the Calls tab is the section\'s, read from its first visit, through a read-only admin route', () => {
  const bot = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.match(bot, /import \{ HelperCalls \} from '\.\/admin-homeroom-bot-calls';/);
  assert.match(bot, /calls: '#admin\/homeroom-bot\/calls',/);
  assert.match(bot, /const TABS: readonly Tab\[\] = \['overview', 'configs', 'benchmark', 'settings', 'calls'\];/);
  assert.match(bot, /\{callsSeen \? <HelperCalls \/> : null\}/);
  const tsx = read(TSX);
  assert.match(tsx, /fetchJson\(`\/api\/admin\/homeroom-bot\/calls\?days=\$\{asked\}`\)/);
  assert.ok(!/from '@\/components\/ui\//.test(tsx), 'the console never reaches for the shell primitives');
  assert.ok(!/\b(gray|indigo)-\d/.test(tsx));
  assert.ok(!/—/.test(tsx), 'no em dashes');
  const admin = read('src/routes/admin.js');
  const at = admin.indexOf("router.get('/api/admin/homeroom-bot/calls'");
  assert.ok(at > 0);
  assert.doesNotMatch(admin.slice(at, admin.indexOf('\n', at)), /requireAdminWrite/, 'a read any admin may make, as the telemetry report is');
  assert.match(admin.slice(at, at + 900), /llmTelemetry\.helperCallsReport\(pool, \{ days \}\)/);
});
