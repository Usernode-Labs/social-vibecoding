'use strict';

// Task 2275: every model call says which call it is. A component name the
// telemetry did not list used to be recorded as `other_helper` without a
// word (llm-telemetry.js), which is how 21,010 Sonnet calls in thirty days,
// mostly the Workshop's themes and the tap-to-translate of people's own
// words, read as one anonymous line. Pinned here:
//   - an unlisted name is recorded as itself, flagged component_unknown;
//     only a missing or unreadable one becomes other_helper (flagged too);
//   - every component name written in src/ is a listed one;
//   - every llm.js call, driven end to end through a fake transport, is
//     recorded under a listed name that is not other_helper, on GLM and on
//     its second try alike;
//   - a streamChat caller that names no component is flagged.
//
// Run with: node --test tests/llm-call-components.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const llm = require('../src/services/llm');
const llmTelemetry = require('../src/services/llm-telemetry');

const ROOT = path.join(__dirname, '..');

test('an unlisted component is recorded as itself and flagged, never folded into other_helper', () => {
  const listed = llmTelemetry.normalizeEvent({ component: 'workshop_themes', provider: 'openrouter' });
  assert.equal(listed.component, 'workshop_themes');
  assert.equal('component_unknown' in listed, false);

  const unlisted = llmTelemetry.normalizeEvent({ component: 'brand_new_helper', provider: 'openrouter' });
  assert.equal(unlisted.component, 'brand_new_helper');
  assert.equal(unlisted.component_unknown, true);

  for (const unreadable of [undefined, null, '', 'Has Spaces', 'drop table;', 'x'.repeat(80), 7]) {
    const row = llmTelemetry.normalizeEvent({ component: unreadable });
    assert.equal(row.component, 'other_helper', String(unreadable));
    assert.equal(row.component_unknown, true, String(unreadable));
  }
});

// Component names in src/ that are not telemetry names, each with why.
const NOT_TELEMETRY = new Map([
  ['kept_plan', 'bot-configs.js: a cost-breakdown row (the plan carried from an earlier run), never a model call'],
]);

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'migrations' ? [] : sourceFiles(full);
    return /\.(js|ts)$/.test(entry.name) ? [full] : [];
  });
}

