// Token order check: does this proposal add a script that reads the sign-in
// token from the address before the bridge has put it there? One synthetic
// row in the proposal checks run.
//
// Why this exists. Since #6151 the shell frames a public app at ONE
// cacheable address with the token after `#` (`#un-token=…`;
// public/js/app-view.js buildAppIframeSrc), and the bridge's first block
// moves it into `?token=` (usernode-bridge/v1/bridge.js,
// __USERNODE_OFFLINE_CACHE_BEGIN__). A script that runs before the bridge
// and reads `location.search` for the token finds nothing, and the app opens
// signed out inside Homeroom. RecipeBot did exactly that (#175, fixed by its
// own PR 176): a fetch wrapper placed above the bridge tag, written in the
// belief that the bridge strips the token from the address. It never has.
// Three apps carried the same pattern; a scan of every public app found no
// other one broken by it. The conventions' Auth section states the rule;
// this row holds a proposal to it.
//
// What it reads. The app's pages a change can affect: every HTML page the
// change adds or edits, plus `public/index.html` and `index.html` (the page
// most apps are), at the proposal head and at the merge base. In each page,
// the scripts that run before the hosted bridge (all of them when the page
// loads none) are read: inline bodies, and same-origin `src` files from the
// repository. A token read is `.get('token')` in code that reads the
// address, or a `token=` match on `location.search` / `location.href`.
//
// Introduced only. A read the merge base already had on the same page is
// not this proposal's, so it never fails the row: apps that read early and
// still work (they read the query again after the bridge) are never held
// to it, and only a change that ADDS such a read, or moves one above the
// bridge, is flagged.
//
// Deterministic: no model, two file reads per page and script, cached per
// (session, head) like the Content rules row.
//
// Mode (TOKEN_ORDER_CHECK_MODE, declared in the root dapp.json platform_env):
//   off       no row at all;
//   advisory  (default) a flag shows on the checks but never closes the gate;
//   blocking  a flag fails the checks, so the proposal cannot merge.
// Checks run on the deployed platform's code, so the row starts advisory
// and is made blocking by changing the setting once it has been seen
// working on real proposals.
//
// Fails OPEN. A code-host error yields an advisory pass row that says it was
// not checked. This row must never turn checks red for infrastructure
// reasons.
//
// Not run on the platform's own repository: it is no app, and its shell
// loads no bridge.

'use strict';

const path = require('node:path');
const log = require('./logger');

const TOKEN_ORDER_CHECK_NAME = 'Sign-in token read after the bridge';
const TOKEN_ORDER_CHECK_PATH = 'proposal pages';
// Synthetic-row index namespace: -1 the missing-advisory rollup, -2 the
// over-ceiling guard (visuals.js), -3 the unit suite, -4 the asset route,
// -5 the Content rules review, -6 render health.
const TOKEN_ORDER_CHECK_INDEX = -7;
const REASON_MAX = 600;
const CACHE_MAX = 500;
// Bounds on what one head costs: pages read, and scripts fetched per page.
const MAX_PAGES = 8;
const MAX_SCRIPTS_PER_PAGE = 12;
const ALWAYS_PAGES = ['public/index.html', 'index.html'];

const MODES = new Set(['off', 'advisory', 'blocking']);

function mode() {
  const v = String(process.env.TOKEN_ORDER_CHECK_MODE ?? '').trim().toLowerCase();
  return MODES.has(v) ? v : 'advisory';
}

