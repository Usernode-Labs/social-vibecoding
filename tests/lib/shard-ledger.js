'use strict';

// Preloaded into every test process of a shard by scripts/test-shard.js:
// the test file this process runs is written down as it starts, so the
// shard can check it ran exactly the files it was given. Only processes
// node's test runner started for a file (NODE_TEST_CONTEXT) and only when
// the shard asked (TEST_SHARD_LEDGER); anything else is left alone.

const fs = require('node:fs');
const path = require('node:path');

const ledger = process.env.TEST_SHARD_LEDGER;
const entry = process.argv[1] || '';
if (ledger && process.env.NODE_TEST_CONTEXT && /\.test\.js$/.test(entry)) {
  const file = path.relative(path.join(__dirname, '..', '..'), entry).split(path.sep).join('/');
  // One short line, appended in one write: lines from processes starting at
  // once do not mix.
  fs.appendFileSync(ledger, `${JSON.stringify({ file, pid: process.pid, ppid: process.ppid })}\n`);
}
