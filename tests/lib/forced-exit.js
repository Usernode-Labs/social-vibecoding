'use strict';

// Loaded by tests/lib/test-net.js, so by every process --test-force-exit
// reaches: a test file's and, under `npm test`, the runner's.
//
// A forced exit closes its report's destination, when that can be closed,
// and then calls process.exit(). A file has a close(); stdout, a pipe to the
// runner, has none, so nothing waited for the writes the pipe had not taken
// yet and they went with the process: up to ~60 KB, the results of the last
// tests of any file that reports faster than the runner reads. The exit code
// stayed right, so the file failed without naming the test that did (24 Nov
// 2026: 20 runs of external-agent-tasks.test.js, which has 199 tests,
// reported 171 to 199). Under `npm test` the runner's own closing counts
// went the same way.
//
// So stdout gets the close() a forced exit asks for, which closes nothing
// and answers once everything written so far has been taken. Node does the
// same by itself since nodejs/node 030745c54ee2 (20 Nov 2026, in no release
// yet); this can go when the pinned node has it.
// tests/forced-exit-report.test.js holds it either way.

if (process.execArgv.includes('--test-force-exit')) {
  const { stdout } = process;
  // Not stdout.write at the time: a test may have left its own there.
  const { write } = stdout;
  stdout.close = (done) => { write.call(stdout, '', () => done()); };
}
