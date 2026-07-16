// Tests for the dapp.json `screenshot` block (issue #360): the
// top-level `screenshot.deviceScaleFactor` parsed leniently by
// src/services/app-manifest.js readScreenshot (default 2× HiDPI), plus
// the deploy-time reconcileAppScreenshot that persists it onto
// apps.screenshot_device_scale.
//
// Run with: node --test tests/app-manifest-screenshot.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appManifest = require('../src/services/app-manifest');

function withManifest(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-shot-'));
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

// ── readScreenshot parsing matrix ─────────────────────────────────────

test('absent screenshot block defaults to 2× HiDPI', () => {
  withManifest({ secrets: [] }, (m) => {
    assert.deepEqual(m.screenshot, { deviceScaleFactor: 2 });
  });
  // A wholly absent manifest file too.
  withManifest(null, (m) => {
    assert.deepEqual(m.screenshot, { deviceScaleFactor: 2 });
  });
});

test('explicit deviceScaleFactor: 1 opts out to standard density', () => {
  withManifest({ screenshot: { deviceScaleFactor: 1 } }, (m) => {
    assert.deepEqual(m.screenshot, { deviceScaleFactor: 1 });
  });
});

test('explicit deviceScaleFactor: 2 passes through', () => {
  withManifest({ screenshot: { deviceScaleFactor: 2 } }, (m) => {
    assert.deepEqual(m.screenshot, { deviceScaleFactor: 2 });
  });
});

test('out-of-range / non-numeric scale drops to the 2× default', () => {
  for (const bad of [3, 0, -1, 1.5, '1', true, null]) {
    withManifest({ screenshot: { deviceScaleFactor: bad } }, (m) => {
      assert.deepEqual(m.screenshot, { deviceScaleFactor: 2 }, `value ${JSON.stringify(bad)}`);
    });
  }
});

test('non-object screenshot block drops to the 2× default', () => {
  withManifest({ screenshot: 'big' }, (m) => {
    assert.deepEqual(m.screenshot, { deviceScaleFactor: 2 });
  });
  withManifest({ screenshot: [1] }, (m) => {
    assert.deepEqual(m.screenshot, { deviceScaleFactor: 2 });
  });
});

test('unparseable manifest still yields the default screenshot block', () => {
  withManifest('{ not json', (m) => {
    assert.deepEqual(m.screenshot, { deviceScaleFactor: 2 });
  });
});

test('full read() return carries the screenshot key alongside the others', () => {
  withManifest({ secrets: [], screenshot: { deviceScaleFactor: 1 } }, (m) => {
    assert.deepEqual(Object.keys(m).sort(),
      ['governance', 'icon', 'llm', 'name', 'screenshot', 'secrets', 'tests', 'visibility'].sort());
    assert.equal(m.screenshot.deviceScaleFactor, 1);
  });
});

// ── reconcileAppScreenshot (deploy-time persistence) ──────────────────

function fakePool(currentScale) {
  const calls = [];
  return {
    calls,
    query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT screenshot_device_scale/.test(sql)) {
        return Promise.resolve({
          rows: currentScale === undefined ? [] : [{ screenshot_device_scale: currentScale }],
        });
      }
      return Promise.resolve({ rows: [] });
    },
  };
}

test('reconcile writes the column when the manifest scale differs', async () => {
  const pool = fakePool(2); // stored 2×, manifest opts to 1×
  const changed = await appManifest.reconcileAppScreenshot(
    pool, { id: 7, slug: 'pix' }, { screenshot: { deviceScaleFactor: 1 } }
  );
  assert.equal(changed, true);
  const update = pool.calls.find((c) => /UPDATE apps SET screenshot_device_scale/.test(c.sql));
  assert.ok(update, 'an UPDATE was issued');
  assert.deepEqual(update.params, [1, 7]);
});

test('reconcile no-ops when the stored scale already matches', async () => {
  const pool = fakePool(2);
  const changed = await appManifest.reconcileAppScreenshot(
    pool, { id: 7, slug: 'app' }, { screenshot: { deviceScaleFactor: 2 } }
  );
  assert.equal(changed, false);
  assert.ok(!pool.calls.some((c) => /UPDATE apps/.test(c.sql)), 'no UPDATE issued');
});

test('reconcile writes the 2× default back when an opted-out app reverts', async () => {
  const pool = fakePool(1); // stored 1×, manifest no longer declares it → default 2×
  const changed = await appManifest.reconcileAppScreenshot(
    pool, { id: 9, slug: 'app' }, appManifest.read(os.tmpdir()) // no dapp.json → { deviceScaleFactor: 2 }
  );
  assert.equal(changed, true);
  const update = pool.calls.find((c) => /UPDATE apps SET screenshot_device_scale/.test(c.sql));
  assert.deepEqual(update.params, [2, 9]);
});

test('reconcile no-ops for a missing app row', async () => {
  const pool = fakePool(undefined); // SELECT returns no rows
  const changed = await appManifest.reconcileAppScreenshot(
    pool, { id: 404, slug: 'gone' }, { screenshot: { deviceScaleFactor: 1 } }
  );
  assert.equal(changed, false);
});
