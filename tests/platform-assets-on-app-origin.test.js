// test:changed: when src/prompts/app-conventions.md (the hosted-asset tags this suite pins, read through services/prompts.js; scripts/test-changed.js)
'use strict';

// The three centrally hosted assets, served from every app's OWN origin.
//
// The defect this guards: an app that names the platform's hostname to load
// the bridge, the native kit and the Tailwind runtime loses all three the
// moment that hostname changes. It did — the platform moved to
// my.onhomeroom.com and every app scaffolded before it went on requesting
// social-vibecoding.usernodelabs.org, which no longer answers, so the
// Tailwind tag 404'd and the very next inline script threw
// `tailwind is not defined` before the app rendered anything.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const k8s = require('../src/services/kubernetes');
const assetServer = require('../scripts/serve-platform-assets');
const { appIdentityEnv, platformOrigin } = require('../src/services/app-identity-env');
const appManifest = require('../src/services/app-manifest');

const CFG = { ingressClassName: 'cilium', appTlsSecretName: 'social-apps-wildcard-tls' };

function ingressFor(hostname, assetBackend = k8s.PLATFORM_ASSET_NAME) {
  return k8s._appIngressManifestForTest({
    name: 'usernode-app-todo-list', namespace: 'social-apps',
    hostname, resourceLabels: {}, cfg: CFG, assetBackend,
  });
}
const pathsOf = (ingress) => ingress.spec.rules[0].http.paths;

test('every app hostname routes the three asset prefixes to the shared backend', () => {
  const paths = pathsOf(ingressFor('todo-list.onhomeroom.com'));
  for (const prefix of k8s.PLATFORM_ASSET_PREFIXES) {
    const rule = paths.find((p) => p.path === prefix);
    assert.ok(rule, `${prefix} is routed`);
    assert.equal(rule.pathType, 'Prefix');
    assert.equal(rule.backend.service.name, k8s.PLATFORM_ASSET_NAME);
  }
  // The app itself still owns everything else.
  const catchAll = paths.find((p) => p.path === '/');
  assert.equal(catchAll.backend.service.name, 'usernode-app-todo-list');
});

test('the asset prefixes precede the catch-all', () => {
  const paths = pathsOf(ingressFor('todo-list.onhomeroom.com'));
  assert.equal(paths[paths.length - 1].path, '/', 'the catch-all is last');
  for (const prefix of k8s.PLATFORM_ASSET_PREFIXES) {
    assert.ok(paths.findIndex((p) => p.path === prefix) < paths.length - 1);
  }
});

test('staging previews get the same routing as production', () => {
  // Proposal checks run against the preview hostname, so an app converted to
  // relative paths would fail its own "Native kit boots" check — and could
  // never merge the conversion — if previews were not covered.
  const preview = pathsOf(ingressFor('todo-list--s412.onhomeroom.com')).map((p) => p.path);
  const production = pathsOf(ingressFor('todo-list.onhomeroom.com')).map((p) => p.path);
  assert.deepEqual(preview, production);
});

test('existing managed child Ingresses are reconciled while self-app routes stay local', async (t) => {
  const managed = 'social-vibecoding-runtime';
  const catchAll = (service) => ({
    path: '/', pathType: 'Prefix', backend: { service: { name: service, port: { number: 3000 } } },
  });
  const staleAsset = {
    path: '/usernode-bridge/', pathType: 'Prefix',
    backend: { service: { name: k8s.PLATFORM_ASSET_NAME, port: { number: 3000 } } },
  };
  const ingresses = [
    {
      metadata: { name: 'sv-preview-9-s42', resourceVersion: '1', labels: { 'app.kubernetes.io/managed-by': managed } },
      spec: { rules: [{ host: 'coffee--s42.apps.example.test', http: { paths: [catchAll('sv-preview-9-s42')] } }] },
    },
    {
      metadata: { name: 'sv-preview-10-s43', resourceVersion: '2', labels: { 'app.kubernetes.io/managed-by': managed } },
      spec: { rules: [{ host: 'usernode-2d5619--s43.apps.example.test', http: { paths: [staleAsset, catchAll('sv-preview-10-s43')] } }] },
    },
    {
      metadata: { name: 'sv-preview-11-s44', resourceVersion: '3', labels: { 'app.kubernetes.io/managed-by': managed } },
      spec: { rules: [{ host: 'usernode-2d5619--showcase.apps.example.test', http: { paths: [catchAll('sv-preview-11-s44')] } }] },
    },
  ];
  const replaced = [];
  k8s._setClientsForTest({ networking: {
    listNamespacedIngress: async ({ namespace, labelSelector }) => {
      assert.equal(namespace, 'social-apps');
      assert.equal(labelSelector, `app.kubernetes.io/managed-by=${managed}`);
      return { items: ingresses };
    },
    replaceNamespacedIngress: async ({ name, namespace, body }) => {
      replaced.push({ name, namespace, body });
      return body;
    },
  } });
  t.after(() => k8s._setClientsForTest(null));

  const updated = await k8s._reconcilePlatformAssetIngressesForTest({
    selfAppSlug: 'usernode-2d5619',
    kubernetes: { appNamespace: 'social-apps', appDomain: 'apps.example.test' },
  });
  assert.equal(updated, 3);

  const childPaths = replaced.find((row) => row.name === 'sv-preview-9-s42')
    .body.spec.rules[0].http.paths;
  assert.deepEqual(childPaths.slice(0, 3).map((item) => item.path), k8s.PLATFORM_ASSET_PREFIXES);
  assert.equal(childPaths[3].backend.service.name, 'sv-preview-9-s42');

  const selfPaths = replaced.find((row) => row.name === 'sv-preview-10-s43')
    .body.spec.rules[0].http.paths;
  assert.deepEqual(selfPaths.map((item) => item.path), ['/']);
  assert.equal(selfPaths[0].backend.service.name, 'sv-preview-10-s43');

  const similarSlugPaths = replaced.find((row) => row.name === 'sv-preview-11-s44')
    .body.spec.rules[0].http.paths;
  assert.deepEqual(similarSlugPaths.slice(0, 3).map((item) => item.path), k8s.PLATFORM_ASSET_PREFIXES);
});

