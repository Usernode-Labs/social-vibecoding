'use strict';

// Read one image out of an OCI image layout (what `crane pull --format=oci`
// writes) and lay one directory of its filesystem out on disk, applying the
// layers in order with their whiteouts. Used by recover-apps.js to get an
// app's source back from the image it runs, since GitHub suspended the
// account that held its repository (25 Oct 2026).
//
// Needs only `tar` (bsdtar on macOS reads gzip and zstd layers alike).

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MANIFEST_TYPES = new Set([
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
]);
const INDEX_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);

function blobPath(layout, digest) {
  const [algo, hex] = String(digest).split(':');
  if (algo !== 'sha256' || !/^[0-9a-f]{64}$/.test(hex || '')) throw new Error(`Not a sha256 digest: ${digest}`);
  return path.join(layout, 'blobs', 'sha256', hex);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** The image manifest for `digest` (an index resolves to its linux/amd64 entry). */
function manifestFor(layout, digest) {
  const file = blobPath(layout, digest);
  if (!fs.existsSync(file)) return null;
  const doc = readJson(file);
  const type = doc.mediaType || '';
  if (INDEX_TYPES.has(type) || Array.isArray(doc.manifests)) {
    const pick = (doc.manifests || []).find((m) => m.platform && m.platform.os === 'linux' && m.platform.architecture === 'amd64')
      || (doc.manifests || [])[0];
    return pick ? manifestFor(layout, pick.digest) : null;
  }
  if (type && !MANIFEST_TYPES.has(type) && !doc.layers) return null;
  return doc;
}

// A layer's member names as the archive spells them.
function rawNames(file) {
  return execFileSync('tar', ['-tf', file], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8').split('\n').filter(Boolean);
}

// Some builders write absolute names (/workspace/...), others ./ or bare.
function normal(name) {
  return name.replace(/^\.?\/+/, '');
}

function listLayer(file) {
  return rawNames(file).map(normal).filter(Boolean);
}

/**
 * Which directory holds the app: kpack images keep it in workspace/,
 * Dockerfile images (services/template.js) in app/. Decided by which one has
 * a package.json or a server.js in the image's layers.
 */
function sourceRoot(layout, manifest) {
  const seen = new Set();
  for (const layer of manifest.layers || []) {
    for (const entry of listLayer(blobPath(layout, layer.digest))) {
      if (/^(workspace|app)\/(package\.json|server\.js)$/.test(entry)) seen.add(entry.split('/')[0]);
    }
  }
  if (seen.has('workspace')) return 'workspace';
  if (seen.has('app')) return 'app';
  return null;
}

/**
 * Lay `root` (a top-level directory of the image) out in `dest`, applying
 * every layer in order: a layer's whiteouts (`.wh.<name>`, and the opaque
 * `.wh..wh..opq`) remove what lower layers put there, then its own files land.
 */
function extractRoot(layout, manifest, root, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const prefix = `${root}/`;
  for (const layer of manifest.layers || []) {
    const file = blobPath(layout, layer.digest);
    const raw = rawNames(file).filter((n) => { const e = normal(n); return e === root || e.startsWith(prefix); });
    const entries = raw.map(normal);
    if (!entries.length) continue;
    for (const entry of entries) {
      const rel = entry.slice(prefix.length);
      const base = path.posix.basename(rel);
      const dir = path.posix.dirname(rel);
      if (base === '.wh..wh..opq') {
        const target = path.join(dest, dir === '.' ? '' : dir);
        if (fs.existsSync(target)) for (const child of fs.readdirSync(target)) fs.rmSync(path.join(target, child), { recursive: true, force: true });
      } else if (base.startsWith('.wh.')) {
        fs.rmSync(path.join(dest, dir === '.' ? '' : dir, base.slice(4)), { recursive: true, force: true });
      }
    }
    const tmp = fs.mkdtempSync(path.join(path.dirname(dest), '.layer-'));
    try {
      // Exactly the members under root, as the archive names them; the
      // whiteouts were applied above and are not files.
      const names = raw.filter((n) => !path.posix.basename(normal(n)).startsWith('.wh.'));
      const list = path.join(tmp, '.names');
      fs.writeFileSync(list, `${names.join('\n')}\n`);
      if (names.length) {
        execFileSync('tar', ['-xf', file, '-C', tmp, '-T', list], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'ignore', 'pipe'] });
      }
      fs.rmSync(list, { force: true });
      const from = path.join(tmp, root);
      if (fs.existsSync(from)) {
        // Layers can leave directories read-only; the next one writes into them.
        execFileSync('chmod', ['-R', 'u+rwX', from]);
        fs.cpSync(from, dest, { recursive: true, force: true, verbatimSymlinks: true });
        execFileSync('chmod', ['-R', 'u+rwX', dest]);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  return dest;
}

module.exports = { blobPath, manifestFor, sourceRoot, extractRoot, listLayer };
