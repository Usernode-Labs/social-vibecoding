'use strict';

// scripts/shots-dry-run.js takes before/after shots of declared changes on
// two local builds with a real shots agent. The run itself needs a browser
// and a model; these pin its argument contract and the contact sheet people
// judge from, which renders proposal text and so must escape it.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  PERSONAS, parseArgs, contactSheet, agentEnv, watchAgentStream, browserServer,
} = require('../scripts/shots-dry-run');
const fixtures = require('./fixtures/shots');

test('the dry run needs a declaration and two origins, and takes exact commits only', () => {
  assert.throws(() => parseArgs(['--intent', 'i.json', '--before', 'http://127.0.0.1:1']), /--after is required/);
  assert.throws(() => parseArgs(['--intent', 'i.json', '--before', 'nope', '--after', 'http://x']), /--before must be a URL/);
  assert.throws(() => parseArgs(['--intent', 'i.json', '--before', 'http://a', '--after', 'http://b',
    '--base-sha', 'abc123']), /40-character/);
  assert.throws(() => parseArgs(['--intent', 'a', '--intent', 'b']), /repeated/);
  assert.throws(() => parseArgs(['--unknown', 'x']), /Invalid/);
  assert.deepEqual(parseArgs(['--help']), { help: true });
  const options = parseArgs(['--intent', 'i.json', '--before', 'http://127.0.0.1:4101/lists?x=1',
    '--after', 'http://127.0.0.1:4102', '--timeout-ms', '5']);
  assert.equal(options.before, 'http://127.0.0.1:4101');
  assert.equal(options.intentFile, path.resolve('i.json'));
  assert.equal(options.timeoutMs, 30_000, 'the budget has a floor');
  assert.deepEqual(options.playwrightMcp, ['npx', '-y', '@playwright/mcp@0.0.41']);
  assert.deepEqual(parseArgs(['--intent', 'i.json', '--before', 'http://a', '--after', 'http://b',
    '--playwright-mcp', 'lab/pw/bin/mcp-server-playwright --flag']).playwrightMcp,
  [path.resolve('lab/pw/bin/mcp-server-playwright'), '--flag'], 'the agent runs elsewhere, so a relative command is resolved');
  assert.equal(options.fixturesFile, null, 'no fixtures unless the pair seeded some');
  assert.equal(options.claudeBin, 'claude');
  assert.equal(options.model, null, 'the run falls back to the hosted shots agent\'s model');
  assert.equal(parseArgs(['--intent', 'i.json', '--before', 'http://a', '--after', 'http://b',
    '--claude-bin', 'bin/claude']).claudeBin, path.resolve('bin/claude'));
  assert.equal(parseArgs(['--intent', 'i.json', '--before', 'http://a', '--after', 'http://b',
    '--fixtures', 'f.json']).fixturesFile, path.resolve('f.json'));
});

test('every declared persona has a browser, and the guest\'s always starts signed out', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  assert.deepEqual(Object.keys(PERSONAS).sort(), [...require('../src/services/visible-changes').PERSONAS].sort());
  assert.deepEqual(PERSONAS.guest, { dir: 'guest', server: 'browser_guest' });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-dry-run-state-'));
  try {
    for (const persona of Object.keys(PERSONAS)) fs.writeFileSync(path.join(stateDir, `${persona}.json`), '{}');
    const options = parseArgs(['--intent', 'i.json', '--before', 'http://a', '--after', 'http://b',
      '--state-dir', stateDir]);
    const args = (persona) => browserServer(options, persona, '/tmp/shots', null).args;
    assert.ok(args('member').includes(path.join(stateDir, 'member.json')));
    assert.equal(args('guest').includes('--storage-state'), false, 'a guest.json is never loaded');
    assert.equal(args('guest')[args('guest').indexOf('--output-dir') + 1], path.join('/tmp/shots', 'guest'));
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('the agent starts without the Claude Code session the harness was run from', () => {
  const env = agentEnv({
    PATH: '/bin', HOME: '/home/x', ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: '/c',
    CLAUDECODE: '1', CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1', CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_AGENT_SDK_VERSION: '0.3', CLAUDE_EFFORT: 'xhigh', CLAUDE_PID: '9',
  });
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'HOME', 'PATH'],
    'host plumbing and the parent’s effort go; the caller’s own credentials and config stay');
});