test('an unavailable asset backend leaves the app routed exactly as before', () => {
  // Shared infrastructure failing must not change how THIS app is served.
  const paths = pathsOf(ingressFor('todo-list.onhomeroom.com', null));
  assert.deepEqual(paths.map((p) => p.path), ['/']);
  assert.equal(paths[0].backend.service.name, 'usernode-app-todo-list');
});

test('the backend serves exactly the prefixes the Ingress routes to it', () => {
  // The coupling that actually matters: a prefix routed but not served is a
  // 404 on every app, and one served but not routed is dead code.
  assert.deepEqual([...assetServer.PREFIXES].sort(), [...k8s.PLATFORM_ASSET_PREFIXES].sort());
});

test('the asset server serves only its three directories', () => {
  assert.ok(assetServer.resolveAsset('/usernode-native/v1/native.css'));
  assert.ok(assetServer.resolveAsset('/usernode-bridge/v1/bridge.js'));
  // A percent-encoded `..` survives URL parsing and is only decoded inside
  // resolveAsset, so containment has to be checked against the asset
  // directories rather than against public/ — otherwise this process
  // quietly becomes a static server for the whole public tree.
  assert.equal(assetServer.resolveAsset('/usernode-native/%2e%2e/js/app.js'), null);
  assert.equal(assetServer.resolveAsset('/usernode-native/../../../etc/passwd'), null);
  assert.equal(assetServer.resolveAsset('/js/app.js'), null);
  assert.equal(assetServer.isAssetPath('/js/app.js'), false);
});

test('the files the backend is asked for are really in the image', () => {
  // snapdom.js: the drawing library the bridge loads, on the app's own
  // origin, when the shell asks an app for its picture (the C comment).
  for (const file of ['usernode-bridge/v1/bridge.js', 'usernode-bridge/v1/snapdom.js', 'usernode-native/v1/native.css',
    'usernode-native/v1/native.js', 'usernode-tailwind/v1/tailwind.js']) {
    assert.ok(fs.existsSync(path.join(assetServer.ROOT, file)), `${file} ships in public/`);
  }
});

test('the asset backend runs the platform image and is not mistaken for an app', async (t) => {
  const created = [];
  const fake = {
    apps: {
      readNamespacedDeployment: async ({ name, namespace }) => {
        assert.equal(namespace, 'social-platform');
        assert.equal(name, 'social-vibecoding');
        return { spec: { template: { spec: { containers: [
          { name: 'platform', image: 'registry.example/social-vibecoding@sha256:abc' },
        ] } } } };
      },
      createNamespacedDeployment: async ({ namespace, body }) => { created.push({ namespace, body }); return body; },
      replaceNamespacedDeployment: async ({ body }) => body,
      listNamespacedPod: async () => ({ items: [] }),
    },
    core: {
      readNamespacedService: async () => { const e = new Error('nf'); e.code = 404; throw e; },
      createNamespacedService: async ({ namespace, body }) => { created.push({ namespace, body }); return body; },
      replaceNamespacedService: async ({ body }) => body,
    },
  };
  // The Deployment read must 404 on first reconcile too.
  fake.apps.readNamespacedDeployment = (() => {
    const platform = fake.apps.readNamespacedDeployment;
    let seen = 0;
    return async (args) => {
      if (args.namespace === 'social-apps') {
        // First read is the upsert's existence check (404 -> create). Later
        // reads are waitForDeployment polling for readiness.
        if (seen++ === 0) { const e = new Error('nf'); e.code = 404; throw e; }
        return { metadata: { name: args.name, generation: 1 }, spec: { replicas: 2 },
          status: { observedGeneration: 1, replicas: 2, updatedReplicas: 2, readyReplicas: 2, availableReplicas: 2 } };
      }
      return platform(args);
    };
  })();

  k8s._setClientsForTest(fake);
  k8s._resetPlatformAssetBackendForTest();
  t.after(() => { k8s._setClientsForTest(null); k8s._resetPlatformAssetBackendForTest(); });

  const config = { kubernetes: { appNamespace: 'social-apps', platformNamespace: 'social-platform',
    platformDeployment: 'social-vibecoding', generatedAppServiceAccount: 'social-generated-app' } };
  const name = await k8s._ensurePlatformAssetBackendForTest(config);
  assert.equal(name, k8s.PLATFORM_ASSET_NAME);

  const deployment = created.find((r) => r.body.kind === 'Deployment').body;
  const service = created.find((r) => r.body.kind === 'Service').body;
  assert.equal(created.every((r) => r.namespace === 'social-apps'), true,
    'it lives beside the apps, because an Ingress backend must be same-namespace');

  const container = deployment.spec.template.spec.containers[0];
  assert.equal(container.image, 'registry.example/social-vibecoding@sha256:abc',
    'the image comes from the running platform Deployment, so the assets track the platform');
  // Dockerfile.kubernetes uses node:22-alpine at UID 1000. Keep the pod
  // identity explicit and aligned; this platform image launches Node directly
  // (it has no CNB launcher).
  assert.deepEqual(deployment.spec.template.spec.securityContext, {
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    fsGroup: 1000,
    seccompProfile: { type: 'RuntimeDefault' },
  });
  assert.deepEqual(container.command, ['node', 'scripts/serve-platform-assets.js']);
  assert.deepEqual(container.args || [], []);
  assert.ok(deployment.spec.replicas >= 2, 'no single-replica restart gap on every app page load');
  assert.equal(deployment.spec.strategy.rollingUpdate.maxUnavailable, 0);

  // listStatusResources enumerates APP deployments by this label value; the
  // asset backend is not an app and must not appear there as a phantom one.
  assert.notEqual(deployment.metadata.labels['app.kubernetes.io/managed-by'], 'social-vibecoding-runtime');
  assert.deepEqual(service.spec.selector, deployment.spec.selector.matchLabels,
    'an ordinary selector Service — the one backend shape every ingress controller programs');
});

