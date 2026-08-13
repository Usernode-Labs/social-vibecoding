// The offline feedback outbox (#1054): public/js/feedback-queue.js.
//
// The module is written to be requireable in Node — no window, so it picks
// its in-memory storage adapter and every pure helper is exported. That means
// the interesting behaviour (caps, dedupe, failure classification, backoff,
// the sequential single-flight flush) is tested for real here, against a
// stubbed fetch, rather than only asserted as source text.
//
// Each test re-requires the module so it starts with an empty store: the
// adapter is module state on purpose (one queue per page), which makes a
// fresh require the cheapest possible reset.
//
// Run with: node --test tests/feedback-offline-queue.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const MODULE_PATH = require.resolve('../public/js/feedback-queue.js');

function load() {
  delete require.cache[MODULE_PATH];
  return require(MODULE_PATH);
}

// A submit body as app.js would hand it over.
function entry(over = {}) {
  return {
    payload: Object.assign({
      description: 'The board scrolls to the top when I drag a card.',
      target: 'platform',
    }, over),
  };
}

// fetch stub: `plan` is consulted per call and returns
// { status } | { throws: true } | { status, body }.
function stubFetch(plan) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const call = { url: String(url), method: opts && opts.method, body: opts && opts.body };
    calls.push(call);
    const next = typeof plan === 'function' ? plan(call, calls.length - 1) : plan;
    if (next && next.throws) throw new TypeError('Failed to fetch');
    const status = (next && next.status) || 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (next && next.body) || {},
    };
  };
  return calls;
}

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

// ── Pure helpers ─────────────────────────────────────────────────────

test('dedupeKey: identity is target + app + title + description, trimmed', () => {
  const FQ = load();
  assert.equal(
    FQ.dedupeKey({ payload: { target: 'app', appSlug: 'a', title: ' T ', description: ' hi ' } }),
    'app|a|T|hi',
  );
  // Anything other than the explicit 'app' opt-in is platform feedback, the
  // same normalisation the server does.
  assert.equal(FQ.dedupeKey({ payload: { description: 'hi' } }), 'platform|||hi');
  // Re-tapping "Save for later" on an unchanged draft must collide.
  assert.equal(
    FQ.dedupeKey({ payload: { description: 'hi' } }),
    FQ.dedupeKey({ payload: { target: 'platform', description: 'hi' } }),
  );
  // A different app is a different message even with identical words.
  assert.notEqual(
    FQ.dedupeKey({ payload: { target: 'app', appSlug: 'a', description: 'hi' } }),
    FQ.dedupeKey({ payload: { target: 'app', appSlug: 'b', description: 'hi' } }),
  );
});

test('withinCaps: duplicates, the entry cap and the screenshot byte cap each have a reason', () => {
  const FQ = load();
  const one = { payload: { description: 'hi' }, screenshotBytes: 0 };

  assert.deepEqual(FQ.withinCaps([], one), { ok: true, reason: null });
  assert.deepEqual(FQ.withinCaps([one], one), { ok: false, reason: 'duplicate' });

  const full = Array.from({ length: FQ.MAX_ENTRIES }, (_, i) => ({ payload: { description: `m${i}` } }));
  assert.deepEqual(FQ.withinCaps(full, one), { ok: false, reason: 'full' });
  assert.equal(FQ.withinCaps(full.slice(0, FQ.MAX_ENTRIES - 1), one).ok, true);

  // Bytes are summed across the queue, not checked per entry — one 11 MB
  // screenshot plus another 2 MB one is what actually threatens the quota.
  const heavy = [{ payload: { description: 'a' }, screenshotBytes: FQ.MAX_SCREENSHOT_BYTES - 1024 }];
  assert.deepEqual(
    FQ.withinCaps(heavy, { payload: { description: 'b' }, screenshotBytes: 4096 }),
    { ok: false, reason: 'too-large' },
  );
  assert.equal(FQ.withinCaps(heavy, { payload: { description: 'b' }, screenshotBytes: 512 }).ok, true);
});

