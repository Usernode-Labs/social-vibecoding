'use strict';

// The Bot configurations admin section (frontend/src/features/admin/admin-bot-configs.tsx):
// registered everywhere the console reads, inside the registry rules; one row
// per active version, the current one first, retired ones folded away; the
// numbers in words (a win rate with its interval and n, what was left out);
// the role actions a full admin gets, never one that would leave no current
// version, each confirmed first; and the routes it reads and writes. The
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

test('the section is registered everywhere the console reads, inside the registry rules', () => {
  const consoleJs = read('frontend/src/features/admin/admin-console.js');
  const sectionBlock = consoleJs.slice(consoleJs.indexOf('SECTIONS: ['), consoleJs.indexOf('isOpen()'));
  assert.match(sectionBlock, /\{ key: 'bot-configs', label: 'Bot configurations', group: 'Platform' \}/);
  assert.match(consoleJs, /'bot-configs': 'AdminBotConfigs'/);
  assert.match(consoleJs, /'bot-configs': '<svg class="w-5 h-5 shrink-0"/, 'it has a nav icon');
  assert.ok(read('frontend/src/features/admin/sections.ts').includes("import './admin-bot-configs.tsx';"));

  const tsx = read(TSX);
  assert.match(tsx, /window as any\)\.AdminBotConfigs = AdminBotConfigs/);
  assert.match(tsx, /render\(el: Element\) \{\n\s+host = el;\n\s+mountLegacyPortal\(el, <BotConfigsSection \/>\);/);
  assert.match(tsx, /destroy\(\) \{\n\s+unmountLegacyPortal\(host\);/);
  assert.match(tsx, /import \{ AdminUI \} from '\.\/admin-console\.js';/);
  assert.ok(!/from '@\/components\/ui\//.test(tsx), 'the console never reaches for the shell primitives');
  assert.ok(!/\b(gray|indigo)-\d/.test(tsx), 'the platform palette only');
  assert.ok(!/—/.test(tsx), 'no em dashes');
  assert.ok(!/target="_blank"/.test(tsx), 'nothing in the console opens a new tab');
  assert.match(tsx, /fetchJson\('\/api\/admin\/homeroom-bot\/configs'\)/);
  assert.match(tsx, /fetch\(`\/api\/admin\/homeroom-bot\/configs\/\$\{Number\(v\.id\)\}\/role`/);
  assert.match(tsx, /_confirm\(confirmCopy\(v, role, current\)\)/, 'every role change is confirmed first');

  const audit = read('scripts/audit-react-ownership.mjs');
  assert.match(audit, /\{ sel: '#admin-section-content', when: '#admin\/bot-configs' \}/);
  assert.match(audit, /'#admin\/bot-configs'/, 'and the audit visits the route');
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
  assert.match(html, /Recipes are saved and pairs are picked\s+through the connector\./);

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
});

test('the routes behind it: any admin reads, a full admin changes a role; the connector\'s doors are full-admin gated first', () => {
  const src = read('src/routes/bot-configs.js');
  assert.match(src, /router\.use\(CONSOLE, adminMiddleware\);/);
  assert.match(src, /router\.get\('\/api\/admin\/homeroom-bot\/configs', handler\(/);
  assert.match(src, /router\.post\('\/api\/admin\/homeroom-bot\/configs\/:id\/role', requireAdminWrite, handler\(/);
  const doors = [...src.matchAll(/router\.(get|post)\('(\/api\/bot-configs[^']*)', ([a-zA-Z]+)/g)];
  assert.equal(doors.length, 5);
  for (const [, method, route, gate] of doors) assert.equal(gate, 'requireAdminWrite', `${method} ${route} is full-admin gated first`);
  const writes = [...src.matchAll(/router\.post\('(\/api\/bot-configs[^']*)', ([^(]+)handler\(/g)];
  assert.equal(writes.length, 3);
  for (const [, route, chain] of writes) {
    assert.match(chain, /requireAdminWrite, benchStudioLimiter, sameOriginBrowserOnly,/, `${route} is limited, then guarded`);
  }
  const policy = require('../src/services/cli-api-policy');
  for (const [m, target] of [
    ['GET', '/api/bot-configs'], ['POST', '/api/bot-configs'], ['POST', '/api/bot-configs/3/role'],
    ['GET', '/api/bot-configs/pairs/next'], ['POST', '/api/bot-configs/pairs/abcdEFGH1234/pick'],
  ]) assert.equal(policy.isConnectorApiRequest(m, target), true, `${m} ${target}`);
  for (const [m, target] of [
    ['DELETE', '/api/bot-configs/3'], ['GET', '/api/bot-configs/3'], ['GET', '/api/bot-configs/pairs/abc/pick'],
    ['GET', '/api/admin/homeroom-bot/configs'], ['POST', '/api/admin/homeroom-bot/configs/3/role'],
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