test('a failed reconcile is retried rather than remembered', async (t) => {
  let calls = 0;
  k8s._setClientsForTest({
    apps: { readNamespacedDeployment: async () => { calls += 1; throw new Error('api down'); } },
    core: {},
  });
  k8s._resetPlatformAssetBackendForTest();
  t.after(() => { k8s._setClientsForTest(null); k8s._resetPlatformAssetBackendForTest(); });

  const config = { kubernetes: { appNamespace: 'social-apps' } };

  // A failure is never cached as a SUCCESS — the next attempt after the
  // cooldown really does reconcile again, so a transient API error heals by
  // itself rather than leaving the fleet unrouted until a platform restart.
  await assert.rejects(() => k8s._ensurePlatformAssetBackendForTest(config, { retryAfterMs: 0 }));
  await assert.rejects(() => k8s._ensurePlatformAssetBackendForTest(config, { retryAfterMs: 0 }));
  assert.equal(calls, 2, 'the memo does not cache a failure');

  // But inside the cooldown it declines immediately rather than retrying:
  // otherwise a backend that cannot come up adds its readiness wait to every
  // app deploy on the platform instead of costing it once.
  await assert.rejects(() => k8s._ensurePlatformAssetBackendForTest(config, { retryAfterMs: 300000 }));
  assert.equal(await k8s._ensurePlatformAssetBackendForTest(config), null);
  assert.equal(calls, 3, 'the cooled-off call touched no API at all');
});

test('apps are handed the platform origin for the links a relative path cannot express', () => {
  const before = process.env.USERNODE_DOMAIN;
  try {
    process.env.USERNODE_DOMAIN = 'my.example.com';
    assert.equal(platformOrigin(), 'https://my.example.com');
    assert.equal(appIdentityEnv({ id: 7 }).USERNODE_PLATFORM_ORIGIN, 'https://my.example.com');

    // Omitted, never defaulted: a baked-in fallback is the exact failure
    // this key exists to end.
    delete process.env.USERNODE_DOMAIN;
    assert.equal(platformOrigin(), null);
    assert.ok(!('USERNODE_PLATFORM_ORIGIN' in appIdentityEnv({ id: 7 })));
  } finally {
    if (before === undefined) delete process.env.USERNODE_DOMAIN;
    else process.env.USERNODE_DOMAIN = before;
  }
});

test('an app manifest cannot shadow the platform origin', () => {
  // This set is what the manifest reader consults before accepting a
  // declared secret: a key in it is dropped with a warning rather than
  // handed to the container. Without it an app could redeclare the key and
  // point its own "Open in Homeroom" links wherever it liked.
  assert.ok(appManifest.RESERVED_KEYS.has('USERNODE_PLATFORM_ORIGIN'));
});

const DEAD_HOST = /\bsocial-vibecoding\.usernodelabs\.org\b/;

