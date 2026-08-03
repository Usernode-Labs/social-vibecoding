// #555: the credit-derivation service.
//
// The arithmetic is "recorded balance − billed spend", and every
// interesting case is about where the spend number comes from and what
// happens when it can't be fetched. Anthropic's `amount` is a decimal
// string ALREADY in cents, so a stray ×100 here would inflate spend a
// hundredfold — pinned below with deliberately fractional values.
//
// Run with: node --test tests/anthropic-credits-service.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const credits = require('../src/services/anthropic-credits');

// A stubbed platform_settings + ledger pool. `settings` is mutated per
// test to move between the configured / not-configured states.
let settings = new Map();
let ledger = { llm: 0, system: 0 };
const pool = {
  async query(sql, params) {
    if (/FROM platform_settings/.test(sql)) {
      const wanted = params[0];
      return {
        rows: [...settings.entries()]
          .filter(([k]) => wanted.includes(k))
          .map(([key, value]) => ({ key, value })),
      };
    }
    if (/FROM llm_usage/.test(sql)) return { rows: [{ cents: ledger.llm }] };
    if (/FROM system_token_usage/.test(sql)) return { rows: [{ cents: ledger.system }] };
    return { rows: [] };
  },
};

const realFetch = global.fetch;
function stubFetch(pages) {
  let i = 0;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    const page = pages[Math.min(i, pages.length - 1)];
    i += 1;
    if (page.status && page.status >= 400) {
      return { ok: false, status: page.status, async text() { return page.body || ''; } };
    }
    return { ok: true, status: 200, async json() { return page; } };
  };
  return calls;
}

function reset() {
  credits.invalidate();
  settings = new Map([
    ['anthropic_credit_balance_cents', '500000'],
    ['anthropic_credit_as_of', '2026-07-01'],
  ]);
  ledger = { llm: 0, system: 0 };
  global.fetch = realFetch;
}

test.afterEach(() => { global.fetch = realFetch; });

// ─── Not configured ──────────────────────────────────────────────────────

test('no recorded balance means not configured, and no upstream call', async () => {
  reset();
  settings.delete('anthropic_credit_balance_cents');
  let called = false;
  global.fetch = async () => { called = true; throw new Error('should not run'); };
  const out = await credits.getCredits(pool, { anthropicAdminKey: 'sk-ant-admin-x' });
  assert.deepEqual(out, { configured: false });
  assert.equal(called, false, 'absence short-circuits before any network call');
});

test('a missing as-of date is also "not configured"', async () => {
  reset();
  settings.delete('anthropic_credit_as_of');
  const out = await credits.getCredits(pool, { anthropicAdminKey: 'sk-ant-admin-x' });
  assert.deepEqual(out, { configured: false });
});

test('a malformed as-of date is rejected rather than sent upstream', async () => {
  reset();
  settings.set('anthropic_credit_as_of', 'last tuesday');
  const out = await credits.getCredits(pool, { anthropicAdminKey: 'sk-ant-admin-x' });
  assert.deepEqual(out, { configured: false });
});

// ─── The Anthropic path ──────────────────────────────────────────────────

test('sums every amount across results and paginated buckets', async () => {
  reset();
  const calls = stubFetch([
    {
      has_more: true,
      next_page: 'page_2',
      data: [
        { results: [{ amount: '1000.5', currency: 'USD' }, { amount: '499.5', currency: 'USD' }] },
        { results: [{ amount: '2000', currency: 'USD' }] },
      ],
    },
    {
      has_more: false,
      next_page: null,
      data: [{ results: [{ amount: '1500', currency: 'USD' }] }],
    },
  ]);

  const out = await credits.getCredits(pool, { anthropicAdminKey: 'sk-ant-admin-x' });
  assert.equal(out.configured, true);
  assert.equal(out.source, 'anthropic');
  // 1000.5 + 499.5 + 2000 + 1500 — cents, not dollars.
  assert.equal(out.spentCents, 5000);
  assert.equal(out.remainingCents, 495000);
  assert.equal(out.partial, false);
  assert.equal(calls.length, 2, 'followed next_page exactly once');
  assert.match(calls[0], /starting_at=2026-07-01T00%3A00%3A00Z/);
  assert.match(calls[0], /bucket_width=1d/);
  assert.match(calls[1], /page=page_2/);
});

test('non-USD rows are skipped rather than added to a dollar total', async () => {
  reset();
  stubFetch([{
    has_more: false,
    data: [{ results: [
      { amount: '1000', currency: 'USD' },
      { amount: '9999', currency: 'EUR' },
    ] }],
  }]);
  const out = await credits.getCredits(pool, { anthropicAdminKey: 'sk-ant-admin-x' });
  assert.equal(out.spentCents, 1000);
});

