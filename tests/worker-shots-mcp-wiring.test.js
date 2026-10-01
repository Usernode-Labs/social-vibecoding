'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const workerDir = path.join(__dirname, '..', 'worker');
const read = (name) => fs.readFileSync(path.join(workerDir, name), 'utf8');
const { browserAllowedOrigins, hostedAppSlugs, trustedHostedAppOrigins } = require('../worker/shots-hosted-origins');
const boundary = require('../worker/shots-boundary');
const hostedContract = require('../worker/shots-hosted-app-contract');

test('only the platform-owned hosted app for this exact run enters the shots catalog', () => {
  const runId = 'b'.repeat(32);
  const slug = hostedContract.hostedAppSlug(runId);
  const fixture = {
    id: hostedContract.HOSTED_APP_ID,
    slug,
    status: 'running',
    view_visibility: 'public',
    self_hosted: false,
    url: `https://${slug}.apps.example.invalid`,
    manifest_snapshot: hostedContract.hostedAppManifest(runId),
  };
  assert.deepEqual([...trustedHostedAppOrigins([fixture], 'https://platform.example.invalid', runId)],
    [[fixture.url, slug]]);
  assert.equal(trustedHostedAppOrigins([fixture], 'https://platform.example.invalid', 'c'.repeat(32)).size, 0);
  assert.equal(trustedHostedAppOrigins([{ ...fixture, id: 42 }], 'https://platform.example.invalid', runId).size, 0);
});