test('nothing the platform hands a coding agent names a platform hostname', () => {
  // The regression guard, asserted on what is actually EMITTED rather than
  // on source text — so a comment recording this defect's history cannot
  // satisfy it, and no new literal can slip past by being formatted oddly.
  //
  // Both surfaces were live defects. The work order handed every agent three
  // dead links, and the conventions doc injected into every build agent's
  // system prompt told them to load the same dead host — which is how apps
  // kept being built with a hostname that a domain move invalidates.
  const before = process.env.USERNODE_DOMAIN;
  try {
    process.env.USERNODE_DOMAIN = 'my.example.com';
    delete require.cache[require.resolve('../src/services/prompts')];
    const prompts = require('../src/services/prompts');
    const svc = require('../src/services/external-agent-tasks');

    const conventions = prompts.getAppConventions();
    assert.doesNotMatch(conventions, DEAD_HOST);
    // #2319: not even THIS deployment's host. Apps copied the absolute form
    // into their markup, which breaks on the next domain move; the doc shows
    // the path the platform serves on every app's own address.
    assert.doesNotMatch(conventions, /my\.example\.com\/usernode-/,
      'the doc never puts a hostname in front of a hosted asset');
    assert.match(conventions, /<script src="\/usernode-tailwind\/v1\/tailwind\.js"><\/script>/,
      'the doc shows the relative tag');

    const order = svc.buildWorkOrder({
      appName: 'Recipe Box', appSlug: 'recipe-box',
      upstreamUrl: 'https://github.com/usernode-bot/recipe-box',
      upstreamSlug: 'usernode-bot/recipe-box',
      forkUrl: 'https://github.com/someuser/recipe-box',
      forkCloneUrl: 'https://github.com/someuser/recipe-box.git',
      forkRepo: 'recipe-box',
      forkPageUrl: 'https://github.com/usernode-bot/recipe-box/fork',
      forkStatus: 'ready',
      branch: 'usernode/recipe-box-issue-4-abc123',
      baseSha: `ba5e${'0'.repeat(34)}fe`,
      brief: 'x',
      webPath: 'https://usernode.example/#app/recipe-box',
      taskId: 31,
      platformRules: prompts.getWorkOrderEssentials(),
    });
    assert.doesNotMatch(order, DEAD_HOST);
    assert.ok(!order.includes('usernode.example/usernode-'),
      'the work order lists hosted assets without a hostname');
  } finally {
    if (before === undefined) delete process.env.USERNODE_DOMAIN;
    else process.env.USERNODE_DOMAIN = before;
    delete require.cache[require.resolve('../src/services/prompts')];
  }
});

test('no platform code names the retired domain, not even as a fallback', () => {
  // This used to be a ratchet over six `process.env.USERNODE_DOMAIN ||
  // '<literal>'` defaults, template.js the worst of them: a deployment that
  // left USERNODE_DOMAIN unset baked the dead host into every app it
  // created. #2322 removed them all — a fallback is now a placeholder
  // (`apps.example.invalid`, as src/config.js uses) or the injected origin
  // alone — so the list is empty and stays empty.
  //
  // Allowed, because none of them uses the name as the PLATFORM's address:
  //   e2e-results-data.js   a record of past test runs, quoting it as history
  //   *-remote-db.sh        SSH to that machine by its own hostname
  //                         (DEPLOY_HOST overrides it) — a server name, not a
  //                         platform origin a domain move invalidates
  const ALLOWED = new Set([
    'frontend/src/features/admin/e2e-results-data.js',
    'scripts/pull-remote-db.sh',
    'scripts/push-remote-db.sh',
  ]);
  const root = path.join(__dirname, '..');
  const found = new Set();
  const visit = (full) => {
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (ALLOWED.has(rel)) return;
    if (DEAD_HOST.test(fs.readFileSync(full, 'utf-8'))) found.add(rel);
  };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs|cjs|ts|tsx|md|sh)$/.test(entry.name)) continue;
      visit(full);
    }
  };
  for (const dir of ['src', 'scripts', 'public/js', 'frontend/src']) walk(path.join(root, dir));
  visit(path.join(root, 'server.js'));
  assert.deepEqual([...found].sort(), [],
    'derive the origin from USERNODE_DOMAIN (or use a relative path) rather than naming a host a domain move invalidates');
});

test('the platform\'s own app keeps serving its own asset trees', async (t) => {
  // The regression these two assertions exist for: the platform IS the
  // source of /usernode-bridge/, /usernode-native/ and /usernode-tailwind/.
  // Routing them to the shared backend on its own deployment served a
  // preview the PRODUCTION image's copy of those files, so the preview's
  // checks described bytes that were not in the preview. Fifteen native-kit
  // demo checks went red on /usernode-native/v1/demo.html.
  k8s._setClientsForTest({
    apps: { readNamespacedDeployment: async () => { throw new Error('must not reconcile for the self app'); } },
    core: {},
  });
  k8s._resetPlatformAssetBackendForTest();
  t.after(() => { k8s._setClientsForTest(null); k8s._resetPlatformAssetBackendForTest(); });

  // The manifest an unrouted app gets: its own catch-all and nothing else.
  const paths = pathsOf(ingressFor('usernode-2d5619--s4137.onhomeroom.com', null));
  assert.deepEqual(paths.map((p) => p.path), ['/'],
    'the self app serves every path from itself, asset trees included');
});

