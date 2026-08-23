// Container hostnames are clamped to 63 bytes; container NAMES are not.
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
// Caddy's map block derives the upstream container name from the request
// host, services/staging-reap parses session ids back out of it, and
// Docker's embedded DNS resolves container names and network aliases —
// never hostnames. Clamping the name would break routing platform-wide;
// clamping the hostname is invisible.
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
function loadDocker() {
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
      '--name is what Caddy and staging-reap resolve; it must never be shortened');
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
