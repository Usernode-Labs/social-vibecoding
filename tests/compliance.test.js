'use strict';

// #5634: the Compliance report's fixed list of plan items, its checks, the
// status a page may save, and the clock that scans. The SQL runs against
// PostgreSQL in tests/compliance-postgres.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { AREAS, ITEMS } = require('../src/services/compliance-items');
const compliance = require('../src/services/compliance');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the plan has 65 items, each with a unique code, a known area, a request and a starting status', () => {
  assert.equal(ITEMS.length, 65);
  const codes = new Set(ITEMS.map((i) => i.code));
  assert.equal(codes.size, ITEMS.length, 'codes are unique');
  const areas = new Set(AREAS.map((a) => a.key));
  const issues = new Set();
  for (const i of ITEMS) {
    assert.match(i.code, /^[A-Z]{1,2}-\d{2}$/, i.code);
    assert.ok(areas.has(i.area), `${i.code} is in a known area`);
    assert.ok(Number.isInteger(i.issue) && i.issue >= 5074 && i.issue <= 5138, `${i.code} names its request`);
    issues.add(i.issue);
    assert.ok(['P0', 'P1', 'P2'].includes(i.priority), `${i.code} priority`);
    assert.ok(compliance.STATUSES.includes(i.start), `${i.code} starting status`);
    assert.ok(i.title && i.title.length <= 200, `${i.code} title`);
    assert.ok(/^[\x20-\x7e]+$/.test(i.title), `${i.code} title is plain text`);
    if (i.start === 'partial') assert.ok(i.startNote, `${i.code}: a partly done item says what is missing`);
  }
  assert.equal(issues.size, ITEMS.length, 'one request per item');
  // The plan's own order: by area, then by number.
  const order = AREAS.map((a) => a.key);
  const sorted = ITEMS.slice().sort((a, b) => (order.indexOf(a.area) - order.indexOf(b.area))
    || (Number(a.code.split('-')[1]) - Number(b.code.split('-')[1])));
  assert.deepEqual(ITEMS.map((i) => i.code), sorted.map((i) => i.code));
});

test('every check names items of the plan, and keys are unique', () => {
  const codes = new Set(ITEMS.map((i) => i.code));
  const keys = new Set();
  for (const c of compliance.CHECKS) {
    assert.ok(!keys.has(c.key), `${c.key} is unique`);
    keys.add(c.key);
    assert.ok(c.key.length <= 32, `${c.key} fits check_key`);
    assert.ok(c.items.length > 0, `${c.key} names an item`);
    for (const code of c.items) assert.ok(codes.has(code), `${c.key}: ${code} is an item`);
    assert.ok(c.label, `${c.key} has a label`);
  }
});

test('a status is one of three, for a known item, with a note within its limit; a blank note means keep it', () => {
  assert.deepEqual(compliance.normaliseStatus('I-05', { status: 'done' }),
    { ok: true, value: { status: 'done', note: null } });
  assert.deepEqual(compliance.normaliseStatus('I-05', { status: 'partial', note: '  Backups still hold them  ' }),
    { ok: true, value: { status: 'partial', note: 'Backups still hold them' } });
  assert.deepEqual(compliance.normaliseStatus('I-05', { status: 'todo', note: '   ' }),
    { ok: true, value: { status: 'todo', note: null } });
  assert.equal(compliance.normaliseStatus('Z-99', { status: 'done' }).status, 404);
  assert.equal(compliance.normaliseStatus('I-05', { status: 'finished' }).status, 400);
  assert.equal(compliance.normaliseStatus('I-05', {}).status, 400);
  assert.equal(compliance.normaliseStatus('I-05', { status: 'done', note: 5 }).status, 400);
  assert.equal(compliance.normaliseStatus('I-05', { status: 'done', note: 'x'.repeat(compliance.NOTE_MAX + 1) }).status, 400);
});

test('the scan interval is COMPLIANCE_SCAN_INTERVAL_DAYS, whole days 1 to 90, else a week', () => {
  assert.equal(compliance.scanIntervalDays({}), 7);
  assert.equal(compliance.scanIntervalDays({ COMPLIANCE_SCAN_INTERVAL_DAYS: '3' }), 3);
  assert.equal(compliance.scanIntervalDays({ COMPLIANCE_SCAN_INTERVAL_DAYS: ' 30 ' }), 30);
  for (const bad of ['0', '91', '-1', '2.5', 'weekly', '']) {
    assert.equal(compliance.scanIntervalDays({ COMPLIANCE_SCAN_INTERVAL_DAYS: bad }), 7, bad);
  }
});

test('the compliance-scan clock runs the scan on its interval', async () => {
  const { JOBS } = require('../src/workflow/clock/services.ts');
  const job = JOBS.find((j) => j.name === 'compliance-scan');
  assert.ok(job, 'the compliance-scan clock exists');
  assert.equal(job.everyMs, compliance.scanIntervalDays() * 24 * 60 * 60 * 1000);
  assert.equal(job.item, undefined, 'a scan is one more row each time: no targets');
});