test('a backend that never becomes ready is not routed to', async (t) => {
  // Publishing the Ingress paths on an upsert that merely SUCCEEDED turned a
  // broken backend into a 503 on every asset path — strictly worse than not
  // routing at all, because then the app cannot serve them either. Readiness
  // is the gate, so the failure mode is "no asset routing", the status quo.
  const fake = {
    apps: {
      readNamespacedDeployment: async ({ namespace, name }) => {
        if (namespace === 'social-platform') {
          return { spec: { template: { spec: { containers: [{ name: 'platform', image: 'img@sha256:a' }] } } } };
        }
        // Never ready.
        return { metadata: { name, generation: 1 }, spec: { replicas: 2 },
          status: { observedGeneration: 1, replicas: 2, updatedReplicas: 0, readyReplicas: 0, availableReplicas: 0 } };
      },
      createNamespacedDeployment: async ({ body }) => body,
      replaceNamespacedDeployment: async ({ body }) => body,
      listNamespacedPod: async () => ({ items: [] }),
    },
    core: {
      readNamespacedService: async () => { const e = new Error('nf'); e.code = 404; throw e; },
      createNamespacedService: async ({ body }) => body,
      replaceNamespacedService: async ({ body }) => body,
      listNamespacedPod: async () => ({ items: [] }),
    },
  };
  k8s._setClientsForTest(fake);
  k8s._resetPlatformAssetBackendForTest();
  t.after(() => { k8s._setClientsForTest(null); k8s._resetPlatformAssetBackendForTest(); });

  const config = { kubernetes: { appNamespace: 'social-apps', platformNamespace: 'social-platform',
    platformDeployment: 'social-vibecoding', generatedAppServiceAccount: 'social-generated-app' } };
  await assert.rejects(
    () => k8s._ensurePlatformAssetBackendForTest(config, { readyTimeoutMs: 150 }),
    'reconcile fails rather than reporting a backend that cannot serve'
  );

  // And it then backs off. Without this, a backend that cannot come up adds
  // the readiness wait to EVERY app deploy on the platform rather than
  // costing it once — the routing is what gets delayed, and nothing needs it
  // urgently enough to pay that.
  const startedAt = Date.now();
  assert.equal(await k8s._ensurePlatformAssetBackendForTest(config, { readyTimeoutMs: 150 }), null,
    'the next caller gets no backend rather than another wait');
  assert.ok(Date.now() - startedAt < 100, 'and returns immediately');
});

test('the platform\'s own deploy still reconciles the shared backend', async (t) => {
  // #2045. Reconciling the shared backend and routing THIS app to it are
  // separate questions, and guarding both on the self-app check meant
  // platform previews — the most frequent deploy here — stopped reconciling
  // at all. The one thing that happens constantly could then no longer heal
  // a broken backend, and an already-deployed app whose Ingress carried the
  // asset paths answered 503 with no way back: it cannot detect that, cannot
  // serve those paths itself (the Ingress rule wins), and cannot fix it from
  // app code.
  let reconciled = 0;
  const fake = {
    apps: {
      readNamespacedDeployment: async ({ namespace, name }) => {
        if (namespace === 'social-platform') {
          reconciled += 1;
          return { spec: { template: { spec: { containers: [{ name: 'platform', image: 'img@sha256:a' }] } } } };
        }
        return { metadata: { name, generation: 1 }, spec: { replicas: 2 },
          status: { observedGeneration: 1, replicas: 2, updatedReplicas: 2, readyReplicas: 2, availableReplicas: 2 } };
      },
      createNamespacedDeployment: async ({ body }) => body,
      replaceNamespacedDeployment: async ({ body }) => body,
      listNamespacedPod: async () => ({ items: [] }),
    },
    core: {
      readNamespacedService: async () => { const e = new Error('nf'); e.code = 404; throw e; },
      createNamespacedService: async ({ body }) => body,
      replaceNamespacedService: async ({ body }) => body,
      listNamespacedPod: async () => ({ items: [] }),
    },
  };
  k8s._setClientsForTest(fake);
  k8s._resetPlatformAssetBackendForTest();
  t.after(() => { k8s._setClientsForTest(null); k8s._resetPlatformAssetBackendForTest(); });

  const config = { kubernetes: { appNamespace: 'social-apps', platformNamespace: 'social-platform',
    platformDeployment: 'social-vibecoding', generatedAppServiceAccount: 'social-generated-app' } };
  assert.equal(await k8s.ensurePlatformAssetBackend(config), k8s.PLATFORM_ASSET_NAME);
  assert.equal(reconciled, 1, 'the reconcile is reachable independent of which app is deploying');

  // The self app still must not be ROUTED to it — it is the source of those
  // three trees, and routing them away serves a preview the production
  // image's copy of its own files.
  assert.deepEqual(
    pathsOf(ingressFor('usernode-2d5619--s4137.onhomeroom.com', null)).map((p) => p.path),
    ['/'],
  );
});

