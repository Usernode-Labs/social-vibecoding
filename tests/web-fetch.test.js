// Tests for src/services/web-fetch.js — the Mayor's web_fetch data tool
// (#30). Covers the SSRF gate (scheme/shape rejection, every blocked
// IPv4/IPv6 range, mixed public+private answers, literal-IP hostnames),
// redirect handling (per-hop re-validation, the 5-redirect limit,
// relative Location resolution), content handling (HTML extraction,
// 20k-char truncation, JSON passthrough, binary refusal), and the
// never-throws contract (network error, timeout, DNS failure all return
// { content: null, note }).
//
// Network access is stubbed at two seams: global.fetch (same pattern as
// tests/github-issues-cache.test.js) and the injectable DNS lookup
// (webFetch._setLookup).
//
// Run with: node --test tests/web-fetch.test.js

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const webFetch = require('../src/services/web-fetch');

const realFetch = global.fetch;

// Lookup stub: hostname -> array of { address, family }, or a function.
// Unknown hostnames reject (DNS failure).
function stubLookup(map) {
  webFetch._setLookup(async (host) => {
    if (typeof map === 'function') return map(host);
    if (Object.prototype.hasOwnProperty.call(map, host)) return map[host];
    throw new Error(`ENOTFOUND ${host}`);
  });
}

// fetch stub: url -> response spec { status, headers, body } or a
// function (url, opts) => spec. Responses expose headers.get and .text()
// (the service's non-streaming fallback path).
function stubFetch(routes) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push(String(url));
    const spec = typeof routes === 'function'
      ? await routes(String(url), opts)
      : routes[String(url)];
    if (!spec) throw new Error(`fetch failed: no stub for ${url}`);
    if (spec.throw) throw spec.throw;
    const headers = { 'content-type': 'text/html', ...(spec.headers || {}) };
    return {
      ok: spec.status ? spec.status >= 200 && spec.status < 300 : true,
      status: spec.status || 200,
      headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
      text: async () => spec.body || '',
    };
  };
  return calls;
}

beforeEach(() => {
  stubLookup({ 'public.example': [{ address: '93.184.216.34', family: 4 }] });
});

afterEach(() => {
  webFetch._setLookup(null);
  global.fetch = realFetch;
});

// --- Scheme / shape rejection -------------------------------------------

test('rejects non-http(s) schemes and malformed URLs', async () => {
  for (const bad of ['ftp://example.com/x', 'file:///etc/passwd', 'javascript:alert(1)']) {
    const result = await webFetch.fetchUrl(bad);
    assert.strictEqual(result.content, null, bad);
    assert.match(result.note, /unsupported scheme/, bad);
  }
  const unparseable = await webFetch.fetchUrl('not a url at all');
  assert.strictEqual(unparseable.content, null);
  assert.match(unparseable.note, /invalid URL/);
  const empty = await webFetch.fetchUrl('');
  assert.strictEqual(empty.content, null);
  const nonString = await webFetch.fetchUrl(undefined);
  assert.strictEqual(nonString.content, null);
});

test('rejects URLs carrying userinfo', async () => {
  const result = await webFetch.fetchUrl('https://user:pass@public.example/');
  assert.strictEqual(result.content, null);
  assert.match(result.note, /credentials/);
  const userOnly = await webFetch.fetchUrl('https://user@public.example/');
  assert.strictEqual(userOnly.content, null);
  assert.match(userOnly.note, /credentials/);
});

// --- Address blocking -----------------------------------------------------

