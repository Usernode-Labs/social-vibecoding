'use strict';

// The Small changes admin section (frontend/src/features/admin/admin-small-changes.tsx),
// where the watch-only small-change tag is read. Pins that the section is
// registered everywhere the console reads, that it renders a payload of
// every verdict in plain words, that it has words for every verdict and
// veto the service can store, and that staging has rows for it to show.
// The declared-check manifest is on its 20-slot floor, so the screen is
// pinned from source and an executed render here rather than a dapp.json slot.
//
// Run with: node --test tests/admin-small-changes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const smallChange = require('../src/services/small-change');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const TSX = 'frontend/src/features/admin/admin-small-changes.tsx';

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

const tag = (id, verdict, extra = {}) => ({
  id, sessionId: 600 + id, app: { slug: 'plant-pal', name: 'Plant Pal' }, prNumber: 40 + id,
  title: `Change ${id}`, headSha: `${id}`.repeat(40).slice(0, 40), verdict, kind: null, reason: null,
  vetoes: [], filesChanged: 2, linesChanged: 10, model: 'z-ai/glm-5.3-flash', costUsd: 0.0004,
  durationMs: 1500, error: null, createdAt: '2026-10-05T10:00:00Z', ...extra,
});

const PAYLOAD = {
  mode: 'on',
  model: 'z-ai/glm-5.3-flash',
  limits: { maxFiles: 6, maxLines: 150 },
  lastWeek: { small: 2, not_small: 1, vetoed: 3, unavailable: 0, costUsd: 0.0123, vetoes: { too_large: 2, dependencies: 1 } },
  tags: [
    tag(1, 'small', { kind: 'fix', reason: 'Fixes the watering date.' }),
    tag(2, 'not_small', { reason: 'Removes the leaderboard.' }),
    tag(3, 'vetoed', { vetoes: ['schema_or_data_sql', 'too_large'], costUsd: null }),
    tag(4, 'unavailable', { error: 'no_key', costUsd: null }),
  ],
};

function render(props) {
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const { SmallChangesView } = loadSection();
  return renderToHtml(createElement(SmallChangesView, { verdict: '', onVerdict() {}, ...props }));
}

