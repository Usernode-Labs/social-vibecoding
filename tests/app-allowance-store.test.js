const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');

const fresh = () => loadTsx('frontend/src/features/dialogs/app-allowance-store.js');
const result = (limit, used = 0, requestedAt = null) => ({
  quota: { used, limit, remaining: Math.max(0, limit - used) },
  canCreateApps: used < limit,
  requestedAt,
});
const response = (data, ok = true) => ({ ok, json: async () => data });

test('fresh allowance replaces a stale blocked snapshot for all subscribers', async () => {
  const model = fresh();
  model.seedAppAllowance({ appCreationQuota: result(0).quota });
  let seen;
  model.appAllowanceStore.subscribe(() => { seen = model.appAllowanceStore.get(); });
  await model.refreshAppAllowance(async () => response(result(2, 1)));
  assert.deepEqual(seen.quota, { used: 1, limit: 2, remaining: 1 });
  assert.equal(seen.loading, false);
});

test('simultaneous subscribers share one read', async () => {
  const model = fresh();
  let resolve;
  let count = 0;
  const fetcher = () => { count++; return new Promise((r) => { resolve = r; }); };
  const a = model.refreshAppAllowance(fetcher);
  const b = model.refreshAppAllowance(fetcher);
  resolve(response(result(2)));
  await Promise.all([a, b]);
  assert.equal(count, 1);
});

test('a read from a previous account cannot overwrite the new account', async () => {
  const model = fresh();
  let resolve;
  const read = model.refreshAppAllowance(() => new Promise((r) => { resolve = r; }));
  model.seedAppAllowance({ appCreationQuota: result(7).quota });
  resolve(response(result(0)));
  await read;
  assert.equal(model.appAllowanceStore.get().quota.limit, 7);
});

test('a read started before a request cannot erase the pending confirmation', async () => {
  const model = fresh();
  let resolve;
  const read = model.refreshAppAllowance(() => new Promise((r) => { resolve = r; }));
  await model.requestMoreApps(async () => response(result(2, 2, '2026-09-07T12:00:00Z')));
  resolve(response(result(2, 2)));
  await read;
  assert.equal(model.appAllowanceStore.get().requestedAt, '2026-09-07T12:00:00Z');
});

test('a read started during a request cannot erase its later confirmation', async () => {
  const model = fresh();
  let resolvePost;
  let resolveGet;
  const post = model.requestMoreApps(() => new Promise((r) => { resolvePost = r; }));
  const get = model.refreshAppAllowance(() => new Promise((r) => { resolveGet = r; }));
  resolvePost(response(result(2, 2, '2026-09-07T12:00:00Z')));
  await post;
  resolveGet(response(result(2, 2)));
  await get;
  assert.ok(model.appAllowanceStore.get().requestedAt);
  assert.equal(model.appAllowanceStore.get().loading, false);
});

test('network failures retain the last count and expose an actionable error', async () => {
  const model = fresh();
  model.seedAppAllowance({ appCreationQuota: result(2, 1).quota });
  await model.refreshAppAllowance(async () => { throw new Error('Network unavailable'); });
  assert.equal(model.appAllowanceStore.get().quota.remaining, 1);
  assert.equal(model.appAllowanceStore.get().error, 'Network unavailable');
  await assert.rejects(model.requestMoreApps(async () => response({ error: 'Please retry later' }, false)), /Please retry later/);
  assert.equal(model.appAllowanceStore.get().requestedAt, null);
});

// #5737: taking back a pending request so it can be sent again properly.
test('undoing a pending request clears it for every subscriber', async () => {
  const model = fresh();
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push([url, init?.method]);
    return model.appAllowanceStore.get().requestedAt
      ? response(result(2, 2))
      : response(result(2, 2, '2026-09-07T12:00:00Z'));
  };
  await model.requestMoreApps(fetcher);
  assert.ok(model.appAllowanceStore.get().requestedAt);
  await model.cancelAppAllowanceRequest(fetcher);
  assert.deepEqual(calls, [
    ['/api/me/app-allowance/request', 'POST'],
    ['/api/me/app-allowance/request', 'DELETE'],
  ]);
  assert.equal(model.appAllowanceStore.get().requestedAt, null);
});

test('a read started before the undo cannot restore the pending request', async () => {
  const model = fresh();
  model.seedAppAllowance({
    appCreationQuota: result(2, 2).quota,
    appQuotaRequestedAt: '2026-09-07T12:00:00Z',
  });
  let resolve;
  const read = model.refreshAppAllowance(() => new Promise((r) => { resolve = r; }));
  await model.cancelAppAllowanceRequest(async () => response(result(2, 2)));
  resolve(response(result(2, 2, '2026-09-07T12:00:00Z')));
  await read;
  assert.equal(model.appAllowanceStore.get().requestedAt, null);
});

test('a failed undo throws the server\'s message and keeps the request pending', async () => {
  const model = fresh();
  model.seedAppAllowance({
    appCreationQuota: result(2, 2).quota,
    appQuotaRequestedAt: '2026-09-07T12:00:00Z',
  });
  await assert.rejects(
    model.cancelAppAllowanceRequest(async () => response({ error: 'Please retry later' }, false)),
    /Please retry later/,
  );
  assert.equal(model.appAllowanceStore.get().requestedAt, '2026-09-07T12:00:00Z');
  await assert.rejects(
    model.cancelAppAllowanceRequest(async () => response({}, false)),
    /Could not undo your request\./,
  );
  assert.equal(model.appAllowanceStore.get().requestedAt, '2026-09-07T12:00:00Z');
});