test('planner origin list rejects stale or malformed hosted-app catalogs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-origins-test-'));
  const file = path.join(dir, 'hosted.json');
  const base = 'http://base.example.invalid';
  const head = 'http://head.example.invalid';
  try {
    fs.writeFileSync(file, JSON.stringify({
      version: 2, baseOrigin: base, headOrigin: head,
      apps: [{ origin: 'https://app.example.invalid', slug: 'real-app' }],
    }));
    assert.deepEqual(browserAllowedOrigins(base, head, file), [base, head, 'https://app.example.invalid']);
    assert.deepEqual(hostedAppSlugs(file, base, head), ['real-app']);
    assert.throws(() => browserAllowedOrigins(base, head, ''), /path is missing/);
    assert.throws(() => browserAllowedOrigins(head, base, file), /does not match/);
    fs.writeFileSync(file, JSON.stringify({
      version: 2, baseOrigin: base, headOrigin: head,
      apps: [{ origin: 'http://127.0.0.1:3000/path', slug: 'real-app' }],
    }));
    assert.throws(() => browserAllowedOrigins(base, head, file), /origin is invalid/);
    fs.writeFileSync(file, JSON.stringify({
      version: 2, baseOrigin: base, headOrigin: head,
      apps: [{ origin: 'https://app.example.invalid', slug: 'real-app' },
        { origin: 'https://other.example.invalid', slug: 'real-app' }],
    }));
    assert.throws(() => hostedAppSlugs(file, base, head), /catalog entry is invalid/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SHOTS_TOOLS = ['get_brief', 'save_shot', 'save_clip', 'skip_change', 'note_change', 'fail_request'];
const RETIRED_TOOLS = /evidence_(?:get_context|run_plan|finish|capture|report_blocker|set_request_failure|reset_pair|reset_side)/;

// Run the real config writer against a temporary state directory.
function writeConfig(dir, extra = {}) {
  const hostedFile = path.join(dir, 'hosted-origins.json');
  if (!fs.existsSync(hostedFile)) {
    fs.writeFileSync(hostedFile, JSON.stringify({
      version: 2, baseOrigin: 'http://base.example.invalid',
      headOrigin: 'http://head.example.invalid',
      apps: [{ origin: 'https://hosted.example.invalid', slug: 'hosted-app' }],
    }));
  }
  const output = path.join(dir, `mcp-${crypto.randomUUID()}.json`);
  const env = {
    ...process.env,
    SHOTS_BROWSER_STATE_DIR: path.join(dir, 'state'),
    SHOTS_PROXY_SERVER: 'http://127.0.0.1:17891',
    SHOTS_BASE_ORIGIN: 'http://base.example.invalid',
    SHOTS_HEAD_ORIGIN: 'http://head.example.invalid',
    SHOTS_HOSTED_ORIGINS_FILE: hostedFile,
    SHOTS_DIR: path.join(dir, 'shots'),
  };
  delete env.SHOTS_RECORD_CLIPS;
  // An undefined value leaves that variable out entirely.
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  execFileSync(process.execPath, [path.join(workerDir, 'write-shots-mcp-config.js'), output], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { output, config: JSON.parse(fs.readFileSync(output, 'utf8')) };
}

test('the shots agent launches Playwright through the content-free timing observer', () => {
  const dockerfile = read('Dockerfile');
  const claudeRunner = read('run-cc.sh');
  const codexRunner = read('run-codex-agent.sh');

  assert.match(dockerfile, /npm install -g @playwright\/mcp@\$\{PLAYWRIGHT_MCP_VERSION\}/);
  assert.match(dockerfile, /command -v mcp-server-playwright/);
  assert.match(dockerfile, /RUN node \/usr\/local\/bin\/verify-shots-browser-mcp\.js/);
  assert.match(dockerfile, /RUN node \/usr\/local\/bin\/verify-shots-browser-auth\.js/);
  assert.match(dockerfile, /COPY shots-mcp\.js \/usr\/local\/bin\/shots-mcp\.js/);
  assert.match(claudeRunner, /command -v mcp-server-playwright[^\n]*\n\s*\|\| die/);
  assert.match(dockerfile, /COPY shots-browser-observer\.js \/usr\/local\/bin\/shots-browser-observer\.js/);
  assert.match(claudeRunner, /SHOTS_BROWSER_DIAGNOSTIC_FILE/);
  // Every shots turn runs on Claude Code. The Codex runner has no shots
  // path: it refuses MODE=shots and starts no shots browser.
  assert.match(codexRunner, /\n\s+shots\) die "shots turns run on Claude Code \(run-cc\.sh\)" ;;\n/);
  assert.doesNotMatch(codexRunner, /shots-browser-observer\.js|SHOTS_BROWSER_DIAGNOSTIC_FILE|--proxy-server/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-config-test-'));
  try {
    const { config } = writeConfig(dir);
    for (const [server, state] of [
      ['browser_member', 'member.json'],
      ['browser_admin', 'read_only_admin.json'],
      ['browser_full_admin', 'full_admin.json'],
    ]) {
      const args = config.mcpServers[server].args;
      assert.equal(config.mcpServers[server].command, 'node');
      assert.equal(args[0], '/usr/local/bin/shots-browser-observer.js');
      assert.ok(args.includes(path.join(dir, 'state', state)));
      // No origin allowlist: the shots proxy is the boundary (shots-boundary.js).
      assert.ok(!args.includes('--allowed-origins'));
      assert.ok(args.includes('--no-sandbox'));
      assert.ok(args.includes('--caps'));
      assert.ok(args.includes('vision'));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.match(read('worker-run.sh'), /"--browser", "chromium", "--headless", "--isolated", "--no-sandbox"/);
  assert.match(claudeRunner, /SHOTS_HOSTED_ORIGINS_FILE/);
});

test('the browsers reach the public internet only through the shots proxy, and the catalog is still checked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-egress-config-'));
  try {
    for (const assets of [undefined, '0', '1']) {
      const { config } = writeConfig(dir, { SHOTS_PLATFORM_ASSETS: assets });
      for (const server of ['browser_member', 'browser_admin', 'browser_full_admin']) {
        const args = config.mcpServers[server].args;
        assert.ok(!args.some((arg) => /allowed-origins|blocked-origins|tailwindcss/.test(arg)), server);
        assert.match(args[args.indexOf('--proxy-server') + 1], /^http:\/\/127\.0\.0\.1:\d+$/, server);
        // Loopback goes through the proxy too, which refuses it.
        assert.equal(args[args.indexOf('--proxy-bypass') + 1], '<-loopback>', server);
      }
    }
    // A catalog that does not match the run's pair still fails before any browser starts.
    fs.writeFileSync(path.join(dir, 'hosted-origins.json'), JSON.stringify({
      version: 2, baseOrigin: 'http://other.example.invalid', headOrigin: 'http://head.example.invalid', apps: [],
    }));
    assert.throws(() => writeConfig(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // The proxy, the observer and the bridge each load the boundary from the image.
  assert.match(read('Dockerfile'), /COPY shots-boundary\.js \/usr\/local\/bin\/shots-boundary\.js/);
  for (const file of ['shots-origin-proxy.js', 'shots-browser-observer.js', 'shots-mcp.js']) {
    assert.match(read(file), /require\('\.\/shots-boundary'\)/, file);
  }
});

test('the config writer gives each persona its own shots directory and records clips only when asked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-shots-config-'));
  try {
    const shotsDir = path.join(dir, 'shots');
    const { output, config } = writeConfig(dir, {
      SHOTS_JWT: 'secret-shots-jwt', SHOTS_MEMBER_TOKEN: 'secret-member-token',
    });
    assert.deepEqual(Object.keys(config.mcpServers).sort(),
      ['browser_admin', 'browser_full_admin', 'browser_member', 'shots']);
    // The bridge is named "shots" (Claude sees mcp__shots__*) and its
    // credentials come from the environment, never from this file.
    assert.deepEqual(config.mcpServers.shots, { command: 'node', args: ['/usr/local/bin/shots-mcp.js'] });
    const text = fs.readFileSync(output, 'utf8');
    assert.doesNotMatch(text, /secret-shots-jwt|secret-member-token/);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);

    for (const [server, persona] of [
      ['browser_member', 'member'], ['browser_admin', 'admin'], ['browser_full_admin', 'full_admin'],
    ]) {
      const args = config.mcpServers[server].args;
      assert.equal(args.filter((arg) => arg === '--output-dir').length, 1);
      assert.equal(args[args.indexOf('--output-dir') + 1], path.join(shotsDir, persona));
      assert.ok(fs.statSync(path.join(shotsDir, persona)).isDirectory(), `${persona} directory is created`);
      assert.equal(args.some((arg) => arg.startsWith('--save-video')), false, 'no video unless a change is motion');
    }

    const clips = writeConfig(dir, { SHOTS_RECORD_CLIPS: '1' }).config;
    for (const server of ['browser_member', 'browser_admin', 'browser_full_admin']) {
      assert.equal(clips.mcpServers[server].args.filter((arg) => arg === '--save-video=1280x800').length, 1);
      assert.equal(clips.mcpServers[server].args.filter((arg) => arg.startsWith('--save-video')).length, 1);
    }
    // Recorded at the motion screen's own size, so a phone clip fills its frame.
    const phone = writeConfig(dir, { SHOTS_RECORD_CLIPS: '1', SHOTS_CLIP_SIZE: '390x844' }).config;
    assert.ok(phone.mcpServers.browser_member.args.includes('--save-video=390x844'));
    for (const odd of ['390', '390x844 --flag', '0x0', 'x']) {
      const fallback = writeConfig(dir, { SHOTS_RECORD_CLIPS: '1', SHOTS_CLIP_SIZE: odd }).config;
      assert.ok(fallback.mcpServers.browser_member.args.includes('--save-video=1280x800'), odd);
    }
    assert.equal(writeConfig(dir, { SHOTS_CLIP_SIZE: '390x844' }).config.mcpServers.browser_member.args
      .some((arg) => arg.startsWith('--save-video')), false, 'a size alone records nothing');
    for (const value of ['0', 'true', 'yes', '']) {
      const off = writeConfig(dir, { SHOTS_RECORD_CLIPS: value }).config;
      for (const server of ['browser_member', 'browser_admin', 'browser_full_admin']) {
        assert.equal(off.mcpServers[server].args.some((arg) => arg.startsWith('--save-video')), false,
          `SHOTS_RECORD_CLIPS=${JSON.stringify(value)} records nothing`);
      }
    }

    // Without a shots directory there is nowhere safe to save, so no config.
    for (const missing of [undefined, '']) {
      assert.throws(() => writeConfig(dir, { SHOTS_DIR: missing }), /inputs are incomplete/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the Claude runner gives the shots bridge its directory; the Codex runner has no shots bridge', () => {
  const claudeRunner = read('run-cc.sh');
  const codexRunner = read('run-codex-agent.sh');
  const workerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'worker.js'), 'utf8');
  // Every shots turn takes shots now; nothing depends on a mode flag.
  assert.match(claudeRunner, /export SHOTS_DIR="\$SHOTS_TMP\/shots"/);
  assert.match(claudeRunner,
    /mkdir -p "\$SHOTS_DIR\/member" "\$SHOTS_DIR\/admin" "\$SHOTS_DIR\/full_admin"/);
  assert.doesNotMatch(claudeRunner, /EVIDENCE_MODE/);
  assert.doesNotMatch(claudeRunner, /EVIDENCE_COMPLETION_REMINDER/);
  assert.doesNotMatch(claudeRunner, RETIRED_TOOLS);
  // Claude's MCP config is written after the directory exists.
  assert.ok(claudeRunner.indexOf('export SHOTS_DIR=')
    < claudeRunner.indexOf('node /usr/local/bin/write-shots-mcp-config.js'));

  // Every shots turn runs on Claude Code, so the Codex runner registers no
  // shots bridge and takes no shots directory.
  assert.doesNotMatch(codexRunner, /\[mcp_servers\.(?:shots|evidence|visual_evidence)\]|SHOTS_DIR|SHOTS_RECORD_CLIPS/);
  assert.doesNotMatch(codexRunner, RETIRED_TOOLS);
  for (const tool of SHOTS_TOOLS) assert.doesNotMatch(codexRunner, new RegExp(`"${tool}"`));

  // The platform turns the run's decision into the runner's 0/1 flag, and
  // refuses anything that is not a boolean.
  assert.match(workerSource, /shotsRecordClips = false,/);
  assert.match(workerSource, /SHOTS_RECORD_CLIPS: shotsRecordClips \? '1' : '0'/);
  assert.match(workerSource, /if \(typeof shotsRecordClips !== 'boolean'\) \{\n\s*throw new Error/);

  // The image smoke test exercises the same writer with clips on and proves
  // a named screenshot lands in the browser's shots directory.
  const smoke = read('verify-shots-browser-mcp.js');
  assert.match(smoke, /SHOTS_DIR: path\.join\(dir, 'shots'\)/);
  assert.match(smoke, /SHOTS_RECORD_CLIPS: '1'/);
  assert.match(smoke, /arguments: \{ filename: 'image-smoke\.png' \}/);
  assert.match(smoke, /fs\.existsSync\(path\.join\(outputDir, 'image-smoke\.png'\)\)/);
});

// Load worker/shots-mcp.js with the MCP SDK and zod replaced by recorders,
// so its tool handlers run for real against a temporary shots directory and a
// fake platform. Nothing is spawned and nothing leaves the process.
function loadBridge(env, platformFetch) {
  const tools = new Map();
  let serverInfo = null;
  class McpServer {
    constructor(info) { serverInfo = info; }
    registerTool(name, _spec, handler) { tools.set(name, handler); }
    connect() { return Promise.resolve(); }
  }
  const schema = new Proxy(function schemaStub() {}, {
    get: () => () => schema,
    apply: () => schema,
  });
  const bridgeRequire = (request) => {
    if (/@modelcontextprotocol\/sdk\/.*\/server\/mcp\.js$/.test(request)) return { McpServer };
    if (/@modelcontextprotocol\/sdk\/.*\/server\/stdio\.js$/.test(request)) return { StdioServerTransport: class {} };
    if (/\/zod$/.test(request)) return { z: schema };
    return require(request.startsWith('.') ? path.join(workerDir, request) : request);
  };
  const bridgeProcess = {
    env,
    exit: (code) => { throw new Error(`bridge exited ${code}`); },
    stderr: { write() {} },
  };
  const source = read('shots-mcp.js').replace(/^#!.*\n/, '');
  new Function('require', 'process', 'fetch', source)(bridgeRequire, bridgeProcess, platformFetch);
  return { tools, serverInfo };
}

function bridgeFixture(t, { declaredChanges } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-bridge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shotsDir = path.join(dir, 'shots');
  for (const persona of ['member', 'admin', 'full_admin']) fs.mkdirSync(path.join(shotsDir, persona), { recursive: true });
  const hostedFile = path.join(dir, 'hosted-origins.json');
  fs.writeFileSync(hostedFile, JSON.stringify({
    version: 2, baseOrigin: 'http://base.example.invalid', headOrigin: 'http://head.example.invalid',
    apps: [{ origin: 'https://hosted.example.invalid', slug: 'hosted-app' }],
  }));
  const runId = 'a'.repeat(32);
  const context = {
    origins: { base: 'http://base.example.invalid', head: 'http://head.example.invalid' },
    addresses: { before: 'http://base.example.invalid', after: 'http://head.example.invalid' },
    declaredChanges: declaredChanges || [
      { id: 'invite-suggestions', persona: 'member', intent: { animation: 'steps' } },
      { id: 'saved-toast', persona: 'member', intent: { animation: 'motion' } },
      { id: 'admin-banner', persona: 'read_only_admin', intent: { animation: 'motion' } },
      {
        id: 'load-error', persona: 'member',
        intent: { animation: 'none', controlledFailurePath: '/api/lists/demo' },
      },
    ],
  };
  const calls = [];
  const platformFetch = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({
      origin: parsed.origin, path: parsed.pathname, query: Object.fromEntries(parsed.searchParams),
      method: init.method || 'GET', headers: init.headers || {}, body: init.body,
    });
    let payload;
    if (parsed.pathname === '/__usernode_shots_control/request-failure') {
      payload = { enabled: JSON.parse(init.body).enabled, hitCount: 0 };
    } else if (parsed.pathname.endsWith('/context')) {
      payload = { ok: true, context };
    } else {
      payload = { ok: true, result: { accepted: parsed.pathname.split('/').pop() } };
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const env = {
    PLATFORM_URL: 'http://platform.test:3000/',
    SHOTS_RUN_ID: runId,
    SHOTS_JWT: 'run-scoped-jwt',
    SHOTS_PROXY_SERVER: 'http://127.0.0.1:17891',
    SHOTS_PROXY_CONTROL_TOKEN: 'c'.repeat(64),
    SHOTS_DIR: shotsDir,
    SHOTS_HOSTED_ORIGINS_FILE: hostedFile,
  };
  const { tools, serverInfo } = loadBridge(env, platformFetch);
  const call = async (name, args = {}) => {
    const result = await tools.get(name)(args);
    return { isError: result.isError === true, value: JSON.parse(result.content[0].text) };
  };
  return { dir, shotsDir, runId, env, calls, tools, serverInfo, call, platformFetch };
}

test('the shots bridge offers exactly six tools and talks only to its own run', async (t) => {
  const bridge = bridgeFixture(t);
  assert.equal(bridge.serverInfo.name, 'usernode-before-after-shots');
  assert.deepEqual([...bridge.tools.keys()], SHOTS_TOOLS);
  assert.deepEqual([...read('shots-mcp.js').matchAll(/registerTool\('([a-z_]+)'/g)].map((match) => match[1]),
    SHOTS_TOOLS);

  const brief = await bridge.call('get_brief');
  assert.equal(brief.isError, false);
  assert.deepEqual(brief.value.eligibleHostedAppSlugs, ['hosted-app']);
  assert.equal(brief.value.declaredChanges.length, 4);

  const skip = await bridge.call('skip_change', { reason: 'Every screen shows a sign-in page.' });
  assert.equal(skip.isError, false);
  const one = await bridge.call('skip_change', { reason: 'Needs a second member.', change: 'invite-suggestions' });
  assert.equal(one.isError, false);
  const note = await bridge.call('note_change', { change: 'saved-toast', note: 'The undo link needs a second list.' });
  assert.equal(note.isError, false);

  assert.deepEqual(bridge.calls.map((sent) => [sent.method, sent.origin, sent.path]), [
    ['GET', 'http://platform.test:3000', `/api/internal/shots/${bridge.runId}/context`],
    ['POST', 'http://platform.test:3000', `/api/internal/shots/${bridge.runId}/skip`],
    ['POST', 'http://platform.test:3000', `/api/internal/shots/${bridge.runId}/skip`],
    ['POST', 'http://platform.test:3000', `/api/internal/shots/${bridge.runId}/note`],
  ]);
  assert.ok(bridge.calls.every((sent) => sent.headers.authorization === 'Bearer run-scoped-jwt'));
  assert.deepEqual(JSON.parse(bridge.calls[1].body), { change: null, reason: 'Every screen shows a sign-in page.' });
  assert.deepEqual(JSON.parse(bridge.calls[2].body), { change: 'invite-suggestions', reason: 'Needs a second member.' });
  assert.deepEqual(JSON.parse(bridge.calls[3].body), { change: 'saved-toast', note: 'The undo link needs a second list.' });

  // A bridge without its run, token or platform refuses to start.
  for (const broken of [{ SHOTS_JWT: '' }, { SHOTS_RUN_ID: 'not-a-run' }, { PLATFORM_URL: 'file:///etc' }]) {
    assert.throws(() => loadBridge({ ...bridge.env, ...broken }, bridge.platformFetch), /bridge exited 1/);
  }
});

// The observer stamps each screenshot with the site it was taken on, and each
// closed session with every site it showed (shots-boundary.js); these stand
// in for it.
const HEAD = 'http://head.example.invalid';
const BASE = 'http://base.example.invalid';
function stamp(bridge, persona, name, pageUrl) {
  const outputDir = path.join(bridge.shotsDir, persona);
  boundary.stampScreenshot(outputDir, path.join(outputDir, name), pageUrl);
}
const uploads = (bridge) => bridge.calls.filter((sent) => sent.path.endsWith('/shot'));

test('save_shot publishes only a plain .png the browser saved in a persona directory', async (t) => {
  const bridge = bridgeFixture(t);
  const image = Buffer.from('png bytes the platform will check');
  fs.writeFileSync(path.join(bridge.shotsDir, 'admin', 'invite-desktop-after.png'), image);
  stamp(bridge, 'admin', 'invite-desktop-after.png', `${HEAD}/#invite`);
  const shot = { change: 'invite-suggestions', screen: 'desktop', side: 'after' };

  const saved = await bridge.call('save_shot', { shots: [{ ...shot, file: 'invite-desktop-after.png' }] });
  assert.equal(saved.isError, false);
  assert.equal(saved.value.saved, 1);
  assert.deepEqual(bridge.calls.map((sent) => sent.path),
    [`/api/internal/shots/${bridge.runId}/context`, `/api/internal/shots/${bridge.runId}/shot`],
    'the run\'s own addresses come from its brief');
  const [sent] = uploads(bridge);
  assert.equal(sent.method, 'POST');
  assert.deepEqual(sent.query, { ...shot, kind: 'screen' });
  assert.equal(sent.headers['content-type'], 'application/octet-stream');
  assert.ok(Buffer.from(sent.body).equals(image));

  // The path the browser reported is reduced to its name inside the shots
  // directories; it cannot lead anywhere else.
  assert.equal((await bridge.call('save_shot', { shots: [{
    ...shot, kind: 'element', file: '../../state/invite-desktop-after.png',
  }] })).isError, false);
  assert.equal(uploads(bridge)[1].query.kind, 'element');
  assert.ok(Buffer.from(uploads(bridge)[1].body).equals(image));

  // Browser storage state, hidden or oddly named files, and links are never read.
  fs.writeFileSync(path.join(bridge.dir, 'member.json'), '{"cookies":["secret"]}');
  fs.writeFileSync(path.join(bridge.dir, 'outside.png'), image);
  fs.symlinkSync(path.join(bridge.dir, 'outside.png'), path.join(bridge.shotsDir, 'member', 'linked.png'));
  fs.writeFileSync(path.join(bridge.shotsDir, 'member', '.hidden.png'), image);
  for (const [file, code] of [
    ['../state/member.json', 'invalid_shot_file'],
    [path.join(bridge.dir, 'member.json'), 'invalid_shot_file'],
    ['.hidden.png', 'invalid_shot_file'],
    ['shot.png.txt', 'invalid_shot_file'],
    ['linked.png', 'shot_file_not_found'],
    ['outside.png', 'shot_file_not_found'],
    ['never-taken.png', 'shot_file_not_found'],
  ]) {
    const refused = await bridge.call('save_shot', { shots: [{ ...shot, file }] });
    assert.equal(refused.isError, true, `${file} must be refused`);
    assert.equal(refused.value.results[0].error.code, code, file);
  }
  assert.equal(uploads(bridge).length, 2, 'a refused file never reaches the platform');

  // Several files in one call, and one screenshot for two changes: each is
  // its own upload, and a refused one does not stop the rest.
  const batch = await bridge.call('save_shot', { shots: [
    { ...shot, file: 'invite-desktop-after.png' },
    { ...shot, change: 'saved-toast', file: 'invite-desktop-after.png' },
    { ...shot, kind: 'element', file: 'never-taken.png' },
  ] });
  assert.equal(batch.isError, false, 'something saved, so the call is not an error');
  assert.equal(batch.value.saved, 2);
  assert.equal(batch.value.refused, 1);
  assert.equal(batch.value.results[2].error.code, 'shot_file_not_found');
  assert.deepEqual(uploads(bridge).slice(2).map((sent) => sent.query.change), ['invite-suggestions', 'saved-toast']);
});

test('save_shot publishes a shot only from its own side\'s address', async (t) => {
  const bridge = bridgeFixture(t);
  const member = path.join(bridge.shotsDir, 'member');
  const take = (name, pageUrl, pixels = name) => {
    fs.writeFileSync(path.join(member, name), pixels);
    if (pageUrl !== undefined) stamp(bridge, 'member', name, pageUrl);
  };
  const save = (side, file) => bridge.call('save_shot', { shots: [
    { change: 'invite-suggestions', screen: 'desktop', side, file },
  ] });

  take('before.png', `${BASE}/#home`);
  take('after.png', `${HEAD}/#home?x=1`);
  take('another-site.png', 'https://example.com/');
  take('blank.png', 'about:blank');
  take('unstamped.png');
  take('replaced.png', `${HEAD}/`);
  fs.writeFileSync(path.join(member, 'replaced.png'), 'a download that took its name');

  assert.equal((await save('before', 'before.png')).isError, false);
  assert.equal((await save('after', 'after.png')).isError, false);
  for (const [side, file] of [
    ['after', 'before.png'],
    ['before', 'after.png'],
    ['after', 'another-site.png'],
    ['after', 'blank.png'],
    ['after', 'unstamped.png'],
    ['after', 'replaced.png'],
  ]) {
    const refused = await save(side, file);
    assert.equal(refused.isError, true, `${side} ${file} must be refused`);
    assert.equal(refused.value.results[0].error.code, 'shot_not_on_app', `${side} ${file}`);
    assert.match(refused.value.results[0].error.message, new RegExp(`the ${side} address`));
  }
  assert.deepEqual(uploads(bridge).map((sent) => Buffer.from(sent.body).toString()), ['before.png', 'after.png']);
  assert.equal(bridge.calls.filter((sent) => sent.path.endsWith('/context')).length, 1, 'the brief is read once');
});

test('save_clip publishes the newest recording and retires every older one', async (t) => {
  const bridge = bridgeFixture(t);
  const member = path.join(bridge.shotsDir, 'member');
  const record = (dir, name, content, secondsAgo) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    const when = new Date(Date.now() - secondsAgo * 1000);
    fs.utimesSync(file, when, when);
  };
  // What the observer writes as each recorded session closes, after its clip.
  const closed = (dir, ...pages) => boundary.recordSession(dir, pages);
  const clip = (change, side) => bridge.call('save_clip', { change, screen: 'desktop', side });
  const lastBody = () => Buffer.from(bridge.calls.at(-1).body).toString();

  // Only a declared motion change takes a clip, and nothing is read otherwise.
  assert.equal((await clip('invite-suggestions', 'before')).value.code, 'clip_not_needed');
  assert.equal((await clip('not-declared', 'before')).value.code, 'unknown_change');
  assert.equal((await clip('saved-toast', 'before')).value.code, 'clip_not_found');
  assert.ok(bridge.calls.every((sent) => sent.path.endsWith('/context')));

  // The stills session closed first; the motion session after it.
  record(member, 'stills-session.webm', 'stills', 60);
  record(member, 'motion-before.webm', 'motion before', 10);
  record(member, 'notes.txt', 'not a clip', 0);
  closed(member, `${BASE}/#lists`);
  const before = await clip('saved-toast', 'before');
  assert.equal(before.isError, false);
  assert.deepEqual(bridge.calls.at(-1).query,
    { change: 'saved-toast', screen: 'desktop', side: 'before', kind: 'clip' });
  assert.equal(lastBody(), 'motion before');

  // Both were retired, so the stale stills session can never be published.
  assert.equal((await clip('saved-toast', 'after')).value.code, 'clip_not_found');
  // A second back: a file's own timestamps come from a coarser clock than Date.now().
  record(member, 'motion-after.webm', 'motion after', 1);
  closed(member, `${HEAD}/#lists`);
  assert.equal((await clip('saved-toast', 'after')).isError, false);
  assert.equal(lastBody(), 'motion after');

  // A read-only admin's browser records into the admin directory.
  const admin = path.join(bridge.shotsDir, 'admin');
  record(admin, 'banner.webm', 'admin banner', 1);
  closed(admin, `${BASE}/`);
  assert.equal((await clip('admin-banner', 'before')).isError, false);
  assert.equal(lastBody(), 'admin banner');

  // A link is not a recording.
  fs.writeFileSync(path.join(bridge.dir, 'elsewhere.webm'), 'not from this browser');
  fs.symlinkSync(path.join(bridge.dir, 'elsewhere.webm'), path.join(member, 'linked.webm'));
  assert.equal((await clip('saved-toast', 'after')).value.code, 'clip_not_found');
  assert.equal(uploads(bridge).length, 3);
});

test('save_clip publishes a recording only when its whole session stayed on its side\'s address', async (t) => {
  const bridge = bridgeFixture(t);
  const member = path.join(bridge.shotsDir, 'member');
  // A second back by default: a file's own timestamps come from a coarser
  // clock than Date.now(), so a record written next could read as older.
  const recorded = (name, secondsAgo = 1) => {
    const file = path.join(member, name);
    fs.writeFileSync(file, name);
    const when = new Date(Date.now() - secondsAgo * 1000);
    fs.utimesSync(file, when, when);
  };
  const clip = (side) => bridge.call('save_clip', { change: 'saved-toast', screen: 'desktop', side });
  const refusedWith = async (side) => {
    const refused = await clip(side);
    assert.equal(refused.isError, true);
    assert.equal(refused.value.code, 'shot_not_on_app');
    return refused.value.message;
  };

  // No session record at all.
  recorded('first.webm');
  assert.match(await refusedWith('after'), /cannot be told/);
  // The session left the address, or it was the other side's.
  boundary.recordSession(member, [`${HEAD}/`, 'https://example.com/']);
  assert.match(await refusedWith('after'), /not taken on the after address/);
  boundary.recordSession(member, [`${HEAD}/`]);
  assert.match(await refusedWith('before'), /not taken on the before address/);
  // A clip newer than the record came from a session no record covers.
  recorded('second.webm', -5);
  assert.match(await refusedWith('after'), /cannot be told/);
  assert.equal(uploads(bridge).length, 0);

  // Recorded again on the address, it is published.
  const second = path.join(member, 'second.webm');
  const earlier = new Date(Date.now() - 1000);
  fs.utimesSync(second, earlier, earlier);
  boundary.recordSession(member, [`${HEAD}/#lists`]);
  assert.equal((await clip('after')).isError, false);
  assert.equal(Buffer.from(uploads(bridge)[0].body).toString(), 'second.webm');
});

test('fail_request only toggles an API path a change declared', async (t) => {
  const bridge = bridgeFixture(t);
  const refused = await bridge.call('fail_request', { path: '/api/other', enabled: true });
  assert.equal(refused.value.code, 'undeclared_controlled_failure');
  assert.ok(bridge.calls.every((sent) => sent.path.endsWith('/context')));

  const enabled = await bridge.call('fail_request', { path: '/api/lists/demo', enabled: true });
  assert.deepEqual(enabled, { isError: false, value: { ok: true, path: '/api/lists/demo', enabled: true, hitCount: 0 } });
  const control = bridge.calls.at(-1);
  assert.equal(control.origin, 'http://127.0.0.1:17891');
  assert.equal(control.path, '/__usernode_shots_control/request-failure');
  assert.equal(control.headers['x-shots-control-token'], 'c'.repeat(64));
  assert.deepEqual(JSON.parse(control.body), { path: '/api/lists/demo', enabled: true });
});
