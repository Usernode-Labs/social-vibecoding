const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');

const helmAvailable = spawnSync('helm', ['version', '--short'], { stdio: 'ignore' }).status === 0;

test('Helm session settings reach the runtime as decimal strings, including zero', {
  skip: !helmAvailable && 'helm is not installed',
}, () => {
  const args = ['template', 'session-config-test', 'deploy/helm/social-vibecoding-platform',
    '--show-only', 'templates/platform.yaml', '--set', 'enabled=true',
    '--set', 'secrets.create=false', '--set-string', `release.sourceRevision=${'a'.repeat(40)}`];
  for (const image of ['image', 'workerImage', 'captureImage']) {
    args.push('--set-string', `platform.${image}.digest=sha256:${'a'.repeat(64)}`);
  }
  for (const [overrides, expected] of [
    [[], { MAX_GLOBAL_SESSIONS: '25', WORKER_IDLE_EVICTION_MS: '600000', SESSION_AUTOPAUSE_IDLE_MS: '300000' }],
    [['--set', 'config.maxGlobalSessions=100,config.workerIdleEvictionMs=300000,config.sessionAutopauseIdleMs=0'],
      { MAX_GLOBAL_SESSIONS: '100', WORKER_IDLE_EVICTION_MS: '300000', SESSION_AUTOPAUSE_IDLE_MS: '0' }],
  ]) {
    const rendered = execFileSync('helm', [...args, ...overrides], { encoding: 'utf8' });
    const env = Object.fromEntries([...rendered.matchAll(/\{name: ([A-Z_]+), value: "([^"]*)"\}/g)]
      .map(([, key, value]) => [key, value]));
    for (const [name, value] of Object.entries({
      ...expected, MAX_USER_SESSIONS: '3', MAX_USER_PROMOTED_SESSIONS: '5',
      MAX_ADMIN_USER_SESSIONS: '5', MAX_ADMIN_USER_PROMOTED_SESSIONS: '8',
      STAGING_IDLE_TEARDOWN_MS: '21600000',
    })) {
      assert.equal(env[name], value, name);
      assert.equal(parseInt(env[name], 10), Number(value), `${name} application parsing`);
    }
  }
});