test('pagination is capped and the truncation is flagged, not silent', async () => {
  reset();
  // Always has_more → the cap is the only thing that can stop it.
  const calls = stubFetch([{
    has_more: true,
    next_page: 'forever',
    data: [{ results: [{ amount: '100', currency: 'USD' }] }],
  }]);
  const out = await credits.getCredits(pool, { anthropicAdminKey: 'sk-ant-admin-x' });
  assert.equal(calls.length, credits.MAX_PAGES, 'stops at the page cap');
  assert.equal(out.partial, true, 'the payload says the window was truncated');
  assert.equal(out.spentCents, 100 * credits.MAX_PAGES);
});

// ─── The local-ledger fallback ───────────────────────────────────────────

test('with no admin key it falls back to the platform ledgers', async () => {
  reset();
  ledger = { llm: 30000, system: 1550 };
  let called = false;
  global.fetch = async () => { called = true; throw new Error('should not run'); };

  const out = await credits.getCredits(pool, {});
  assert.equal(called, false, 'no key means no upstream call at all');
  assert.equal(out.source, 'local-estimate');
  assert.equal(out.spentCents, 31550, 'llm_usage + system_token_usage');
  assert.equal(out.remainingCents, 500000 - 31550);
});

test('the fallback query never touches byok_cost_cents', async () => {
  reset();
  const seen = [];
  const spyPool = {
    async query(sql, params) {
      seen.push(sql);
      return pool.query(sql, params);
    },
  };
  await credits.getCredits(spyPool, {});
  const ledgerSql = seen.filter((s) => /llm_usage/.test(s)).join('\n');
  assert.ok(ledgerSql.length > 0, 'the ledger was read');
  assert.ok(!/byok_cost_cents/.test(ledgerSql),
    'BYOK spend is billed to users’ own keys and must not count against org credit');
});

// ─── Caching and failure ─────────────────────────────────────────────────

test('a second call inside the TTL is served from cache', async () => {
  reset();
  const calls = stubFetch([{ has_more: false, data: [{ results: [{ amount: '100', currency: 'USD' }] }] }]);
  const first = await credits.getCredits(pool, { anthropicAdminKey: 'sk-ant-admin-x' });
  const second = await credits.getCredits(pool, { anthropicAdminKey: 'sk-ant-admin-x' });
  assert.equal(calls.length, 1, 'only one upstream request');
  assert.equal(second.spentCents, first.spentCents);
});

test('re-recording the balance busts the cache even inside the TTL', async () => {
  reset();
  const calls = stubFetch([{ has_more: false, data: [{ results: [{ amount: '100', currency: 'USD' }] }] }]);
  await credits.getCredits(pool, { anthropicAdminKey: 'sk-ant-admin-x' });
  settings.set('anthropic_credit_balance_cents', '900000');
  const out = await credits.getCredits(pool, { anthropicAdminKey: 'sk-ant-admin-x' });
  assert.equal(calls.length, 2, 'the cache entry is bound to the settings that produced it');
  assert.equal(out.remainingCents, 900000 - 100);
});

test('a 401 serves the cached figure, flagged stale', async () => {
  reset();
  stubFetch([{ has_more: false, data: [{ results: [{ amount: '100', currency: 'USD' }] }] }]);
  const good = await credits.getCredits(pool, { anthropicAdminKey: 'sk-ant-admin-x' });
  assert.equal(good.stale, undefined);

  // Same settings, so the cache key matches; force past the TTL.
  stubFetch([{ status: 401, body: '{"error":"nope"}' }]);
  const out = await credits.getCredits(pool, { anthropicAdminKey: 'sk-ant-admin-x' }, { force: true });
  assert.equal(out.stale, true);
  assert.equal(out.remainingCents, good.remainingCents, 'the last good figure survives');
  assert.match(out.error, /401/);
});

test('a failure with nothing cached returns no numbers rather than a zero', async () => {
  reset();
  stubFetch([{ status: 500, body: 'boom' }]);
  const out = await credits.getCredits(pool, { anthropicAdminKey: 'sk-ant-admin-x' });
  assert.equal(out.configured, true);
  assert.equal(out.remainingCents, undefined,
    'a rendered 0 would read as "out of credit" — leave it absent');
  assert.match(out.error, /500/);
});

test('getCredits never throws, even on a hard network error', async () => {
  reset();
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const out = await credits.getCredits(pool, { anthropicAdminKey: 'sk-ant-admin-x' });
  assert.equal(out.configured, true);
  assert.match(out.error, /ECONNREFUSED/);
});