test('every component name written in src/ is one the telemetry lists', () => {
  const found = new Map();
  for (const file of sourceFiles(path.join(ROOT, 'src'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\b(?:telemetryComponent|component)\s*:\s*['"]([a-z0-9_]+)['"]/g)) {
      if (!found.has(m[1])) found.set(m[1], path.relative(ROOT, file));
    }
  }
  assert.ok(found.size > 30, 'the scan finds the call sites');
  const unlisted = [...found].filter(([name]) => !llmTelemetry.COMPONENTS.has(name) && !NOT_TELEMETRY.has(name));
  assert.deepEqual(unlisted, [], 'add each name to COMPONENTS in src/services/llm-telemetry.js');
  for (const name of NOT_TELEMETRY.keys()) assert.ok(found.has(name), `${name} is still written somewhere; else drop it from NOT_TELEMETRY`);
});

test('every translation call names its own component', () => {
  for (const file of sourceFiles(path.join(ROOT, 'src'))) {
    const text = fs.readFileSync(file, 'utf8');
    if (path.basename(file) === 'llm.js') continue;
    for (const m of text.matchAll(/translateCatalogDirect\(([^;]*?)\);/gs)) {
      assert.match(m[1], /component:/, `${path.relative(ROOT, file)}: translateCatalogDirect(${m[1].slice(0, 60)}) names no component`);
    }
  }
});

function fakeOpenRouter() {
  return {
    async streamChat() {
      const err = new Error('GLM is down');
      err.code = 'provider_error';
      throw err;
    },
  };
}

function fakeClient() {
  return {
    messages: {
      async create(params) {
        return {
          model: params.model, stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"title":"A title","summary":"A summary","description":"A description","answer":"An answer","score":2,"reason":"ok","verdict":"pass","category":"none","file":"","themes":[],"placements":[]}' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    },
  };
}

// Each llm.js call, with the least it takes to reach the provider.
const CALLS = {
  generatePrMetadata: () => llm.generatePrMetadata({ userRequest: 'Add a button', ccSummary: 'Added it', username: 'sam' }),
  generateSinceSummary: () => llm.generateSinceSummary({ changes: [{ title: 'A' }], total: 1, truncated: false, fromDate: '2026-11-01' }),
  translateCatalogDirect: () => llm.translateCatalogDirect([{ customId: 'es-0', params: { model: 'claude-sonnet-5-5', max_tokens: 50, messages: [{ role: 'user', content: 'hola' }] } }]),
  generateShortDescription: () => llm.generateShortDescription({ name: 'Plant club', brief: 'Water reminders' }),
  generateThreadTitle: () => llm.generateThreadTitle({ messages: [{ role: 'user', content: 'Can we add a map?' }] }),
  generateRequestSummary: () => llm.generateRequestSummary({ input: { title: 'Map', body: 'Add a map', comments: [] } }),
  generateRevisedDescription: () => llm.generateRevisedDescription({ previous: 'Old', title: 'Map', summary: 'A map', reply: 'Also pins', plan: '' }),
  generateChecksExplanation: () => llm.generateChecksExplanation({ input: { failing: [{ name: 'loads', output: 'boom' }] } }),
  generateAppSketch: () => llm.generateAppSketch({ system: 's', user: 'u', schema: { type: 'object' } }),
  inferAppCategory: () => llm.inferAppCategory({ system: 's', user: 'u', schema: { type: 'object' } }),
  generateFirstVersionPlan: () => llm.generateFirstVersionPlan({ system: 's', user: 'u', schema: { type: 'object' } }),
  generateFirstLook: () => llm.generateFirstLook({ system: 's', user: 'u', model: 'claude-sonnet-5-5' }),
  gradeChallengeUnit: () => llm.gradeChallengeUnit({ system: 's', user: 'u', schema: { type: 'object' } }),
  generateIssueTitle: () => llm.generateIssueTitle({ description: 'The map does not load' }),
  readChatAsk: () => llm.readChatAsk({ text: 'What changed today?' }),
  generateReportSummary: () => llm.generateReportSummary({ inputJson: '{}', appName: 'Plant club', knownUsernames: [] }),
  generateWorkshopThemeDefinitions: () => llm.generateWorkshopThemeDefinitions({ inputJson: '{}', appName: 'Plant club', itemKeys: [] }),
  placeWorkshopItems: () => llm.placeWorkshopItems({ themesJson: '[]', itemsJson: '[]', appName: 'Plant club', itemKeys: [], themeIds: [] }),
  generateWorkshopDigest: () => llm.generateWorkshopDigest({ inputJson: '{}', lastWeekJson: '[]', thisWeekJson: '[]', themesJson: '[]', appName: 'Plant club', windows: {} }),
  answerWorkshopQuestion: () => llm.answerWorkshopQuestion({ contextJson: '{}', question: 'What is next?', history: [] }),
  reviewContentRules: () => llm.reviewContentRules({ system: 's', diff: 'diff --git a/x b/x' }),
};

async function recorded(call) {
  const events = [];
  const prevDeps = llm._setHelperDepsForTests({ openrouter: fakeOpenRouter(), key: 'sk-or-platform', config: {} });
  const prevClient = llm._setClientForTests(fakeClient());
  const prevEnabled = llmTelemetry._setEnabledForTests(true);
  const prevSink = llmTelemetry._setSinkForTests((e) => { events.push(e); });
  try {
    try { await call(); } catch { /* a parse refusing '{}' still recorded the call */ }
  } finally {
    llm._setHelperDepsForTests(prevDeps);
    llm._setClientForTests(prevClient);
    llmTelemetry._setEnabledForTests(prevEnabled);
    llmTelemetry._setSinkForTests(prevSink);
  }
  return events;
}

test('every llm.js call is recorded under its own listed component, GLM and second try alike', async () => {
  const seen = new Map();
  for (const [name, call] of Object.entries(CALLS)) {
    const events = await recorded(call);
    assert.ok(events.length > 0, `${name} recorded nothing`);
    for (const e of events) {
      assert.ok(llmTelemetry.COMPONENTS.has(e.component), `${name}: ${e.component} is not listed`);
      assert.notEqual(e.component, 'other_helper', `${name} recorded as other_helper`);
      assert.equal(e.component_unknown, undefined, `${name} recorded flagged`);
      assert.equal(e.provider, 'openrouter', `${name}: every call goes to OpenRouter`);
    }
    seen.set(name, [...new Set(events.map((e) => e.component))]);
  }
  // The Workshop's three calls read on their own lines now.
  assert.deepEqual(seen.get('generateWorkshopThemeDefinitions'), ['workshop_themes']);
  assert.deepEqual(seen.get('placeWorkshopItems'), ['workshop_placement']);
  assert.deepEqual(seen.get('generateWorkshopDigest'), ['workshop_digest']);
});

test('a streamChat caller that names no component is recorded flagged, not as a quiet other_helper', async () => {
  const events = await recorded(() => llm.streamChat({ messages: [{ role: 'user', content: 'hi' }], systemPrompt: 's' }));
  assert.equal(events.length, 1);
  assert.equal(events[0].component, 'other_helper');
  assert.equal(events[0].component_unknown, true);
  const named = await recorded(() => llm.streamChat({
    messages: [{ role: 'user', content: 'hi' }], systemPrompt: 's',
    telemetryContext: { component: 'fleet_maintenance', backend: 'helper' },
  }));
  assert.equal(named[0].component, 'fleet_maintenance');
  assert.equal(named[0].component_unknown, undefined);
});
