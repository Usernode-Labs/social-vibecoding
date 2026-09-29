'use strict';

// #2506: the private-IP gate could be satisfied by the INGRESS's own address,
// which admitted external callers to four server-to-server surfaces.
//
//   src/middleware/internal-auth.js        (worker push / issues)
//   src/middleware/anthropic-proxy-auth.js (the worker LLM proxy)
//   src/middleware/app-llm-auth.js         (the app LLM proxy, two gates)
//   src/middleware/app-storage-auth.js     (app file storage)
//
// Each one did `if (!isPrivateIp(clientIp(req))) return 403`, which is sound
// only while `clientIp` returns the real originator. It does not always:
//
//   services/client-ip.js resolves the trusted proxy by DNS, and on a lookup
//   failure it empties `trustedAddresses` and falls back to the socket peer.
//   Its own comment calls that "fail closed" — and for the RATE LIMITERS it
//   is, because grouping callers under one key only ever over-counts. For
//   THIS gate it is fail OPEN, because the address it falls back to is the
//   ingress's, and the ingress lives on a private network.
//
// So: DNS blips, an external request arrives through Caddy, `clientIp`
// answers `172.18.0.9`, `isPrivateIp` says yes, and the request is inside.
// Reproduced directly against the unfixed code before this was written.
//
// The same hole is reachable without any DNS failure in Kubernetes mode,
// where `trustDirectPeer` trusts every peer to supply a forwarding header —
// the TODO already recorded at client-ip.js:93.
//
// THE FIX is to stop asking the wrong question. "Is this address private" is
// a proxy for "did this come from inside", and the two diverge exactly here.
// `isDirectInternalCall(req)` asks the real question: the SOCKET PEER is
// private AND the request carries no forwarding header at all. A genuine
// server-to-server call satisfies both — client-ip.js's own comment notes
// that internal calls "carry no forwarding header" — and a request that came
// through any proxy hop fails the second, whatever DNS did.
//
// Run with: node --test tests/internal-gate-direct-peer.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  trustedProxyClientIp, clientIp, isPrivateIp, isDirectInternalCall,
} = require('../src/services/client-ip');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// Run the resolver middleware over a request, as server.js does.
async function resolve(req, { lookup, hostname = 'caddy', trustDirectPeer = false } = {}) {
  const mw = trustedProxyClientIp({ hostname, trustDirectPeer, lookup });
  await new Promise((r) => mw(req, {}, r));
  return req;
}

const dnsDown = async () => { throw new Error('dns down'); };
const dnsUp = async () => [{ address: '172.18.0.9' }];

function request({ peer, headers = {} }) {
  return { socket: { remoteAddress: peer }, headers };
}

// ── The hole ───────────────────────────────────────────────────────────

test('the old question answers YES for an external caller when DNS is down', async () => {
  // This is the bug, stated as a fact about the old predicate rather than
  // asserted away — if this ever stops being true the fix can be revisited.
  const req = await resolve(
    request({ peer: '172.18.0.9', headers: { 'x-forwarded-for': '203.0.113.7' } }),
    { lookup: dnsDown }
  );
  assert.equal(clientIp(req), '172.18.0.9', 'it falls back to the ingress address');
  assert.equal(isPrivateIp(clientIp(req)), true,
    'and the ingress address is private, so the old gate admitted the request');
});

test('the new question answers NO for the same request', async () => {
  const req = await resolve(
    request({ peer: '172.18.0.9', headers: { 'x-forwarded-for': '203.0.113.7' } }),
    { lookup: dnsDown }
  );
  assert.equal(isDirectInternalCall(req), false,
    'it arrived through a proxy hop, whatever DNS managed to resolve');
});

test('and NO when DNS is healthy too — the answer does not depend on it', async () => {
  const req = await resolve(
    request({ peer: '172.18.0.9', headers: { 'x-forwarded-for': '203.0.113.7' } }),
    { lookup: dnsUp }
  );
  assert.equal(isDirectInternalCall(req), false);
  // With DNS up the old predicate happened to be right, which is why the
  // hole only opened intermittently.
  assert.equal(isPrivateIp(clientIp(req)), false);
});

test('Kubernetes mode does not reopen it', async () => {
  // trustDirectPeer trusts EVERY peer to supply a forwarding header
  // (client-ip.js's own TODO). The forwarding header is still the tell.
  const req = await resolve(
    request({ peer: '10.42.0.5', headers: { 'x-forwarded-for': '203.0.113.7' } }),
    { hostname: '', trustDirectPeer: true, lookup: dnsUp }
  );
  assert.equal(isDirectInternalCall(req), false);
});

