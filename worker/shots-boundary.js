'use strict';

// The shots browser's boundary: where it may go, and which of its
// screenshots may be published.
//
// WHERE IT MAY GO. The shots browser used to reach only the run's two
// preview copies and the hosted-app catalog, and every hosted app whose page
// needs an outside host (a CDN script or stylesheet, map tiles) failed to
// render (2026-09-30: gym-tracker, puzzlechain, homeroom-maps). It may now
// reach the public internet. What it must never reach is the network it runs
// in: the platform's internal addresses, other apps' services, the cloud
// metadata endpoint. The shots agent drives the browser and reads pages
// written by whoever opened the proposal, so a hostile page could try to send
// it there. A destination outside the pair and the catalog is therefore
// allowed only on a web port, and only when EVERY address its name resolves
// to is public; the proxy then connects to the address it checked, so a
// second lookup (DNS rebinding) cannot move it inside.
//
// WHICH SCREENSHOTS MAY BE PUBLISHED. With the internet open, a confused or
// steered agent could screenshot another website and save it as a proposal's
// "after". The browser observer stamps each screenshot with the site of the
// page it was taken on (the last page URL Playwright reported), and each
// closed recording session with every site it visited; the shots bridge
// publishes a still only from the run's own address for that side (before =
// base, after = head), and a clip only when its session never left it. This
// guards against the agent's mistakes and steering, not against the page: a
// proposal's own page can already show anything on its own address.

const crypto = require('node:crypto');
const dns = require('node:dns');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const WEB_PORTS = Object.freeze(new Set([80, 443]));

// Every range that is not the public internet. IPv4-mapped IPv6 addresses
// (::ffff:a.b.c.d) need no rule of their own: net.BlockList checks them
// against the IPv4 rules (and an IPv4 address against an ::ffff:0:0/96 rule,
// which is why that rule is absent: it would refuse all of IPv4).
// tests/shots-boundary.test.js pins both behaviours. The other IPv6 forms
// that embed an IPv4 address (NAT64, 6to4, Teredo) are refused outright
// rather than unpacked: no public site needs them, and unpacking is where
// checks slip.
const NON_PUBLIC = Object.freeze({
  ipv4: [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ],
  ipv6: [
    ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
    ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16],
    ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
  ],
});
const nonPublic = new net.BlockList();
for (const [address, prefix] of NON_PUBLIC.ipv4) nonPublic.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of NON_PUBLIC.ipv6) nonPublic.addSubnet(address, prefix, 'ipv6');

function isPublicAddress(address) {
  const family = net.isIP(String(address || ''));
  if (!family) return false;
  return !nonPublic.check(String(address), family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Whether a destination outside the pair and the catalog may be reached, and
 * at which address. `{ ok: true, address, family }` names the address to
 * connect to; `{ ok: false, reason }` is `port`, `dns` or `private_address`.
 * A failed lookup is a refusal: a name that cannot be shown to be public is
 * not reached.
 */
async function vetPublicDestination(hostname, port, { lookup = dns.promises.lookup } = {}) {
  if (!WEB_PORTS.has(Number(port))) return { ok: false, reason: 'port' };
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (!host) return { ok: false, reason: 'dns' };
  let answers;
  if (net.isIP(host)) {
    answers = [{ address: host, family: net.isIP(host) }];
  } else {
    try { answers = await lookup(host, { all: true, verbatim: true }); } catch { return { ok: false, reason: 'dns' }; }
  }
  if (!Array.isArray(answers) || !answers.length) return { ok: false, reason: 'dns' };
  if (answers.some((answer) => !isPublicAddress(answer?.address))) return { ok: false, reason: 'private_address' };
  return { ok: true, address: answers[0].address, family: net.isIP(answers[0].address) };
}

// ── Screenshot provenance ───────────────────────────────────────────────
//
// Kept beside the browser's output directory, never inside it: a page can make
// the browser save a download there under a name the page chooses (Playwright
// MCP writes downloads to its output directory). A stamp also carries the
// digest of the image it describes, so a file replaced after it was stamped is
// a file with no provenance; and a session record counts only for a clip
// written before it.

const SESSION_FILE = 'session.json';

function provenanceDir(outputDir) {
  const resolved = path.resolve(outputDir);
  return path.join(path.dirname(resolved), '.provenance', path.basename(resolved));
}

function webOrigin(url) {
  try {
    const parsed = new URL(String(url || ''));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : null;
  } catch { return null; }
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const staged = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(staged, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(staged, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const stampFile = (outputDir, name) => path.join(provenanceDir(outputDir), `${path.basename(name)}.json`);

/** Record the site the screenshot just saved in outputDir was taken on. */
function stampScreenshot(outputDir, imagePath, pageUrl) {
  writePrivate(stampFile(outputDir, imagePath), {
    origin: webOrigin(pageUrl), sha256: digest(fs.readFileSync(imagePath)),
  });
}

/** The site this image was stamped with, or null when it has no stamp or is not the image stamped. */
function screenshotOrigin(outputDir, name, image) {
  const value = readJson(stampFile(outputDir, name));
  if (typeof value?.origin !== 'string' || typeof value?.sha256 !== 'string') return null;
  return digest(image) === value.sha256 ? value.origin : null;
}

/** Record every site a browser session showed, as it closes (its clip's pages). */
function recordSession(outputDir, origins) {
  writePrivate(path.join(provenanceDir(outputDir), SESSION_FILE), {
    origins: [...new Set([...origins].map(webOrigin).filter(Boolean))],
  });
}

/**
 * The sites the most recently closed session showed, or null. With
 * `notBefore` (a clip's mtime in ms), a record written before the clip does
 * not describe it: the clip came from a session no record covers.
 */
function sessionOrigins(outputDir, { notBefore = 0 } = {}) {
  const file = path.join(provenanceDir(outputDir), SESSION_FILE);
  try { if (fs.statSync(file).mtimeMs < notBefore) return null; } catch { return null; }
  const value = readJson(file);
  return Array.isArray(value?.origins) ? value.origins.filter((item) => typeof item === 'string') : null;
}

/**
 * Whether a shot for `side` may be published from these sites: exactly the
 * run's own address for that side (before = base, after = head), and nothing
 * else. Returns null when it may, or the reason it may not.
 */
function provenanceRefusal(side, origins, { base, head }) {
  const expected = webOrigin(side === 'before' ? base : side === 'after' ? head : null);
  if (!expected) return 'The run has no address for this side.';
  const seen = (Array.isArray(origins) ? origins : [origins]).filter(Boolean);
  if (!seen.length) return `It cannot be told which page this was taken on. Open the ${side} address, then take it again.`;
  if (seen.some((origin) => origin !== expected)) {
    return `This was not taken on the ${side} address. Open the ${side} address and take it again there.`;
  }
  return null;
}

module.exports = {
  WEB_PORTS,
  NON_PUBLIC,
  isPublicAddress,
  vetPublicDestination,
  provenanceDir,
  webOrigin,
  stampScreenshot,
  screenshotOrigin,
  recordSession,
  sessionOrigins,
  provenanceRefusal,
};
