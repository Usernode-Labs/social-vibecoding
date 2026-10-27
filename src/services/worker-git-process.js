'use strict';

const { spawn } = require('child_process');

const MEMORY_KIB = 256 * 1024;
const CPU_SECONDS = 30;
const TIMEOUT_MS = 60000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

// Production runs on Linux. RLIMIT_AS bounds allocations in Git and every
// descendant before Git decodes untrusted objects. A failed ulimit stops
// execution. macOS lacks this limit; its local development path still uses
// the decoded-pack budget and the same bounded publication queue.
const LIMIT_SCRIPT = [
  'set -e',
  ...(process.platform === 'linux' ? [`ulimit -S -v ${MEMORY_KIB}`, `ulimit -H -v ${MEMORY_KIB}`] : []),
  `ulimit -S -t ${CPU_SECONDS}`,
  `ulimit -H -t ${CPU_SECONDS}`,
  'ulimit -S -c 0',
  'ulimit -H -c 0',
  'exec "$@"',
].join('\n');

// A trusted command, never worker-provided executable code. Separate process
// groups let deadlines/output limits stop helpers such as index-pack too.
function run(command, args, { env, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', LIMIT_SCRIPT, 'usernode-trusted-git', command, ...args], {
      env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = ''; let stderr = ''; let bytes = 0; let failure; let finished = false;
    const kill = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
        if (error.code !== 'ESRCH') { try { child.kill('SIGKILL'); } catch (_) { /* already gone */ } }
      }
    };
    const timer = setTimeout(() => {
      failure = Object.assign(new Error('Trusted Git command timed out'), { code: 'ETIMEDOUT' });
      kill();
    }, timeoutMs);
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      kill();
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else resolve({ stdout, stderr });
    };
    const collect = isStdout => chunk => {
      if (failure || finished) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT_BYTES) {
        failure = Object.assign(new Error('Trusted Git output exceeds the size limit'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
        kill();
        return;
      }
      if (isStdout) stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on('data', collect(true));
    child.stderr.on('data', collect(false));
    const streamError = error => { failure = failure || error; kill(); };
    child.stdout.on('error', streamError);
    child.stderr.on('error', streamError);
    child.once('error', error => finish(error));
    child.once('close', (code, signal) => {
      const error = failure || (code === 0 ? null : new Error(`Trusted Git command failed (${signal || code})`));
      finish(error);
    });
  });
}

module.exports = { run, MEMORY_KIB, CPU_SECONDS, TIMEOUT_MS, MAX_OUTPUT_BYTES };
