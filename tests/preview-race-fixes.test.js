'use strict';

// Change 4930 was promoted with its checks never started: a recovered build
// that deployed fresh staging marked the verdict pending and stopped, and the
// promote kick trusted that pending verdict. Both halves are the preview
// machine's now (src/workflow/preview/: a 'pending' verdict always has its
// work outstanding there), and are tested with it. What stays here: the
// board-change hook, which once leaked a preview run's guarded pool into a
// timer, reads the platform's own pool.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('the Workshop board-change hook arms its reconcile on the platform pool', () => {
  assert.match(SERVER_SRC,
    /ws\.onBoardChange\(\(info\) => workshopThemes\.noteBoardChange\(getPool\(config\), info\)\)/);
});

test('no shots run on a change reads as none', () => {
  const orchestrator = require('../src/services/shots-orchestrator');
  assert.equal(orchestrator.inFlightRunFor(987654), null);
});
