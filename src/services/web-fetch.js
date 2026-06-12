'use strict';

// Read-only URL fetcher backing the Mayor's `web_fetch` data tool (#30).
// Contract mirrors github.fetchPublicIssue: fetchUrl NEVER throws and
// always returns a JSON-serializable object —
//   success: { url, finalUrl, status, contentType, title, content, truncated }
//   failure: { url, content: null, note }   (human-readable note)
//
// SSRF posture: every hop (the initial URL and each redirect Location)
// goes through validateTargetUrl, which resolves the hostname via the
// container's own resolver and rejects when ANY returned address falls
// in a private/internal range. Docker service names resolve to bridge-
// network 172.x addresses and are caught by the same IP check, so no
// hostname blocklist is needed. Known gap (accepted for v1): the
// validated lookup and fetch's own lookup are two resolutions, so a
// malicious DNS server could swap answers between them — closing it
// needs connection pinning via an undici custom-lookup Agent (deferred).

const net = require('node:net');
const dns = require('node:dns');

const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 10000;          // total budget across all hops
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024; // abort the stream past 2 MB raw
const MAX_CONTENT_CHARS = 20000;
// Names the limit so the model understands the cut without a ranged
// re-fetch tool existing yet (same idea as truncateIssueBodies naming
// get_github_issue(N)).
const TRUNCATION_MARKER = '\n\n[truncated at 20,000 chars]';
const FETCH_USER_AGENT = 'usernode-mayor-web-fetch';

// DNS injection point for tests (_setLookup). Default goes through the
// container's resolver; literal IPs short-circuit before this is called.
const defaultLookup = (host, opts) => dns.promises.lookup(host, opts);
let activeLookup = defaultLookup;
function _setLookup(fn) {
  activeLookup = fn || defaultLookup;
}

// --- Address blocking -------------------------------------------------

// [base, prefixLen] pairs over uint32. Covers "this host", RFC1918,
// CGNAT, loopback, link-local, RFC1918-adjacent special blocks,
// benchmarking, multicast, reserved, and broadcast.
const BLOCKED_IPV4_RANGES = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['192.0.0.0', 24],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  ['255.255.255.255', 32],
];

