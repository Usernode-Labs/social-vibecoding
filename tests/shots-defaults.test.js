const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../src/config');

// The flags retired before the rename, which nothing reads any more.
const RETIRED_FLAGS = [
  'VISUAL_EVIDENCE_V2_COLLECT',
  'VISUAL_EVIDENCE_V2_EXECUTE',
  'VISUAL_EVIDENCE_V2_PRESENT',
  'VISUAL_EVIDENCE_V2_ENFORCE',
  'VISUAL_EVIDENCE_V2_LEGACY_CAPTURE',
];
const VISUAL_FLAGS = ['SHOTS_ENABLED', 'VISUAL_EVIDENCE_V2_ENABLED', ...RETIRED_FLAGS];
const VISUAL_BUDGETS = [
  'SHOTS_MAX_RUN_MS',
  'SHOTS_MAX_AGENT_MS',
  'SHOTS_AGENT_MODEL',
  'VISUAL_EVIDENCE_MAX_RUN_MS',
  'VISUAL_EVIDENCE_MAX_AGENT_MS',
  'VISUAL_EVIDENCE_AGENT_MODEL',
];

function loadVisualConfig(overrides = {}) {
  const required = {
    USERNODE_ENV: 'staging',
    DATABASE_URL: 'postgres://localhost/test',
    SESSION_SECRET: 'test-session-secret',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'admin-pass',
  };
  const keys = new Set([...Object.keys(required), ...VISUAL_FLAGS, ...VISUAL_BUDGETS]);
  const saved = new Map([...keys].map((key) => [key, process.env[key]]));
  for (const key of [...VISUAL_FLAGS, ...VISUAL_BUDGETS]) delete process.env[key];
  Object.assign(process.env, required, overrides);
  const realLog = console.log;
  console.log = () => {};
  try {
    return config.load().shots;
  } finally {
    console.log = realLog;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('before & after shots collection, execution, and presentation are advisory and on by default', () => {
  const visual = loadVisualConfig();
  assert.deepEqual({
    enabled: visual.enabled,
    collect: visual.collect,
    execute: visual.execute,
    present: visual.present,
    enforce: visual.enforce,
  }, {
    enabled: true,
    collect: true,
    execute: true,
    present: true,
    enforce: false,
  });
});

test('the shots agent gets twelve minutes for the doubled photographing and the run budget stays aligned', () => {
  const visual = loadVisualConfig();
  assert.equal(visual.maxAgentMs, 720_000);
  assert.equal(visual.maxRepairAgentMs, undefined);
  assert.equal(visual.maxRunMs, 1_800_000);
  const override = loadVisualConfig({ SHOTS_MAX_AGENT_MS: '300000' });
  assert.equal(override.maxAgentMs, 300_000);
});

test('the shots agent runs on Sonnet 5.5 unless an operator names another Claude model', () => {
  assert.equal(loadVisualConfig().agentModel, 'claude-sonnet-5-5');
  assert.equal(loadVisualConfig({ SHOTS_AGENT_MODEL: 'claude-opus-5-5' }).agentModel, 'claude-opus-5-5');
  for (const malformed of ['', 'gpt-5', 'claude-', 'claude-Opus', 'claude-opus-5-5 --bare']) {
    assert.equal(loadVisualConfig({ SHOTS_AGENT_MODEL: malformed }).agentModel, 'claude-sonnet-5-5', malformed);
  }
});

test('one emergency switch disables the mechanism and legacy activation flags are ignored', () => {
  const visual = loadVisualConfig({
    SHOTS_ENABLED: 'false',
    VISUAL_EVIDENCE_V2_COLLECT: 'true',
    VISUAL_EVIDENCE_V2_EXECUTE: 'true',
    VISUAL_EVIDENCE_V2_PRESENT: 'true',
    VISUAL_EVIDENCE_V2_ENFORCE: 'true',
    VISUAL_EVIDENCE_V2_LEGACY_CAPTURE: 'true',
  });
  assert.deepEqual({
    enabled: visual.enabled,
    collect: visual.collect,
    execute: visual.execute,
    present: visual.present,
    enforce: visual.enforce,
    legacyCapture: visual.legacyCapture,
  }, {
    enabled: false,
    collect: false,
    execute: false,
    present: false,
    enforce: false,
    legacyCapture: undefined,
  });
});

test('each setting still reads its name from before the rename, and the new name wins', () => {
  assert.equal(loadVisualConfig({ VISUAL_EVIDENCE_V2_ENABLED: 'false' }).enabled, false);
  assert.equal(loadVisualConfig({ SHOTS_ENABLED: 'true', VISUAL_EVIDENCE_V2_ENABLED: 'false' }).enabled, true);
  assert.equal(loadVisualConfig({ VISUAL_EVIDENCE_MAX_AGENT_MS: '300000' }).maxAgentMs, 300_000);
  assert.equal(loadVisualConfig({ SHOTS_MAX_AGENT_MS: '360000', VISUAL_EVIDENCE_MAX_AGENT_MS: '300000' }).maxAgentMs, 360_000);
  assert.equal(loadVisualConfig({ VISUAL_EVIDENCE_AGENT_MODEL: 'claude-opus-5-5' }).agentModel, 'claude-opus-5-5');
});

test('deployment documentation exposes only the default-on emergency switch', () => {
  const root = path.join(__dirname, '..');
  const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8');
  assert.match(example, /SHOTS_ENABLED=true/);
  assert.match(workflow,
    /SHOTS_ENABLED=\$\{\{ vars\.SHOTS_ENABLED \|\| vars\.VISUAL_EVIDENCE_V2_ENABLED \|\| 'true' \}\}/);
  for (const retired of RETIRED_FLAGS) {
    assert.doesNotMatch(example, new RegExp(retired));
    assert.doesNotMatch(workflow, new RegExp(retired));
  }
});
