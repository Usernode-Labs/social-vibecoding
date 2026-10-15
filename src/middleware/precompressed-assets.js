'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Negotiator = require('negotiator');
const { artifactDir, digest, eligibleAsset } = require('../../scripts/precompress-static-assets');
const { parseBuildScopedPath } = require('../../scripts/shell-stamp');
const { wantsCompression } = require('./response-compression');
const { IMMUTABLE, REVALIDATE, applyShellBuildHeader, shellBuildId } = require('../services/static-cache');

// Optional build output, behind the same auth gate and ahead of the existing
// static handlers. Missing/stale artifacts fall through to those handlers and
// their runtime compression. Development always uses the editable source.
function precompressedAssets(publicDir, env = process.env) {
  let manifest;
  try {
    if (env.NODE_ENV !== 'production') return (_req, _res, next) => next();
    manifest = JSON.parse(fs.readFileSync(path.join(artifactDir(publicDir), 'manifest.json'), 'utf8'));
    if (manifest.version !== 1 || manifest.build !== (env.GIT_SHA || 'dev') || !manifest.assets) {
      return (_req, _res, next) => next();
    }
  } catch { return (_req, _res, next) => next(); }

  const validated = new Map();
  async function sourceMatches(url, entry) {
    const file = path.join(publicDir, url);
    const stat = await fs.promises.stat(file, { bigint: true });
    if (!stat.isFile()) return null;
    const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const old = validated.get(url);
    if (old?.stamp === stamp) return old.valid ? stat : null;
    const valid = digest(await fs.promises.readFile(file)) === entry.sourceHash;
    validated.set(url, { stamp, valid });
    return valid ? stat : null;
  }

  return async function servePrecompressed(req, res, next) {
    if (!wantsCompression(req) || req.headers.range || res.getHeader('Content-Encoding')
        || /\bno-transform\b/i.test(String(res.getHeader('Cache-Control') || ''))) return next();
    let url;
    try { url = decodeURIComponent(req.path); } catch { return next(); }
    const scoped = parseBuildScopedPath(url);
    const asset = scoped ? scoped.path : url;
    if (!eligibleAsset(asset)) return next();
    const entry = Object.hasOwn(manifest.assets, asset) ? manifest.assets[asset] : null;
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.sourceHash) || !entry.variants) return next();
    const available = ['br', 'gzip'].filter((encoding) => /^[a-f0-9]{64}$/.test(entry.variants[encoding] || ''));
    // Identity participates in q-value negotiation. A client preferring plain
    // bytes, or accepting only another coding, keeps the existing behavior.
    const encoding = new Negotiator(req).encoding(['br', 'gzip', 'deflate', 'identity'], { preferred: ['br', 'gzip'] });
    res.vary('Accept-Encoding');
    if (!available.includes(encoding)) return next();
    let stat;
    try { stat = await sourceMatches(asset, entry); } catch { return next(); }
    if (!stat) return next();
    const file = path.join(artifactDir(publicDir), `${entry.variants[encoding]}.${encoding}`);
    try { await fs.promises.access(file); } catch { return next(); }

    const previous = new Map(['Content-Type', 'Content-Encoding', 'Cache-Control', 'ETag', 'Last-Modified', 'X-Platform-Build']
      .map((name) => [name, res.getHeader(name)]));
    res.type(path.extname(asset));
    res.setHeader('Content-Encoding', encoding);
    res.setHeader('ETag', `"${entry.variants[encoding]}"`);
    res.setHeader('Last-Modified', new Date(Number(stat.mtimeMs)).toUTCString());
    res.setHeader('Cache-Control', scoped && shellBuildId(env) === scoped.build ? IMMUTABLE : REVALIDATE);
    applyShellBuildHeader(res, env);
    res.sendFile(file, { dotfiles: 'allow', cacheControl: false, acceptRanges: false }, (err) => {
      if (!err) return;
      if (res.headersSent) return next(err);
      for (const [name, value] of previous) {
        if (value === undefined) res.removeHeader(name); else res.setHeader(name, value);
      }
      res.removeHeader('Content-Length');
      if (err.code === 'ENOENT' || err.status === 404) return next();
      return next(err);
    });
  };
}

module.exports = { precompressedAssets };
