#!/usr/bin/env node
'use strict';

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_CAPTURE_BYTES = 32 * 1024;
const TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;

function usage() {
  return `Usage: npm run readiness:evidence -- [options]

Runs the repository-only npm test contract once. It does not contact or
change an environment and does not declare a release ready.

Options:
  --target <label>      Content-neutral evidence label (default: unspecified)
  --timeout-ms <ms>     1000-${MAX_TIMEOUT_MS} (default: ${DEFAULT_TIMEOUT_MS})
  --output <path>       Create a private JSON artifact; refuses to overwrite
  --help                Show this help
`;
}

function parseArgs(argv) {
  const result = {
    target: 'unspecified',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    output: null,
    help: false,
  };
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      result.help = true;
      continue;
    }
    if (!['--target', '--timeout-ms', '--output'].includes(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (seen.has(arg)) throw new Error(`Duplicate option: ${arg}`);
    seen.add(arg);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }
    index += 1;
    if (arg === '--target') result.target = value;
    if (arg === '--output') result.output = value;
    if (arg === '--timeout-ms') {
      if (!/^\d+$/.test(value)) throw new Error('--timeout-ms must be an integer');
      result.timeoutMs = Number(value);
    }
  }

  if (!TARGET_PATTERN.test(result.target)) {
    throw new Error('--target must be 1-80 letters, numbers, dots, slashes, underscores, or hyphens');
  }
  if (!Number.isSafeInteger(result.timeoutMs)
      || result.timeoutMs < MIN_TIMEOUT_MS
      || result.timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`--timeout-ms must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  if (result.output && result.output.includes('\u0000')) {
    throw new Error('--output contains an invalid character');
  }
  return result;
}

function sanitizeOutput(value, repositoryRoots) {
  let output = String(value || '');
  const roots = Array.isArray(repositoryRoots) ? repositoryRoots : [repositoryRoots];
  for (const root of roots.filter(Boolean).sort((a, b) => b.length - a.length)) {
    output = output.split(root).join('<repo>');
  }
  output = output
    .replace(/\b(Bearer)\s+[^\s]+/gi, '$1 [REDACTED]')
    .replace(/\b(gh[opsu]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g, '[REDACTED]')
    .replace(/\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, '[REDACTED]')
    .replace(/\b([A-Za-z][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|CREDENTIAL|AUTHORIZATION|COOKIE|SESSION)[A-Za-z0-9_]*)\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
  return output;
}

function terminate(child, signal) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already exited */ }
  }
}

function runProcess(command, args, options = {}) {
  const {
    cwd,
    timeoutMs,
    spawnImpl = spawn,
    now = Date.now,
    terminateImpl = terminate,
  } = options;
  return new Promise((resolve) => {
    const started = now();
    let timedOut = false;
    let spawnError = null;
    let hardKillTimer = null;
    let settled = false;
    const captureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-evidence-'));
    const capturePath = path.join(captureDirectory, 'check.log');
    const captureFd = fs.openSync(capturePath, 'wx', 0o600);
    let child;
    try {
      child = spawnImpl(command, args, {
        cwd,
        env: process.env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', captureFd, captureFd],
      });
    } catch (error) {
      fs.closeSync(captureFd);
      fs.rmSync(captureDirectory, { recursive: true, force: true });
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        error: error.message,
        durationMs: Math.max(0, now() - started),
        output: '',
        outputTruncated: false,
      });
      return;
    }

    child.on('error', (error) => { spawnError = error; });

    const timeout = setTimeout(() => {
      timedOut = true;
      terminateImpl(child, 'SIGTERM');
      hardKillTimer = setTimeout(() => terminateImpl(child, 'SIGKILL'), 3000);
      if (typeof hardKillTimer.unref === 'function') hardKillTimer.unref();
    }, timeoutMs);
    if (typeof timeout.unref === 'function') timeout.unref();

    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      fs.closeSync(captureFd);
      let output = '';
      let outputTruncated = false;
      try {
        const size = fs.statSync(capturePath).size;
        const length = Math.min(size, MAX_CAPTURE_BYTES);
        const buffer = Buffer.alloc(length);
        const readFd = fs.openSync(capturePath, 'r');
        fs.readSync(readFd, buffer, 0, length, Math.max(0, size - length));
        fs.closeSync(readFd);
        output = buffer.toString('utf8');
        outputTruncated = size > MAX_CAPTURE_BYTES;
      } catch (error) {
        spawnError ||= error;
      } finally {
        fs.rmSync(captureDirectory, { recursive: true, force: true });
      }
      resolve({
        exitCode,
        signal,
        timedOut,
        error: spawnError ? spawnError.message : null,
        durationMs: Math.max(0, now() - started),
        output,
        outputTruncated,
      });
    };
    child.on('close', finish);
  });
}

function classify(result) {
  if (result.timedOut) return 'timed_out';
  if (result.error) return 'error';
  return result.exitCode === 0 ? 'passed' : 'failed';
}

function checkedCommit(repositoryRoot) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
  } catch {
    return 'unavailable';
  }
}

function repositoryRootsForRedaction(repositoryRoot) {
  const roots = [repositoryRoot];
  try {
    const dependencyRoot = path.dirname(fs.realpathSync(path.join(repositoryRoot, 'node_modules')));
    if (!roots.includes(dependencyRoot)) roots.push(dependencyRoot);
  } catch { /* dependencies may not be installed */ }
  return roots;
}

function writeArtifact(outputPath, report) {
  const destination = path.resolve(outputPath);
  const parent = path.dirname(destination);
  const base = path.basename(destination);
  if (!base || base === '.' || base === '..') throw new Error('Invalid output path');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent, `.${base}.${process.pid}.${Date.now()}.tmp`);
  const body = `${JSON.stringify(report, null, 2)}\n`;
  try {
    fs.writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 });
    fs.linkSync(temporary, destination);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Refusing to overwrite existing artifact: ${destination}`);
    throw error;
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* no temporary file remains */ }
  }
  return destination;
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`readiness:evidence: ${error.message}\n\n${usage()}`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }

  const repositoryRoot = path.resolve(__dirname, '..');
  const startedAt = new Date();
  process.stderr.write('Running repository evidence check once: npm test\n');
  const processResult = await runProcess('npm', ['test'], {
    cwd: repositoryRoot,
    timeoutMs: options.timeoutMs,
  });
  const endedAt = new Date();
  const status = classify(processResult);
  const sanitizedOutput = sanitizeOutput(
    processResult.output,
    repositoryRootsForRedaction(repositoryRoot),
  );
  if (sanitizedOutput) {
    process.stderr.write('\n--- sanitized bounded check output ---\n');
    process.stderr.write(sanitizedOutput);
    if (!sanitizedOutput.endsWith('\n')) process.stderr.write('\n');
    process.stderr.write('--- end check output ---\n');
  }
  const report = {
    schemaVersion: 1,
    kind: 'usernode.repository-readiness-evidence',
    disclaimer: 'Repository checks only. A passing result does not declare any environment or release ready.',
    target: options.target,
    commit: checkedCommit(repositoryRoot),
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: processResult.durationMs,
    result: status,
    checks: [{
      id: 'npm-test',
      command: ['npm', 'test'],
      attempts: 1,
      status,
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      timedOut: processResult.timedOut,
      durationMs: processResult.durationMs,
      error: processResult.error,
      output: {
        truncated: processResult.outputTruncated,
        text: sanitizedOutput,
      },
    }],
  };

  if (options.output) {
    try {
      const destination = writeArtifact(options.output, report);
      process.stderr.write(`Evidence artifact created: ${destination}\n`);
    } catch (error) {
      process.stderr.write(`readiness:evidence: ${error.message}\n`);
      return 2;
    }
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
  process.stderr.write(`Repository evidence result: ${status}\n`);
  return status === 'passed' ? 0 : 1;
}

module.exports = {
  MAX_CAPTURE_BYTES,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  classify,
  main,
  parseArgs,
  repositoryRootsForRedaction,
  runProcess,
  sanitizeOutput,
  usage,
  writeArtifact,
};

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}
