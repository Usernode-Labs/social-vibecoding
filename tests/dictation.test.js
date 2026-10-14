'use strict';

// Real services with bounded provider doubles; hardware runs are separate.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { loadTsx } = require('./lib/render-tsx');
const { pcmWav, appendTranscript, DictationSession } = loadTsx('frontend/src/features/dictation/session.ts');
const { validateWav, transcribe, MAX_BYTES } = require('../src/services/dictation');
const { dictationRoutes } = require('../src/routes/dictation');
const { encrypt } = require('../src/services/secrets');

async function recording(seconds = 1) {
  return Buffer.from(await pcmWav(Float32Array.from({ length: 16000 * seconds }, (_, i) => Math.sin(i / 13) * 0.2)).arrayBuffer());
}

test('PCM encoding has a real frame-derived duration and preserves signed samples', async () => {
  const data = await recording(2);
  assert.deepEqual(validateWav(data), { seconds: 2 });
  assert.equal(data.length, 64044);
  const signed = Buffer.from(await pcmWav(new Float32Array([-1, 0, 1])).arrayBuffer());
  assert.equal(signed.readInt16LE(44), -32768); assert.equal(signed.readInt16LE(48), 32767);
});

test('audio validation rejects silence, oversized data, wrong rate and false chunk lengths', async () => {
  const data = await recording();
  for (const alter of [b => b.writeUInt32LE(48000, 24), b => b.writeUInt32LE(1, 40), b => b.writeUInt16LE(2, 22)]) {
    const invalid = Buffer.from(data); alter(invalid); assert.throws(() => validateWav(invalid), /invalid_audio/);
  }
  assert.throws(() => validateWav(Buffer.alloc(MAX_BYTES + 2)), /invalid_audio/);
  const silence = Buffer.from(await pcmWav(new Float32Array(16000)).arrayBuffer());
  assert.throws(() => validateWav(silence), /no_speech/);
});

test('a transcript appends to current words without silently truncating the draft', () => {
  assert.equal(appendTranscript('Typed meanwhile.', ' Spoken words. ', 100), 'Typed meanwhile. Spoken words.');
  assert.equal(appendTranscript('Line\n', 'Next', 100), 'Line\nNext');
  assert.throws(() => appendTranscript('Keep my draft', 'too much speech', 15), /too_long/);
});

test('the provider receives actual WAV bytes and only returns bounded plain text', async () => {
  const data = await recording(); let seen;
  const result = await transcribe({ data, apiKey: 'private-test-key', config: {}, fetchImpl: async (url, init) => {
    seen = { url, init }; return Response.json({ text: '  Purple bicycle 47.  ', usage: { cost: 0.0001 } });
  } });
  assert.match(seen.url, /\/audio\/transcriptions$/);
  const body = JSON.parse(seen.init.body);
  assert.deepEqual(Buffer.from(body.input_audio.data, 'base64'), data);
  assert.equal(body.input_audio.format, 'wav'); assert.equal(result.text, 'Purple bicycle 47.');
  for (const [status, code] of [[402, 'credits_required'], [401, 'key_required'], [429, 'busy'], [500, 'transcription_failed']]) {
    await assert.rejects(transcribe({ data, apiKey: 'secret', config: {}, fetchImpl: async () => new Response('provider details', { status }) }), new RegExp(code));
  }
  await assert.rejects(transcribe({ data, apiKey: null, config: {} }), /key_required/);
  await assert.rejects(transcribe({ data, apiKey: 'key', config: {}, fetchImpl: async () => Response.json({ text: 'x'.repeat(16001) }) }), /transcription_failed/);
});

