'use strict';

// #4296: the admin console's Unexpected events section
// (frontend/src/features/admin/admin-incidents.tsx). Where it sits, that it
// is built the console's React way, that view-only admins can read it, and
// what its pure helpers make of an incident.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SECTION = 'frontend/src/features/admin/admin-incidents.tsx';

test('it sits in Operations, beside Health & status, and is not public', () => {
  const src = read('frontend/src/features/admin/admin-console.js');
  const entry = /\{ key: 'incidents', label: 'Unexpected events', group: 'Operations' \}/;
  assert.match(src, entry, 'admin-only: no `public: true`');
  const sections = src.slice(src.indexOf('SECTIONS: ['), src.indexOf('LEGACY_SECTION_KEYS'));
  const at = (key) => sections.indexOf(`{ key: '${key}'`);
  assert.ok(at('status') < at('incidents') && at('incidents') < at('push'),
    'in Operations, next to Health & status and Node & chain');
  assert.match(src, /incidents: 'AdminIncidents',/);
  assert.match(src, /'incidents': '<svg /, 'a nav icon like every section');
  assert.match(read('frontend/src/features/admin/sections.ts'), /import '\.\/admin-incidents\.tsx';/);
});

test('it mounts through the render/destroy portal seam and draws with AdminUI', () => {
  const src = read(SECTION);
  assert.match(src, /render\(el: Element\) \{\s*host = el;\s*mountLegacyPortal\(el, <UnexpectedEventsSection \/>\);/);
  assert.match(src, /destroy\(\) \{\s*unmountLegacyPortal\(host\);\s*host = null;/);
  assert.match(src, /import \{ AdminUI \} from '\.\/admin-console\.js';/);
  assert.doesNotMatch(src, /@\/components\/ui/, 'no admin source imports the shell primitives');
  assert.doesNotMatch(src, /requireAdminWrite|canWrite/, 'nothing here writes, so view-only admins see all of it');
  const audit = read('scripts/audit-react-ownership.mjs');
  assert.match(audit, /\{ sel: '#admin-section-content', when: '#admin\/incidents' \}/);
  assert.match(audit, /'#admin\/incidents'/);
});

test('the read is admin-gated but not write-gated', () => {
  const src = read('src/routes/admin.js');
  assert.match(src, /router\.get\('\/api\/admin\/incidents', async \(req, res\) => \{/,
    'on the plain adminMiddleware gate, like every console read');
});

test('the Homeroom bot card links to the whole log', () => {
  const src = read('frontend/src/features/admin/admin-homeroom-bot-health.tsx');
  assert.match(src, /href="#admin\/incidents" id="admin-homeroom-bot-unexpected-all"/);
});

test('an incident links to its session or request, and the days table counts per kind', () => {
  const { loadTsx } = require('./lib/render-tsx.js');
  const mod = loadTsx(SECTION, { stubs: { '../../lib/legacy-portals': { mountLegacyPortal() {}, unmountLegacyPortal() {} } } });
  const base = { at: '2026-10-07T10:00:00Z', kind: 'build_interrupted', app: 'recipe-bot', sessionId: null, runId: 12, issueNumber: null, why: null, outcome: 'resumed' };
  assert.deepEqual(mod.incidentLink({ ...base, sessionId: 41, issueNumber: 7 }),
    { href: '#app/recipe-bot/dev/sessions/41', label: 'Session 41' });
  assert.deepEqual(mod.incidentLink({ ...base, issueNumber: 7 }),
    { href: '#app/recipe-bot/dev/issues/7', label: 'Request #7' });
  assert.equal(mod.incidentLink({ ...base, app: null, sessionId: 41 }), null);
  assert.equal(mod.kindLabel('build_interrupted'), 'Build interrupted');
  assert.equal(mod.kindLabel('deploy_failed'), 'deploy failed', 'a kind this build has no words for still reads');
  assert.equal(mod.outcomeLabel('resumed'), 'carried on from its plan');

  const table = mod.dailyTable([
    { day: '2026-10-06', kind: 'build_interrupted', n: 2 },
    { day: '2026-10-07', kind: 'build_interrupted', n: 3 },
    { day: '2026-10-07', kind: 'stuck', n: 1 },
  ]);
  assert.deepEqual(table.kinds, ['build_interrupted', 'stuck']);
  assert.deepEqual(table.rows, [
    { day: '2026-10-07', counts: { build_interrupted: 3, stuck: 1 }, total: 4 },
    { day: '2026-10-06', counts: { build_interrupted: 2 }, total: 2 },
  ]);
});
