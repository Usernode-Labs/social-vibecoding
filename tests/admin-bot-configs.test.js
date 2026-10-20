'use strict';

// The Bot configurations admin section (frontend/src/features/admin/admin-bot-configs.tsx):
// registered everywhere the console reads, inside the registry rules; one row
// per active version, the current one first, retired ones folded away; the
// numbers in words (a win rate with its interval and n, what was left out);
// the role actions a full admin gets, never one that would leave no current
// version, each confirmed first; the scope switch (First versions, Later
// changes) and each scope's side-build budget, which a full admin sets; and
// the routes it reads and writes. The
// declared-check manifest is on its floor, so the screen is pinned from source
// and an executed render here rather than a dapp.json slot.
//
// Run with: node --test tests/admin-bot-configs.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const TSX = 'frontend/src/features/admin/admin-bot-configs.tsx';

function loadSection() {
  globalThis.window = globalThis.window || globalThis;
  const { loadTsx } = require('./lib/render-tsx');
  return loadTsx(TSX, {
    stubs: {
      './admin-console.js': {
        AdminUI: new Proxy({}, {
          get: (_t, key) => (['btn', 'badge'].includes(key) ? new Proxy({}, { get: (_u, k) => `${key}-${String(k)}` }) : String(key)),
        }),
      },
      '../../lib/legacy-portals': { mountLegacyPortal() {}, unmountLegacyPortal() {} },
    },
  });
}

const OPUS = 'anthropic/claude-opus-5.5';
const GLM = 'z-ai/glm-5.3-flash';
const version = (id, key, role, extra = {}) => ({
  id, key, label: { 'opus-spec-review': 'Opus spec, GLM build, Opus review', 'all-glm': 'All GLM', 'opus-spec-no-review': 'Opus spec + GLM, no reviewer', old: 'Old idea' }[key],
  version: 1, role,
  recipe: { models: { triage: GLM, spec: key === 'all-glm' ? GLM : OPUS, build: GLM }, reviewer: role === 'current' ? { model: OPUS, maxRounds: 3, budgetMinutes: 25 } : null, pack: null },
  recipeLine: `${key} recipe line`, notes: null, createdAt: '2026-10-07T10:00:00Z',
  stats: { builds: 0, built: 0, avgCostUsd: null, medianActiveMs: null, bootRate: null, pairsWaiting: 0, vsCurrent: null },
  ...extra,
});

const PAYLOAD = {
  currentId: 1,
  pairsWaiting: 3,
  sideBuilds: { limitUsd: 25, spentUsd: 4.2, pendingUsd: 0.8, leftUsd: 20, skipped: 1 },
  versions: [
    version(1, 'opus-spec-review', 'current', { stats: { builds: 12, built: 12, avgCostUsd: 2.051, medianActiveMs: 37 * 60000, bootRate: 1, pairsWaiting: 3, vsCurrent: null } }),
    version(2, 'all-glm', 'side', {
      stats: {
        builds: 11, built: 10, avgCostUsd: 0.402, medianActiveMs: 21 * 60000, bootRate: 0.9, pairsWaiting: 1,
        vsCurrent: { against: 1, wins: 2, ties: 1, losses: 6, rate: 2.5 / 9, low: 0.09, high: 0.6, n: 9, excluded: 2, didntBoot: 1, didntBuild: 1, waiting: 1 },
      },
    }),
    version(3, 'opus-spec-no-review', 'side', {
      stats: {
        builds: 12, built: 12, avgCostUsd: 1.03, medianActiveMs: 24 * 60000, bootRate: 1, pairsWaiting: 2,
        vsCurrent: { against: 1, wins: 4, ties: 2, losses: 4, rate: 0.5, low: 0.24, high: 0.76, n: 10, excluded: 0, didntBoot: 0, didntBuild: 0, waiting: 2 },
      },
    }),
    version(4, 'old', 'retired'),
  ],
};

function render(props) {
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const { BotConfigsView } = loadSection();
  return renderToHtml(createElement(BotConfigsView, { canWrite: true, onRole() {}, onToggleRetired() {}, ...props }));
}

