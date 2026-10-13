'use strict';

// The shots worker's memory, sampled through a turn (worker/shots-memory.js),
// so a shots agent that dies mid-run says whether memory ran out. Pinned
// here: cgroup v2 and v1 are both read, an unlimited limit and a missing
// counter are null rather than guessed, resident memory is split into fixed
// classes of process, and nothing but numbers and class names comes out.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const memory = require('../worker/shots-memory');

const MB = 1024 * 1024;

function tree(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-memory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

test('the container\'s use, limit, peak and out-of-memory kills come from cgroup v2', (t) => {
  const root = tree(t, {
    'memory.current': `${1900 * MB}\n`,
    'memory.max': `${2048 * MB}\n`,
    'memory.peak': `${2040 * MB}\n`,
    'memory.events': 'low 0\nhigh 0\nmax 12\noom 2\noom_kill 2\noom_group_kill 0\n',
  });
  assert.deepEqual(memory.readCgroup(root), { usedMb: 1900, limitMb: 2048, peakMb: 2040, oomKills: 2 });

  // No limit, and a kernel without memory.peak.
  const unlimited = tree(t, { 'memory.current': `${300 * MB}`, 'memory.max': 'max\n', 'memory.events': 'oom_kill 0\n' });
  assert.deepEqual(memory.readCgroup(unlimited), { usedMb: 300, limitMb: null, peakMb: null, oomKills: 0 });
});

test('cgroup v1 is read too, and a machine with neither reports nothing rather than a guess', (t) => {
  const root = tree(t, {
    'memory/memory.usage_in_bytes': `${700 * MB}`,
    'memory/memory.limit_in_bytes': '9223372036854771712',
    'memory/memory.max_usage_in_bytes': `${900 * MB}`,
    'memory/memory.oom_control': 'oom_kill_disable 0\nunder_oom 0\noom_kill 1\n',
  });
  assert.deepEqual(memory.readCgroup(root), { usedMb: 700, limitMb: null, peakMb: 900, oomKills: 1 });
  assert.deepEqual(memory.readCgroup(tree(t, { 'unrelated': 'x' })),
    { usedMb: null, limitMb: null, peakMb: null, oomKills: null });
});

test('resident memory is split into fixed classes of process, never named', (t) => {
  const proc = (pid, cmdline, rssKb) => ({
    [`${pid}/cmdline`]: cmdline.split(' ').join('\0'),
    [`${pid}/status`]: `Name:\tx\nVmPeak:\t1 kB\nVmRSS:\t${rssKb} kB\nThreads:\t1\n`,
  });
  const root = tree(t, {
    ...proc(10, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome --headless --user-data-dir=/tmp/secret-profile', 300 * 1024),
    ...proc(11, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome --type=renderer --lang=en', 500 * 1024),
    ...proc(12, 'node /usr/local/bin/claude --model x -p "the private prompt"', 400 * 1024),
    ...proc(13, 'node /usr/local/bin/shots-browser-observer.js member --output-dir /tmp/x', 90 * 1024),
    ...proc(14, 'node /usr/local/bin/shots-mcp.js', 60 * 1024),
    ...proc(15, 'node /usr/local/bin/shots-origin-proxy.js', 50 * 1024),
    ...proc(16, 'sleep infinity', 1024),
    // A kernel thread has no resident set, and an entry that is not a pid is not a process.
    '17/cmdline': '', '17/status': 'Name:\tkthreadd\n',
    'self/status': 'VmRSS:\t999999 kB\n',
  });
  const result = memory.processMemory(root);
  assert.deepEqual(result, { rssMb: { browser: 800, agent: 400, mcp: 150, proxy: 50, other: 1 }, browserProcesses: 2 });
  assert.doesNotMatch(JSON.stringify(memory.sample({ cgroupRoot: root, procRoot: root })), /secret|prompt|tmp|member/);

  assert.equal(memory.processClass('/usr/bin/chromium --type=gpu-process'), 'browser');
  assert.equal(memory.processClass('node /usr/local/lib/node_modules/@playwright/mcp/cli.js'), 'mcp');
  // A phone browser's server and its Playwright are counted with the others.
  assert.equal(memory.processClass('node /usr/local/bin/shots-browser-observer.js member_phone --device iPhone 15'), 'mcp');
  assert.equal(memory.processClass('mcp-server-playwright --browser chromium --device iPhone 15'), 'mcp');
  assert.equal(memory.processClass('node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'), 'agent');
  assert.equal(memory.processClass('sh -c /usr/local/bin/run-cc.sh'), 'other');
  assert.deepEqual(memory.processMemory(path.join(root, 'missing')), { rssMb: null, browserProcesses: null });
});

test('the sampler reports at once and then on its interval, and never keeps the process alive', async (t) => {
  const root = tree(t, { 'memory.current': `${10 * MB}`, 'memory.max': `${20 * MB}`, 'memory.events': 'oom_kill 0\n' });
  const seen = [];
  const stop = memory.startSampler((event) => seen.push(event), { intervalMs: 1000, cgroupRoot: root, procRoot: root });
  t.after(stop);
  assert.equal(seen.length, 1, 'one sample straight away');
  assert.deepEqual(seen[0], {
    kind: 'worker_memory', usedMb: 10, limitMb: 20, peakMb: null, oomKills: 0,
    rssMb: { browser: 0, agent: 0, mcp: 0, proxy: 0, other: 0 }, browserProcesses: 0,
  });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.ok(seen.length >= 2, 'and again on the interval');

  // A sample that fails is skipped; the sampler goes on.
  let calls = 0;
  const stopThrowing = memory.startSampler(() => { calls += 1; throw new Error('emit failed'); },
    { intervalMs: 1000, cgroupRoot: root, procRoot: root });
  stopThrowing();
  assert.equal(calls, 1);
});