// The hosted bridge, by relative path or behind a hostname. A vendored copy
// (`/usernode-bridge.js`) is not it: it moves no token.
const BRIDGE_SRC = /(^|\/)usernode-bridge\/v\d+\/bridge\.js(?:[?#]|$)/;
const PLATFORM_SRC = /(^|\/)usernode-(?:bridge|native|tailwind)\//;
const PAGE_FILE = /\.html?$/i;
const SKIP_DIRS = /(^|\/)(node_modules|vendor|tests?|e2e|coverage|\.git)\//;

// HTML comments blanked to spaces, newlines kept, so a commented-out tag is
// not a script and line numbers still match the file.
function blankComments(html) {
  return String(html || '').replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

function parseAttrs(raw) {
  const out = {};
  const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(String(raw || '')))) {
    const value = m[2] ?? m[3] ?? m[4];
    out[m[1].toLowerCase()] = value === undefined ? true : value;
  }
  return out;
}

// When a script runs relative to parsing: 'sync' (as it is parsed),
// 'deferred' (after parsing, in document order: defer and modules), 'async'
// (whenever it arrives), or null for a non-JavaScript block (JSON, templates).
function timing(attrs, inline) {
  const type = String(attrs.type || '').trim().toLowerCase();
  if (type && type !== 'module' && !/^(text|application)\/(x-)?(java|ecma)script$/.test(type)) return null;
  if (type === 'module') return attrs.async ? 'async' : 'deferred';
  if (inline) return 'sync';
  if (attrs.async) return 'async';
  if (attrs.defer) return 'deferred';
  return 'sync';
}

// Pure: every script tag on the page in document order, with the 1-based
// line its body starts on.
function scriptTags(html) {
  const text = blankComments(html);
  const tags = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(text))) {
    const attrs = parseAttrs(m[1]);
    const inline = typeof attrs.src !== 'string';
    const run = timing(attrs, inline);
    if (!run) continue;
    const bodyAt = m.index + m[0].indexOf('>') + 1;
    tags.push({
      src: inline ? null : attrs.src,
      body: inline ? m[2] : '',
      run,
      line: text.slice(0, bodyAt).split('\n').length,
    });
  }
  return tags;
}

// Pure: the scripts that can run before the hosted bridge has, and whether
// the page loads the bridge at all.
function scriptsBeforeBridge(html) {
  const tags = scriptTags(html);
  const at = tags.findIndex((t) => t.src && BRIDGE_SRC.test(t.src));
  if (at === -1) return { bridge: false, scripts: tags };
  const bridge = tags[at];
  const before = tags.filter((t, i) => {
    if (i === at) return false;
    if (t.run === 'async' || bridge.run === 'async') return true;
    if (t.run === 'sync') return i < at || bridge.run !== 'sync';
    // deferred: after every sync script, in document order among themselves.
    return bridge.run === 'deferred' && i < at;
  });
  return { bridge: true, scripts: before };
}

