'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const express = require('express');
const { streamResource } = require('../src/services/http-stream-access');
const policy = require('../src/services/cli-api-policy');
const { DELEGATION_KINDS } = require('../src/services/mcp-connect-constants');
const poolModule = require('../src/db/pool');
const tick = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function server(t, handler, { query = async () => true, options = {}, bearer = false } = {}) {
    let calls = 0;
    const previous = poolModule.getPool;
    poolModule.getPool = () => ({ query: async () => { calls += 1; return { rows: [{ allowed: await query(calls) }] }; } });
    const modulePath = require.resolve('../src/middleware/private-streams');
    delete require.cache[modulePath];
    const { privateStreamDelivery } = require(modulePath);
    const app = express();
    app.use(require('../src/middleware/response-compression').responseCompression());
    app.use((req, _res, next) => {
        req.user = { id: 1 };
        req.cookies = { session: 'synthetic-cookie' };
        if (bearer)
            req.cliAuthenticated = true;
        next();
    });
    app.use(privateStreamDelivery({}, { revalidateMs: 1000, authorizeTimeoutMs: 1000, ...options }));
    app.use(handler);
    const http = app.listen(0, '127.0.0.1');
    await new Promise(resolve => http.once('listening', resolve));
    t.after(async () => { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); poolModule.getPool = previous; delete require.cache[modulePath]; });
    return { base: `http://127.0.0.1:${http.address().port}`, calls: () => calls };
}
const sse = res => { res.setHeader('Content-Type', 'text/event-stream; charset=utf-8'); res.setHeader('Cache-Control', 'public, max-age=100'); };
// The one classified platform stream: Workshop's ask (routes/workshop-ask.js).
const STREAM = '/api/apps/example/workshop/ask';
const post = (url, init = {}) => fetch(url, { method: 'POST', ...init });
test('private SSE classifies current platform routes and rejects new/ambiguous scopes', () => {
    assert.deepEqual(streamResource('POST', '/api/apps/a%2Db/workshop/ask'), { slug: 'a-b' });
    assert.deepEqual(streamResource('POST', '/API/APPS/a-b/WORKSHOP/ASK/'), { slug: 'a-b' });
    for (const [method, path] of [
        ['POST', '/api/apps/a%2Fb/workshop/ask'], ['POST', '/api/apps/%zz/workshop/ask'], ['GET', '/api/apps/a-b/workshop/ask'],
        ['GET', '/api/new-private-stream'],
        // The change and agent chat streams are retired: nothing classifies them any more.
        ['GET', '/api/sessions/1/events'], ['POST', '/api/sessions/1/chat'],
        ['GET', '/api/agent-sessions/1/events'], ['POST', '/api/agent-sessions/1/turns'],
    ])
        assert.equal(streamResource(method, path), null, `${method} ${path}`);
});
test('hosted connector policies expose no SSE routes; adding one needs a streaming credential policy', () => {
    const paths = [
        ['POST', '/api/apps/example/workshop/ask'],
    ];
    for (const [method, path] of paths) {
        assert.equal(policy.isConnectorApiRequest(method, path), false, path);
        for (const kind of DELEGATION_KINDS)
            assert.equal(policy.isDelegatedApiRequest(kind, method, path), false, `${kind}: ${path}`);
    }
});
test('production installs the stream boundary immediately after authentication', () => {
    const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    const auth = source.indexOf('app.use(authMiddleware(config));');
    const guard = source.indexOf("app.use(require('./src/middleware/private-streams').privateStreamDelivery(config));");
    assert.ok(auth >= 0 && guard > auth);
    assert.doesNotMatch(source.slice(auth + 'app.use(authMiddleware(config));'.length, guard), /app\.use\(/, 'no router may bypass delivery between auth and the stream boundary');
    for (const route of ['workshopAskRoutes'])
        assert.ok(source.indexOf(`app.use(${route}(config))`) > guard, route);
});
test('ordinary JSON responses bypass stream authorization and retain their bytes', async (t) => {
    const s = await server(t, (_req, res) => res.status(207).json({ marker: 'ordinary' }));
    const r = await post(s.base + STREAM);
    assert.equal(r.status, 207);
    assert.deepEqual(await r.json(), { marker: 'ordinary' });
    assert.equal(s.calls(), 0);
});
test('one-shot end, UTF-8 framing, compression and private cache headers survive delivery', async (t) => {
    const body = 'event: token\ndata: {"text":"synthetic 🙂"}\n\n';
    const s = await server(t, (_req, res) => { sse(res); res.end(body); });
    const r = await post(s.base + STREAM, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(await r.text(), body);
    assert.equal(r.headers.get('content-encoding'), null);
    assert.match(r.headers.get('cache-control'), /private/);
    assert.match(r.headers.get('cache-control'), /no-store/);
    assert.equal(s.calls(), 1);
});
for (const rawHeaders of [false, true])
    test(`writeHead overload preserves SSE protection (${rawHeaders ? 'array' : 'object'})`, async (t) => {
        const s = await server(t, (_req, res) => {
            res.writeHead(200, 'OK', rawHeaders ? ['Content-Type', 'text/event-stream', 'Cache-Control', 'public'] : { 'Content-Type': 'text/event-stream', 'Cache-Control': 'public' });
            res.end('data: synthetic\n\n');
        });
        const r = await post(s.base + STREAM);
        assert.equal(await r.text(), 'data: synthetic\n\n');
        assert.match(r.headers.get('cache-control'), /no-store/);
        assert.equal(s.calls(), 1);
    });
test('a burst shares a check without dropping frames, UTF-8 byte fragments or callbacks', async (t) => {
    let callbacks = 0;
    const data = Buffer.from('data: 🙂\n\n');
    const s = await server(t, (_req, res) => {
        sse(res);
        for (let i = 0; i < 100; i++) {
            res.write(data.subarray(0, 7), () => callbacks++);
            res.write(data.subarray(7), () => callbacks++);
        }
        res.end();
    });
    const r = await post(s.base + STREAM);
    assert.equal(await r.text(), data.toString().repeat(100));
    await tick();
    assert.equal(callbacks, 200);
    assert.equal(s.calls(), 1);
});
test('an end chunk queued behind an authorization decision is discarded on refusal', async (t) => {
    const entered = gate(), release = gate();
    let done = false;
    const s = await server(t, (_req, res) => { sse(res); res.end('data: FORBIDDEN\n\n', () => { done = true; }); }, {
        query: async () => { entered.resolve(); await release.promise; return false; },
    });
    const response = post(s.base + STREAM);
    await entered.promise;
    release.resolve();
    assert.equal(await (await response).text(), '');
    await tick();
    assert.equal(done, true);
});
test('bytes arriving during an authorized batch need a new snapshot', async (t) => {
    const entered = gate(), release = gate();
    let response;
    const s = await server(t, (_req, res) => { response = res; sse(res); res.write('data: allowed\n\n'); }, {
        query: async (n) => {
            if (n === 1) {
                entered.resolve();
                await release.promise;
                return true;
            }
            return false;
        },
    });
    const request = post(s.base + STREAM);
    await entered.promise;
    response.end('data: FORBIDDEN_NEW_BATCH\n\n');
    release.resolve();
    assert.equal(await (await request).text(), 'data: allowed\n\n');
    assert.equal(s.calls(), 2);
});
for (const failure of ['denied', 'error', 'timeout'])
    test(`stream fails closed when authorization is ${failure}`, async (t) => {
        const s = await server(t, (_req, res) => { sse(res); res.end('data: FORBIDDEN\n\n'); }, {
            query: async () => {
                if (failure === 'error')
                    throw new Error('synthetic failure');
                if (failure === 'timeout')
                    return new Promise(() => { });
                return false;
            },
            options: { authorizeTimeoutMs: 30 },
        });
        assert.equal(await (await post(s.base + STREAM)).text(), '');
    });
test('idle streams are revalidated and closed without needing another private event', async (t) => {
    const s = await server(t, (_req, res) => { sse(res); res.write(':connected\n\n'); }, {
        query: async (n) => n === 1, options: { revalidateMs: 20 },
    });
    assert.equal(await (await post(s.base + STREAM)).text(), ':connected\n\n');
    assert.equal(s.calls(), 2);
});
test('unclassified SSE cannot send bytes even to a valid user', async (t) => {
    const s = await server(t, (_req, res) => { sse(res); res.end('data: FORBIDDEN\n\n'); });
    assert.equal(await (await fetch(s.base + '/api/new-private-stream')).text(), '');
    assert.equal(s.calls(), 0);
});
test('an unsupported connector cannot borrow an accompanying browser cookie', async (t) => {
    const s = await server(t, (_req, res) => { sse(res); res.end('data: FORBIDDEN\n\n'); }, { bearer: true });
    assert.equal(await (await post(s.base + STREAM)).text(), '');
    assert.equal(s.calls(), 0);
});
test('oversized pending output closes the stream with a bounded queue', async (t) => {
    const s = await server(t, (_req, res) => { sse(res); res.end('x'.repeat(1024 * 1024 + 1)); });
    assert.equal(await (await post(s.base + STREAM)).text(), '');
});
test('Express case-insensitive aliases cannot skip current stream authority', async (t) => {
    const s = await server(t, (_req, res) => { sse(res); res.end('data: FORBIDDEN\n\n'); }, { query: async () => false });
    assert.equal(await (await post(s.base + '/API/APPS/example/WORKSHOP/ASK/')).text(), '');
    assert.equal(s.calls(), 1);
});
test('changing the MIME type cannot release an already guarded SSE body', async (t) => {
    const s = await server(t, (_req, res) => {
        sse(res);
        res.write('data: FORBIDDEN_FIRST_CHUNK\n\n');
        res.setHeader('Content-Type', 'application/json');
        res.end('FORBIDDEN_END_CHUNK');
    }, { query: async () => false });
    const response = await post(s.base + STREAM);
    assert.equal(await response.text(), '');
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(s.calls(), 1);
});
test('backpressure preserves a legitimate replay larger than the pending-output limit', async (t) => {
    const frame = 'data: ' + 'x'.repeat(8192) + '\n\n';
    const s = await server(t, async (_req, res) => {
        sse(res);
        for (let i = 0; i < 256; i++) {
            if (res.write(frame) === false)
                await new Promise(resolve => res.once('drain', resolve));
        }
        res.end();
    });
    const r = await post(s.base + STREAM);
    assert.equal(await r.text(), frame.repeat(256));
    assert.ok(s.calls() < 40, 'coalesce frames rather than querying once per frame');
});