// ── The calls that must still get through ──────────────────────────────

test('a genuine worker call is still admitted', async () => {
  for (const peer of ['172.18.0.5', '10.42.0.7', '192.168.1.20', '127.0.0.1', '::1']) {
    const req = await resolve(request({ peer }), { lookup: dnsUp });
    assert.equal(isDirectInternalCall(req), true,
      `${peer} is a direct internal peer carrying no forwarding header`);
  }
});

test('a direct call from a public address is refused', async () => {
  const req = await resolve(request({ peer: '203.0.113.7' }), { lookup: dnsUp });
  assert.equal(isDirectInternalCall(req), false);
});

test('any forwarding header disqualifies, not just x-forwarded-for', async () => {
  for (const header of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host']) {
    const req = await resolve(
      request({ peer: '172.18.0.5', headers: { [header]: '203.0.113.7' } }),
      { lookup: dnsUp }
    );
    assert.equal(isDirectInternalCall(req), false, `${header} should disqualify`);
  }
});

test('an empty forwarding header does not disqualify a real internal call', async () => {
  // A header present but empty is not evidence of a proxy hop, and refusing
  // it would break a legitimate caller for no gain.
  const req = await resolve(
    request({ peer: '172.18.0.5', headers: { 'x-forwarded-for': '' } }),
    { lookup: dnsUp }
  );
  assert.equal(isDirectInternalCall(req), true);
});

test('it reads the SOCKET peer, never the resolved clientIp', async () => {
  // If it read req.clientIp it would be reading a value a forwarding header
  // can set, which is the whole bug.
  const req = request({ peer: '203.0.113.7' });
  req.clientIp = '10.0.0.1';
  assert.equal(isDirectInternalCall(req), false,
    'a forged clientIp must not admit a public peer');
});

test('isPrivateIp itself is unchanged and still correct', () => {
  for (const ip of ['127.0.0.1', '::1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.255', '::ffff:10.1.2.3']) {
    assert.equal(isPrivateIp(ip), true, `${ip} is private`);
  }
  for (const ip of ['203.0.113.7', '8.8.8.8', '172.15.0.1', '172.32.0.1', '11.0.0.1', '', null]) {
    assert.equal(isPrivateIp(ip), false, `${ip} is not private`);
  }
});

// ── All four surfaces, and only one implementation ─────────────────────

test('every server-to-server gate asks the new question', () => {
  for (const file of [
    'src/middleware/internal-auth.js',
    'src/middleware/anthropic-proxy-auth.js',
    'src/middleware/app-llm-auth.js',
    'src/middleware/app-storage-auth.js',
  ]) {
    const src = code(read(file));
    assert.match(src, /isDirectInternalCall\(req\)/, `${file} must use the direct-peer gate`);
    assert.doesNotMatch(src, /isPrivateIp\(clientIp\(req\)\)/,
      `${file} still asks whether the RESOLVED address is private — that is the bug`);
  }
});

test('app-llm-auth has BOTH of its gates converted', () => {
  const src = code(read('src/middleware/app-llm-auth.js'));
  const uses = (src.match(/isDirectInternalCall\(req\)/g) || []).length;
  assert.ok(uses >= 2, `expected both gates converted, found ${uses}`);
});

test('there is one isPrivateIp, not two copies drifting apart', () => {
  // It was duplicated verbatim in internal-auth.js and
  // anthropic-proxy-auth.js. Two copies of a security predicate is its own
  // hazard: a fix to one is invisible to the other.
  const canonical = code(read('src/services/client-ip.js'));
  assert.match(canonical, /function isPrivateIp/);
  for (const file of ['src/middleware/internal-auth.js', 'src/middleware/anthropic-proxy-auth.js']) {
    assert.doesNotMatch(code(read(file)), /function isPrivateIp/,
      `${file} must import the predicate, not redefine it`);
  }
});

test('anthropic-proxy-auth still re-exports isPrivateIp for its importers', () => {
  // app-storage-auth.js and app-llm-auth.js import it from there.
  const { isPrivateIp: reexported } = require('../src/middleware/anthropic-proxy-auth');
  assert.equal(typeof reexported, 'function');
  assert.equal(reexported('10.0.0.1'), true);
});