test('isBlockedAddress blocks every listed IPv4 range', () => {
  const blocked = [
    '0.0.0.1',          // 0.0.0.0/8
    '10.1.2.3',         // 10.0.0.0/8
    '100.64.0.1',       // 100.64.0.0/10 CGNAT
    '100.127.255.254',  // top of 100.64.0.0/10
    '127.0.0.1',        // loopback
    '169.254.169.254',  // link-local (cloud metadata)
    '172.16.0.1',       // 172.16.0.0/12
    '172.31.255.254',   // top of /12
    '192.168.1.1',      // 192.168.0.0/16
    '192.0.0.1',        // 192.0.0.0/24
    '198.18.0.1',       // 198.18.0.0/15 benchmarking
    '198.19.255.254',   // top of /15
    '224.0.0.1',        // multicast
    '240.0.0.1',        // reserved
    '255.255.255.255',  // broadcast
  ];
  for (const addr of blocked) {
    assert.strictEqual(webFetch.isBlockedAddress(addr), true, `${addr} should be blocked`);
  }
  const allowed = ['93.184.216.34', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '198.17.0.1', '198.20.0.1', '11.0.0.1'];
  for (const addr of allowed) {
    assert.strictEqual(webFetch.isBlockedAddress(addr), false, `${addr} should be allowed`);
  }
});

test('isBlockedAddress blocks IPv6 loopback, unspecified, ULA, link-local, and IPv4-mapped', () => {
  const blocked = [
    '::',                    // unspecified
    '::1',                   // loopback
    'fc00::1',               // ULA fc00::/7
    'fdab:1234::1',          // ULA (fd…)
    'fe80::1',               // link-local fe80::/10
    'febf::1',               // top of fe80::/10
    '::ffff:127.0.0.1',      // IPv4-mapped loopback
    '::ffff:10.0.0.1',       // IPv4-mapped RFC1918
    '::ffff:192.168.0.5',    // IPv4-mapped RFC1918
  ];
  for (const addr of blocked) {
    assert.strictEqual(webFetch.isBlockedAddress(addr), true, `${addr} should be blocked`);
  }
  const allowed = [
    '2606:2800:220:1:248:1893:25c8:1946', // public
    '::ffff:93.184.216.34',               // IPv4-mapped public
    'fec0::1',                            // just past fe80::/10
  ];
  for (const addr of allowed) {
    assert.strictEqual(webFetch.isBlockedAddress(addr), false, `${addr} should be allowed`);
  }
  // Garbage fails closed.
  assert.strictEqual(webFetch.isBlockedAddress('not-an-ip'), true);
});

test('fetchUrl refuses hostnames resolving to private addresses', async () => {
  stubLookup({ 'internal.example': [{ address: '172.18.0.5', family: 4 }] });
  stubFetch(() => { throw new Error('fetch must not be called'); });
  const result = await webFetch.fetchUrl('http://internal.example/admin');
  assert.strictEqual(result.content, null);
  assert.match(result.note, /private or internal address/);
});

test('fetchUrl refuses a hostname resolving to a MIX of public and private addresses', async () => {
  stubLookup({
    'rebind.example': [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.7', family: 4 },
    ],
  });
  stubFetch(() => { throw new Error('fetch must not be called'); });
  const result = await webFetch.fetchUrl('https://rebind.example/');
  assert.strictEqual(result.content, null);
  assert.match(result.note, /private or internal address/);
});

test('fetchUrl refuses literal-IP hostnames in blocked ranges (no DNS round-trip)', async () => {
  // The lookup stub knows NO hostnames — literal IPs must short-circuit.
  stubLookup({});
  stubFetch(() => { throw new Error('fetch must not be called'); });
  for (const target of ['http://127.0.0.1:3000/', 'http://10.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://[fd00::1]/']) {
    const result = await webFetch.fetchUrl(target);
    assert.strictEqual(result.content, null, target);
    assert.match(result.note, /private or internal address/, target);
  }
});

test('validateTargetUrl accepts an injected lookup option', async () => {
  const result = await webFetch.validateTargetUrl('https://somewhere.example/', {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
  });
  assert.strictEqual(result.ok, true);
  const blocked = await webFetch.validateTargetUrl('https://somewhere.example/', {
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
  });
  assert.strictEqual(blocked.ok, false);
});

// --- Redirect handling -----------------------------------------------------

test('follows redirects and re-validates each hop (public -> private redirect rejected)', async () => {
  stubLookup({
    'public.example': [{ address: '93.184.216.34', family: 4 }],
    'internal.example': [{ address: '192.168.1.10', family: 4 }],
  });
  const calls = stubFetch({
    'https://public.example/start': {
      status: 302,
      headers: { location: 'http://internal.example/secret' },
    },
  });
  const result = await webFetch.fetchUrl('https://public.example/start');
  assert.strictEqual(result.content, null);
  assert.match(result.note, /private or internal address/);
  // The private hop must never have been fetched.
  assert.deepStrictEqual(calls, ['https://public.example/start']);
});