const READS_ADDRESS = /\blocation\b|document\.URL\b|document\.documentURI\b/;
const GET_TOKEN = /\.get\(\s*(['"`])token\1\s*\)/;
// `token=` with no word character or hyphen before it: `?token=`, a
// `/[?&]token=/` literal, `'token='`, but never `invite_token=` or the
// bridge's own `un-token=`.
const TOKEN_IN_URL = /location\.(?:search|href)[^\n]*(?<![\w-])token=|(?<![\w-])token=[^\n]*location\.(?:search|href)/;

// Pure: the lines of `code` that read the token from the address, as
// { line, text } with `line` 1-based within `code`.
function tokenReads(code) {
  const src = String(code || '');
  if (!READS_ADDRESS.test(src)) return [];
  const out = [];
  src.split('\n').forEach((ln, i) => {
    if (GET_TOKEN.test(ln) || TOKEN_IN_URL.test(ln)) {
      out.push({ line: i + 1, text: ln.trim().replace(/\s+/g, ' ').slice(0, 160) });
    }
  });
  return out;
}

// The repository path a same-origin script src names, from the page that
// loads it, as candidates in the order a static server would answer them.
// Null for another origin or a platform-hosted file.
function scriptPaths(pagePath, src) {
  const raw = String(src || '').trim();
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null;
  if (PLATFORM_SRC.test(raw)) return null;
  const clean = raw.split(/[?#]/)[0];
  if (!clean) return null;
  const dir = path.posix.dirname(pagePath);
  const out = [];
  if (clean.startsWith('/')) {
    const rel = clean.replace(/^\/+/, '');
    if (pagePath.startsWith('public/')) out.push(`public/${rel}`);
    if (dir !== '.') out.push(path.posix.join(dir, rel));
    out.push(rel);
  } else {
    out.push(path.posix.normalize(path.posix.join(dir, clean)));
  }
  return [...new Set(out)].filter((p) => p && !p.startsWith('..'));
}

// Every early token read on one page as the repository has it at `ref`:
// [{ page, file, line, text }]. `read(path, ref)` answers a file's text or
// null. Null for a page that does not exist at `ref`.
async function pageReads(pagePath, ref, read) {
  const html = await read(pagePath, ref);
  if (html == null) return null;
  const { bridge, scripts } = scriptsBeforeBridge(html);
  const found = [];
  for (const s of scripts.slice(0, MAX_SCRIPTS_PER_PAGE)) {
    if (!s.src) {
      for (const r of tokenReads(s.body)) {
        found.push({ page: pagePath, file: pagePath, line: s.line + r.line - 1, text: r.text, bridge });
      }
      continue;
    }
    const candidates = scriptPaths(pagePath, s.src);
    if (!candidates) continue;
    for (const p of candidates) {
      const code = await read(p, ref);
      if (code == null) continue;
      for (const r of tokenReads(code)) found.push({ page: pagePath, file: p, line: r.line, text: r.text, bridge });
      break;
    }
  }
  return found;
}

// Pure: the pages worth reading for a change, from the compare's file list.
function pagesFor(files = []) {
  const changed = (Array.isArray(files) ? files : [])
    .filter((f) => f && f.filename && f.status !== 'removed')
    .map((f) => String(f.filename))
    .filter((f) => PAGE_FILE.test(f) && !SKIP_DIRS.test(`/${f}`));
  return [...new Set([...changed, ...ALWAYS_PAGES])].slice(0, MAX_PAGES);
}

// Pure: whether the change touches anything a page runs (markup or script).
function touchesPages(files = []) {
  return (Array.isArray(files) ? files : []).some((f) => f && /\.(html?|m?js|cjs|jsx?|tsx?)$/i.test(String(f.filename || '')));
}

// Pure: head reads the base did not have on the same page.
function introducedReads(head = [], base = []) {
  const had = new Set((base || []).map((r) => `${r.page}\n${r.text}`));
  return (head || []).filter((r) => !had.has(`${r.page}\n${r.text}`));
}

function clip(text, n = REASON_MAX) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

// Pure: the row the checks pipeline consumes. `reads` are the introduced
// reads; null means "not checked" (`note` says why).
function shapeRow({ reads = [], checkMode, note = '', checkedSha = null }) {
  const flagged = Array.isArray(reads) && reads.length > 0;
  let failureReason = '';
  if (flagged) {
    const first = reads[0];
    const more = reads.length > 1 ? ` (and ${reads.length - 1} more)` : '';
    const where = first.bridge
      ? 'before the bridge tag'
      : 'on a page that loads no bridge';
    failureReason = clip(
      `Reads the sign-in token ${where}: ${first.file} line ${first.line}, \`${first.text}\`${more}. `
      + 'Inside Homeroom the token arrives after # and the bridge moves it into ?token=, so a read that runs '
      + 'before <script src="/usernode-bridge/v1/bridge.js"> finds nothing and the app opens signed out. '
      + 'Move this code below the bridge tag.'
    );
  }
  return {
    index: TOKEN_ORDER_CHECK_INDEX,
    name: TOKEN_ORDER_CHECK_NAME,
    path: TOKEN_ORDER_CHECK_PATH,
    status: flagged ? 'fail' : 'pass',
    advisory: flagged ? checkMode !== 'blocking' : true,
    consoleErrors: [],
    failureReason,
    summary: flagged ? '' : (note || 'Passes'),
    ...(checkedSha ? { checkedSha: String(checkedSha).toLowerCase() } : {}),
  };
}

const cache = new Map();
function cacheKey(sessionId, sha) { return `${sessionId}:${String(sha).toLowerCase()}`; }
function remember(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

async function storedVerdict(pool, sessionId, sha) {
  if (!pool || !sessionId || !sha) return null;
  try {
    const { rows } = await pool.query('SELECT test_results FROM chat_sessions WHERE id = $1', [sessionId]);
    const results = Array.isArray(rows[0]?.test_results) ? rows[0].test_results : [];
    return results.find((r) => r && r.name === TOKEN_ORDER_CHECK_NAME
      && r.checkedSha && String(r.checkedSha).toLowerCase() === String(sha).toLowerCase()) || null;
  } catch {
    return null;
  }
}

// The row with the CURRENT mode applied, so a cached flag follows a change
// of setting.
function withMode(row, checkMode) {
  if (row.status !== 'fail') return row;
  return { ...row, advisory: checkMode !== 'blocking' };
}

function isSelfApp(config, appSlug) {
  const slug = String(config?.selfAppSlug || '');
  return !!slug && slug === String(appSlug || '');
}

/**
 * Check one proposal head. Returns { row } or null when the check is off or
 * cannot apply. Never throws.
 *
 * deps are injectable for tests: { github }.
 */
async function maybeRunTokenOrderCheck({
  config = null, pool, sessionId, appSlug = null, repoOwner, repoName, commitHash,
  baseRef = 'main', deps = {},
} = {}) {
  try {
    const checkMode = mode();
    if (checkMode === 'off') return null;
    if (!repoOwner || !repoName || !commitHash) return null;
    if (isSelfApp(config, appSlug)) return null;
    const github = deps.github || require('./github');
    if (typeof github.isEnabled === 'function' && !github.isEnabled()) return null;

    const key = cacheKey(sessionId, commitHash);
    if (cache.has(key)) return { row: withMode(cache.get(key), checkMode) };
    const stored = await storedVerdict(pool, sessionId, commitHash);
    if (stored) {
      remember(key, stored);
      return { row: withMode(stored, checkMode) };
    }

    const notChecked = (why) => ({ row: shapeRow({ checkMode, note: `Passes (not checked: ${why})` }) });

    let compare;
    try {
      compare = await github.compareFiles(repoOwner, repoName, `${baseRef}...${commitHash}`, 0);
    } catch (err) {
      log.warn('token-order-check', 'Could not compare the proposal (failing open)', { sessionId, err: err.message });
      return notChecked('the change could not be compared');
    }
    const files = Array.isArray(compare?.files) ? compare.files : [];
    if (!touchesPages(files)) {
      const row = shapeRow({ checkMode, checkedSha: commitHash, note: 'Passes (no page or script changed)' });
      remember(key, row);
      return { row };
    }
    const baseSha = compare?.mergeBaseSha || null;
    if (!baseSha) return notChecked('the merge base is unknown');

    const read = async (p, ref) => {
      const text = await github.getFileContent(repoOwner, repoName, p, ref);
      return typeof text === 'string' ? text : null;
    };
    const introduced = [];
    try {
      for (const page of pagesFor(files)) {
        const head = await pageReads(page, commitHash, read);
        if (!head || !head.length) continue;
        const base = (await pageReads(page, baseSha, read)) || [];
        introduced.push(...introducedReads(head, base));
      }
    } catch (err) {
      log.warn('token-order-check', 'Could not read the proposal pages (failing open)', { sessionId, err: err.message });
      return notChecked('the pages could not be read');
    }

    const row = shapeRow({ reads: introduced, checkMode, checkedSha: commitHash });
    remember(key, row);
    log.info('token-order-check', 'Token order checked', {
      sessionId, commit: String(commitHash).slice(0, 7), flagged: introduced.length, mode: checkMode,
    });
    return { row };
  } catch (err) {
    log.warn('token-order-check', 'Token order check failed (failing open)', { sessionId, err: err && err.message });
    return null;
  }
}

function _resetCache() { cache.clear(); }

module.exports = {
  TOKEN_ORDER_CHECK_NAME, TOKEN_ORDER_CHECK_PATH, TOKEN_ORDER_CHECK_INDEX,
  mode, scriptTags, scriptsBeforeBridge, tokenReads, scriptPaths, pageReads,
  pagesFor, touchesPages, introducedReads, shapeRow,
  maybeRunTokenOrderCheck, _resetCache,
};