test('the LICENSE check reads each project once, names the ones without, and gives way to the budget', async () => {
  const pool = {
    query: async () => ({ rows: [
      { id: 1, slug: 'has-one', name: 'Has one', repo_url: 'https://github.com/usernode-bot/has-one' },
      { id: 2, slug: 'has-md', name: 'Has md', repo_url: 'https://github.com/usernode-bot/has-md.git' },
      { id: 3, slug: 'has-none', name: 'Has none', repo_url: 'https://github.com/usernode-bot/has-none' },
      { id: 4, slug: 'elsewhere', name: 'Elsewhere', repo_url: 'https://gitlab.com/x/y' },
      { id: 5, slug: 'broken', name: 'Broken', repo_url: 'https://github.com/usernode-bot/broken' },
    ] }),
  };
  const reads = [];
  const github = {
    async getFileContent(owner, repo, p) {
      reads.push(`${repo}/${p}`);
      if (repo === 'broken') throw new Error('boom');
      if (repo === 'has-one' && p === 'LICENSE') return 'MIT';
      if (repo === 'has-md' && p === 'LICENSE.md') return 'MIT';
      return null;
    },
  };
  const r = await compliance.checkRepoLicenses(pool, { github, budget: { budgetAllows: () => true } });
  assert.equal(r.state, 'fail');
  assert.equal(r.checked, 5);
  assert.equal(r.failed, 3);
  assert.deepEqual(r.failing.map((f) => [f.slug, f.reason]).sort(),
    [['broken', 'unreadable'], ['elsewhere', 'not_on_github'], ['has-none', 'missing']]);
  assert.equal(reads.filter((x) => x.startsWith('has-one/')).length, 1, 'one read for a project with a LICENSE');

  const down = await compliance.checkRepoLicenses(pool, {
    github: { getFileContent: async () => { throw new Error('no token'); } },
    budget: { budgetAllows: () => true },
  });
  // The project not on GitHub still fails on its own; four unreadable of
  // five is not "GitHub could not be read".
  assert.equal(down.state, 'fail');
  const githubOnly = { query: async () => ({ rows: (await pool.query()).rows.filter((r) => r.repo_url.includes('github')) }) };
  const allDown = await compliance.checkRepoLicenses(githubOnly, {
    github: { getFileContent: async () => { throw new Error('no token'); } },
    budget: { budgetAllows: () => true },
  });
  assert.equal(allDown.state, 'error', 'no repository readable is the scan failing, not every project');
  assert.deepEqual(allDown.failing, []);

  const held = await compliance.checkRepoLicenses(pool, { github, budget: { budgetAllows: () => false } });
  assert.equal(held.state, 'error', 'a scan held by the budget is not a pass');
  assert.equal(held.checked, 0);
});

test('a scan stores every check, an error included, and a check that throws does not stop the rest', async () => {
  const stored = [];
  const pool = {
    async query(sql, params) {
      if (/INSERT INTO compliance_scans/.test(sql)) return { rows: [{ id: 7, started_at: new Date() }] };
      if (/INSERT INTO compliance_scan_results/.test(sql)) stored.push(params);
      return { rows: [] };
    },
  };
  const checks = [
    { key: 'a', items: ['I-03'], label: 'A', run: async () => ({ state: 'pass', summary: 'fine' }) },
    { key: 'b', items: ['I-05'], label: 'B', run: async () => { throw new Error('no table'); } },
    { key: 'c', items: ['X-07'], label: 'C', run: async () => ({ state: 'fail', summary: 'two', checked: 3, failed: 2, failing: [{ slug: 'x', reason: 'missing' }] }) },
  ];
  const out = await compliance.runScan(pool, { checks });
  assert.deepEqual(out, { scanId: 7, states: { a: 'pass', b: 'error', c: 'fail' } });
  assert.equal(stored.length, 3);
  assert.match(stored[1][3], /The check failed: no table/);
  assert.equal(stored[2][4], 3);
  assert.equal(JSON.parse(stored[2][6]).length, 1);

  // Asked to stop, it records what it reached and fails, so the clock runs
  // it again sooner.
  let n = 0;
  await assert.rejects(compliance.runScan(pool, { checks, shouldStop: () => n++ > 0 }), /stopped/);
});

test('the console wires the section: menu entry, module, ownership audit', () => {
  const consoleSrc = read('frontend/src/features/admin/admin-console.js');
  assert.match(consoleSrc, /\{ key: 'compliance', label: 'Compliance', group: 'Operations' \}/);
  assert.match(consoleSrc, /compliance: 'AdminCompliance'/);
  assert.match(read('frontend/src/features/admin/sections.ts'), /import '\.\/admin-compliance\.tsx';/);
  const audit = read('scripts/audit-react-ownership.mjs');
  assert.match(audit, /when: '#admin\/compliance'/);
  assert.match(audit, /'#admin\/compliance'/);
  const section = read('frontend/src/features/admin/admin-compliance.tsx');
  assert.ok(!/<a\s/.test(section), 'nothing from the API is drawn as a link');
  assert.match(section, /placeholder=\{item\.note \|\|/, 'the note field shows the current note as its placeholder');
});