test('resolves relative Location headers against the issuing URL', async () => {
  const calls = stubFetch((url) => {
    if (url === 'https://public.example/a/start') {
      return { status: 301, headers: { location: '../moved' } };
    }
    if (url === 'https://public.example/moved') {
      return { status: 200, headers: { 'content-type': 'text/plain' }, body: 'arrived' };
    }
    return null;
  });
  const result = await webFetch.fetchUrl('https://public.example/a/start');
  assert.strictEqual(result.content, 'arrived');
  assert.strictEqual(result.finalUrl, 'https://public.example/moved');
  assert.strictEqual(result.status, 200);
  assert.deepStrictEqual(calls, ['https://public.example/a/start', 'https://public.example/moved']);
});

test('rejects a chain of 6 redirects (limit is 5)', async () => {
  stubFetch((url) => {
    const n = Number(/\/hop(\d+)/.exec(url)[1]);
    return { status: 302, headers: { location: `https://public.example/hop${n + 1}` } };
  });
  const result = await webFetch.fetchUrl('https://public.example/hop0');
  assert.strictEqual(result.content, null);
  assert.match(result.note, /redirect limit exceeded/);
});

test('a 5-redirect chain succeeds', async () => {
  stubFetch((url) => {
    const n = Number(/\/hop(\d+)/.exec(url)[1]);
    if (n < 5) return { status: 302, headers: { location: `https://public.example/hop${n + 1}` } };
    return { status: 200, headers: { 'content-type': 'text/plain' }, body: 'made it' };
  });
  const result = await webFetch.fetchUrl('https://public.example/hop0');
  assert.strictEqual(result.content, 'made it');
});

test('redirect with no Location header returns a note', async () => {
  stubFetch({ 'https://public.example/x': { status: 302, headers: {} } });
  const result = await webFetch.fetchUrl('https://public.example/x');
  assert.strictEqual(result.content, null);
  assert.match(result.note, /no Location header/);
});

// --- Content handling -------------------------------------------------------

test('extractHtmlText strips scripts/styles, captures title, decodes entities', () => {
  const html = `<!doctype html>
<html><head><title>My &amp; Page</title><style>body { color: red }</style></head>
<body>
<script>var hidden = "should not appear";</script>
<noscript>no-js fallback</noscript>
<svg><circle r="1"/></svg>
<!-- a comment -->
<h1>Heading &lt;One&gt;</h1>
<p>First&nbsp;para &#8212; with a dash</p>
<div>Second<br>line</div>
</body></html>`;
  const { title, text } = webFetch.extractHtmlText(html);
  assert.strictEqual(title, 'My & Page');
  assert.ok(!text.includes('should not appear'));
  assert.ok(!text.includes('no-js fallback'));
  assert.ok(!text.includes('color: red'));
  assert.ok(!text.includes('a comment'));
  assert.ok(!text.includes('circle'));
  assert.ok(text.includes('Heading <One>'));
  assert.ok(text.includes('First para — with a dash'));
  assert.ok(text.includes('Second\nline'));
});

test('fetchUrl returns extracted text for HTML pages', async () => {
  stubFetch({
    'https://public.example/page': {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<html><head><title>Docs</title></head><body><p>Hello world</p></body></html>',
    },
  });
  const result = await webFetch.fetchUrl('https://public.example/page');
  assert.strictEqual(result.title, 'Docs');
  assert.strictEqual(result.content, 'Hello world');
  assert.strictEqual(result.contentType, 'text/html');
  assert.strictEqual(result.truncated, false);
  assert.strictEqual(result.url, 'https://public.example/page');
  assert.strictEqual(result.finalUrl, 'https://public.example/page');
});

