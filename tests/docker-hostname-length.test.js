// Container hostnames are clamped to 63 bytes; container NAMES are not —
// and because they are not, every container also carries a short, resolvable
// network ALIAS.
//
// Why this test is worth its weight: Linux caps a hostname at
// HOST_NAME_MAX (64 bytes) and runc's sethostname() returns EINVAL above
// it, so `docker run --hostname <65+ chars>` fails during container init
// with nothing but "error during container init: sethostname: invalid
// argument". Staging previews are named
// `usernode-staging-<slug>--<sessionId>`, and a real 43-character app slug
// plus a 4-digit session id lands at 66 — that preview could never boot,
// and because the name is deterministic every retry failed identically.
//
// The other half matters just as much: --name must stay byte-identical.
// services/staging-reap parses session ids back out of it, staging_container_id
// and staging_runtime_name persist it, and `docker` itself is addressed by it.
// Clamping the name would break all of that; clamping the hostname is
// invisible, because nothing resolves a container by its hostname.
//
// #1381 is the correction to the sentence that used to sit here — "Docker's
// embedded DNS resolves container names and network aliases", offered as the
// reason the long name was still fine. It resolves them only when they are
// legal DNS labels. A 66-byte name is not one, so the same container that now
// boots is unreachable: the capture browser gets ERR_NAME_NOT_RESOLVED on
// every route and the proposal is scored as failing. The fix is a second,
// short identity — `--network-alias usernode-staging-s<sessionId>` — attached
// alongside the unchanged name. These tests pin both halves: the name is not
// touched, and the alias is always there.
//
// Run with: node --test tests/docker-hostname-length.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const MAX_HOSTNAME = 63;

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// services/docker closes over `promisify(execFile)` at require time, so the
// seam is child_process — stub it, then load docker fresh.
function loadDocker(respond) {
  const ids = {
    childProcess: require.resolve('child_process'),
    logger: require.resolve('../src/services/logger'),
    subject: require.resolve('../src/services/docker'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const calls = [];
  const fakeExecFile = (cmd, args) => {
    calls.push({ cmd, args });
    if (respond) {
      const r = respond(cmd, args);
      if (r !== undefined) return Promise.resolve(r).then((v) => v || { stdout: '', stderr: '' });
    }
    return Promise.resolve({ stdout: 'deadbeefcafe0000\n', stderr: '' });
  };
  fakeExecFile[require('util').promisify.custom] = fakeExecFile;

  stub(ids.childProcess, { execFile: fakeExecFile, spawn: () => { throw new Error('unused'); } });
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  delete require.cache[ids.subject];
  const docker = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { docker, calls, restore };
}

function flagValue(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

// The exact name that broke in production: app slug
// `workquest-escape-from-the-underclass-831ec5` (43 chars), dev session
// 3539. 66 characters — two over HOST_NAME_MAX.
const WORKQUEST = 'usernode-staging-workquest-escape-from-the-underclass-831ec5--3539';

test('the WorkQuest session-3539 name keeps its --name and gets a clamped --hostname', async () => {
  assert.equal(WORKQUEST.length, 66, 'regression fixture drifted');
  const { docker, calls, restore } = loadDocker();
  try {
    await docker.runContainer(WORKQUEST, {
      image: 'usernode-staging-workquest-escape-from-the-underclass-831ec5-3539:abc123',
      env: { PORT: '3000' },
      port: '3000',
    });
    const { args } = calls[0];
    assert.equal(flagValue(args, '--name'), WORKQUEST,
      '--name is what staging-reap parses and the DB persists; never shorten it');
    const hostname = flagValue(args, '--hostname');
    assert.ok(hostname.length <= MAX_HOSTNAME,
      `--hostname was ${hostname.length} bytes; runc rejects anything over ${MAX_HOSTNAME + 1}`);
    assert.ok(!hostname.endsWith('-'), 'a trailing hyphen is not a valid RFC-1123 label');
    assert.match(hostname, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
  } finally {
    restore();
  }
});

test('two sessions on the same long slug get different hostnames', () => {
  // The session id lives in the tail that truncation cuts, so a clamp that
  // hashed the truncated prefix would collapse every preview of a long-named
  // app onto one hostname.
  const { docker, restore } = loadDocker();
  try {
    const a = docker.containerHostname(WORKQUEST);
    const b = docker.containerHostname(WORKQUEST.replace('--3539', '--3530'));
    assert.notEqual(a, b);
    assert.ok(a.length <= MAX_HOSTNAME && b.length <= MAX_HOSTNAME);
    // …and it is deterministic, so a restart re-derives the same hostname.
    assert.equal(docker.containerHostname(WORKQUEST), a);
  } finally {
    restore();
  }
});

test('a name that already fits is passed through byte-for-byte', async () => {
  const short = 'usernode-staging-my-cool-app-460fe8--3521';
  assert.ok(short.length <= MAX_HOSTNAME, 'fixture must fit');
  const { docker, calls, restore } = loadDocker();
  try {
    await docker.runContainer(short, {
      image: 'usernode-staging-my-cool-app:abc123',
      env: {},
      port: '3000',
    });
    const { args } = calls[0];
    assert.equal(flagValue(args, '--hostname'), short);
    assert.equal(flagValue(args, '--hostname'), flagValue(args, '--name'),
      'the overwhelmingly common case must behave exactly as it did before');
    assert.equal(docker.containerHostname(short), short);
  } finally {
    restore();
  }
});

test('containerHostname never emits an over-long or hyphen-terminated label', () => {
  const { docker, restore } = loadDocker();
  try {
    for (const name of [
      'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(120),
      // A name whose 54-char truncation point lands on a hyphen run.
      `usernode-staging-${'x'.repeat(36)}---${'y'.repeat(30)}--3600`,
      '',
    ]) {
      const h = docker.containerHostname(name);
      assert.ok(h.length <= MAX_HOSTNAME, `${name.length}-char name produced ${h.length} bytes`);
      assert.ok(!h.endsWith('-'), `hostname "${h}" ends in a hyphen`);
    }
  } finally {
    restore();
  }
});

// ── #1381: the resolvable identity ─────────────────────────────────────

function flagValues(args, flag) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === flag) out.push(args[i + 1]);
  return out;
}

test('an over-long staging name is created WITH a short --network-alias', async () => {
  const { docker, calls, restore } = loadDocker();
  try {
    await docker.runContainer(WORKQUEST, {
      image: 'x:abc123', env: {}, port: '3000',
      aliases: ['usernode-staging-s3539'],
    });
    const { args } = calls[0];
    // Both identities, side by side. The name is untouched…
    assert.equal(flagValue(args, '--name'), WORKQUEST);
    // …and the alias is what DNS can actually answer for.
    assert.deepEqual(flagValues(args, '--network-alias'), ['usernode-staging-s3539']);
    const alias = flagValue(args, '--network-alias');
    assert.ok(alias.length <= MAX_HOSTNAME,
      `alias was ${alias.length} bytes — the whole point is that it fits`);
    // The alias must be registered on the same network the peers are on,
    // which means it has to appear after --network in the argv.
    assert.ok(args.indexOf('--network') < args.indexOf('--network-alias'));
  } finally {
    restore();
  }
});

test('a short name gets its alias too — the alias is unconditional', async () => {
  // Caddy's map row cannot branch on how long a container name happens to
  // be, so it targets the alias for EVERY preview. A conditional alias would
  // give the proxy an upstream that exists for some apps and not others.
  const short = 'usernode-staging-my-cool-app-460fe8--3521';
  const { docker, calls, restore } = loadDocker();
  try {
    await docker.runContainer(short, {
      image: 'x:abc', env: {}, port: '3000', aliases: ['usernode-staging-s3521'],
    });
    assert.deepEqual(flagValues(calls[0].args, '--network-alias'), ['usernode-staging-s3521']);
    assert.equal(flagValue(calls[0].args, '--name'), short);
  } finally {
    restore();
  }
});

test('no aliases, or an alias equal to the name, emits no --network-alias', async () => {
  const { docker, calls, restore } = loadDocker();
  try {
    await docker.runContainer('usernode-app-thing', { image: 'x', env: {}, port: '3000' });
    await docker.runContainer('usernode-app-thing', {
      image: 'x', env: {}, port: '3000', aliases: ['usernode-app-thing', '', null],
    });
    for (const c of calls) {
      assert.equal(c.args.includes('--network-alias'), false,
        'a redundant alias must not change the argv of the common case');
    }
  } finally {
    restore();
  }
});

// ── ensureNetworkAlias: repairing a LIVE container ─────────────────────
//
// A re-check reuses the running preview instead of rebuilding it, and the
// only thing that would rebuild it is a new commit — which clears the
// proposal's votes. So the alias has to be attachable in place.

function networksJson(aliases) {
  return { stdout: `${JSON.stringify({ 'shared-web': { Aliases: aliases } })}\n`, stderr: '' };
}

test('ensureNetworkAlias is a no-op when the alias is already attached', async () => {
  const { docker, calls, restore } = loadDocker((cmd, args) => (
    args[0] === 'inspect' ? networksJson(['usernode-staging-s3539']) : undefined
  ));
  try {
    const ok = await docker.ensureNetworkAlias(WORKQUEST, 'usernode-staging-s3539');
    assert.equal(ok, true, 'already-attached still reports the alias as usable');
    assert.equal(calls.length, 1, 'one inspect, and nothing else');
    assert.equal(calls[0].args[0], 'inspect');
  } finally {
    restore();
  }
});

test('ensureNetworkAlias reconnects exactly once when the alias is missing', async () => {
  const { docker, calls, restore } = loadDocker((cmd, args) => (
    args[0] === 'inspect' ? networksJson(['deadbeefcafe']) : undefined
  ));
  try {
    const ok = await docker.ensureNetworkAlias(WORKQUEST, 'usernode-staging-s3539');
    assert.equal(ok, true);
    const verbs = calls.map((c) => c.args.slice(0, 2).join(' '));
    assert.deepEqual(verbs, ['inspect --format', 'network disconnect', 'network connect']);
    const connect = calls[2].args;
    assert.deepEqual(flagValues(connect, '--alias'), ['usernode-staging-s3539', 'deadbeefcafe'],
      'the new alias is added; whatever was already there is preserved');
    assert.equal(connect[connect.length - 2], 'shared-web');
    assert.equal(connect[connect.length - 1], WORKQUEST);
  } finally {
    restore();
  }
});

test('ensureNetworkAlias never re-asserts the container name as an alias', async () => {
  // Newer engines report the container's own name in .Aliases. Re-passing it
  // to `network connect --alias` would hand docker the very >63-byte label
  // this whole change exists to stop relying on.
  const { docker, calls, restore } = loadDocker((cmd, args) => (
    args[0] === 'inspect' ? networksJson([WORKQUEST, 'deadbeefcafe']) : undefined
  ));
  try {
    await docker.ensureNetworkAlias(WORKQUEST, 'usernode-staging-s3539');
    const passed = flagValues(calls[2].args, '--alias');
    assert.equal(passed.includes(WORKQUEST), false);
    for (const a of passed) assert.ok(a.length <= MAX_HOSTNAME);
  } finally {
    restore();
  }
});

test('ensureNetworkAlias swallows a docker failure and reports the alias unusable', async () => {
  const { docker, restore } = loadDocker((cmd, args) => {
    if (args[0] === 'inspect') return networksJson([]);
    return Promise.reject(Object.assign(new Error('daemon says no'), { stderr: 'nope' }));
  });
  try {
    // Never throws: every caller has real work to do afterwards and none of
    // it should fail because a repair could not be applied.
    assert.equal(await docker.ensureNetworkAlias(WORKQUEST, 'usernode-staging-s3539'), false);
  } finally {
    restore();
  }
});

test('ensureNetworkAlias leaves a container it cannot inspect completely alone', async () => {
  // "Could not look" must never become "disconnect and hope".
  const { docker, calls, restore } = loadDocker((cmd, args) => (
    args[0] === 'inspect'
      ? Promise.reject(Object.assign(new Error('boom'), { stderr: 'daemon unreachable' }))
      : undefined
  ));
  try {
    assert.equal(await docker.ensureNetworkAlias(WORKQUEST, 'usernode-staging-s3539'), false);
    assert.equal(calls.length, 1, 'inspect failed — nothing else may be attempted');
  } finally {
    restore();
  }
});
