'use strict';

// Read-only, tightly bounded source access for the security bot's attacker
// reasoning (#4678). The bot may look at an app's own source tree to reason
// about its routes, but only its source: never the host's filesystem, never a
// secret, and never a byte outside a single pinned root.
//
//   * every path is resolved under ONE fixed root. An absolute path, a `..`
//     segment, or any resolved path that lands outside the root is refused.
//   * no symlinks. Every component is lstat'd; a symbolic link anywhere on the
//     path is refused rather than followed, so a link planted in the tree can
//     never point the reader at /etc or at another app's checkout.
//   * an allowlist of source extensions, and a denylist of secret-bearing
//     names (.env*, *.pem, *.key, id_rsa, *.secret, credential files). A file
//     that is not allowlisted, or is denylisted, is refused even inside root.
//   * bounded: a per-file byte ceiling, a bounded line range, and a bounded
//     directory listing. Nothing streams unboundedly into the model.
//
// This module reads the local filesystem only. It never executes a file, never
// resolves an env var, and never returns bytes from a denied path.

const fs = require('node:fs');
const path = require('node:path');

class SourceToolError extends Error {
  constructor(code) {
    super(`Security bot source tools: ${code}`);
    this.name = 'SecurityBotSourceToolError';
    this.code = code;
  }
}

const DEFAULT_MAX_BYTES = 128 * 1024;
const DEFAULT_MAX_LINES = 400;
const DEFAULT_LIST_LIMIT = 500;

// Source the bot is allowed to read. Everything else (binaries, archives,
// images, lockfiles' noise) is refused.
const DEFAULT_ALLOW_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.html', '.htm',
  '.css', '.scss', '.md', '.txt', '.yml', '.yaml', '.sql', '.sh', '.svg',
]);

// Names and patterns that carry secrets, refused even when the extension is
// otherwise allowlisted. Matched case-insensitively against the basename.
const SECRET_NAME_RE = /(^\.env($|\.)|\.pem$|\.key$|\.p12$|\.pfx$|(^|[._-])secret|(^|[._-])credential|(^|[._-])password|^id_rsa|\.keystore$|\.ppk$)/i;

function denySecret(basename) {
  if (SECRET_NAME_RE.test(basename)) throw new SourceToolError('secret_file_denied');
}

/**
 * Resolve a caller-supplied relative path under the pinned root, refusing
 * traversal, absolute paths, and symlinked components. Returns the absolute
 * path only when every check passes.
 */
function resolveWithin(root, relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 4096) {
    throw new SourceToolError('invalid_path');
  }
  if (/[\u0000]/.test(relPath)) throw new SourceToolError('invalid_path');
  if (path.isAbsolute(relPath)) throw new SourceToolError('absolute_path_denied');
  // Reject a `..` segment before any filesystem touch.
  if (relPath.split(/[\\/]/).some((segment) => segment === '..')) {
    throw new SourceToolError('path_traversal');
  }
  const resolved = path.resolve(root, relPath);
  const rel = path.relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new SourceToolError('path_escape');
  }
  // Walk each component from the root and refuse a symlink anywhere on the way,
  // so a link inside the tree cannot redirect the read.
  let current = root;
  for (const segment of rel.split(path.sep)) {
    current = path.join(current, segment);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch { throw new SourceToolError('not_found'); }
    if (stat.isSymbolicLink()) throw new SourceToolError('symlink_denied');
  }
  return resolved;
}

/**
 * A bounded source-access tool rooted at one directory.
 *
 *   root            absolute path to the one tree the bot may read.
 *   maxBytes        per-file ceiling (default 128 KiB).
 *   maxLines        line-range ceiling per read (default 400).
 *   allowExtensions overrides the default allowlist when supplied.
 */
function createSourceTools({
  root, maxBytes = DEFAULT_MAX_BYTES, maxLines = DEFAULT_MAX_LINES,
  listLimit = DEFAULT_LIST_LIMIT, allowExtensions = DEFAULT_ALLOW_EXTENSIONS,
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new SourceToolError('invalid_root');
  let realRoot;
  try { realRoot = fs.realpathSync(root); }
  catch { throw new SourceToolError('root_unavailable'); }
  const allow = allowExtensions instanceof Set ? allowExtensions : new Set(allowExtensions);

  function assertAllowed(absolute) {
    const basename = path.basename(absolute);
    denySecret(basename);
    const ext = path.extname(basename).toLowerCase();
    if (!allow.has(ext)) throw new SourceToolError('extension_denied');
  }

  function listDir(relDir = '.') {
    const absolute = relDir === '.' || relDir === '' ? realRoot : resolveWithin(realRoot, relDir);
    let stat;
    try { stat = fs.statSync(absolute); }
    catch { throw new SourceToolError('not_found'); }
    if (!stat.isDirectory()) throw new SourceToolError('not_a_directory');
    const entries = fs.readdirSync(absolute, { withFileTypes: true });
    const out = [];
    for (const entry of entries) {
      if (out.length >= listLimit) break;
      if (entry.isSymbolicLink()) continue; // never surface a link
      const isDir = entry.isDirectory();
      const isFile = entry.isFile();
      if (!isDir && !isFile) continue;
      if (isFile) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SECRET_NAME_RE.test(entry.name) || !allow.has(ext)) continue;
      }
      out.push({ name: entry.name, type: isDir ? 'dir' : 'file' });
    }
    return out;
  }

  function readFile(relPath, { startLine = 1, endLine } = {}) {
    const absolute = resolveWithin(realRoot, relPath);
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) throw new SourceToolError('not_a_file');
    assertAllowed(absolute);
    if (stat.size > maxBytes) throw new SourceToolError('file_too_large');
    const text = fs.readFileSync(absolute, 'utf8');
    const from = Number.isSafeInteger(startLine) && startLine >= 1 ? startLine : 1;
    const lines = text.split('\n');
    const requestedEnd = endLine == null ? from + maxLines - 1 : endLine;
    if (!Number.isSafeInteger(requestedEnd) || requestedEnd < from) throw new SourceToolError('invalid_range');
    const to = Math.min(requestedEnd, from + maxLines - 1, lines.length);
    return {
      path: path.relative(realRoot, absolute),
      startLine: from,
      endLine: to,
      totalLines: lines.length,
      truncated: to < lines.length || (endLine != null && endLine > to),
      content: lines.slice(from - 1, to).join('\n'),
    };
  }

  return { root: realRoot, listDir, readFile };
}

module.exports = {
  createSourceTools, resolveWithin, SourceToolError,
  DEFAULT_ALLOW_EXTENSIONS, SECRET_NAME_RE,
};
