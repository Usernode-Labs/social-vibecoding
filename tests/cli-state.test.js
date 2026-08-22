'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const state = require('../src/cli/state');
const main = require('../src/cli/main');
const {
  CLIENT_ID,
  IDENTITY_SCOPE,
  API_SCOPE,
  REQUIRED_SCOPES,
  REQUIRED_SCOPE_TEXT,
  PRODUCTION_ORIGIN,
  LOCAL_ORIGIN,
} = require('../src/services/cli-auth-constants');
const {
  hashSecret,
  makeAccessToken,
  makeDeviceCode,
} = require('../src/services/cli-auth');

test('profile origin normalization and profile grammar are fail closed', () => {
  assert.equal(state.canonicalOrigin('HTTPS://EXAMPLE.COM:443/'), 'https://example.com');
  assert.equal(state.canonicalOrigin('https://example.com:444/'), 'https://example.com:444');
  assert.equal(state.canonicalOrigin('http://localhost:3000/'), 'http://localhost:3000');
  assert.equal(state.canonicalOrigin('http://example.com/'), null);
  assert.equal(state.canonicalOrigin('https://example.com/a'), null);
  assert.equal(state.canonicalOrigin('https://u@example.com'), null);
  assert.match('lab_1', state.PROFILE_RE);
  assert.doesNotMatch('../lab', state.PROFILE_RE);
  assert.deepEqual(state.resolveProfile(state.defaultConfig(), 'local'), {
    name: 'local',
    origin: LOCAL_ORIGIN,
  });
});

test('OS account home, not HOME or XDG_CONFIG_HOME, selects user state', () => {
  const expected = state.userConfigDirectory();
  const oldHome = process.env.HOME;
  const oldXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = '/tmp/repository-controlled-home';
  process.env.XDG_CONFIG_HOME = '/tmp/repository-controlled-xdg';
  try {
    assert.equal(state.userConfigDirectory(), expected);
  } finally {
    if (oldHome == null) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldXdg == null) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdg;
  }
});

test('Windows state paths use the OS known folder and verified private ACLs', () => {
  const source = require('node:fs').readFileSync(
    require.resolve('../src/cli/state'),
    'utf8'
  );
  assert.match(source, /SpecialFolder\]::ApplicationData/);
  assert.match(source, /\$acl\.SetAccessRuleProtection/);
  assert.match(source, /AreAccessRulesProtected/);
  assert.match(source, /SecurityIdentifier/);
  assert.match(source, /ReparsePoint/);
});

test('version-1 config keeps production as default and protects built-in profiles', () => {
  const defaults = state.defaultConfig();
  assert.equal(defaults.default_profile, 'production');
  assert.deepEqual(defaults.profiles, {});
  assert.doesNotThrow(() => state.validateConfig(defaults));
  assert.throws(() => state.validateConfig({
    ...state.defaultConfig(),
    extra: true,
  }), /unsupported fields/);
  assert.throws(() => state.validateConfig({
    ...state.defaultConfig(),
    default_profile: 'missing',
  }), /does not exist/);
  assert.throws(() => state.validateConfig({
    ...state.defaultConfig(),
    profiles: { production: { origin: 'https://evil.example' } },
  }), /invalid profile/);
  assert.throws(
    () => state.resolveProfile(state.defaultConfig(), 'constructor'),
    /Unknown profile/
  );
  assert.doesNotThrow(() => state.validateConfig({
    ...state.defaultConfig(),
    default_profile: 'local',
  }));
  assert.throws(() => state.validateConfig({
    ...state.defaultConfig(),
    profiles: { local: { origin: 'http://127.0.0.1:3000' } },
  }), /cannot retarget/);
});