test('each release reconciles the backend in its own build, on Kubernetes only', () => {
  // Otherwise a fix to how the backend is BUILT does not reach one that
  // already exists until some child app happens to deploy. The release's
  // work (src/workflow/platform.ts ADOPTIONS), never an older build's.
  const platform = fs.readFileSync(path.join(__dirname, '..', 'src', 'workflow', 'platform.ts'), 'utf-8');
  assert.match(platform, /\['assetBackend', \(\) => reconcileAssetBackend\(\)\]/);
  const fn = platform.slice(platform.indexOf('async function reconcileAssetBackend()'));
  assert.match(fn.slice(0, 300), /if \(!clusterRelease\(\)\) return null;/, 'never on a staging preview, never on Docker');
  assert.match(platform, /const clusterRelease = \(\) => legacy\('config'\)\.runsClusterMaintenance\(\)\s+&& legacy\('services\/application-runtime'\)\.mode\(appConfig\) === 'kubernetes';/);
  assert.match(fn.slice(0, 400), /ensurePlatformAssetBackend\(appConfig\)/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
  assert.ok(!server.includes('ensurePlatformAssetBackend'), 'no leader runs it at its election any more');
});

// ── A deploy and the backend's reconcile (sharedBackendForDeploy) ─────────
//
// The reconcile's first run in a process upserts the backend, waits for its
// rollout and rewrites every app Ingress, 20-30 s. A deploy waited for all
// of it, and since platform pods restart on every release nearly every new
// app's deploy was the first in its process. A backend that already serves
// now takes the app at once, the reconcile going on behind it; one that does
// not serve is still waited for, because routing to it is #2045's 503.

const log = require('../src/services/logger');

const notFound = () => Object.assign(new Error('not found'), { code: 404 });
const readyStatus = (n) => ({ observedGeneration: 1, replicas: n, updatedReplicas: n, readyReplicas: n, availableReplicas: n });
const DEPLOY_CONFIG = {
  selfAppSlug: 'usernode-2d5619',
  kubernetes: {
    appNamespace: 'social-apps', platformNamespace: 'social-platform', platformDeployment: 'social-vibecoding',
    generatedAppServiceAccount: 'social-generated-app', appDomain: 'apps.example.test', platformDomain: 'apps.example.test',
    ingressClassName: 'cilium', appTlsSecretName: 'social-apps-wildcard-tls',
  },
};
const configWith = (over = {}) => ({ ...DEPLOY_CONFIG, kubernetes: { ...DEPLOY_CONFIG.kubernetes, ...over } });

// An app namespace in which the asset backend exists and serves (or not),
// and whose reconcile reads the platform's own Deployment through
// `platformRead`, so a test can hold the reconcile where it likes.
// `serving` names the shared backends (the asset backend, the app gate)
// that exist and answer before the deploy; a reconcile that creates one
// makes it answer.
function deployCluster({ serving, platformRead = async () => ({
  spec: { template: { spec: { containers: [{ name: 'platform', image: 'img@sha256:a' }] } } },
}) }) {
  const up = new Set(serving === true ? [k8s.PLATFORM_ASSET_NAME] : (serving || []));
  const shared = new Set([k8s.PLATFORM_ASSET_NAME, k8s.APP_GATE_NAME]);
  const state = { ingresses: [], backendReads: 0 };
  const appDeployments = new Map();
  const clients = {
    core: {
      readNamespacedSecret: async () => { throw notFound(); },
      createNamespacedSecret: async ({ body }) => body,
      readNamespacedService: async ({ name }) => {
        if (shared.has(name)) {
          state.backendReads += 1;
          if (up.has(name)) {
            return { metadata: { name, resourceVersion: '1' }, spec: { selector: { 'social.usernode.io/runtime-name': name } } };
          }
        }
        throw notFound();
      },
      createNamespacedService: async ({ body }) => body,
      replaceNamespacedService: async ({ body }) => body,
      listNamespacedPod: async () => ({ items: [] }),
    },
    apps: {
      readNamespacedDeployment: async ({ namespace, name }) => {
        if (namespace === 'social-platform') return platformRead();
        if (shared.has(name)) {
          if (!up.has(name)) throw notFound();
          return { metadata: { name, generation: 1, resourceVersion: '1' }, spec: { replicas: 2 }, status: readyStatus(2) };
        }
        const body = appDeployments.get(name);
        if (!body) throw notFound();
        return { ...body, metadata: { ...body.metadata, generation: 1 }, status: readyStatus(1) };
      },
      createNamespacedDeployment: async ({ body }) => {
        if (shared.has(body.metadata.name)) up.add(body.metadata.name);
        else appDeployments.set(body.metadata.name, body);
        return { ...body, metadata: { ...body.metadata, generation: 1 } };
      },
      replaceNamespacedDeployment: async ({ body }) => body,
    },
    networking: {
      readNamespacedIngress: async () => { throw notFound(); },
      createNamespacedIngress: async ({ body }) => { state.ingresses.push(body); return body; },
    },
  };
  return { clients, state };
}

function held() {
  let release;
  let fail;
  const promise = new Promise((resolve, reject) => { release = resolve; fail = reject; });
  return { promise, release, fail };
}

const PLATFORM = { spec: { template: { spec: { containers: [{ name: 'platform', image: 'img@sha256:a' }] } } } };
const assetPathsIn = (ingress) => pathsOf(ingress).map((p) => p.path).filter((p) => p !== '/');
const deployChild = (config, slug = 'todo-list-123456') => k8s.deployApplication(config, {
  app: { id: 7, slug }, environment: 'production', imageRef: 'ghcr.io/example/todo@sha256:deadbeef', env: {},
});

test('a deploy routes to an asset backend that already serves without waiting for its reconcile', async (t) => {
  const reconcile = held();
  const { clients, state } = deployCluster({ serving: true, platformRead: () => reconcile.promise });
  k8s._setClientsForTest(clients);
  k8s._resetPlatformAssetBackendForTest();
  t.after(() => { k8s._setClientsForTest(null); k8s._resetPlatformAssetBackendForTest(); });

  // The reconcile is held at its first read; the deploy finishes anyway.
  await deployChild(DEPLOY_CONFIG);
  assert.deepEqual(assetPathsIn(state.ingresses[0]), [...k8s.PLATFORM_ASSET_PREFIXES],
    'routed to the serving backend at once');

  // The reconcile was started all the same, and finishes behind the deploy.
  reconcile.release(PLATFORM);
  assert.equal(await k8s.ensurePlatformAssetBackend(DEPLOY_CONFIG), k8s.PLATFORM_ASSET_NAME);

  // Once it has, a deploy reads nothing about the backend: the memo answers.
  const reads = state.backendReads;
  await deployChild(DEPLOY_CONFIG, 'groceries-654321');
  assert.equal(state.backendReads, reads, 'no serving read once the reconcile has settled');
  assert.deepEqual(assetPathsIn(state.ingresses[1]), [...k8s.PLATFORM_ASSET_PREFIXES]);
});

test('a deploy whose asset backend does not serve yet waits for the reconcile, as before (#2045)', async (t) => {
  const reconcile = held();
  const { clients, state } = deployCluster({ serving: false, platformRead: () => reconcile.promise });
  k8s._setClientsForTest(clients);
  k8s._resetPlatformAssetBackendForTest();
  t.after(() => { k8s._setClientsForTest(null); k8s._resetPlatformAssetBackendForTest(); });

  let done = false;
  const deploying = deployChild(DEPLOY_CONFIG).then(() => { done = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(done, false, 'nothing is routed to a backend that is not up');
  assert.equal(state.ingresses.length, 0);

  reconcile.release(PLATFORM);
  await deploying;
  assert.deepEqual(assetPathsIn(state.ingresses[0]), [...k8s.PLATFORM_ASSET_PREFIXES],
    'routed once the reconcile has brought it up');
});

test('a reconcile that fails behind a routed deploy is logged, and the deploy stands', async (t) => {
  const warnings = [];
  t.mock.method(log, 'warn', (category, message, data) => warnings.push({ category, message, data }));
  const reconcile = held();
  const { clients, state } = deployCluster({ serving: true, platformRead: () => reconcile.promise });
  k8s._setClientsForTest(clients);
  k8s._resetPlatformAssetBackendForTest();
  t.after(() => { k8s._setClientsForTest(null); k8s._resetPlatformAssetBackendForTest(); });

  const result = await deployChild(DEPLOY_CONFIG);
  assert.equal(result.url, 'https://todo-list-123456.apps.example.test');
  reconcile.fail(new Error('api down'));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(assetPathsIn(state.ingresses[0]), [...k8s.PLATFORM_ASSET_PREFIXES]);
  const warned = warnings.find((w) => /reconcile failed behind a deploy/.test(w.message));
  assert.ok(warned, 'the background failure is logged');
  assert.equal(warned.data.backend, k8s.PLATFORM_ASSET_NAME);
  assert.equal(warned.data.error, 'api down');

  // And it cools off as any failed reconcile does: the next deploy is not
  // routed and does not wait, exactly as before this change.
  await deployChild(DEPLOY_CONFIG, 'groceries-654321');
  assert.deepEqual(assetPathsIn(state.ingresses[1]), [], 'cooling off: no routing');
});

test('KUBERNETES_ASSET_BACKEND_WAIT=always waits for the reconcile even when the backend serves', async (t) => {
  const reconcile = held();
  const { clients, state } = deployCluster({ serving: true, platformRead: () => reconcile.promise });
  k8s._setClientsForTest(clients);
  k8s._resetPlatformAssetBackendForTest();
  t.after(() => { k8s._setClientsForTest(null); k8s._resetPlatformAssetBackendForTest(); });

  let done = false;
  const deploying = deployChild(configWith({ assetBackendWait: 'always' })).then(() => { done = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(done, false);
  assert.equal(state.backendReads, 0, 'not even asked whether it serves');
  reconcile.release(PLATFORM);
  await deploying;
  assert.deepEqual(assetPathsIn(state.ingresses[0]), [...k8s.PLATFORM_ASSET_PREFIXES]);
});

test('a backend serves only with its Service selecting it and a ready, available replica', async (t) => {
  const name = k8s.PLATFORM_ASSET_NAME;
  const service = { metadata: { name }, spec: { selector: { 'social.usernode.io/runtime-name': name } } };
  const deployment = { metadata: { name }, spec: { replicas: 2 }, status: { readyReplicas: 1, availableReplicas: 1 } };
  const serving = async (svc, dep) => {
    k8s._setClientsForTest({
      core: { readNamespacedService: async () => { if (svc instanceof Error) throw svc; return svc; } },
      apps: { readNamespacedDeployment: async () => { if (dep instanceof Error) throw dep; return dep; } },
    });
    return k8s._sharedBackendServingForTest(DEPLOY_CONFIG, name);
  };
  t.after(() => k8s._setClientsForTest(null));
  assert.equal(await serving(service, deployment), true, 'one old replica answering is serving');
  assert.equal(await serving(notFound(), deployment), false, 'no Service');
  assert.equal(await serving(service, notFound()), false, 'no Deployment');
  assert.equal(await serving(new Error('timeout'), deployment), false, 'an API error');
  assert.equal(await serving({ ...service, spec: { selector: { app: 'other' } } }, deployment), false, 'a Service selecting something else');
  assert.equal(await serving({ ...service, metadata: { name, deletionTimestamp: 'now' } }, deployment), false);
  assert.equal(await serving(service, { ...deployment, status: { readyReplicas: 0, availableReplicas: 0 } }), false, 'nothing ready');
  assert.equal(await serving(service, { ...deployment, status: { readyReplicas: 1, availableReplicas: 0 } }), false, 'ready but not yet available');
  assert.equal(await serving(service, { ...deployment, spec: { replicas: 0 } }), false, 'scaled to zero');
  assert.equal(await serving(service, { ...deployment, metadata: { name, deletionTimestamp: 'now' } }), false);
});

test('the Ingress reconcile skips an Ingress a deploy wrote since its list, and carries on', async (t) => {
  const managed = 'social-vibecoding-runtime';
  const ingress = (name, host) => ({
    metadata: { name, resourceVersion: '1', labels: { 'app.kubernetes.io/managed-by': managed } },
    spec: { rules: [{ host, http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name, port: { number: 3000 } } } }] } }] },
  });
  const replaced = [];
  k8s._setClientsForTest({ networking: {
    listNamespacedIngress: async () => ({ items: [ingress('sv-a', 'a.apps.example.test'), ingress('sv-b', 'b.apps.example.test')] }),
    replaceNamespacedIngress: async ({ name }) => {
      if (name === 'sv-a') throw Object.assign(new Error('the object has been modified'), { code: 409 });
      replaced.push(name);
    },
  } });
  t.after(() => k8s._setClientsForTest(null));
  assert.equal(await k8s._reconcilePlatformAssetIngressesForTest(DEPLOY_CONFIG), 1);
  assert.deepEqual(replaced, ['sv-b']);

  // Any other failure still stops it, as before.
  k8s._setClientsForTest({ networking: {
    listNamespacedIngress: async () => ({ items: [ingress('sv-a', 'a.apps.example.test')] }),
    replaceNamespacedIngress: async () => { throw Object.assign(new Error('forbidden'), { code: 403 }); },
  } });
  await assert.rejects(() => k8s._reconcilePlatformAssetIngressesForTest(DEPLOY_CONFIG), /forbidden/);
});

