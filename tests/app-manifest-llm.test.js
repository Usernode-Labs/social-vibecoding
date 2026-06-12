// Tests for the dapp.json `llm` block (issue #34) — consent metadata
// for the platform's app-LLM proxy, parsed leniently by
// src/services/app-manifest.js — plus the reserved
// USERNODE_LLM_PROXY_* env-var family.
//
// Run with: node --test tests/app-manifest-llm.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appManifest = require('../src/services/app-manifest');

function withManifest(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-llm-'));
  try {
    if (content != null) {
      fs.writeFileSync(path.join(dir, 'dapp.json'),
        typeof content === 'string' ? content : JSON.stringify(content));
    }
    return fn(appManifest.read(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('valid llm block passes through', () => {
  withManifest({
    secrets: [],
    llm: { purpose: 'Summarizes long threads for you', suggested_daily_cap_cents: 300 },
  }, (m) => {
    assert.deepEqual(m.llm, {
      purpose: 'Summarizes long threads for you',
      suggested_daily_cap_cents: 300,
    });
  });
});

test('absent llm block resolves to null', () => {
  withManifest({ secrets: [] }, (m) => assert.equal(m.llm, null));
  withManifest(null, (m) => assert.equal(m.llm, null)); // no dapp.json at all
});

test('garbage suggested caps are dropped, purpose survives', () => {
  for (const bad of [0, -5, 1.5, '300', null, {}]) {
    withManifest({ llm: { purpose: 'Helps', suggested_daily_cap_cents: bad } }, (m) => {
      assert.deepEqual(m.llm, { purpose: 'Helps' }, `cap ${JSON.stringify(bad)} should drop`);
    });
  }
});

test('non-string / empty purpose is dropped, cap survives', () => {
  for (const bad of [42, '', '   ', null, ['x']]) {
    withManifest({ llm: { purpose: bad, suggested_daily_cap_cents: 200 } }, (m) => {
      assert.deepEqual(m.llm, { suggested_daily_cap_cents: 200 });
    });
  }
});

test('a block with only garbage resolves to null', () => {
  withManifest({ llm: { purpose: 42, suggested_daily_cap_cents: -1 } }, (m) => {
    assert.equal(m.llm, null);
  });
  withManifest({ llm: 'not-an-object' }, (m) => assert.equal(m.llm, null));
  withManifest({ llm: ['array'] }, (m) => assert.equal(m.llm, null));
});

test('purpose is trimmed and clipped to 140 chars', () => {
  withManifest({ llm: { purpose: `  ${'x'.repeat(200)}  ` } }, (m) => {
    assert.equal(m.llm.purpose.length, 140);
    assert.equal(m.llm.purpose, 'x'.repeat(140));
  });
});

test('USERNODE_LLM_PROXY_* secret keys are rejected as reserved', () => {
  withManifest({
    secrets: [
      { key: 'USERNODE_LLM_PROXY_URL', description: 'spoof' },
      { key: 'USERNODE_LLM_PROXY_TOKEN', description: 'spoof' },
      { key: 'USERNODE_LLM_PROXY_FUTURE_THING', description: 'prefix spoof' },
      { key: 'LEGIT_KEY', description: 'fine' },
    ],
  }, (m) => {
    assert.deepEqual(m.secrets.map((s) => s.key), ['LEGIT_KEY']);
  });
});