test('server list exposes built-in local without making it the default', async () => {
  const originalLoadConfig = state.loadConfig;
  let stdout = '';
  let stderr = '';
  state.loadConfig = async () => state.defaultConfig();
  try {
    assert.equal(await main.main(['auth', 'server', 'list'], {
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } },
    }), 0);
  } finally {
    state.loadConfig = originalLoadConfig;
  }
  assert.equal(stderr, '');
  assert.equal(
    stdout,
    `* production\t${PRODUCTION_ORIGIN}\n  local\t${LOCAL_ORIGIN}\n`
  );
});

test('server add cannot replace the built-in local profile', async () => {
  let stderr = '';
  assert.equal(await main.main([
    'auth',
    'server',
    'add',
    'local',
    LOCAL_ORIGIN,
  ], {
    stdout: { write: () => {} },
    stderr: { write: (chunk) => { stderr += chunk; } },
  }), 1);
  assert.match(stderr, /reserved profile name/);
});

test('credential records are exact, canonical, and scope bound', () => {
  const good = {
    access_token: makeAccessToken(),
    expires_at: new Date(Date.now() + 60000).toISOString(),
    scopes: [...REQUIRED_SCOPES],
    client_id: CLIENT_ID,
  };
  assert.equal(state.validateRecord(good), good);
  assert.doesNotThrow(() => state.validateRecord({
    ...good,
    expires_at: '2026-08-29T12:00:00Z',
  }));
  assert.doesNotThrow(() => state.validateRecord({
    ...good,
    expires_at: '2026-08-29T12:00:00.1Z',
  }));
  assert.doesNotThrow(() => state.validateRecord({
    ...good,
    expires_at: '2026-08-29T12:00:00.123456Z',
  }));
  assert.throws(() => state.validateRecord({
    ...good,
    expires_at: '2026-08-29T12:00:00+00:00',
  }), /malformed expiry/);
  assert.throws(() => state.validateRecord({
    ...good,
    expires_at: '2026-02-30T12:00:00Z',
  }), /malformed expiry/);
  assert.throws(() => state.validateRecord({ ...good, extra: true }), /unsupported fields/);
  assert.throws(() => state.validateRecord({ ...good, scopes: [] }), /unsupported client or scope/);
  assert.throws(() => state.validateRecord({ ...good, client_id: 'other' }), /unsupported client or scope/);

  const native = state.nativeRecordJson(good);
  assert.equal(state.parseNativeRecord(native).access_token, good.access_token);
  assert.throws(
    () => state.parseNativeRecord(JSON.stringify(good)),
    /missing, duplicate, or unsupported fields/
  );
  assert.throws(
    () => state.parseNativeRecord(JSON.stringify({ version: 2, ...good })),
    /unsupported version/
  );
});