test('classifyFailure: transient retries, a lapsed session retries for free, a bad request is permanent', () => {
  const FQ = load();
  assert.equal(FQ.classifyFailure({ networkError: true }), 'retry');
  assert.equal(FQ.classifyFailure({ status: 0, networkError: true }), 'retry');
  assert.equal(FQ.classifyFailure({ status: 500 }), 'retry');
  assert.equal(FQ.classifyFailure({ status: 502 }), 'retry');
  assert.equal(FQ.classifyFailure({ status: 503 }), 'retry');
  assert.equal(FQ.classifyFailure({ status: 429 }), 'retry');
  // Signed out / no longer permitted: retry when the session is back, but
  // don't age the record out while nobody is signed in.
  assert.equal(FQ.classifyFailure({ status: 401 }), 'retry-no-count');
  assert.equal(FQ.classifyFailure({ status: 403 }), 'retry-no-count');
  // Waiting cannot fix these.
  assert.equal(FQ.classifyFailure({ status: 400 }), 'permanent');
  assert.equal(FQ.classifyFailure({ status: 404 }), 'permanent');
  assert.equal(FQ.classifyFailure({ status: 409 }), 'permanent');
  assert.equal(FQ.classifyFailure({ status: 200 }), 'ok');
});

test('backoffMs: 30s doubling, capped at ten minutes', () => {
  const FQ = load();
  assert.equal(FQ.backoffMs(0), 30_000);
  assert.equal(FQ.backoffMs(1), 60_000);
  assert.equal(FQ.backoffMs(2), 120_000);
  assert.equal(FQ.backoffMs(4), 480_000);
  assert.equal(FQ.backoffMs(5), 600_000);
  assert.equal(FQ.backoffMs(50), 600_000, 'never grows without bound');
  assert.equal(FQ.backoffMs(undefined), 30_000);
});

test('formatQueuedAt: ISO-8601 UTC, or null for an unusable clock', () => {
  const FQ = load();
  assert.equal(FQ.formatQueuedAt(Date.parse('2026-08-11T10:00:00.000Z')), '2026-08-11T10:00:00.000Z');
  assert.equal(FQ.formatQueuedAt(0), null);
  assert.equal(FQ.formatQueuedAt(NaN), null);
  assert.equal(FQ.formatQueuedAt('nope'), null);
  assert.equal(FQ.formatQueuedAt(Number.MAX_VALUE), null, 'an out-of-range date must not throw');
});

test('isDue: honours the backoff, a live claim, and never picks up a failed record', () => {
  const FQ = load();
  const now = 1_000_000;
  assert.equal(FQ.isDue({ nextAttemptAt: now - 1, status: 'pending' }, now), true);
  assert.equal(FQ.isDue({ nextAttemptAt: now + 1, status: 'pending' }, now), false);
  assert.equal(FQ.isDue({ nextAttemptAt: 0, status: 'failed' }, now), false);
  // Another tab is sending it right now.
  assert.equal(FQ.isDue({ nextAttemptAt: 0, sendingSince: now - 1000 }, now), false);
  // ...but a tab closed mid-flight must not strand it forever.
  assert.equal(FQ.isDue({ nextAttemptAt: 0, sendingSince: now - 5 * 60_000 }, now), true);
});

// ── enqueue / pending ────────────────────────────────────────────────

test('enqueue: keeps the payload and stamps a queuedAt the server can print', async () => {
  const FQ = load();
  const rec = await FQ.enqueue(entry({ title: 'Board jumps' }));

  assert.equal(rec.payload.description, 'The board scrolls to the top when I drag a card.');
  assert.equal(rec.payload.title, 'Board jumps');
  assert.equal(rec.status, 'pending');
  assert.equal(rec.attempts, 0);
  assert.match(rec.queuedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d\d\dZ$/);

  const pending = await FQ.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, rec.id);
});

test('enqueue: an identical draft is refused with a code the dialog can explain', async () => {
  const FQ = load();
  await FQ.enqueue(entry());
  await assert.rejects(() => FQ.enqueue(entry()), (err) => {
    assert.equal(err.code, 'duplicate');
    return true;
  });
  assert.equal((await FQ.pending()).length, 1, 'the queue did not grow');
});