let nextUserId = 7000;
async function serverFor(t, { user = { id: nextUserId++ }, config = {}, ...deps } = {}) {
  const app = express();
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(dictationRoutes(config, { pool: { query: async () => ({ rows: [] }) },
    readMetadata: async () => ({ revision: 1, metadata: { source: 'personal' } }),
    readSecret: async () => 'test-key', checkBudget: async () => ({ ok: true }), recordSpend: async () => {}, ...deps }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/api/dictation/transcribe`;
}
const post = (url, data, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'audio/wav', ...headers }, body: data });

test('dictation reuses the signed-in account’s encrypted managed key and never borrows another account’s key', async t => {
  const managedUserId = nextUserId++;
  const revokedUserId = nextUserId++;
  const dataKey = 'synthetic-dictation-encryption-key';
  const assignedKey = 'synthetic-managed-openrouter-key';
  const pool = { query: async (sql, values) => {
    if (!sql.includes('FROM credentials.user_ai_credentials')) return { rows: [] };
    assert.deepEqual(values.slice(1), ['openrouter', 'coding_agent']);
    if (![managedUserId, revokedUserId].includes(values[0])) return { rows: [] };
    return { rows: [{ status: values[0] === revokedUserId ? 'revoked' : 'valid',
      secret_enc: encrypt(assignedKey, dataKey), revision: 1, metadata: { source: 'usernode_managed' } }] };
  } };
  const url = await serverFor(t, { user: { id: managedUserId }, config: { dataEncryptionKey: dataKey }, pool,
    readMetadata: null, readSecret: null, transcribe: async ({ apiKey }) => {
      assert.equal(apiKey, assignedKey);
      return { text: 'Managed key works', seconds: 1, usage: {} };
    } });
  const data = await recording();
  const response = await post(url, data);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).text, 'Managed key works');
  // The real provider service refuses missing/revoked keys before any network request.
  for (const id of [nextUserId++, revokedUserId]) {
    const unavailable = await serverFor(t, { user: { id }, config: { dataEncryptionKey: dataKey }, pool, readMetadata: null, readSecret: null });
    const denied = await post(unavailable, data);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'key_required');
  }
});

test('managed dictation observes the shared budget and records provider cost in the correct bucket', async t => {
  const user = { id: nextUserId++ };
  let allowed = false; let calls = 0; const spend = [];
  const url = await serverFor(t, { user,
    readMetadata: async () => ({ revision: 4, metadata: { source: 'usernode_managed' } }),
    readSecret: async (args) => { assert.equal(args.expectedRevision, 4); return 'synthetic-key'; },
    checkBudget: async (_pool, id) => { assert.equal(id, user.id); return allowed ? { ok: true } : { error: 'Weekly limit reached', reason: 'weekly_limit' }; },
    transcribe: async () => { calls++; return { text: 'words', seconds: 1, usage: { cost: 0.0001 } }; },
    recordSpend: async (_pool, ...args) => { spend.push(args); },
  });
  const data = await recording();
  const refused = await post(url, data);
  assert.equal(refused.status, 402); assert.equal((await refused.json()).code, 'credits_required');
  assert.equal(calls, 0); assert.deepEqual(spend, []);
  allowed = true;
  assert.equal((await post(url, data)).status, 200);
  assert.deepEqual(spend, [[user.id, 0.01, { byok: false }]]);
  const ownKeyUser = { id: nextUserId++ };
  const byok = await serverFor(t, { user: ownKeyUser,
    checkBudget: async () => assert.fail('Personal keys do not use the platform allowance'),
    transcribe: async () => ({ text: 'own words', seconds: 1, usage: { cost: 0.0001 } }),
    recordSpend: async (_pool, ...args) => { spend.push(args); },
  });
  assert.equal((await post(byok, data)).status, 200);
  assert.deepEqual(spend[1], [ownKeyUser.id, 0.01, { byok: true }]);
});

test('route gates authentication, cross-origin requests, MIME, byte limits and audio before provider work', async t => {
  let calls = 0;
  const deps = { transcribe: async () => { calls++; return { text: 'result', seconds: 1, model: 'test', usage: {} }; } };
  const anonymous = await serverFor(t, { user: null, ...deps });
  assert.equal((await post(anonymous, await recording())).status, 401);
  const url = await serverFor(t, deps);
  assert.equal((await post(url, await recording(), { 'Sec-Fetch-Site': 'same-site' })).status, 403);
  assert.equal((await post(url, await recording(), { 'Content-Type': 'application/json' })).status, 415);
  assert.equal((await post(url, Buffer.alloc(MAX_BYTES + 1))).status, 413);
  assert.equal((await post(url, Buffer.from('invalid'))).status, 400);
  assert.equal(calls, 0);
  const good = await post(url, await recording());
  assert.equal(good.status, 200); assert.match(good.headers.get('cache-control'), /no-store/);
  assert.deepEqual(Object.keys(await good.json()).sort(), ['requestId', 'seconds', 'text']); assert.equal(calls, 1);
});

test('only one provider request per user is in flight and completion frees the slot', async t => {
  let release; let started;
  const begun = new Promise(r => { started = r; });
  const waiting = new Promise(r => { release = r; });
  const url = await serverFor(t, { transcribe: async () => { started(); await waiting; return { text: 'ok', seconds: 1, usage: {} }; } });
  const data = await recording(); const first = post(url, data); await begun;
  assert.equal((await post(url, data)).status, 429);
  release(); assert.equal((await first).status, 200);
  assert.equal((await post(url, data)).status, 200);
});

test('a provider timeout aborts its work and frees the user to try again', async t => {
  let attempts = 0;
  const url = await serverFor(t, { timeoutMs: 30, transcribe: async ({ signal }) => {
    if (++attempts > 1) return { text: 'recovered', seconds: 1, usage: {} };
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  const data = await recording();
  const timedOut = await post(url, data);
  assert.equal(timedOut.status, 504); assert.equal((await timedOut.json()).code, 'timeout');
  assert.equal((await post(url, data)).status, 200);
});

test('rate limits bound repeated successful recordings before provider work', async t => {
  let calls = 0;
  const url = await serverFor(t, { transcribe: async () => { calls++; return { text: 'speech', seconds: 1, usage: {} }; } });
  const data = await recording();
  for (let i = 0; i < 12; i++) assert.equal((await post(url, data)).status, 200);
  assert.equal((await post(url, data)).status, 429); assert.equal(calls, 12);
});

test('disconnecting the browser aborts upstream work', async t => {
  let started; let stopped;
  const begun = new Promise(r => { started = r; });
  const aborted = new Promise(r => { stopped = r; });
  const url = await serverFor(t, { transcribe: async ({ signal }) => {
    started();
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => { stopped(); reject(new Error('aborted')); }, { once: true }));
  } });
  const controller = new AbortController();
  const pending = fetch(url, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: await recording(), signal: controller.signal });
  await begun; controller.abort(); await assert.rejects(pending);
  await Promise.race([aborted, new Promise((_r, reject) => { const timer = setTimeout(() => reject(new Error('upstream kept recording')), 1000); timer.unref(); })]);
});

function browser(t, getUserMedia, fetchImpl) {
  const originals = new Map(['navigator', 'MediaRecorder', 'OfflineAudioContext', 'fetch'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const track = { readyState: 'live', onended: null, stop() { this.readyState = 'ended'; } };
  const stream = { getTracks: () => [track] };
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['recorded']) }); void this.onstop?.(); }
  }
  const values = { navigator: { mediaDevices: { getUserMedia: getUserMedia || (async () => stream) } }, MediaRecorder: Recorder,
    OfflineAudioContext: class { async decodeAudioData() { return { length: 16000, duration: 1, numberOfChannels: 1, getChannelData: () => Float32Array.from({ length: 16000 }, () => 0.2) }; } },
    fetch: fetchImpl || (async () => Response.json({ text: 'Spoken phrase', requestId: 'test-request' })) };
  for (const [k, value] of Object.entries(values)) Object.defineProperty(globalThis, k, { configurable: true, writable: true, value });
  t.after(() => { for (const [k, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, k, descriptor); else delete globalThis[k]; } });
  return { stream, track };
}
const settle = () => new Promise(r => setTimeout(r, 20));

test('recording releases its tracks before transcription and inserts exactly once', async t => {
  let captured = []; const { track } = browser(t, null, async () => { assert.equal(track.readyState, 'ended'); return Response.json({ text: 'speech' }); });
  const session = new DictationSession({ onState() {}, onText: text => captured.push(text) });
  await session.start(); assert.equal(track.readyState, 'live'); session.stop(); await settle();
  assert.deepEqual(captured, ['speech']); assert.equal(session.diagnostics.tracksEnded, true);
  session.cancel();
});

test('permission granted after cancellation immediately releases its tracks', async t => {
  let grant; const permission = new Promise(r => { grant = r; });
  const { stream, track } = browser(t, () => permission);
  const session = new DictationSession({ onState() {}, onText() { assert.fail('cancelled'); } });
  const opening = session.start(); session.cancel(); grant(stream); await opening;
  assert.equal(track.readyState, 'ended');
});

test('permission refusal returns an actionable error and no recording', async t => {
  browser(t, async () => { throw new DOMException('denied', 'NotAllowedError'); });
  let state;
  const session = new DictationSession({ onState: next => { state = next; }, onText() { assert.fail('no microphone was granted'); } });
  await session.start(); assert.deepEqual(state, { phase: 'idle', error: 'permission_denied' });
});

test('a cancelled transcription cannot insert its late response into a different draft', async t => {
  let finish; let requested;
  const begun = new Promise(r => { requested = r; });
  const response = new Promise(r => { finish = r; });
  browser(t, null, async () => { requested(); return response; });
  const words = []; const session = new DictationSession({ onState() {}, onText: text => words.push(text) });
  await session.start(); session.stop(); await begun; session.cancel();
  finish(Response.json({ text: 'late speech' })); await settle(); assert.deepEqual(words, []);
});

test('starting another composer cancels the earlier microphone owner', async t => {
  const { track } = browser(t); let firstPhase;
  const first = new DictationSession({ onState: state => { firstPhase = state.phase; }, onText() {} });
  const second = new DictationSession({ onState() {}, onText() {} });
  await first.start(); await second.start(); assert.equal(firstPhase, 'idle');
  second.cancel(); assert.equal(track.readyState, 'ended');
});