function ipv4ToInt(addr) {
  const parts = String(addr).split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

const BLOCKED_IPV4 = BLOCKED_IPV4_RANGES.map(([base, prefix]) => ({
  base: ipv4ToInt(base),
  // Number of addresses NOT covered by the prefix; compare via division
  // to avoid 32-bit signed bitwise pitfalls at /4 and /8 scales.
  span: 2 ** (32 - prefix),
}));

function isBlockedIpv4(addr) {
  const value = ipv4ToInt(addr);
  if (value === null) return true; // unparseable → fail closed
  return BLOCKED_IPV4.some(({ base, span }) => value >= base && value < base + span);
}

// Expand an IPv6 string to its 8 16-bit groups, or null if unparseable.
// Handles `::` compression and a trailing IPv4-dotted tail (::ffff:1.2.3.4).
function ipv6ToGroups(addr) {
  let s = String(addr).toLowerCase();
  // Strip a zone index (fe80::1%eth0).
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  // Convert a dotted-IPv4 tail into two hex groups.
  const v4tail = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (v4tail) {
    const v4 = ipv4ToInt(v4tail[2]);
    if (v4 === null) return null;
    s = v4tail[1]
      + ((v4 >>> 16).toString(16)) + ':'
      + ((v4 & 0xffff).toString(16));
  }
  const doubleColon = s.indexOf('::');
  let head;
  let tail;
  if (doubleColon !== -1) {
    head = s.slice(0, doubleColon).split(':').filter(Boolean);
    tail = s.slice(doubleColon + 2).split(':').filter(Boolean);
    if (head.length + tail.length > 7) return null;
  } else {
    head = s.split(':');
    tail = [];
    if (head.length !== 8) return null;
  }
  const groups = [...head, ...new Array(8 - head.length - tail.length).fill('0'), ...tail];
  const out = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

function isBlockedIpv6(addr) {
  const groups = ipv6ToGroups(addr);
  if (!groups) return true; // unparseable → fail closed
  // IPv4-mapped (::ffff:a.b.c.d) — re-check against the IPv4 ranges.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return isBlockedIpv4(v4);
  }
  if (groups.every((g) => g === 0)) return true;                       // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
  if ((groups[0] & 0xfe00) === 0xfc00) return true;                    // fc00::/7 ULA
  if ((groups[0] & 0xffc0) === 0xfe80) return true;                    // fe80::/10 link-local
  return false;
}

// True when the address must not be fetched. Unrecognized shapes are
// blocked (fail closed).
function isBlockedAddress(address) {
  const family = net.isIP(String(address));
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

// --- URL validation ----------------------------------------------------

// Validate a target URL for fetching. Applied to the initial URL AND to
// every redirect hop. Returns { ok: true, url } (a parsed URL object) or
// { ok: false, note }. Never throws.
async function validateTargetUrl(rawUrl, { lookup } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return { ok: false, note: `invalid URL: ${String(rawUrl).slice(0, 200)}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, note: `unsupported scheme ${url.protocol.replace(/:$/, '')}: — only http and https are allowed` };
  }
  if (url.username || url.password) {
    return { ok: false, note: 'blocked: URLs with embedded credentials are not allowed' };
  }
  // WHATWG URL keeps brackets on IPv6 literal hostnames.
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (!host) return { ok: false, note: 'invalid URL: missing host' };

  let addresses;
  const literalFamily = net.isIP(host);
  if (literalFamily) {
    addresses = [{ address: host, family: literalFamily }];
  } else {
    const doLookup = lookup || activeLookup;
    try {
      addresses = await doLookup(host, { all: true });
    } catch {
      return { ok: false, note: `could not resolve host ${host}` };
    }
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return { ok: false, note: `could not resolve host ${host}` };
  }
  // ANY blocked address rejects the whole host — a mixed public/private
  // answer is exactly the DNS-rebinding/split-horizon shape we refuse.
  for (const entry of addresses) {
    if (isBlockedAddress(entry && entry.address)) {
      return { ok: false, note: 'blocked: resolves to a private or internal address' };
    }
  }
  return { ok: true, url };
}

// --- HTML text extraction ----------------------------------------------

const NAMED_ENTITIES = {
  lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', copy: '©',
  reg: '®', trade: '™', deg: '°', middot: '·',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', times: '×', bull: '•',
};

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
    // &amp; last, so "&amp;lt;" decodes to the literal "&lt;".
    .replace(/&amp;/gi, '&');
}

// Tags whose open/close boundaries become newlines so block structure
// survives tag stripping.
const BLOCK_TAGS = 'p|div|section|article|header|footer|nav|main|aside|h[1-6]|ul|ol|li|table|thead|tbody|tfoot|tr|th|td|blockquote|pre|form|fieldset|figure|figcaption|hr|dl|dt|dd|details|summary';

// Dependency-free HTML → text. Returns { title, text }.
function extractHtmlText(html) {
  const source = String(html);
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(source);
  const title = titleMatch
    ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() || null
    : null;

  let s = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '');
  for (const tag of ['script', 'style', 'noscript', 'svg']) {
    s = s.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}\\s*>`, 'gi'), '');
  }
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  const text = s
    .split('\n')
    .map((line) => line.replace(/[ \t\r ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}

// --- Body reading -------------------------------------------------------

// Read the response body, aborting past MAX_DOWNLOAD_BYTES of raw
// download. Prefers streaming (web ReadableStream from global fetch);
// falls back to .text() for non-streaming responses (test stubs).
async function readBodyCapped(response) {
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    let capped = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      chunks.push(buf);
      total += buf.length;
      if (total >= MAX_DOWNLOAD_BYTES) {
        capped = true;
        reader.cancel().catch(() => {});
        break;
      }
    }
    return { text: Buffer.concat(chunks).toString('utf8'), capped };
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_DOWNLOAD_BYTES) {
    return { text: text.slice(0, MAX_DOWNLOAD_BYTES), capped: true };
  }
  return { text, capped: false };
}

function isTextualMime(mime) {
  if (!mime) return true; // missing Content-Type: assume text, the cap still bounds us
  return mime.startsWith('text/')
    || mime === 'application/json'
    || mime === 'application/xml'
    || mime.endsWith('+json')
    || mime.endsWith('+xml');
}

// --- Public fetch -------------------------------------------------------

// Fetch one public web page and return its text. NEVER throws.
async function fetchUrl(rawUrl) {
  const urlStr = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!urlStr) {
    return { url: urlStr, content: null, note: 'no URL provided' };
  }
  try {
    // One shared budget across every hop.
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    let currentUrl = urlStr;
    let response = null;
    let finalUrl = null;

    for (let redirects = 0; ; redirects++) {
      const check = await validateTargetUrl(currentUrl);
      if (!check.ok) {
        return { url: urlStr, content: null, note: check.note };
      }
      let resp;
      try {
        resp = await fetch(check.url.toString(), {
          redirect: 'manual',
          signal,
          headers: {
            'User-Agent': FETCH_USER_AGENT,
            'Accept': 'text/html, application/json, text/plain, */*',
          },
        });
      } catch (err) {
        const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
        return {
          url: urlStr,
          content: null,
          note: timedOut
            ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s`
            : `fetch failed: ${(err && err.message) || 'network error'}`,
        };
      }

      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get('location');
        if (resp.body && typeof resp.body.cancel === 'function') resp.body.cancel().catch(() => {});
        if (!location) {
          return { url: urlStr, content: null, note: `redirect (HTTP ${resp.status}) with no Location header` };
        }
        if (redirects >= MAX_REDIRECTS) {
          return { url: urlStr, content: null, note: `redirect limit exceeded (more than ${MAX_REDIRECTS} redirects)` };
        }
        try {
          // Relative Locations resolve against the URL that issued them.
          currentUrl = new URL(location, check.url).toString();
        } catch {
          return { url: urlStr, content: null, note: 'redirect to an invalid URL' };
        }
        continue;
      }

      response = resp;
      finalUrl = check.url.toString();
      break;
    }

    const contentTypeRaw = response.headers.get('content-type') || '';
    const mime = contentTypeRaw.split(';')[0].trim().toLowerCase();
    if (!isTextualMime(mime)) {
      if (response.body && typeof response.body.cancel === 'function') response.body.cancel().catch(() => {});
      return {
        url: urlStr,
        finalUrl,
        status: response.status,
        contentType: mime,
        content: null,
        note: `unsupported content type ${mime} — this isn't a text page, binary content is not returned`,
      };
    }

    const { text: rawBody, capped } = await readBodyCapped(response);

    let title = null;
    let content;
    if (mime === 'text/html' || mime === 'application/xhtml+xml') {
      const extracted = extractHtmlText(rawBody);
      title = extracted.title;
      content = extracted.text;
    } else {
      content = rawBody;
    }

    let truncated = capped;
    if (content.length > MAX_CONTENT_CHARS) {
      content = content.slice(0, MAX_CONTENT_CHARS);
      truncated = true;
    }
    if (truncated) content += TRUNCATION_MARKER;

    return {
      url: urlStr,
      finalUrl,
      status: response.status,
      contentType: mime,
      title,
      content,
      truncated,
    };
  } catch (err) {
    // Belt-and-suspenders for the never-throws contract.
    return { url: urlStr, content: null, note: `fetch failed: ${(err && err.message) || 'unexpected error'}` };
  }
}

module.exports = {
  fetchUrl,
  validateTargetUrl,
  isBlockedAddress,
  extractHtmlText,
  _setLookup,
  MAX_REDIRECTS,
  FETCH_TIMEOUT_MS,
  MAX_DOWNLOAD_BYTES,
  MAX_CONTENT_CHARS,
};