test('enqueue: the entry cap is enforced against the store, not just in the helper', async () => {
  const FQ = load();
  for (let i = 0; i < FQ.MAX_ENTRIES; i++) await FQ.enqueue(entry({ description: `message ${i}` }));
  await assert.rejects(() => FQ.enqueue(entry({ description: 'one too many' })), (err) => {
    assert.equal(err.code, 'full');
    return true;
  });
  assert.equal((await FQ.pending()).length, FQ.MAX_ENTRIES);
});

// ── flush ────────────────────────────────────────────────────────────

test('flush: posts the payload with queuedAt and drops the record once filed', async () => {
  const FQ = load();
  const rec = await FQ.enqueue(entry({ target: 'app', appSlug: 'demo-app' }));
  const calls = stubFetch({ status: 200, body: { issueUrl: 'https://github.com/o/r/issues/9' } });

  const res = await FQ.flush('test');
  assert.equal(res.sent, 1);
  assert.equal(res.failed, 0);
  assert.equal(res.remaining, 0);
  assert.equal(res.filed[0].appSlug, 'demo-app');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/feedback');
  const posted = JSON.parse(calls[0].body);
  assert.equal(posted.target, 'app');
  assert.equal(posted.appSlug, 'demo-app');
  assert.equal(posted.queuedAt, rec.queuedAt);

  assert.deepEqual(await FQ.pending(), [], 'a filed message is gone from the outbox');
});

test('flush: a 500 keeps the message, counts one attempt and backs off', async () => {
  const FQ = load();
  await FQ.enqueue(entry());
  stubFetch({ status: 500 });

  const before = Date.now();
  const res = await FQ.flush();
  assert.equal(res.sent, 0);
  assert.equal(res.failed, 0);
  assert.equal(res.remaining, 1);

  const [rec] = await FQ.pending();
  assert.equal(rec.attempts, 1);
  assert.equal(rec.status, 'pending');
  assert.equal(rec.sendingSince, null, 'the claim is released');
  assert.ok(rec.nextAttemptAt >= before + FQ.backoffMs(1), 'waits out the backoff before retrying');
});

test('flush: a 401 retries without ageing the record out', async () => {
  const FQ = load();
  await FQ.enqueue(entry());
  stubFetch({ status: 401 });

  await FQ.flush();
  const [rec] = await FQ.pending();
  assert.equal(rec.attempts, 0, 'a lapsed session must not consume the retry budget');
  assert.equal(rec.status, 'pending');
});

test('flush: a 400 becomes a failed record, handed back exactly once', async () => {
  const FQ = load();
  await FQ.enqueue(entry({ description: 'a message the server refuses' }));
  stubFetch({ status: 400, body: { error: 'description too long' } });

  const res = await FQ.flush();
  assert.equal(res.failed, 1);
  assert.equal(res.remaining, 0, 'a failed record is no longer "waiting to send"');

  const failed = await FQ.takeFailed();
  assert.equal(failed.payload.description, 'a message the server refuses');
  assert.equal(failed.lastError, 'description too long');
  assert.equal(await FQ.takeFailed(), null, 'handing it back removes it');
});

test('flush: a dropped connection stops the pass instead of burning every attempt', async () => {
  const FQ = load();
  await FQ.enqueue(entry({ description: 'first' }));
  await FQ.enqueue(entry({ description: 'second' }));
  const calls = stubFetch({ throws: true });

  await FQ.flush();
  assert.equal(calls.length, 1, 'the second message is not attempted on a dead connection');

  const pending = await FQ.pending();
  assert.equal(pending.length, 2);
  assert.equal(pending.filter((r) => r.attempts === 1).length, 1);
  assert.equal(pending.filter((r) => r.attempts === 0).length, 1);
});

test('flush: concurrent callers share one pass, so nothing is filed twice', async () => {
  const FQ = load();
  await FQ.enqueue(entry());
  const calls = stubFetch({ status: 200 });

  const [a, b] = await Promise.all([FQ.flush('reconnect'), FQ.flush('timer')]);
  assert.equal(calls.length, 1, 'one POST for one queued message');
  assert.equal(a, b, 'the second caller awaited the in-flight pass');
  assert.equal((await FQ.pending()).length, 0);
});