test('durable credential JSON writes use private permissions and no backup', async () => {
  // realpath: on macOS os.tmpdir() sits under /var → /private/var, and the
  // CLI's config-path safety check rejects symlinked path components.
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sv-cli-state-')));
  await fs.chmod(directory, 0o700);
  const filename = path.join(directory, 'credentials.json');
  try {
    await state.durableWriteJson(filename, { version: 1, servers: {} });
    const stat = await fs.stat(filename);
    if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600);
    const entries = await fs.readdir(directory);
    assert.deepEqual(entries, ['credentials.json']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('state and origin locks serialize live owners and recover only stale dead owners', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sv-cli-lock-')));
  await fs.chmod(directory, 0o700);
  const filename = path.join(directory, 'operation.lock');
  try {
    const first = await state.acquireLock(filename, {
      operation: 'login',
      timeoutMs: 100,
      recoverAfterMs: 1000,
    });
    await assert.rejects(
      state.acquireLock(filename, {
        operation: 'login',
        timeoutMs: 50,
        recoverAfterMs: 1000,
      }),
      (err) => err.code === 'login_in_progress'
    );
    await first.release();

    await fs.writeFile(filename, JSON.stringify({
      version: 1,
      pid: 99999999,
      started_at: '2026-01-01T00:00:00.000Z',
      recover_after: '2026-01-01T00:00:01.000Z',
      attempt_id: '0123456789abcdef0123456789abcdef',
      operation: 'login',
      process_identity: '99999999:1',
    }), { mode: 0o600 });
    const recovered = await state.acquireLock(filename, {
      operation: 'login',
      timeoutMs: 100,
      recoverAfterMs: 1000,
    });
    assert.equal((await fs.lstat(filename)).isDirectory(), true);
    await recovered.release();

    const staleAttempt = 'fedcba9876543210fedcba9876543210';
    await fs.mkdir(filename, { mode: 0o700 });
    await fs.writeFile(path.join(filename, 'owner.json'), JSON.stringify({
      version: 1,
      pid: 99999999,
      started_at: '2026-01-01T00:00:00.000Z',
      recover_after: '2026-01-01T00:00:01.000Z',
      attempt_id: staleAttempt,
      operation: 'race',
      process_identity: '99999999:1',
    }), { mode: 0o600 });

    const contenders = await Promise.allSettled([
      state.acquireLock(filename, {
        operation: 'race', timeoutMs: 120, recoverAfterMs: 1000,
      }),
      state.acquireLock(filename, {
        operation: 'race', timeoutMs: 120, recoverAfterMs: 1000,
      }),
    ]);
    const winners = contenders.filter((result) => result.status === 'fulfilled');
    const losers = contenders.filter((result) => result.status === 'rejected');
    assert.equal(winners.length, 1, 'only one stale-lock contender may acquire');
    assert.equal(losers.length, 1);
    assert.equal(losers[0].reason.code, 'race_in_progress');
    assert.equal(
      (await fs.lstat(`${filename}.stale-${staleAttempt}`)).isDirectory(),
      true,
      'the attempt-specific tombstone remains to stop delayed recovery'
    );
    await winners[0].value.release();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('fallback credential persistence is journaled outside environment-selected homes', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sv-cli-fallback-')));
  await fs.chmod(home, 0o700);
  const originalUserInfo = os.userInfo;
  const originalPath = process.env.PATH;
  const account = originalUserInfo();
  os.userInfo = () => ({ ...account, homedir: home });
  process.env.PATH = '/definitively-unavailable-for-cli-state-test';
  const record = {
    access_token: makeAccessToken(),
    expires_at: '2026-08-30T00:00:00Z',
    scopes: [...REQUIRED_SCOPES],
    client_id: CLIENT_ID,
  };
  try {
    assert.equal(
      await state.storeCredential(PRODUCTION_ORIGIN, record, 'production'),
      'file'
    );
    const persisted = await state.getPersistedCredential(PRODUCTION_ORIGIN);
    assert.equal(persisted.backend, 'file');
    assert.equal(
      hashSecret(persisted.record.access_token) === hashSecret(record.access_token),
      true
    );
    await state.removePersistedCopies(
      PRODUCTION_ORIGIN,
      new Set(['file']),
      { forgetMarker: true }
    );
    assert.equal((await state.getPersistedCredential(PRODUCTION_ORIGIN)).record, null);
  } finally {
    os.userInfo = originalUserInfo;
    if (originalPath == null) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('Codex setup table contains only canonical launcher data and reviewed tools', () => {
  const document = main.setupToml({
    nodePath: '/usr/bin/node',
    scriptPath: '/checkout/tools/social-vibecoding',
    checkoutRoot: '/checkout',
    profile: 'production',
    forwardEnv: false,
    hookSha256: 'a'.repeat(64),
  });
  assert.match(document, /command = "\/usr\/bin\/node"/);
  assert.match(document, /"mcp"/);
  assert.match(document, /"social_vibecoding\.login_status"/);
  assert.match(document, /"social_vibecoding\.whoami"/);
  assert.match(document, /"social_vibecoding\.api_read"/);
  assert.match(document, /"social_vibecoding\.api_write"/);
  assert.match(document, /"social_vibecoding\.proposal_start"/);
  assert.match(document, /"social_vibecoding\.proposal_append_context"/);
  assert.match(document, /"social_vibecoding\.proposal_upload_image"/);
  assert.match(document, /"social_vibecoding\.proposal_push_commit"/);
  assert.match(document, /"social_vibecoding\.proposal_submit_build"/);
  assert.match(document, /"social_vibecoding\.proposal_status"/);
  assert.match(document, /"social_vibecoding\.proposal_promote"/);
  assert.match(document, /^approvals_reviewer = "user"$/m);
  assert.match(
    document,
    /\[mcp_servers\.social_vibecoding\.tools\."social_vibecoding\.proposal_promote"\]\napproval_mode = "prompt"/
  );
  assert.match(document, /\[\[hooks\.PreToolUse\]\]/);
  assert.match(document, /\[\[hooks\.UserPromptSubmit\]\]/);
  assert.match(document, /\[\[hooks\.UserPromptSubmit\.hooks\]\]/);
  assert.match(document, /additionalContextLimit = 256/);
  assert.match(document, /\[\[hooks\.PermissionRequest\]\]/);
  assert.match(document, /\[\[hooks\.PostToolUse\]\]/);
  assert.match(document, /\/checkout\/\.codex\/hooks\/promotion-approval\.js/);
  assert.match(document, /createHash\\\("sha256"\\\)|createHash\('sha256'\)/);
  assert.match(document, /a{64}/);
  assert.doesNotMatch(document, /\benv\s*=|bearer_token|SOCIAL_VIBECODING_TOKEN/);
  assert.doesNotMatch(document, new RegExp(PRODUCTION_ORIGIN));

  const forwarded = main.setupToml({
    nodePath: '/usr/bin/node',
    scriptPath: '/checkout/tools/social-vibecoding',
    checkoutRoot: '/checkout',
    profile: 'lab',
    forwardEnv: true,
    hookSha256: 'b'.repeat(64),
  });
  assert.match(
    forwarded,
    /env_vars = \["SOCIAL_VIBECODING_TOKEN", "SOCIAL_VIBECODING_SERVER"\]/
  );
  assert.ok(
    forwarded.indexOf('env_vars =')
      < forwarded.indexOf('[mcp_servers.social_vibecoding.tools.'),
    'forwarded MCP environment names stay in the server table'
  );
  assert.throws(() => main.setupToml({
    nodePath: '/usr/bin/node',
    scriptPath: '/checkout/tools/social-vibecoding',
    checkoutRoot: '/checkout',
    profile: 'production',
    forwardEnv: false,
    hookSha256: 'not-a-digest',
  }), /SHA-256/);
});

test('OpenCode setup config contains canonical launcher data and reviewed permissions', () => {
  const document = main.setupOpenCodeJsonc({
    nodePath: '/usr/bin/node',
    scriptPath: '/checkout/tools/social-vibecoding',
    profile: 'production',
  });
  assert.ok(document.startsWith(`${main.OPENCODE_GENERATED_HEADER}\n`));
  const config = JSON.parse(document.slice(main.OPENCODE_GENERATED_HEADER.length));
  assert.deepEqual(config.mcp.social_vibecoding, {
    type: 'local',
    command: [
      '/usr/bin/node',
      '/checkout/tools/social-vibecoding',
      'mcp',
      '--profile',
      'production',
    ],
    enabled: true,
  });
  assert.equal(config.permission['social_vibecoding_*'], 'deny');
  assert.equal(
    config.permission.social_vibecoding_social_vibecoding_proposal_promote,
    'ask'
  );
  assert.equal(
    config.permission.social_vibecoding_social_vibecoding_api_write,
    'allow'
  );
  assert.doesNotMatch(document, /bearer_token|SOCIAL_VIBECODING_TOKEN/);
  assert.doesNotMatch(document, new RegExp(PRODUCTION_ORIGIN));
});

test('Claude setup registers only the canonical credential-free stdio command', () => {
  const server = main.claudeMcpServer({
    nodePath: '/usr/bin/node',
    scriptPath: '/checkout/tools/social-vibecoding',
    profile: 'production',
  });
  assert.deepEqual(server, {
    type: 'stdio',
    command: '/usr/bin/node',
    args: [
      '/checkout/tools/social-vibecoding',
      'mcp',
      '--profile',
      'production',
    ],
  });
  assert.doesNotMatch(JSON.stringify(server), /env|bearer|token|https?:/i);

  const marker = main.claudeSetupMarker({
    checkoutRoot: '/checkout',
    profile: 'production',
    server,
  });
  assert.equal(main.validateClaudeSetupMarker(marker), marker);
  assert.throws(
    () => main.validateClaudeSetupMarker({ ...marker, unexpected: true }),
    /not generated/
  );
  assert.throws(
    () => main.validateClaudeSetupMarker({
      ...marker,
      server: { ...server, env: { SOCIAL_VIBECODING_TOKEN: 'secret' } },
    }),
    /not generated/
  );
  assert.throws(
    () => main.validateClaudeSetupMarker({
      ...marker,
      server: { ...server, args: [...server.args, '--extra'] },
    }),
    /not generated/
  );
  assert.throws(
    () => main.validateClaudeSetupMarker({
      ...marker,
      server: {
        ...server,
        args: ['/another-checkout/tools/social-vibecoding', ...server.args.slice(1)],
      },
    }),
    /not generated/
  );
});

test('Claude setup distinguishes an absent local MCP server from command failure', () => {
  const present = main.claudeServerExists(() => ({
    status: 0,
    signal: null,
    stdout: 'social_vibecoding:\n  Scope: Local config (private to you in this project)',
    stderr: '',
  }), '/checkout');
  assert.equal(present, true);

  const otherScope = main.claudeServerScope(() => ({
    status: 0,
    signal: null,
    stdout: 'social_vibecoding:\n  Scope: User config (available in all your projects)',
    stderr: '',
  }), '/checkout');
  assert.equal(otherScope, 'other');

  const absent = main.claudeServerExists(() => ({
    status: 1,
    signal: null,
    stdout: 'No MCP server named "social_vibecoding". Configured servers:',
    stderr: '',
  }), '/checkout');
  assert.equal(absent, false);

  assert.throws(() => main.claudeServerExists(() => ({
    status: 1,
    signal: null,
    stdout: '',
    stderr: 'configuration is invalid',
  }), '/checkout'), /could not inspect/);
  assert.throws(() => main.claudeServerExists(() => ({
    status: null,
    signal: null,
    error: { code: 'ENOENT' },
    stdout: '',
    stderr: '',
  }), '/checkout'), /not found on PATH/);
});

test('CLI usage advertises all agent setup commands', async () => {
  let stderr = '';
  assert.equal(await main.main([], {
    stdout: { write: () => {} },
    stderr: { write: (chunk) => { stderr += chunk; } },
  }), 2);
  assert.match(stderr, /social-vibecoding codex setup/);
  assert.match(stderr, /social-vibecoding claude setup/);
  assert.match(stderr, /social-vibecoding opencode setup/);
});

test('CLI option parsing rejects duplicates instead of applying last-one-wins', () => {
  assert.throws(
    () => main.parseOptions(
      ['--profile', 'production', '--profile', 'lab'],
      new Set(['--profile'])
    ),
    /Duplicate option/
  );
});

test('token protocol validation normalizes expiry and never accepts metadata drift', () => {
  const data = {
    access_token: makeAccessToken(),
    token_type: 'bearer',
    scope: REQUIRED_SCOPE_TEXT,
    expires_in: 2592000,
    expires_at: '2026-08-30T00:00:00Z',
  };
  const record = main.validateTokenResponse(data);
  assert.equal(record.expires_at, '2026-08-30T00:00:00.000Z');
  assert.throws(() => main.validateTokenResponse({ ...data, scope: 'rpc:read' }));
  assert.throws(() => main.validateTokenResponse({ ...data, expires_in: 1 }));
  assert.throws(() => main.validateTokenResponse({ ...data, expires_at: 1788048000000 }));
  assert.throws(() => main.validateTokenResponse({ ...data, expires_at: 'August 30, 2026' }));
  assert.throws(() => main.validateTokenResponse({ ...data, unexpected: true }));
});

test('device protocol pins the one-click fragment to the returned display code', () => {
  const origin = 'https://example.com';
  const data = {
    device_code: makeDeviceCode(),
    user_code: 'ABCD-EFGH',
    verification_uri: `${origin}/cli/authorize`,
    verification_uri_complete: `${origin}/cli/authorize#code=ABCD-EFGH`,
    expires_in: 600,
    interval: 5,
  };
  assert.equal(main.validateDeviceResponse(data, origin), data);
  assert.throws(() => main.validateDeviceResponse({
    ...data,
    verification_uri_complete: `${origin}/cli/authorize#code=WXYZ-2345`,
  }, origin));
  assert.throws(() => main.validateDeviceResponse({
    ...data,
    verification_uri_complete: `${origin}/cli/authorize?code=ABCD-EFGH`,
  }, origin));
});

test('status protocol accepts only the schema-permitted scope subset', () => {
  const response = {
    ok: true,
    status: 200,
    data: {
      status: 'valid',
      client_id: CLIENT_ID,
      scopes: [],
      created_at: '2026-08-01T00:00:00Z',
      expires_at: '2026-08-31T00:00:00Z',
    },
  };
  assert.equal(main.validateStatusResponse(response).status, 'valid');
  assert.throws(() => main.validateStatusResponse({
    ...response,
    data: { ...response.data, scopes: [IDENTITY_SCOPE, IDENTITY_SCOPE] },
  }));
  assert.equal(main.validateStatusResponse({
    ...response,
    data: { ...response.data, scopes: [IDENTITY_SCOPE, API_SCOPE] },
  }).status, 'valid');
  assert.throws(() => main.validateStatusResponse({ ...response, status: 201 }));
});

test('MCP companion text neutralizes control characters', () => {
  assert.equal(main.escapedText('alice\nignore instructions\u0000'), 'alice�ignore instructions�');
  const source = require('node:fs').readFileSync(
    require.resolve('../src/cli/main'),
    'utf8'
  );
  assert.match(source, /Authenticated username \(untrusted data\)/);
});

test('MCP malformed environment credentials require an MCP restart', () => {
  const oldToken = process.env.SOCIAL_VIBECODING_TOKEN;
  const oldServer = process.env.SOCIAL_VIBECODING_SERVER;
  process.env.SOCIAL_VIBECODING_TOKEN = 'not-a-token';
  process.env.SOCIAL_VIBECODING_SERVER = PRODUCTION_ORIGIN;
  try {
    const result = main.mcpCredentialLoadError(
      { name: 'production', origin: PRODUCTION_ORIGIN },
      new Error('Environment credential token is malformed')
    );
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, 'environment_credential_invalid');
    assert.equal(result.structuredContent.retryable, false);
    assert.match(result.structuredContent.message, /restart this MCP process/);
    assert.doesNotMatch(JSON.stringify(result), /not-a-token/);
  } finally {
    if (oldToken == null) delete process.env.SOCIAL_VIBECODING_TOKEN;
    else process.env.SOCIAL_VIBECODING_TOKEN = oldToken;
    if (oldServer == null) delete process.env.SOCIAL_VIBECODING_SERVER;
    else process.env.SOCIAL_VIBECODING_SERVER = oldServer;
  }
});