test('two refused credentials, or a browser server that did not start, stop the agent', () => {
  const refused = [];
  const failed = [];
  const feed = watchAgentStream({ onRefused: (status) => refused.push(status), onServersFailed: (names) => failed.push(names) });
  const retry = (status) => `${JSON.stringify({ type: 'system', subtype: 'api_retry', error_status: status })}\n`;
  feed(Buffer.from(retry(529) + retry(401).slice(0, 20)));
  assert.deepEqual(refused, [], 'an overload is worth retrying, and a half line is not an event');
  feed(Buffer.from(retry(401).slice(20)));
  assert.deepEqual(refused, []);
  feed(Buffer.from(retry(401) + retry(401)));
  assert.deepEqual(refused, [401], 'reported once');

  const init = (servers) => `${JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: servers })}\n`;
  feed(Buffer.from(init([{ name: 'shots', status: 'connected' }, { name: 'browser_member', status: 'connected' }])));
  assert.deepEqual(failed, []);
  feed(Buffer.from(init([{ name: 'shots', status: 'connected' }, { name: 'browser_member', status: 'failed' },
    { name: 'browser_admin', status: 'pending' }])));
  assert.deepEqual(failed, [['browser_member', 'browser_admin']]);
});

test('the contact sheet shows each change with its result and escapes proposal text', () => {
  const intent = fixtures.motionIntent();
  intent.stories[0].claim = 'Shows <img src=x onerror=alert(1)> suggestions';
  const summary = {
    readyCount: 1,
    stories: [
      { id: 'invite-suggestions', status: 'skipped', reason: 'Needs <b>data</b>' },
      { id: 'saved-toast', status: 'ready', files: 4, note: 'Undo needs <i>two</i> lists.' },
    ],
  };
  const files = new Map([
    ['saved-toast|desktop|base|context', 'saved-toast-desktop-before-screen.png'],
    ['saved-toast|desktop|head|context', 'saved-toast-desktop-after-screen.png'],
    ['saved-toast|desktop|base|animation', 'saved-toast-desktop-before-clip.webm'],
    ['saved-toast|desktop|head|animation', 'saved-toast-desktop-after-clip.webm'],
  ]);
  const html = contactSheet(intent, summary, files, {
    before: 'http://127.0.0.1:4101', after: 'http://127.0.0.1:4102',
    agentOutcome: 'finished', agentMs: 61_000, finalText: '<script>x</script>', toolCounts: {},
  });
  assert.ok(!html.includes('<img src=x'), 'a claim is text, never markup');
  assert.ok(!html.includes('<script>x'), 'the agent’s words are text too');
  assert.match(html, /Needs &lt;b&gt;data&lt;\/b&gt;/);
  assert.match(html, /Not in these shots: Undo needs &lt;i&gt;two&lt;\/i&gt; lists\./);
  assert.match(html, /<b class="skipped">skipped<\/b>/);
  assert.match(html, /<b class="ready">ready<\/b>/);
  assert.match(html, /<video src="shots\/saved-toast-desktop-before-clip\.webm" controls muted playsinline>/);
  assert.match(html, /<img src="shots\/saved-toast-desktop-after-screen\.png" alt="After · screen">/);
  assert.match(html, /1 of 2 ready · agent finished in 61 s/);
  assert.doesNotMatch(html, /Also noticed/, 'nothing noticed, no section');

  // What the agent noticed broken on the after build, as text.
  const noticed = contactSheet(intent, { ...summary, notices: [
    { text: 'The <b>table</b> is cut off.', change: 'saved-toast', screen: 'desktop', shot: 'screen', alsoBefore: false },
    { text: 'Overlap.', change: 'saved-toast', screen: 'desktop', shot: null, alsoBefore: 'unknown' },
  ] }, files, { before: 'b', after: 'a', agentOutcome: 'finished', agentMs: 1000, finalText: '', toolCounts: {} });
  assert.match(noticed, /<h2>Also noticed<\/h2>/);
  assert.match(noticed, /The &lt;b&gt;table&lt;\/b&gt; is cut off\./);
  assert.match(noticed, /screen shot\s+· not on the before build/);
  assert.match(noticed, /before build not checked/);
});