test('the section is registered everywhere the console reads, inside the registry rules', () => {
  const consoleJs = read('frontend/src/features/admin/admin-console.js');
  const sectionBlock = consoleJs.slice(consoleJs.indexOf('SECTIONS: ['), consoleJs.indexOf('isOpen()'));
  assert.match(sectionBlock, /\{ key: 'small-changes', label: 'Small changes', group: 'Platform' \}/);
  assert.match(consoleJs, /'small-changes': 'AdminSmallChanges'/);
  assert.match(consoleJs, /'small-changes': '<svg class="w-5 h-5 shrink-0"/, 'it has a nav icon');
  assert.ok(read('frontend/src/features/admin/sections.ts').includes("import './admin-small-changes.tsx';"));

  const tsx = read(TSX);
  assert.match(tsx, /window as any\)\.AdminSmallChanges = AdminSmallChanges/);
  assert.ok(!/from '@\/components\/ui\//.test(tsx), 'the console never reaches for the shell primitives');
  assert.ok(!/target="_blank"/.test(tsx), 'nothing in the console opens a new tab');
  assert.match(tsx, /fetchJson\(`\/api\/admin\/small-change-tags\?limit=\$\{LIMIT\}`\)/);
  assert.ok(!/method: '(POST|PUT|DELETE)'/.test(tsx), 'read only: the screen writes nothing');

  const audit = read('scripts/audit-react-ownership.mjs');
  assert.match(audit, /\{ sel: '#admin-section-content', when: '#admin\/small-changes' \}/);
  assert.match(audit, /'#admin\/small-changes'/, 'and the audit visits the route');
});

test('every verdict and veto the service can store has words on the screen', () => {
  const { VERDICT_LABEL, VETO_LABEL, KIND_LABEL } = loadSection();
  assert.deepEqual(Object.keys(VERDICT_LABEL).sort(), [...smallChange.VERDICTS].sort());
  assert.deepEqual(Object.keys(VETO_LABEL), [...smallChange.VETOES]);
  assert.deepEqual(Object.keys(KIND_LABEL).sort(), [...smallChange.KINDS].sort());
});

test('a payload of every verdict renders its rows, its reasons in words, and the week', () => {
  const html = render({ payload: PAYLOAD });
  assert.match(html, /id="admin-small-changes-table"/);
  assert.equal((html.match(/data-small-change-tag="/g) || []).length, 4);
  assert.match(html, /data-verdict="small"[\s\S]*?Small[\s\S]*?fix[\s\S]*?Fixes the watering date\./);
  assert.match(html, /Removes the leaderboard\./);
  assert.match(html, /SQL that changes a schema or writes data, too large/, 'vetoes read as words, in order');
  assert.match(html, /no OpenRouter key for the bot/, 'an undecided head says why');
  assert.match(html, /Last 7 days: 2 small, 1 not small, 3 ruled out, \$0\.01 in model calls\./);
  assert.match(html, /Ruled out this week for: too large \(2\), changes dependencies \(1\)\./);
  assert.match(html, /Nothing about votes, merges, checks or cards reads these tags\./);
  assert.match(html, /6 files or 150 changed lines/);
  // The link is built from the row's own slug and session id.
  assert.match(html, /href="#app\/plant-pal\/dev\/changes\/41"/); // #4367: by its PR number
  assert.match(html, /#41 Change 1/);
  assert.match(html, /&lt;\$0\.01/, 'a fraction of a cent reads as under a cent');
  assert.match(html, /2 files, 10 lines/);
  const one = render({ payload: { ...PAYLOAD, tags: [tag(1, 'small', { kind: 'fix', filesChanged: 1, linesChanged: 1 })] } });
  assert.match(one, /· 1 file, 1 line ·/, 'one of each is singular');
  assert.ok(!/admin-small-changes-off/.test(html), 'no off note while the tagger is on');
});

test('the filter shows one verdict, and empty states say what is missing', () => {
  const small = render({ payload: PAYLOAD, verdict: 'small' });
  assert.equal((small.match(/data-small-change-tag="/g) || []).length, 1);
  assert.match(small, /<option value="small" selected="">Small<\/option>/);

  const none = render({ payload: { ...PAYLOAD, tags: PAYLOAD.tags.filter((t) => t.verdict !== 'unavailable') }, verdict: 'unavailable' });
  assert.match(none, /No not decided tags among the latest 200\./);

  const fresh = render({ payload: { ...PAYLOAD, tags: [], lastWeek: { small: 0, not_small: 0, vetoed: 0, unavailable: 0, costUsd: 0, vetoes: {} } } });
  assert.match(fresh, /No tags yet\. A proposal is tagged when its checks finish\./);
  assert.match(fresh, /Nothing tagged in the last 7 days\./);
  assert.ok(!/admin-small-changes-vetoes/.test(fresh), 'no veto line when nothing was ruled out');

  const off = render({ payload: { ...PAYLOAD, mode: 'off' } });
  assert.match(off, /id="admin-small-changes-off"/);
  assert.match(off, /SMALL_CHANGE_TAG_MODE is set to off/);

  const loading = render({ payload: null });
  assert.match(loading, /Loading…/);
  assert.ok(!/admin-small-changes-empty/.test(loading), 'no empty state before the first answer');
});

test('staging seeds one tag of every verdict on the merged-PR fixtures', () => {
  const migrate = read('src/db/migrate.js');
  const merged = migrate.indexOf('await seedStagingMergedPrs(pool, config);');
  const tags = migrate.indexOf('await seedStagingSmallChangeTags(pool, config);');
  assert.ok(merged > 0 && tags > merged, 'the tags seed runs after the fixtures it hangs off');
  const fn = migrate.slice(migrate.indexOf('async function seedStagingSmallChangeTags'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /process\.env\.USERNODE_ENV !== 'staging'\) return;/);
  assert.match(body, /ON CONFLICT \(session_id, head_sha\) DO NOTHING/);
  for (const v of smallChange.VERDICTS) assert.match(body, new RegExp(`verdict: '${v}'`), `${v} is seeded`);
  for (const veto of body.match(/vetoes: \[([^\]]*)\]/g).flatMap((m) => [...m.matchAll(/'(\w+)'/g)].map((x) => x[1]))) {
    assert.ok(smallChange.VETOES.includes(veto), `${veto} is a real veto`);
  }
});
