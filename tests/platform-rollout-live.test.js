'use strict';

// #6233: a change of Homeroom's own app reads Live only once the whole
// rollout finished, and a complete rollout that no longer carries it takes
// it back to Going live.
//
// A release replaces its servers one at a time, so one process booting a
// build says nothing about production carrying the change everywhere
// (workflow/platform.ts releaseServing). The platform-rollout clock job
// reads the web Deployment the deploy banner reads, and once it reports
// complete it tells the merge machine: Deployed for the merges that build
// carries (Live), RolledBack for the Live ones it no longer carries (Going
// live again). The machine owns live_at, so a rollback clears it there
// (merge-followups machine, project) and every surface that reads live_at
// follows. The rollback itself is exercised end to end in
// tests/workflow-merge-followups-platform-postgres.test.js.
//
// Run with: node --test tests/platform-rollout-live.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const CLOCK = read('src/workflow/clock/services.ts');
const PLATFORM = read('src/workflow/platform.ts');
const MACHINE = read('src/workflow/merge-followups/machine.ts');

test('the rollout, not a boot, makes a Homeroom change Live', () => {
  // A serving process records its boot and the builds it carries, but on
  // Kubernetes it does not report Deployed: the rollout is not finished.
  assert.match(PLATFORM, /if \(runtime && !onKubernetes\) await releaseBooted/, 'only off Kubernetes is one boot the rollout');
  assert.match(PLATFORM, /const onKubernetes = !!process\.env\.KUBERNETES_SERVICE_HOST/);
  // The merge machine does not turn a boot record into Live on Kubernetes.
  assert.match(MACHINE, /if \(!app\.onKubernetes\) \{[\s\S]{0,200}toLive/);
  // The clock job reads the same Deployment the banner does, and acts only
  // when it reports complete.
  assert.match(CLOCK, /name: 'platform-rollout'/);
  assert.match(CLOCK, /legacy\('services\/deploy-status'\)\.read\(config\)/);
  assert.match(CLOCK, /deploy\.phase !== 'complete'/);
  assert.match(CLOCK, /productionDeployed\(Number\(app\.id\), sha, nonce\)/);
  // It runs in production only: staging previews and anything off
  // Kubernetes have no rollout to wait for.
  assert.match(CLOCK, /USERNODE_ENV === 'staging' \|\| !process\.env\.KUBERNETES_SERVICE_HOST/);
});

test('a complete rollout that no longer carries a Live change takes it back', () => {
  // The job asks for the rollback after Deployed, from the build's merge
  // order (release-watch.mergeOrder).
  assert.match(CLOCK, /productionRolledBack\(Number\(app\.id\), sha, nonce\)/);
  assert.match(PLATFORM, /export async function productionRolledBack/);
  assert.match(PLATFORM, /releaseWatch\.mergeOrder\(kernelPool!, appId, sha\)/);
  assert.match(PLATFORM, /type: 'RolledBack'/);
  assert.match(PLATFORM, /const key = `rolled-back:\$\{sha\.toLowerCase\(\)\}/);
  assert.match(CLOCK, /const nonce = deploy\.startedAt \? String\(deploy\.startedAt\) : null/,
    'this rollout names its reports, so the same build deployed twice is reported twice');
  // It reaches the merges after the boundary, and the changes they carried.
  assert.match(PLATFORM, /w\.state = 'live'/);
  assert.match(PLATFORM, /cs\.merged_at, cs\.created_at\), cs\.id\) > \(\$3::timestamptz, \$4::int\)/);
  assert.match(PLATFORM, /w\.data->'includedIn'->>'sessionId'/);
  // The machine goes back to delivering, and clears live_at as its own
  // write: no second "It's live" when a release carries it again.
  assert.match(MACHINE, /RolledBack: \(p: any\) => \(\{ sha: sha\(p\?\.sha, 'sha', true\)! \}\)/);
  assert.match(MACHINE, /RolledBack: rolledBack/);
  assert.match(MACHINE, /next: \{ name: 'delivering', data: d \}/);
  assert.match(MACHINE, /UPDATE chat_sessions SET live_at = NULL WHERE id = \$1/);
  assert.match(MACHINE, /if \(!d\.wasLive\) \{/, 'a change carried again is not announced twice');
});

test('a release that never finished leaves the change Going live', () => {
  // Nothing else stamps live_at: the boot path is gated (above), and the job
  // reports only a complete rollout.
  const phases = [...CLOCK.matchAll(/phase !== 'complete'/g)];
  assert.equal(phases.length, 1, 'the one gate on the rollout');
  // A build no merge made has no boundary, so nothing is compared and no
  // change is ruled out.
  assert.match(PLATFORM, /if \(!order\) return;/);
});