test('the app gate is chosen the same way: one that answers takes the app while its reconcile goes on', async (t) => {
  const before = process.env.PLATFORM_INTERNAL_URL;
  process.env.PLATFORM_INTERNAL_URL = 'http://social-vibecoding.social-platform.svc:3000';
  const reconcile = held();
  const { clients, state } = deployCluster({ serving: [k8s.PLATFORM_ASSET_NAME, k8s.APP_GATE_NAME], platformRead: () => reconcile.promise });
  k8s._setClientsForTest(clients);
  k8s._resetPlatformAssetBackendForTest();
  k8s._resetAppGateForTest();
  t.after(() => {
    k8s._setClientsForTest(null); k8s._resetPlatformAssetBackendForTest(); k8s._resetAppGateForTest();
    if (before === undefined) delete process.env.PLATFORM_INTERNAL_URL; else process.env.PLATFORM_INTERNAL_URL = before;
  });
  const gated = { ...DEPLOY_CONFIG, kubernetes: { ...DEPLOY_CONFIG.kubernetes, appGate: 'on' } };
  await deployChild(gated);
  const catchAll = pathsOf(state.ingresses[0]).find((p) => p.path === '/');
  assert.equal(catchAll.backend.service.name, k8s.APP_GATE_NAME, 'behind the gate that answers');
  reconcile.release(PLATFORM);
  assert.equal(await k8s.ensureAppGateBackend(gated), k8s.APP_GATE_NAME, 'its reconcile finished behind the deploy');
  await k8s.ensurePlatformAssetBackend(gated);

  // A gate that does not answer yet is still waited for.
  const second = held();
  const fresh = deployCluster({ serving: [k8s.PLATFORM_ASSET_NAME], platformRead: () => second.promise });
  k8s._setClientsForTest(fresh.clients);
  k8s._resetPlatformAssetBackendForTest();
  k8s._resetAppGateForTest();
  let done = false;
  const deploying = deployChild(gated).then(() => { done = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(done, false);
  second.release(PLATFORM);
  await deploying;
  assert.equal(pathsOf(fresh.state.ingresses[0]).find((p) => p.path === '/').backend.service.name, k8s.APP_GATE_NAME);
});
