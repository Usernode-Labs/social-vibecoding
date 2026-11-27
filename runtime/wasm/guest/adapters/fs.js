'use strict';
// fs, read-only: the project's files are bundled into the module (every file
// of the tree but dotfiles, node_modules, docs and lockfiles), and the runner
// answers reads from them. /app is the project's root, as in its container.
// Writing fails with EROFS: an instance keeps nothing between requests.

const rt = require('../runtime.js');
const { Buffer } = rt;

function encOf(o) { return typeof o === 'string' ? o : o && o.encoding ? o.encoding : null; }
function erofs(syscall, p) { const e = new Error(`EROFS: read-only file system, ${syscall} '${p}'`); e.code = 'EROFS'; e.errno = -30; e.syscall = syscall; e.path = String(p); return e; }
function enoent(syscall, p) { const e = new Error(`ENOENT: no such file or directory, ${syscall} '${p}'`); e.code = 'ENOENT'; e.errno = -2; e.syscall = syscall; e.path = String(p); return e; }

function stats(st) {
  const t = new Date(0);
  return {
    size: st.dir ? 4096 : st.size, mode: st.dir ? 0o40555 : 0o100444, uid: 1000, gid: 1000, nlink: 1, dev: 0, ino: 0, rdev: 0,
    blksize: 4096, blocks: Math.ceil((st.size || 0) / 512), atime: t, mtime: t, ctime: t, birthtime: t,
    atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0,
    isFile: () => !st.dir, isDirectory: () => st.dir, isSymbolicLink: () => false, isFIFO: () => false,
    isSocket: () => false, isBlockDevice: () => false, isCharacterDevice: () => false,
  };
}

function readFileSync(p, options) {
  const fd = typeof p === 'number' ? null : p;
  if (fd === null) throw new Error('reading by file descriptor is not available');
  const b = rt.fileRead(p);
  const e = encOf(options);
  return e ? b.toString(e) : b;
}
function existsSync(p) { try { return !!rt.fileStat(p); } catch (_) { return false; } }
function statSync(p, options) {
  const st = rt.fileStat(p);
  if (!st) { if (options && options.throwIfNoEntry === false) return undefined; throw enoent('stat', p); }
  return stats(st);
}
function readdirSync(p, options) {
  const names = rt.fileList(p).slice().sort();
  if (options && options.withFileTypes) {
    return names.map((n) => { const st = rt.fileStat(String(p).replace(/\/$/, '') + '/' + n); return Object.assign({ name: n, path: String(p), parentPath: String(p) }, { isFile: () => !st.dir, isDirectory: () => st.dir, isSymbolicLink: () => false }); });
  }
  return names;
}
function accessSync(p) { if (!rt.fileStat(p)) throw enoent('access', p); }
function realpathSync(p) { if (!rt.fileStat(p)) throw enoent('realpath', p); return '/app/' + rt.fileKey(p); }
realpathSync.native = realpathSync;

function cbify(fn) {
  return function (...a) {
    const cb = typeof a[a.length - 1] === 'function' ? a.pop() : null;
    let out, err = null;
    try { out = fn(...a); } catch (e) { err = e; }
    if (cb) rt.queueJob(() => (err ? cb(err) : cb(null, out)));
  };
}
function promisified(fn) { return (...a) => { try { return Promise.resolve(fn(...a)); } catch (e) { return Promise.reject(e); } }; }

const denied = (name) => (p) => { throw erofs(name, p); };
const writeFileSync = denied('open');
const appendFileSync = denied('open');
const unlinkSync = denied('unlink');
const rmSync = denied('rm');
const rmdirSync = denied('rmdir');
const renameSync = denied('rename');
const copyFileSync = denied('copyfile');
function mkdirSync(p, options) {
  const st = rt.fileStat(p);
  if (st && st.dir) { if (options && options.recursive) return undefined; const e = new Error(`EEXIST: file already exists, mkdir '${p}'`); e.code = 'EEXIST'; throw e; }
  throw erofs('mkdir', p);
}

const promises = {
  readFile: promisified(readFileSync),
  stat: promisified(statSync),
  lstat: promisified(statSync),
  readdir: promisified(readdirSync),
  access: promisified(accessSync),
  realpath: promisified(realpathSync),
  writeFile: promisified(writeFileSync),
  appendFile: promisified(appendFileSync),
  mkdir: promisified(mkdirSync),
  unlink: promisified(unlinkSync),
  rm: promisified(rmSync),
  rename: promisified(renameSync),
  copyFile: promisified(copyFileSync),
};

module.exports = {
  readFileSync, existsSync, statSync, lstatSync: statSync, readdirSync, accessSync, realpathSync,
  writeFileSync, appendFileSync, mkdirSync, unlinkSync, rmSync, rmdirSync, renameSync, copyFileSync,
  readFile: cbify(readFileSync), stat: cbify(statSync), lstat: cbify(statSync), readdir: cbify(readdirSync),
  access: cbify(accessSync), realpath: cbify(realpathSync), writeFile: cbify(writeFileSync), appendFile: cbify(appendFileSync),
  mkdir: cbify(mkdirSync), unlink: cbify(unlinkSync), rm: cbify(rmSync), rename: cbify(renameSync),
  exists: (p, cb) => rt.queueJob(() => cb(existsSync(p))),
  createReadStream() { throw new Error('fs streams are not available: use readFileSync, res.sendFile or express.static'); },
  createWriteStream(p) { throw erofs('open', p); },
  watch() { throw new Error('fs.watch is not available'); },
  promises,
  constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY: 0 },
  Stats: function Stats() {},
};
module.exports.default = module.exports;
void Buffer;
