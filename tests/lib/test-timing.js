'use strict';

// Preloaded through NODE_OPTIONS by `npm run test:durations`
// (scripts/test-durations.js), never by a normal run: every node process
// writes down how long it ran and the CPU it used, under the test file it
// belongs to. A test file's own process names the file for every process
// it starts (TEST_TIMING_FILE is inherited), so a suite that forks workers
// is charged with their CPU too. A process may be SIGKILLed (the crash
// suite kills its children on purpose), so it also writes a snapshot every
// tenth of a second; the reader keeps each process's last line. What a
// database server spends for a file is not charged to it.

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const out = process.env.TEST_TIMING_OUT;
const entry = process.argv[1] || '';
if (out) {
  const own = process.env.NODE_TEST_CONTEXT && /\.test\.js$/.test(entry)
    ? path.relative(path.join(__dirname, '..', '..'), entry).split(path.sep).join('/') : null;
  if (own) process.env.TEST_TIMING_FILE = own;
  const file = own || process.env.TEST_TIMING_FILE || null;
  if (file) {
    const write = () => {
      const u = process.cpuUsage();
      try {
        fs.appendFileSync(out, `${JSON.stringify({ file, own: !!own, pid: process.pid, wallMs: performance.now(), cpuMs: (u.user + u.system) / 1000 })}\n`);
      } catch { /* measurement only */ }
    };
    process.on('exit', write);
    setInterval(write, 100).unref();
  }
}