test('it is the Homeroom bot\'s Configurations tab, and its old address opens that tab', () => {
  const consoleJs = read('frontend/src/features/admin/admin-console.js');
  const sectionBlock = consoleJs.slice(consoleJs.indexOf('SECTIONS: ['), consoleJs.indexOf('isOpen()'));
  assert.doesNotMatch(sectionBlock, /key: 'bot-configs'/, 'no longer a section of its own');
  assert.doesNotMatch(consoleJs, /'bot-configs': 'AdminBotConfigs'/);
  assert.match(consoleJs, /LEGACY_SECTION_KEYS: \{[\s\S]*?'bot-configs': 'homeroom-bot',/, 'the retired key resolves to the bot\'s section');
  assert.ok(!read('frontend/src/features/admin/sections.ts').includes("import './admin-bot-configs.tsx';"),
    'loaded with the Homeroom bot section, which imports it');
  assert.match(read('public/js/app.js'), /if \(_adminSection === 'bot-configs'\) \{\n\s+_adminSection = 'homeroom-bot';\n\s+try \{\n\s+history\.replaceState\(null, '', '#admin\/homeroom-bot\/configs'\);/,
    'a bookmark to #admin/bot-configs lands on the Configurations tab');
  const bot = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.match(bot, /import \{ BotConfigsSection \} from '\.\/admin-bot-configs';/);
  assert.match(bot, /configs: '#admin\/homeroom-bot\/configs',/);
  assert.match(bot, /\{configsSeen \? <BotConfigsSection onOpenBenchmark=\{\(\) => showTab\('benchmark'\)\} asked=\{configAsk\} \/> : null\}/);

  const tsx = read(TSX);
  assert.match(tsx, /export \{ BotConfigsSection \};/);
  assert.doesNotMatch(tsx, /AdminBotConfigs/, 'no section module of its own any more');
  assert.match(tsx, /import \{ AdminUI \} from '\.\/admin-console\.js';/);
  assert.ok(!/from '@\/components\/ui\//.test(tsx), 'the console never reaches for the shell primitives');
  assert.ok(!/\b(gray|indigo)-\d/.test(tsx), 'the platform palette only');
  assert.ok(!/—/.test(tsx), 'no em dashes');
  assert.ok(!/target="_blank"/.test(tsx), 'nothing in the console opens a new tab');
  assert.match(tsx, /fetchJson\(`\/api\/admin\/homeroom-bot\/configs\?scope=\$\{asked\}`\)/, 'one scope at a time');
  assert.match(tsx, /fetch\(`\/api\/admin\/homeroom-bot\/configs\/\$\{Number\(v\.id\)\}\/role`/);
  assert.match(tsx, /body: JSON\.stringify\(\{ role, scope \}\)/, 'a role change names its scope');
  assert.match(tsx, /fetch\('\/api\/admin\/homeroom-bot\/configs\/budget'/);
  assert.match(tsx, /body: JSON\.stringify\(\{ scope, weeklyUsd \}\)/);
  assert.match(tsx, /_confirm\(confirmCopy\(v, role, current\)\)/, 'every role change is confirmed first');

  // A side version is saved from the console, only ever as a side version.
  assert.match(tsx, /fetch\('\/api\/admin\/homeroom-bot\/configs', \{/);
  assert.match(tsx, /body: JSON\.stringify\(\{ label: draft\.label\.trim\(\), scope: draft\.scope, recipe, role: 'side' \}\)/);

  const audit = read('scripts/audit-react-ownership.mjs');
  assert.doesNotMatch(audit, /when: '#admin\/bot-configs'/, 'the host is the Homeroom bot section\'s');
  assert.match(audit, /'#admin\/homeroom-bot\/configs', '#admin\/homeroom-bot\/calls'/, 'and the audit visits the tabs');
});

test('one row per active version, the current one first; its numbers in words', () => {
  const html = render({ payload: PAYLOAD });
  assert.match(html, /id="admin-bot-configs-table"/);
  const rows = [...html.matchAll(/data-bot-config="(\d+)" data-role="(\w+)"/g)].map((m) => [Number(m[1]), m[2]]);
  assert.deepEqual(rows, [[1, 'current'], [2, 'side'], [3, 'side']], 'retired versions are folded away');
  assert.match(html, /Opus spec, GLM build, Opus review/);
  assert.match(html, /opus-spec-review<\/span> v1/);
  assert.match(html, /badge-secondary">Current/);
  assert.match(html, /all-glm recipe line/);
  assert.match(html, /\$2\.05/);
  assert.match(html, /37 min/);
  assert.match(html, /The baseline/, 'the current one is what the others are measured against');
  assert.match(html, /28% \(9 to 60%\), n 9/, 'a win rate with its interval and n');
  assert.match(html, /1 didn&#x27;t build, 1 didn&#x27;t boot|1 didn't build, 1 didn't boot/);
  assert.match(html, /50% \(24 to 76%\), n 10/);
  assert.match(html, /3 pairs waiting for a pick/);
  assert.match(html, /Side builds in the last 7 days: \$4\.20 of \$25\.00 spent, about \$0\.80 more under way\. 1 side build was skipped/);
  assert.match(html, /Show 1 retired version/);
  assert.match(html, /never shown to the person/);
  assert.match(html, /Pairs are picked through the connector\./);
  assert.match(html, /<th class="th">Benchmark<\/th>/);
  assert.match(html, /data-bot-config-bench="2"><span class="muted">Not run<\/span>/);

  const all = render({ payload: PAYLOAD, showRetired: true });
  assert.equal((all.match(/data-bot-config="/g) || []).length, 4);
  assert.match(all, /Hide retired versions/);
});

test('a full admin gets the role actions, never one that leaves no current version; a viewer gets none', () => {
  const { actionsFor } = loadSection();
  assert.deepEqual(actionsFor('current'), []);
  assert.deepEqual(actionsFor('side').map((a) => a.role), ['current', 'retired']);
  assert.deepEqual(actionsFor('retired').map((a) => a.role), ['current', 'side']);
  const html = render({ payload: PAYLOAD, showRetired: true });
  assert.match(html, /Builds every first version/);
  assert.equal((html.match(/data-bot-config-action="current"/g) || []).length, 3);
  assert.equal((html.match(/data-bot-config-action="retired"/g) || []).length, 2);
  assert.equal((html.match(/data-bot-config-action="side"/g) || []).length, 1);
  const viewer = render({ payload: PAYLOAD, canWrite: false });
  assert.ok(!/data-bot-config-action=/.test(viewer), 'a view-only admin reads, and changes nothing');
  const busy = render({ payload: PAYLOAD, busy: true });
  assert.match(busy, /data-bot-config-action="current"[^>]*disabled=""|disabled=""[^>]*data-bot-config-action="current"/);
});

test('each role change says what it does before it does it', () => {
  const { confirmCopy } = loadSection();
  const [cur, glm] = PAYLOAD.versions;
  const promote = confirmCopy(glm, 'current', cur);
  assert.equal(promote.title, 'Build first versions with All GLM v1?');
  assert.match(promote.message, /Every new project's first version will be built with it \(all-glm recipe line\)\. Opus spec, GLM build, Opus review v1 becomes a side configuration\./);
  assert.match(confirmCopy(glm, 'retired', cur).message, /Its numbers are kept\./);
  assert.match(confirmCopy(PAYLOAD.versions[3], 'side', cur).message, /within the side builds' weekly budget/);
});

test('the scope switch: First versions or Later changes, each with its own words, budget and proposals', () => {
  const first = render({ payload: PAYLOAD });
  assert.match(first, /id="admin-bot-configs-scope"/);
  assert.match(first, /aria-pressed="true"[^>]*data-bot-config-scope="first_version"|data-bot-config-scope="first_version"[^>]*aria-pressed="true"/);
  assert.match(first, /btn-primarySm"[^>]*>First versions<|First versions</);
  assert.match(first, /aria-pressed="false"[^>]*data-bot-config-scope="later"/);
  assert.match(first, /Builds every first version/);

  const later = {
    scope: 'later', currentId: 21, pairsWaiting: 1,
    sideBuilds: { limitUsd: 50, spentUsd: 50, pendingUsd: 0, leftUsd: 0, skipped: 2, paused: true },
    versions: [
      version(21, 'opus-spec-review', 'current', {
        key: 'later-opus-spec', label: 'Opus spec + GLM build', scope: 'later',
        stats: {
          builds: 8, built: 7, buildRate: 0.875, avgCostUsd: 1.4, medianActiveMs: 18 * 60000, bootRate: null, pairsWaiting: 1, vsCurrent: null,
          proposals: { merged: 3, closed: 1, open: 2, none: 1 },
        },
      }),
      version(22, 'all-glm', 'side', { key: 'later-all-glm', scope: 'later' }),
    ],
  };
  const html = render({ payload: later, scope: 'later' });
  assert.match(html, /aria-pressed="true"[^>]*data-bot-config-scope="later"|data-bot-config-scope="later"[^>]*aria-pressed="true"/);
  assert.match(html, /How the Homeroom bot handles every request that is not a first version: the current configuration decides\s+its triage, its plan, its build and its follow-ups/);
  assert.match(html, /pairs compare the two sides(&#x27;|')\s+plans and diffs/);
  assert.match(html, /Builds every later change/);
  assert.match(html, /88% built/);
  assert.match(html, /Proposals: 3 merged, 1 closed, 2 open, 1 not proposed/);
  assert.match(html, /Side builds in the last 7 days: \$50\.00 of \$50\.00 spent\. 2 side builds were skipped for the budget, a missing snapshot, a platform failure or a build given up or the platform(&#x27;|')s own repository\. Paused: the week(&#x27;|')s budget is spent/);

  // A full admin sets the scope's weekly budget; a view-only admin reads it.
  const editable = render({ payload: later, scope: 'later', onBudget() {} });
  assert.match(editable, /id="admin-bot-configs-budget-form"/);
  assert.match(editable, /id="admin-bot-configs-budget-input"[^>]*value="50"|value="50"[^>]*id="admin-bot-configs-budget-input"/);
  assert.ok(!/admin-bot-configs-budget-form/.test(render({ payload: later, scope: 'later', canWrite: false, onBudget() {} })));
  assert.ok(!/admin-bot-configs-budget-form/.test(render({ payload: later, scope: 'later' })), 'only with somewhere to send it');

  const { confirmCopy, proposalsText } = loadSection();
  const promote = confirmCopy(later.versions[1], 'current', later.versions[0]);
  assert.equal(promote.title, 'Build later changes with All GLM v1?');
  assert.match(promote.message, /^Every later change, live or shadow, will be built with it/);
  assert.match(confirmCopy(later.versions[1], 'side', null).message, /beside every later change, within the later changes' side builds' weekly budget/);
  assert.match(confirmCopy(later.versions[1], 'retired', null).message, /stops being built beside later changes/);
  assert.equal(proposalsText(undefined), '');
  assert.equal(proposalsText({ merged: 0, closed: 0, open: 0, none: 0 }), '');
});

test('loading, empty and error states', () => {
  assert.match(render({ payload: null }), /Loading…/);
  const empty = render({ payload: { ...PAYLOAD, versions: [], sideBuilds: null, pairsWaiting: 0 } });
  assert.match(empty, /id="admin-bot-configs-empty"/);
  assert.match(empty, /0 pairs waiting for a pick/);
  assert.match(render({ payload: PAYLOAD, error: 'Could not load the configurations.' }), /role="alert">Could not load the configurations\./);
  const { minutes, usd, winRateText } = loadSection();
  assert.equal(minutes(95 * 60000), '1 h 35 min');
  assert.equal(minutes(10_000), 'under a minute');
  assert.equal(usd(0.004), '<$0.01');
  assert.equal(winRateText(null, 'side'), 'No picks yet');
  assert.equal(winRateText({ n: 0 }, 'side'), 'No picks yet');
  // What was left out, each kind in its own words: a side with nothing
  // captured is not one that failed to boot, and an identical pair (the
  // review changed nothing) is never a tie.
  const { leftOutText } = loadSection();
  assert.equal(leftOutText({ didntBuild: 1, didntBoot: 2, noScreenshots: 1, identical: 3 }),
    '1 didn\'t build, 2 didn\'t boot, 1 without screenshots, 3 identical (the review changed nothing)');
  assert.equal(leftOutText({ didntBuild: 0, didntBoot: 0 }), '');
});

test('the routes behind it: any admin reads, a full admin changes a role; the connector\'s doors are full-admin gated first', () => {
  const src = read('src/routes/bot-configs.js');
  assert.match(src, /router\.use\(CONSOLE, adminMiddleware\);/);
  assert.match(src, /router\.get\('\/api\/admin\/homeroom-bot\/configs', handler\(/);
  assert.match(src, /router\.post\('\/api\/admin\/homeroom-bot\/configs\/:id\/role', requireAdminWrite, handler\(/);
  assert.match(src, /router\.post\('\/api\/admin\/homeroom-bot\/configs\/budget', requireAdminWrite, handler\(/);
  const doors = [...src.matchAll(/router\.(get|post)\('(\/api\/bot-configs[^']*)', ([a-zA-Z]+)/g)];
  assert.equal(doors.length, 6);
  for (const [, method, route, gate] of doors) assert.equal(gate, 'requireAdminWrite', `${method} ${route} is full-admin gated first`);
  const writes = [...src.matchAll(/router\.post\('(\/api\/bot-configs[^']*)', ([^(]+)handler\(/g)];
  assert.equal(writes.length, 4);
  for (const [, route, chain] of writes) {
    assert.match(chain, /requireAdminWrite, benchStudioLimiter, sameOriginBrowserOnly,/, `${route} is limited, then guarded`);
  }
  const policy = require('../src/services/cli-api-policy');
  for (const [m, target] of [
    ['GET', '/api/bot-configs'], ['POST', '/api/bot-configs'], ['POST', '/api/bot-configs/3/role'],
    ['POST', '/api/bot-configs/budget'],
    ['GET', '/api/bot-configs/pairs/next'], ['POST', '/api/bot-configs/pairs/abcdEFGH1234/pick'],
  ]) assert.equal(policy.isConnectorApiRequest(m, target), true, `${m} ${target}`);
  for (const [m, target] of [
    ['DELETE', '/api/bot-configs/3'], ['GET', '/api/bot-configs/3'], ['GET', '/api/bot-configs/pairs/abc/pick'],
    ['GET', '/api/bot-configs/budget'],
    ['GET', '/api/admin/homeroom-bot/configs'], ['POST', '/api/admin/homeroom-bot/configs/3/role'],
    ['POST', '/api/admin/homeroom-bot/configs/budget'],
  ]) assert.equal(policy.isConnectorApiRequest(m, target), false, `${m} ${target} is refused`);
  assert.match(read('server.js'), /app\.use\(require\('\.\/src\/routes\/bot-configs'\)\.botConfigRoutes\(config\)\);/);
});

test('staging seeds a few obviously fake first versions with every configuration\'s result and their pairs', () => {
  const migrate = read('src/db/migrate.js');
  const seed = migrate.indexOf("require('../services/bot-configs').seedConfigs(pool)");
  const demo = migrate.indexOf("require('../services/bot-configs').seedStagingBotConfigs(pool)");
  assert.ok(seed > 0 && demo > seed, 'the configurations exist before their staging demo');
  const src = read('src/services/bot-configs.js');
  const fn = src.slice(src.indexOf('async function seedStagingBotConfigs'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /process\.env\.USERNODE_ENV !== 'staging'\) return false;/);
  assert.match(body, /'Staging demo: a first version for the configurations table'/);
  assert.match(body, /ON CONFLICT \(current_result_id, side_result_id\) DO NOTHING/);
});

// ── A new side version, and a comparison on the benchmark ───────────────

const FV = {
  id: 16, key: 'fv', label: 'First versions', version: 2, role: 'current', scope: 'first_version',
  recipe: {
    models: { triage: 'deepseek/deepseek-v4.1-flash-1017', spec: 'anthropic/claude-opus-5.5', build: 'deepseek/deepseek-v4.1-flash-1017' },
    reviewer: { model: 'anthropic/claude-opus-5.5', maxRounds: 2, budgetMinutes: 20 }, pack: null, tweaks: ['lean_plan'],
  },
  recipeLine: '', notes: null, createdAt: null,
  stats: { builds: 0, built: 0, avgCostUsd: null, medianActiveMs: null, bootRate: null, pairsWaiting: 0, vsCurrent: null },
};
const LATER = {
  ...FV, id: 14, key: 'later', label: 'Later', version: 1, scope: 'later',
  recipe: {
    models: { triage: 'deepseek/deepseek-v4.1-flash-1017', spec: 'anthropic/claude-opus-5.5', build: 'deepseek/deepseek-v4.1-flash-1017', followup: 'deepseek/deepseek-v4.1-flash-1017' },
    reviewer: null, pack: null,
  },
};

test('a draft copies a version, a stage\'s model swapped in where asked, and saves a recipe in its one shape', () => {
  const { draftFrom, recipeOfDraft, stagesOf } = loadSection();
  assert.deepEqual(stagesOf('first_version').map((s) => s.key), ['triage', 'spec', 'build'], 'a first version has no follow-ups');
  assert.deepEqual(stagesOf('later').map((s) => s.key), ['triage', 'spec', 'build', 'followup']);
  const copy = draftFrom(FV);
  assert.equal(copy.label, 'First versions (copy)');
  assert.equal(copy.scope, 'first_version');
  assert.deepEqual(copy.base, { reviewer: FV.recipe.reviewer, pack: null, tweaks: ['lean_plan'] }, 'its review, pack and tweaks kept');
  const max = { ...copy, effort: { ...copy.effort, build: 'max' }, clocks: { ...copy.clocks, build: '45' } };
  assert.deepEqual(recipeOfDraft(max), {
    recipe: { models: FV.recipe.models, reviewer: FV.recipe.reviewer, pack: null, tweaks: ['lean_plan'], effort: { build: 'max' }, clocks: { build: 45 } },
    error: null,
  }, 'a max-effort build of today\'s first versions');
  assert.deepEqual(recipeOfDraft(copy).recipe, { models: FV.recipe.models, reviewer: FV.recipe.reviewer, pack: null, tweaks: ['lean_plan'] },
    'nothing named, nothing added');
  assert.match(recipeOfDraft({ ...copy, clocks: { ...copy.clocks, spec: '0' } }).error, /^Plan: a clock is a whole number of minutes from 1 to 180/);
  assert.match(recipeOfDraft({ ...copy, models: { ...copy.models, build: '' } }).error, /^Build: name a model/);
  assert.match(recipeOfDraft({ ...copy, label: ' ' }).error, /name/);

  const asked = draftFrom(LATER, { stage: 'build', model: 'z-ai/glm-5.3-flash' });
  assert.equal(asked.models.build, 'z-ai/glm-5.3-flash', 'the Benchmark\'s Use for: that stage on that model');
  assert.equal(asked.label, 'Later, build on glm-5.3-flash');
  assert.equal(recipeOfDraft(asked).recipe.models.followup, 'deepseek/deepseek-v4.1-flash-1017');
  assert.equal(draftFrom(FV, { stage: 'followup', model: 'a/b' }).models.followup, '', 'a first version takes no follow-up model');
});

test('the draft form names every stage the scope decides, with effort and clock, and saves as a side version', () => {
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const { draftFrom, DraftForm } = loadSection();
  const html = renderToHtml(createElement(DraftForm, { draft: draftFrom(LATER), busy: false, onChange() {}, onSave() {}, onCancel() {} }));
  assert.match(html, /id="admin-bot-configs-draft"/);
  for (const st of ['triage', 'spec', 'build', 'followup']) assert.match(html, new RegExp(`data-draft-stage="${st}"`));
  assert.match(html, /<option value="max">max<\/option>/);
  assert.match(html, /Effort max reaches Claude Code turns only/);
  assert.match(html, /id="admin-bot-configs-draft-save"[^>]*>Save as a side version</);
  const first = renderToHtml(createElement(DraftForm, { draft: draftFrom(FV), busy: false, onChange() {}, onSave() {}, onCancel() {} }));
  assert.doesNotMatch(first, /data-draft-stage="followup"/);
  assert.match(first, /Kept as they are: review claude-opus-5\.5 ×2 in 20 min · tweaks lean_plan/);
});

test('compare on the benchmark: a first version in the studio beside the current one; a later change at the stages it differs', () => {
  const { benchRequestFor, benchText } = loadSection();
  const side = { ...FV, id: 20, role: 'side' };
  assert.deepEqual(benchRequestFor(side, FV), { view: 'studio', models: 'config:20, config:16' });
  const laterSide = { ...LATER, id: 21, role: 'side', recipe: { ...LATER.recipe, models: { ...LATER.recipe.models, build: 'z-ai/glm-5.3-flash' } } };
  assert.deepEqual(benchRequestFor(laterSide, LATER), {
    view: 'launch', preset: { stages: ['build'], models: ['z-ai/glm-5.3-flash', 'deepseek/deepseek-v4.1-flash-1017'] },
  });
  const effortOnly = { ...LATER, id: 22, role: 'side', recipe: { ...LATER.recipe, effort: { build: 'max' } } };
  assert.equal(benchRequestFor(effortOnly, LATER), null, 'the benchmark compares models; effort alone is for the blind pairs');
  assert.equal(benchText(null), '');
  assert.equal(benchText({ runs: 2, trials: 10, ok: 9, avgCostUsd: 1.1, medianMs: 18 * 60000, lastRunId: 245 }), '2 runs: 9 of 10 built, $1.10, 18 min');
});

test('a side version saved from the console is only ever a side version, behind the write gate', () => {
  const routes = read('src/routes/bot-configs.js');
  const at = routes.indexOf("router.post('/api/admin/homeroom-bot/configs', requireAdminWrite,");
  assert.ok(at > 0, 'a full admin\'s write');
  const body = routes.slice(at, routes.indexOf('}));', at));
  assert.match(body, /if \(b\.role != null && b\.role !== 'side'\) return bad\(/);
  assert.match(body, /role: 'side',/);
});