test('flush: a screenshot is uploaded first and its id attached to the submit', async () => {
  const FQ = load();
  // The in-memory adapter keeps blobs, like IndexedDB does.
  const blob = { size: 1234, type: 'image/png' };
  await FQ.enqueue({ payload: { description: 'with a picture', target: 'platform' }, screenshot: blob });

  const calls = stubFetch((call) => (call.url === '/api/feedback/screenshot'
    ? { status: 200, body: { id: 'a'.repeat(32) } }
    : { status: 200 }));

  const res = await FQ.flush();
  assert.equal(res.sent, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, '/api/feedback/screenshot');
  assert.equal(calls[0].body, blob, 'the retained bytes are what gets uploaded');
  assert.equal(JSON.parse(calls[1].body).screenshotId, 'a'.repeat(32));
});

test('flush: a screenshot the server rejects outright still files the words', async () => {
  const FQ = load();
  await FQ.enqueue({
    payload: { description: 'with a doomed picture', target: 'platform' },
    screenshot: { size: 99, type: 'image/gif' },
  });
  const calls = stubFetch((call) => (call.url === '/api/feedback/screenshot'
    ? { status: 400, body: { error: 'unsupported image type' } }
    : { status: 200 }));

  const res = await FQ.flush();
  assert.equal(res.sent, 1, 'the description is worth more than the attachment');
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[1].body).screenshotId, undefined);
});

test('flush: a screenshot upload that times out retries the whole message', async () => {
  const FQ = load();
  await FQ.enqueue({
    payload: { description: 'keep us together', target: 'platform' },
    screenshot: { size: 99, type: 'image/png' },
  });
  const calls = stubFetch({ throws: true });

  const res = await FQ.flush();
  assert.equal(res.sent, 0);
  assert.equal(calls.length, 1, 'the submit is not sent without its attachment');
  assert.equal((await FQ.pending()).length, 1);
});

// ── display-only seeding (the ?shot= links) ──────────────────────────

test('seedDisplayOnly: shows a queued message but never sends one', async () => {
  const FQ = load();
  FQ.seedDisplayOnly([{ payload: { description: 'a saved message', target: 'platform' } }]);
  const calls = stubFetch({ status: 200 });

  assert.equal((await FQ.pending()).length, 1);
  const res = await FQ.flush('test');
  assert.equal(res.sent, 0);
  assert.equal(calls.length, 0, 'a screenshot link must never file an issue');
  assert.equal((await FQ.pending()).length, 1, 'the pinned state survives a flush attempt');
});

test('seedDisplayOnly: an earlier IndexedDB open cannot replace the screenshot store', async () => {
  let openRequest;
  const previousWindow = global.window;
  global.window = {
    App: { user: { id: 7 } },
    indexedDB: {
      open() {
        openRequest = {};
        return openRequest;
      },
    },
    localStorage: {},
  };
  try {
    const FQ = load();
    // Matches browser boot: the dialog controller starts opening the durable
    // store, then enterAuthed applies ?shot=feedback-queued before that open
    // has completed.
    const openingRead = FQ.pending();
    assert.ok(openRequest, 'the IndexedDB open is pending');
    FQ.seedDisplayOnly([{ payload: { description: 'seed wins', target: 'platform' } }]);

    openRequest.result = {};
    openRequest.onsuccess();

    assert.equal((await openingRead).length, 1,
      'the read that started before the seed is redirected to the seeded adapter');
    assert.equal(FQ.storage, 'memory');
    assert.equal((await FQ.pending())[0].payload.description, 'seed wins');
  } finally {
    delete require.cache[MODULE_PATH];
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});

test('storage: reports which adapter is backing the queue', async () => {
  const FQ = load();
  assert.equal(FQ.storage, 'none', 'nothing is opened until the queue is used');
  await FQ.pending();
  // No window in Node, so it lands on the in-memory adapter; in a browser this
  // is 'idb', or 'local' where IndexedDB is unavailable.
  assert.equal(FQ.storage, 'memory');
});
