'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { packagedFixture } = require('./lib/packaged-cli-fixture');

const { inspectFreshStore, seed, servingPreview, identities, migrate } = require('./lib/packaged-cli-scenarios');

async function verifyPrivatePermissions(f, tls, app) {
  const jwt = require('../src/services/platform-jwt');
  const visuals = require('../src/services/visuals');
  const saved = {
    privateKey: process.env.IFRAME_JWT_PRIVATE_KEY,
    publicKey: process.env.IFRAME_JWT_PUBLIC_KEY,
    edgeKey: process.env.EDGE_JWT_SECRET,
  };
  process.env.IFRAME_JWT_PRIVATE_KEY = f.environment.IFRAME_JWT_PRIVATE_KEY;
  process.env.IFRAME_JWT_PUBLIC_KEY = f.environment.IFRAME_JWT_PUBLIC_KEY;
  process.env.EDGE_JWT_SECRET = f.environment.EDGE_JWT_SECRET;
  let tokens;
  let nonMemberCookie;
  try {
    const users = (await f.pool.query("SELECT * FROM users WHERE username IN ('usernode-capture','usernode-capture-admin')")).rows;
    const screenshotUser = users.find(user => user.username === 'usernode-capture');
    const assertionUser = users.find(user => user.username === 'usernode-capture-admin');
    assert.equal(screenshotUser.is_admin, false);
    assert.equal(screenshotUser.has_platform_access, true, 'Packaged migration seeds platform access');
    assert.equal(assertionUser.is_admin, true);
    assert.equal(assertionUser.admin_readonly, true);
    const membership = (await f.pool.query(`SELECT count(*)::int AS n FROM app_collaborators
      WHERE app_id = $1 AND user_id = $2`, [app.id, screenshotUser.id])).rows[0];
    assert.equal(membership.n, 0, 'No fixture grant may conceal ordinary private capture denial');
    nonMemberCookie = `__usernode_access=${jwt.signEdgeCookie({
      uid: screenshotUser.id, appId: app.id, host: tls.destination.hostname,
    })}`;
    tokens = visuals.selectCaptureTokens({
      captureToken: visuals.mintCaptureToken(screenshotUser, app.id),
      adminToken: visuals.mintCaptureToken(assertionUser, app.id),
    });
    const rejectedTokens = [
      undefined,
      'malformed',
      tokens.screenshotToken,
      jwt.signAppIdentityToken({ appId: app.id + 1, user: assertionUser }),
      jwt.signAppIdentityToken({ appId: app.id, user: assertionUser, ttl: -1 }),
      jwt.signAppIdentityToken({ appId: app.id, user: { id: 999999, username: 'unknown' } }),
    ];
    for (const token of rejectedTokens) {
      assert.equal((await tls.request('/api/proof/identity', { token, method: 'POST' })).status, 404);
      assert.equal((await tls.request('/usernode-bridge/v1/bridge.js', { token, method: 'POST' })).status, 404);
    }
    // A valid admin identity reaches the clone; its mismatching local username
    // must still be rejected by the shipped staging authentication middleware.
    const mismatch = jwt.signAppIdentityToken({ appId: app.id, user: { ...assertionUser, username: 'wrong' } });
    assert.equal((await tls.request('/api/proof/identity', { token: mismatch })).status, 401);
  } finally {
    for (const [key, value] of [
      ['IFRAME_JWT_PRIVATE_KEY', saved.privateKey],
      ['IFRAME_JWT_PUBLIC_KEY', saved.publicKey],
      ['EDGE_JWT_SECRET', saved.edgeKey],
    ]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }

  // A valid screenshot JWT does not delegate the CLI author's membership.
  const denied = await tls.request(`/api/proof/identity?token=${tokens.screenshotToken}`);
  assert.equal(denied.status, 302);
  assert.ok(denied.headers.location.includes('/__access/authorize'));
  assert.equal(denied.headers['set-cookie'], undefined);
  assert.equal((await tls.request('/api/proof/identity', { cookie: nonMemberCookie, method: 'POST' })).status, 404,
    'Even a correctly signed edge cookie cannot replace current membership');

  // The distinct assertion admin passes existing visibility policy and the
  // real edge/clone exchanges. This cannot count as successful screenshot access.
  const first = await tls.request(`/api/proof/identity?token=${tokens.testsToken}`);
  assert.equal(first.status, 302);
  assert.match(first.headers['set-cookie'][0], /__usernode_access=.*HttpOnly.*Secure/);
  const edgeCookie = first.headers['set-cookie'][0].split(';')[0];
  const exchanged = await tls.request(first.headers.location, { cookie: edgeCookie });
  assert.equal(exchanged.status, 200, exchanged.body);
  assert.equal(JSON.parse(exchanged.body).isAdmin, true);
  assert.equal(JSON.parse(exchanged.body).canAdminWrite, false);
  const sessionCookie = exchanged.headers['set-cookie'][0];
  assert.match(sessionCookie, /session=.*HttpOnly.*Secure/);
  const cookie = `${edgeCookie}; ${sessionCookie.split(';')[0]}`;
  assert.equal((await tls.request('/api/proof/identity', { cookie })).status, 200);
  assert.equal((await tls.request('/api/proof/admin', { cookie })).status, 200);
  assert.equal((await tls.request('/api/proof/admin', { token: tokens.testsToken, method: 'POST' })).status, 403);

  const assets = [
    '/usernode-bridge/v1/bridge.js',
    '/usernode-native/v1/native.css',
    '/usernode-tailwind/v1/tailwind.js',
  ];
  for (const asset of assets) {
    const deniedAsset = await tls.request(asset, { token: tokens.screenshotToken });
    assert.equal(deniedAsset.status, 302);
    assert.equal(deniedAsset.headers['set-cookie'], undefined);
    const loaded = await tls.request(asset, { cookie });
    assert.equal(loaded.status, 200, `${asset}: ${loaded.body.slice(0, 100)}`);
    assert.ok(loaded.body.length > 100);
  }
  fs.writeFileSync(path.join(f.directory, 'https-permissions.json'), JSON.stringify({
    tls: true,
    secureCookies: true,
    captureMembership: false,
    screenshotsNonAdmin: true,
    ordinaryPrivateCapture: 'denied_by_shipped_membership_policy',
    assertionsReadOnly: true,
    rejected: ['missing', 'malformed', 'non-member-capture', 'wrong-app', 'expired', 'unknown-user', 'username-mismatch'],
    privateAssets: 'denied-to-capture; accessible-to-authorized-assertion-identity',
  }));
}

test('packaged web HTTP admission and standalone worker recover persisted phase boundaries', {
  skip: process.env.RUN_ISOLATED_PACKAGED_CLI_TEST !== '1', timeout: 1800000,
}, async t => {
  const httpsCapture = process.env.RUN_ISOLATED_HTTPS_CAPTURE_TEST === '1';
  const f = await packagedFixture(t, { httpsCapture });
  await migrate(f);
  const freshInventory = await inspectFreshStore(f);
  const { app, session, token } = await seed(f, { privateIdentity: httpsCapture });
  const serving = await servingPreview(f, session, app);

  // Admission commits through HTTP; losing its reply must join the same work.
  let web = await f.start('web', { pause: 'admitted' });
  let origin = await f.healthy(web);
  const request = async (authorization = token) => {
    const response = await fetch(`${origin}/api/sessions/${session.id}/proposal-handoff/build`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authorization}` },
      body: JSON.stringify({ schemaVersion: 1, headSha: f.fixture.preparationSource.revision, history: [] }),
    });
    return { status: response.status, body: await response.json() };
  };
  assert.notEqual((await request('svcli_' + 'A'.repeat(43))).status, 202, 'Real CLI authentication rejects an invalid credential');
  const lostReply = request().catch(() => null);
  const marker = name => path.join(f.evidence, `${name}.json`);
  await f.waitFor(() => fs.existsSync(marker('admitted')), 'HTTP admission COMMIT');
  const admission = JSON.parse(fs.readFileSync(marker('admitted'), 'utf8'));
  await f.stop(web);
  await lostReply;
  web = await f.start('web');
  origin = await f.healthy(web);
  const retry = await request();
  assert.equal(retry.status, 202);
  assert.equal(retry.body.workId, admission.workId);
  assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM execution_work_requests
    WHERE workflow = 'native-preview-kubernetes-prepare' AND session_id = $1`, [session.id])).rows[0].n, 1);


  // Candidate completion records continuation before either serving change or checks.
  let worker = await f.start('worker', { pause: 'candidate_committed' });
  await f.waitFor(() => fs.existsSync(marker('candidate_committed')), 'real candidate completion', 600000);
  const prepared = await identities(f, session.id);
  const handoff = (await f.pool.query('SELECT * FROM cli_preview_handoffs WHERE session_id = $1', [session.id])).rows[0];
  assert.ok(handoff.continuation_work_id);
  const beforeActivation = await f.clients.networking.readNamespacedIngress({ namespace: serving.ref.namespace, name: serving.ref.runtimeName });
  assert.equal(beforeActivation.metadata.uid, serving.binding.metadata.uid);
  assert.equal(beforeActivation.spec.rules[0].http.paths.find(value => value.path === '/').backend.service.name, serving.intent.runtimeName);
  await serving.assertHealthy();
  await f.stop(worker);
  await f.stop(web);
  web = await f.start('web', { admission: false });
  origin = await f.healthy(web);
  assert.equal((await request()).body.workId, handoff.continuation_work_id);
  const refusedHead = await fetch(`${origin}/api/sessions/${session.id}/proposal-handoff/build`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ schemaVersion: 1, headSha: 'a'.repeat(40), history: [] }),
  });
  assert.equal(refusedHead.status, 409);
  assert.equal((await refusedHead.json()).error, 'durable_revision_admission_disabled');


  // Lose the reply after the real conditional binding write; adoption keeps its UID.
  worker = await f.start('worker', { pause: 'activation_written', admission: false });
  await f.waitFor(() => fs.existsSync(marker('activation_written')), 'real binding update');
  const activated = await f.clients.networking.readNamespacedIngress({ namespace: serving.ref.namespace, name: serving.ref.runtimeName });
  assert.equal(activated.metadata.uid, serving.binding.metadata.uid);
  assert.equal(activated.spec.rules[0].http.paths.find(value => value.path === '/').backend.service.name, prepared.runtimeName);
  await f.stop(worker);
  await f.stop(web);
  web = await f.start('web', { admission: false });
  origin = await f.healthy(web);
  // Policy transition is seeded, not a voting/PR proof. It makes gate delivery
  // exercise the policy service rather than a legitimate not-in-review no-op.
  await f.pool.query(`UPDATE chat_sessions SET status = 'promoted', reviewed_head_sha = checks_commit_sha WHERE id = $1`, [session.id]);

  let tls;
  if (httpsCapture) {
    tls = await require('./lib/https-private-fixture').startPrivateCapture(f, session, app, web);
    await verifyPrivatePermissions(f, tls, app);
    fs.writeFileSync(path.join(f.evidence, 'hold-capture'), 'owned capture barrier');
    worker = await f.start('worker', { pause: 'checks_created', admission: false });
    await f.waitFor(() => fs.existsSync(marker('checks_created')), 'original browser and companion Jobs');
    const original = await require('../src/services/kubernetes').findCheckJobs(f.fixture.config, {
      sessionId: session.id, previewRunId: (await f.pool.query('SELECT run_id FROM check_runs WHERE session_id=$1', [session.id])).rows[0].run_id,
    });
    assert.ok(original.capture && original.unitSuite);
    fs.writeFileSync(path.join(f.directory, 'https-original-jobs.json'), JSON.stringify(original));
    await f.stop(worker);
    fs.unlinkSync(path.join(f.evidence, 'hold-capture'));
  }

  // Real Jobs produce the verdict. Its receipt, history and gate commit before loss.
  worker = await f.start('worker', { pause: 'verdict_committed', admission: false });
  await f.waitFor(() => fs.existsSync(marker('verdict_committed')), 'real capture/unit verdict COMMIT', 300000);
  assert.deepEqual(await identities(f, session.id), prepared);
  const verdict = (await f.pool.query('SELECT check_state, test_results FROM chat_sessions WHERE id = $1', [session.id])).rows[0];
  assert.ok(['passing', 'failing'].includes(verdict.check_state));
  assert.equal(verdict.test_results.find(result => result.index === -3)?.status, 'pass');
  if (!httpsCapture && verdict.check_state === 'failing') {
    assert.ok(verdict.test_results.some(result => result.consoleErrors?.some(error =>
      error.source?.endsWith('/favicon.ico'))), 'Keep the sample app’s actual console failure');
  }
  const receipt = (await f.pool.query('SELECT * FROM cli_check_settlement_receipts WHERE session_id = $1', [session.id])).rows[0];
  assert.ok(receipt);
  const history = (await f.pool.query('SELECT * FROM app_check_history WHERE app_id = $1 ORDER BY check_key', [app.id])).rows;
  const gates = (await f.pool.query(`SELECT * FROM execution_work_requests WHERE workflow = 'native-cli-check-gate'
    AND session_id = $1`, [session.id])).rows;
  assert.equal(gates.length, 1);
  const policy = verdict.check_state === 'passing' ? 'merge' : 'bot';
  assert.equal(gates[0].input.gate, policy);
  assert.notEqual(gates[0].status, 'succeeded', 'Required gate remains owned before the final recovery');
  const checks = (await f.pool.query('SELECT * FROM check_runs WHERE session_id = $1', [session.id])).rows[0];
  assert.ok(checks?.manifest.durableCli);
  const jobs = await require('../src/services/kubernetes').findCheckJobs(f.fixture.config, {
    sessionId: session.id, previewRunId: checks.run_id,
  });
  assert.ok(jobs.capture && jobs.unitSuite);
  if (httpsCapture) {
    const originals = JSON.parse(fs.readFileSync(path.join(f.directory, 'https-original-jobs.json')));
    assert.equal(jobs.capture.uid, originals.capture.uid);
    assert.equal(jobs.unitSuite.uid, originals.unitSuite.uid);
    assert.equal(verdict.check_state, 'passing', 'Existing policy keeps optional media separate from required assertions/unit checks');
    const pods = await f.clients.core.listNamespacedPod({ namespace: f.fixture.isolation.namespace.name,
      labelSelector: `job-name=${jobs.capture.name}` });
    assert.equal(pods.items.length, 1);
    assert.ok(pods.items[0].metadata.ownerReferences.some(owner => owner.uid === jobs.capture.uid));
    const output = await f.clients.core.readNamespacedPodLog({ namespace: f.fixture.isolation.namespace.name,
      name: pods.items[0].metadata.name, container: 'capture' });
    const frames = require('../src/services/visuals').parseShots(output);
    fs.writeFileSync(path.join(f.directory, 'https-capture-output.log'), output, { mode: 0o600 });
    assert.equal(frames.shots.some(shot => shot.kind === 'after' && shot.status === 200), false,
      'The non-member capture cannot publish a successful private screenshot');
    const traffic = fs.readFileSync(path.join(f.evidence, 'https.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(traffic.some(event => event.kind === 'identity' && event.detail.username === 'usernode-capture'), false,
      'The private gate rejects capture before reaching the app');
    assert.ok(traffic.some(event => event.kind === 'identity' && event.detail.path === '/proof' && event.detail.username === 'usernode-capture-admin' && !event.detail.canWrite));
    assert.ok(traffic.filter(event => event.kind === 'edge').every(event => event.detail.tls));
    assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM app_collaborators c
      JOIN users u ON u.id = c.user_id WHERE c.app_id = $1 AND u.username = 'usernode-capture'`, [app.id])).rows[0].n, 0);
  }
  await f.stop(worker);
  await f.stop(web);
  web = await f.start('web', { admission: false });
  origin = await f.healthy(web);

  // Recovery closes original checks and delivers the retained gate exactly once.
  fs.writeFileSync(path.join(f.evidence, 'allow-gate'), 'fixture dependency recovered');
  worker = await f.start('worker', { admission: false });
  await f.waitFor(async () => {
    const row = (await f.pool.query(`SELECT status FROM execution_work_requests WHERE id = $1`, [handoff.continuation_work_id])).rows[0];
    const gate = (await f.pool.query(`SELECT status, last_code FROM execution_work_requests WHERE id = $1`, [gates[0].id])).rows[0];
    return row.status === 'succeeded' && gate.status === 'succeeded' && gate.last_code === 'gate_delivered';
  }, 'durable continuation and gate delivery', 300000);
  assert.deepEqual(await identities(f, session.id), prepared);
  assert.deepEqual((await f.pool.query('SELECT check_state, test_results FROM chat_sessions WHERE id = $1', [session.id])).rows[0], verdict);
  assert.deepEqual((await f.pool.query('SELECT * FROM app_check_history WHERE app_id = $1 ORDER BY check_key', [app.id])).rows, history);
  assert.deepEqual((await f.pool.query('SELECT * FROM cli_check_settlement_receipts WHERE session_id = $1', [session.id])).rows[0], receipt);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM check_runs WHERE session_id = $1', [session.id])).rows[0].n, 0);
  await serving.assertHealthy();
  const events = fs.readFileSync(path.join(f.evidence, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.filter(event => event.kind === 'entry_preloaded').every(event => event.detail.uid === 1000));
  assert.equal(events.filter(event => event.kind === `${policy}_policy_invoked`).length, 1);
  const otherPolicy = policy === 'merge' ? 'bot' : 'merge';
  assert.equal(events.filter(event => event.kind === `${otherPolicy}_policy_invoked`).length, 0);
  assert.equal(events.filter(event => event.kind === 'activation_written').length, 1);
  const createdJobs = events.filter(event => event.kind === 'job_created');
  assert.equal(createdJobs.length, 2, 'Recovery creates neither another capture nor another companion Job');
  assert.deepEqual(createdJobs.map(event => event.detail.uid).sort(), [jobs.capture.uid, jobs.unitSuite.uid].sort());
  assert.ok(createdJobs.every(event => event.detail.runId === checks.run_id));
  fs.writeFileSync(path.join(f.directory, 'result.json'), JSON.stringify({
    freshInventory,
    verdict: verdict.check_state,
    capturePermission: httpsCapture ? 'non-member-denied; optional screenshot unavailable despite passing checks' : 'public',
    policy,
    tuple: {
      revision: f.revision,
      backendImageId: f.backendImageId,
      builderImage: f.fixture.config.kubernetes.builderImage,
      captureImage: f.fixture.config.kubernetes.captureImage,
      unitImage: f.fixture.config.kubernetes.workerImage,
      sourceRevision: f.fixture.preparationSource.revision,
      unitRevision: f.fixture.checks.unitSuite.revision,
    },
    sessionId: session.id,
    workId: admission.workId,
    continuationId: handoff.continuation_work_id,
    gateId: gates[0].id,
    checkRunId: checks.run_id,
    checkJobs: jobs,
    identities: prepared,
  }, null, 2), { mode: 0o600 });
});
