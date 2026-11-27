'use strict';
// path (POSIX). The working directory is /app, the project's root.

function normalizeArray(parts, allowAbove) {
  const out = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (allowAbove) out.push('..'); } else out.push(p);
  }
  return out;
}
function normalize(p) {
  const s = String(p);
  if (s === '') return '.';
  const abs = s.startsWith('/');
  const trail = s.endsWith('/');
  let out = normalizeArray(s.split('/'), !abs).join('/');
  if (!out && !abs) out = '.';
  if (out && trail) out += '/';
  return (abs ? '/' : '') + out;
}
function join(...parts) {
  for (const p of parts) if (typeof p !== 'string') throw new TypeError('The "path" argument must be of type string. Received ' + typeof p);
  const s = parts.filter((p) => p !== '').join('/');
  return s ? normalize(s) : '.';
}
function resolve(...parts) {
  let r = '';
  for (let i = parts.length - 1; i >= 0 && !r.startsWith('/'); i--) { const p = String(parts[i]); if (p) r = p + (r ? '/' + r : ''); }
  if (!r.startsWith('/')) r = '/app' + (r ? '/' + r : '');
  const out = '/' + normalizeArray(r.split('/'), false).join('/');
  return out;
}
function dirname(p) {
  const s = String(p);
  if (!s) return '.';
  const t = s.replace(/\/+$/, '');
  if (!t) return '/';
  const i = t.lastIndexOf('/');
  if (i < 0) return '.';
  if (i === 0) return '/';
  return t.slice(0, i);
}
function basename(p, ext) {
  const t = String(p).replace(/\/+$/, '');
  let b = t.slice(t.lastIndexOf('/') + 1);
  if (ext && b.endsWith(ext) && b !== ext) b = b.slice(0, -ext.length);
  return b;
}
function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i);
}
function relative(from, to) {
  const a = resolve(from).split('/').filter(Boolean);
  const b = resolve(to).split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(i).map(() => '..').concat(b.slice(i)).join('/');
}
function parse(p) {
  const s = String(p);
  const root = s.startsWith('/') ? '/' : '';
  const base = basename(s);
  const ext = extname(s);
  const dir = s.includes('/') ? dirname(s) : '';
  return { root, dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
}
function format(o) { const dir = o.dir || o.root || ''; const base = o.base || (o.name || '') + (o.ext || ''); return dir ? (dir === o.root ? dir + base : dir + '/' + base) : base; }
const path = {
  sep: '/', delimiter: ':', normalize, join, resolve, dirname, basename, extname, relative, parse, format,
  isAbsolute: (p) => String(p).startsWith('/'),
  toNamespacedPath: (p) => p,
  matchesGlob: () => { throw new Error('path.matchesGlob is not available'); },
};
path.posix = path;
path.win32 = path;
module.exports = path;
module.exports.default = path;
