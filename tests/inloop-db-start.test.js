'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HELPER = path.join(ROOT, 'worker', 'start-inloop-db.sh');

test('both coding runners prepare the same throwaway database on build turns', () => {
  for (const runner of ['run-cc.sh', 'run-codex-agent.sh']) {
    const source = fs.readFileSync(path.join(ROOT, 'worker', runner), 'utf8');
    assert.match(source, /if \[ "\$MODE" = "build" \]; then\s*\n\s*sh "\$\(dirname "\$0"\)\/start-inloop-db\.sh"/);
  }
  const image = fs.readFileSync(path.join(ROOT, 'worker', 'Dockerfile'), 'utf8');
  assert.match(image, /COPY start-inloop-db\.sh \/usr\/local\/bin\/start-inloop-db\.sh/);
  assert.match(image, /COPY usernode-run-inloop \/usr\/local\/bin\/usernode-run-inloop/);
});

test('database helper starts Postgres and recreates the inloop DB; failures stay diagnostic', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inloop-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const data = path.join(dir, 'pgdata');
  fs.mkdirSync(bin);
  fs.mkdirSync(data);
  const callLog = path.join(dir, 'calls');
  for (const name of ['pg_ctl', 'psql', 'dropdb', 'createdb']) {
    const script = `#!/bin/sh\nprintf '%s\\n' '${name}:'"$*" >> "$CALL_LOG"\n`
      + (name === 'pg_ctl' ? '[ "$3" = status ] && exit 1\n' : '')
      + `[ "$FAIL_COMMAND" = ${name} ] && exit 1\nexit 0\n`;
    const file = path.join(bin, name);
    fs.writeFileSync(file, script, { mode: 0o755 });
  }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`,
    INLOOP_PGDATA: data, CALL_LOG: callLog, FAIL_COMMAND: '' };
  const first = spawnSync('sh', [HELPER], { env, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /__USERNODE_PHASE__ inloop-db/);
  const calls = fs.readFileSync(callLog, 'utf8');
  assert.match(calls, /pg_ctl:.* status/);
  assert.match(calls, /pg_ctl:.* start/);
  assert.match(calls, /psql:.*pg_terminate_backend/);
  assert.match(calls, /dropdb:.* inloop/);
  assert.match(calls, /createdb:.* inloop/);

  const failure = spawnSync('sh', [HELPER], {
    env: { ...env, FAIL_COMMAND: 'createdb' }, encoding: 'utf8',
  });
  assert.equal(failure.status, 0, failure.stderr);
  assert.match(failure.stdout, /__USERNODE_WARN__ .*recreate failed/);
  assert.doesNotMatch(failure.stdout, /__USERNODE_PHASE__ inloop-db/);
});
