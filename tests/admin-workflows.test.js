'use strict';

// The admin console's Workflows section (frontend/src/features/admin/
// admin-workflows.tsx): registered where the console reads sections, and its
// problems panel and timeline render what the API returns
// (routes/admin-workflow.js, exercised in workflow-governance-routes-postgres).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const TSX = 'frontend/src/features/admin/admin-workflows.tsx';

function load() {
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
const render = (name, props) => {
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  return renderToHtml(createElement(load()[name], props));
};

test('the section is registered: menu, module, icon, lazy import and ownership audit', () => {
  const consoleJs = read('frontend/src/features/admin/admin-console.js');
  assert.match(consoleJs, /\{ key: 'workflows', label: 'Workflows', group: 'Operations' \}/);
  assert.match(consoleJs, /workflows: 'AdminWorkflows'/);
  assert.match(consoleJs, /'workflows': '<svg class="w-5 h-5 shrink-0"/);
  assert.match(read('frontend/src/features/admin/sections.ts'), /import '\.\/admin-workflows\.tsx';/);
  assert.match(read('scripts/audit-react-ownership.mjs'), /when: '#admin\/workflows' \}/);
  assert.match(read('server.js'), /app\.use\(adminWorkflowRoutes\(config\)\);/);
});

test('the problems panel lists each kind of problem, and says when nothing is stuck', () => {
  const empty = { flagged: [], overdueDeadlines: [], work: [], ownershipViolations: [] };
  assert.match(render('Problems', { overview: { problems: empty }, onOpen() {} }), /Nothing is stuck\./);
  const html = render('Problems', {
    onOpen() {},
    overview: {
      problems: {
        flagged: [{ machine: 'governance-proposal', key: 'issue:4', flag: 'faulted', flagDetail: { message: 'boom' }, heldEvents: 2 }],
        overdueDeadlines: [{ machine: 'governance-proposal', key: 'issue:5', deadlineAt: '2026-10-01T00:00:00Z' }],
        work: [{ id: 'w', machine: 'governance-proposal', key: 'issue:6', kind: 'github.closeIssue', workKey: 'target', status: 'settled', lastError: { message: '503' } }],
        ownershipViolations: [{ table_name: 'issues', column_path: 'status', count: 3, last_at: '2026-10-01T00:00:00Z' }],
        ownershipViolationRows: [{ id: 7, table: 'issues', column: 'status', row: { id: 42 }, application: 'homeroom-platform',
          query: 'UPDATE issues SET status = $1 WHERE id = $2', createdAt: '2026-10-01T00:00:00Z' }],
      },
    },
  });
  for (const kind of ['flagged', 'overdue', 'work', 'ownership']) assert.match(html, new RegExp(`data-wf-problem="${kind}"`));
  assert.match(html, /governance-proposal \/ issue:4/);
  assert.match(html, /boom · 2 held/);
  assert.match(html, /out of retries/);
  assert.match(html, /data-wf-violation="7"/);
  assert.match(html, /row \{&quot;id&quot;:42\}/, 'the row the write touched');
  assert.match(html, /by homeroom-platform/, 'the application that wrote it');
  assert.doesNotMatch(html, /Nothing is stuck/);
});

test('a guard left on while its flag is off here is a problem; one its flag runs here is not', () => {
  const empty = { flagged: [], overdueDeadlines: [], work: [], ownershipViolations: [] };
  const html = render('Problems', { onOpen() {}, overview: { problems: empty, guards: [
    { machine: 'governance-proposal', flag: 'WF_GOVERNANCE_ENABLED', on: true, flagHere: false },
    { machine: 'merge-followups', flag: 'WF_MERGE_FOLLOWUPS_ENABLED', on: true, flagHere: true },
  ] } });
  assert.match(html, /data-wf-problem="guard"/);
  assert.match(html, /guard on, flag off here/);
  assert.match(html, /WF_GOVERNANCE_ENABLED is off in this process/);
  assert.doesNotMatch(html, /merge-followups/, 'its flag runs it here');
  assert.doesNotMatch(html, /Nothing is stuck/);
  const fine = render('Problems', { onOpen() {}, overview: { problems: empty, guards: [
    { machine: 'governance-proposal', flag: 'WF_GOVERNANCE_ENABLED', on: false, flagHere: false },
  ] } });
  assert.match(fine, /Nothing is stuck\./);
});

test('the timeline shows result, reason, transition, source, cause and what an event emitted', () => {
  const html = render('Timeline', {
    onOpen() {},
    events: [
      { id: 9, type: 'VoteCast', result: 'accepted', status: 'processed', reason: null, stateBefore: 'open', stateAfter: 'applied',
        source: { kind: 'route', name: 'vote' }, actor: 'user:3', requestKey: 'vote:3:x', attempts: 0, causedBy: null, cause: null,
        emitted: { writes: ['vote', 'apply'], work: [{ kind: 'github.closeIssue', key: 'target' }], timer: null }, createdAt: '2026-10-01T00:00:00Z' },
      { id: 10, type: 'TargetClosed', result: 'rejected', status: 'processed', reason: 'not_target', stateBefore: 'open', stateAfter: 'open',
        source: { kind: 'message' }, actor: null, requestKey: 'msg:8:0', attempts: 1, causedBy: 8,
        cause: { machine: 'preview', key: 'session:2', type: 'Retire' }, emitted: null, error: null, createdAt: '2026-10-01T00:00:00Z' },
    ],
  });
  assert.match(html, /data-wf-result="accepted"/);
  assert.match(html, /open → applied/);
  assert.match(html, /wrote vote, apply · work github\.closeIssue target · timer cleared/);
  assert.match(html, /not_target/);
  assert.match(html, /preview \/ session:2/);
  assert.match(html, /1 timeout\b/);
});