test('JSON and other textual types pass through as-is', async () => {
  const payload = JSON.stringify({ hello: ['world'] });
  stubFetch((url) => {
    if (url.endsWith('/api')) return { headers: { 'content-type': 'application/json' }, body: payload };
    if (url.endsWith('/feed')) return { headers: { 'content-type': 'application/atom+xml' }, body: '<feed/>' };
    return null;
  });
  const json = await webFetch.fetchUrl('https://public.example/api');
  assert.strictEqual(json.content, payload);
  const xml = await webFetch.fetchUrl('https://public.example/feed');
  assert.strictEqual(xml.content, '<feed/>');
});

test('binary content types are refused with a note (no body returned)', async () => {
  stubFetch({
    'https://public.example/cat.png': {
      headers: { 'content-type': 'image/png' },
      body: 'PNGBYTES',
    },
    'https://public.example/doc.pdf': {
      headers: { 'content-type': 'application/pdf' },
      body: '%PDF',
    },
  });
  for (const target of ['https://public.example/cat.png', 'https://public.example/doc.pdf']) {
    const result = await webFetch.fetchUrl(target);
    assert.strictEqual(result.content, null, target);
    assert.match(result.note, /unsupported content type/, target);
    assert.strictEqual(result.status, 200, target);
  }
});

test('content over 20,000 chars is truncated with truncated: true and a marker', async () => {
  stubFetch({
    'https://public.example/big': {
      headers: { 'content-type': 'text/plain' },
      body: 'x'.repeat(30000),
    },
  });
  const result = await webFetch.fetchUrl('https://public.example/big');
  assert.strictEqual(result.truncated, true);
  assert.ok(result.content.includes('[truncated at 20,000 chars]'));
  // 20k of body + the marker, nothing more.
  assert.ok(result.content.length <= webFetch.MAX_CONTENT_CHARS + 100);
  assert.ok(result.content.startsWith('xxxx'));
});

test('short content is not truncated', async () => {
  stubFetch({
    'https://public.example/small': {
      headers: { 'content-type': 'text/plain' },
      body: 'tiny',
    },
  });
  const result = await webFetch.fetchUrl('https://public.example/small');
  assert.strictEqual(result.truncated, false);
  assert.strictEqual(result.content, 'tiny');
});

test('non-2xx text responses still return their body (with status)', async () => {
  stubFetch({
    'https://public.example/missing': {
      status: 404,
      headers: { 'content-type': 'text/html' },
      body: '<html><body><p>Not found, sorry</p></body></html>',
    },
  });
  const result = await webFetch.fetchUrl('https://public.example/missing');
  assert.strictEqual(result.status, 404);
  assert.strictEqual(result.content, 'Not found, sorry');
});

// --- Never-throws contract ---------------------------------------------------

test('network errors return { content: null, note } instead of throwing', async () => {
  stubFetch({ 'https://public.example/down': { throw: new TypeError('fetch failed') } });
  const result = await webFetch.fetchUrl('https://public.example/down');
  assert.strictEqual(result.content, null);
  assert.match(result.note, /fetch failed/);
});

test('timeouts return a timed-out note instead of throwing', async () => {
  const abortErr = new Error('The operation was aborted due to timeout');
  abortErr.name = 'TimeoutError';
  stubFetch({ 'https://public.example/slow': { throw: abortErr } });
  const result = await webFetch.fetchUrl('https://public.example/slow');
  assert.strictEqual(result.content, null);
  assert.match(result.note, /timed out after 10s/);
});

test('DNS failure returns { content: null, note } instead of throwing', async () => {
  stubLookup({}); // every hostname rejects
  stubFetch(() => { throw new Error('fetch must not be called'); });
  const result = await webFetch.fetchUrl('https://no-such-host.example/');
  assert.strictEqual(result.content, null);
  assert.match(result.note, /could not resolve host no-such-host.example/);
});

test('every result is JSON-serializable', async () => {
  stubFetch({
    'https://public.example/page': {
      headers: { 'content-type': 'text/html' },
      body: '<html><body>ok</body></html>',
    },
  });
  for (const target of ['https://public.example/page', 'ftp://x/', 'http://127.0.0.1/', '']) {
    const result = await webFetch.fetchUrl(target);
    assert.strictEqual(typeof JSON.stringify(result), 'string', target);
  }
});
