// Application-runtime dispatch and naming.
//
// Docker's `run` command prints a 64-character container ID. Docker commands
// accept that ID, but the embedded DNS shared by proposal-check containers
// does not resolve it; peers resolve the container's configured --name.
// `runtimeName` therefore has to preserve the requested Docker name while
// Kubernetes keeps the runtime name returned by its deploy adapter.

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function loadRuntime() {
  const ids = {
    docker: require.resolve('../src/services/docker'),
    caddy: require.resolve('../src/services/caddy'),
    kubernetes: require.resolve('../src/services/kubernetes'),
    subject: require.resolve('../src/services/application-runtime'),
  };
  const original = Object.fromEntries(
    Object.entries(ids).map(([key, id]) => [key, require.cache[id]])
  );
  const calls = [];

  stub(ids.docker, {
    stopAndRemove: async (name) => { calls.push(['remove', name]); },
    runContainer: async (name) => {
      calls.push(['run', name]);
      return 'f'.repeat(64);
    },
    waitForHealthy: async (name) => { calls.push(['healthy', name]); },
    getHostPort: async () => null,
  });
  stub(ids.caddy, {
    productionHostname: (slug) => `${slug}.example.test`,
    stagingHostname: (slug, suffix) => `${slug}--${suffix}.example.test`,
  });
  stub(ids.kubernetes, {
    deployApplication: async () => ({
      runtimeKind: 'kubernetes',
      runtimeName: 'widget-s42',
      url: 'https://widget-s42.example.test',
    }),
  });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  const restore = () => {
    for (const [key, id] of Object.entries(ids)) {
      if (original[key]) require.cache[id] = original[key];
      else delete require.cache[id];
    }
  };
  return { subject, calls, restore };
}

const input = {
  app: { slug: 'widget' },
  environment: 'staging',
  sessionId: 42,
  imageRef: 'widget:staging',
  env: {},
  dockerName: 'usernode-staging-widget--42',
};

test('Docker deploy returns the stable DNS name, not docker run\'s container ID', async () => {
  const { subject, calls, restore } = loadRuntime();
  try {
    const deployed = await subject.deploy({ appRuntime: 'docker' }, input);

    assert.equal(deployed.runtimeKind, 'docker');
    assert.equal(deployed.runtimeName, input.dockerName);
    assert.notEqual(deployed.runtimeName, 'f'.repeat(64));
    assert.deepEqual(calls, [
      ['remove', input.dockerName],
      ['run', input.dockerName],
      ['healthy', input.dockerName],
    ]);
  } finally {
    restore();
  }
});

test('Kubernetes deploy preserves the adapter-provided runtime name', async () => {
  const { subject, restore } = loadRuntime();
  try {
    const deployed = await subject.deploy({ appRuntime: 'kubernetes' }, input);
    assert.equal(deployed.runtimeKind, 'kubernetes');
    assert.equal(deployed.runtimeName, 'widget-s42');
  } finally {
    restore();
  }
});
