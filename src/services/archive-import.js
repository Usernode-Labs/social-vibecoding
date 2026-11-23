'use strict';

// Reading an uploaded website archive into the files of a new project
// (POST /api/apps/archive, then services/app-creator.js's first commit).
//
// An archive is read in memory, never written to disk: the format comes from
// its magic bytes, the extension must agree, and every entry is checked
// against the same limits before it is kept. A file that would land outside
// the project (an absolute path, a drive letter, a backslash, a NUL, a `..`
// segment), a link, or a device is refused rather than sanitised: the person
// uploaded a website, and a shape Homeroom cannot keep byte for byte is a
// refusal with one plain sentence.
//
// Zip and tar.gz (and tar.gz's .tgz spelling) are read here. Rar and 7z are
// read by 7-Zip's WASM build (7z-wasm). A bare .gz holds one file, not a
// tree, so only a gzip that holds a tar is accepted.

const zlib = require('zlib');
const yauzl = require('yauzl');
const tar = require('tar');
const { DEV_CONSOLE_FORWARDER } = require('./template');

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 500;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_PATH_LENGTH = 200;

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
const RAR_MAGIC = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]); // Rar!\x1a\x07
const SEVEN_ZIP_MAGIC = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]); // 7z\xbc\xaf'\x1c

const TOO_BIG = 'That archive is too big. Upload one up to 25 MB.';
const TOO_MANY = `That archive holds too many files. Upload one with ${MAX_FILES} or fewer.`;
const A_FILE_TOO_BIG = 'A file in that archive is too big.';
const TOO_BIG_UNPACKED = 'That archive is too big once unpacked.';
const UNSAFE_PATH = 'That archive has a file whose path is unsafe.';
const NO_INDEX = 'There is no index.html at the top of this archive.';
const UNREADABLE = 'That archive could not be read. Try another file.';
const WRONG_TYPE = 'Upload a .zip, .tar.gz, .rar or .7z file.';

function startsWith(buffer, magic) {
  return Buffer.isBuffer(buffer) && buffer.length >= magic.length
    && buffer.subarray(0, magic.length).equals(magic);
}

/** The format the bytes are, and the extension that must name it. */
function formatOf(buffer, filename) {
  const name = String(filename || '').toLowerCase();
  const isZip = startsWith(buffer, ZIP_MAGIC);
  const isGzip = startsWith(buffer, GZIP_MAGIC);
  const isRar = startsWith(buffer, RAR_MAGIC);
  const isSevenZip = startsWith(buffer, SEVEN_ZIP_MAGIC);
  if (isZip && name.endsWith('.zip')) return 'zip';
  if (isGzip && (name.endsWith('.tar.gz') || name.endsWith('.tgz'))) return 'tgz';
  if (isRar && name.endsWith('.rar')) return 'rar';
  if (isSevenZip && name.endsWith('.7z')) return '7z';
  return null;
}

/**
 * A path as the project would keep it, or null when it must be refused.
 * Absolute paths, drive letters, backslashes, NUL, `..` segments and paths
 * longer than the cap are all refused.
 */
function safePath(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  if (raw.includes('\0') || raw.includes('\\')) return null;
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return null;
  const parts = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  if (!parts.length) return null;
  const joined = parts.join('/');
  if (joined.length > MAX_PATH_LENGTH) return null;
  return joined;
}

/** Mac clutter is dropped without a word: `__MACOSX/` and `.DS_Store`. */
function isClutter(path) {
  const parts = path.split('/');
  return parts[0] === '__MACOSX' || parts[parts.length - 1] === '.DS_Store';
}

/** What a readable entry left behind: a path and its bytes. */
function makeSink() {
  const files = [];
  let count = 0;
  let total = 0;
  let error = null;

  function fail(message) {
    error ||= message;
    return false;
  }

  function add(rawPath, chunks) {
    if (error) return false;
    const path = safePath(rawPath);
    if (!path) return fail(UNSAFE_PATH);
    if (isClutter(path)) return true;
    const content = Buffer.concat(chunks);
    if (content.length > MAX_FILE_BYTES) return fail(A_FILE_TOO_BIG);
    count += 1;
    if (count > MAX_FILES) return fail(TOO_MANY);
    total += content.length;
    if (total > MAX_TOTAL_BYTES) return fail(TOO_BIG_UNPACKED);
    files.push({ path, content });
    return true;
  }

  return { files, add, fail, get error() { return error; }, get count() { return count; } };
}

/** Read a zip: lazy entries, unix symlinks refused, caps enforced while streaming. */
function readZip(buffer) {
  return new Promise((resolve) => {
    const sink = makeSink();
    yauzl.fromBuffer(buffer, { lazyEntries: true, strictFileNames: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) return resolve({ ok: false, error: UNREADABLE });
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        try { zipfile.close(); } catch { /* already closed */ }
        resolve(error ? { ok: false, error } : { ok: true, ...sink });
      };
      // yauzl itself refuses `..` and absolute names before an entry is
      // emitted; that is the same unsafe path, said the same way.
      zipfile.on('error', (err) => finish(/invalid relative path|absolute path|invalid characters/i.test(err?.message || '') ? UNSAFE_PATH : UNREADABLE));
      zipfile.on('end', () => finish(sink.error || null));
      zipfile.on('entry', (entry) => {
        const name = entry.fileName;
        if (name.endsWith('/')) {
          zipfile.readEntry();
          return;
        }
        // Unix mode lives in the high 16 bits of the external attributes.
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (mode === 0o120000) return finish(UNSAFE_PATH);
        if (entry.uncompressedSize > MAX_FILE_BYTES) return finish(A_FILE_TOO_BIG);
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return finish(UNREADABLE);
          const chunks = [];
          let size = 0;
          stream.on('data', (chunk) => {
            if (settled) return;
            size += chunk.length;
            if (size > MAX_FILE_BYTES) {
              stream.destroy();
              finish(A_FILE_TOO_BIG);
              return;
            }
            chunks.push(chunk);
          });
          stream.on('error', () => finish(UNREADABLE));
          stream.on('end', () => {
            if (settled) return;
            if (!sink.add(name, chunks)) return finish(sink.error);
            zipfile.readEntry();
          });
        });
      });
      zipfile.readEntry();
    });
  });
}

/** Read a tar.gz with the tar parser; links and devices are refused. */
function readTarGz(buffer) {
  return new Promise((resolve) => {
    const sink = makeSink();
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      resolve(error ? { ok: false, error } : { ok: true, ...sink });
    };
    let parser;
    try {
      const Parser = tar.Parser || tar.Parse;
      parser = new Parser();
    } catch {
      return resolve({ ok: false, error: UNREADABLE });
    }
    const gunzip = zlib.createGunzip();
    gunzip.on('error', () => finish(UNREADABLE));
    parser.on('error', () => finish(UNREADABLE));
    parser.on('end', () => finish(sink.error || null));
    parser.on('entry', (entry) => {
      const type = entry.type;
      if (type === 'Directory') {
        entry.resume();
        return;
      }
      if (type !== 'File') return finish(UNSAFE_PATH);
      const chunks = [];
      let size = 0;
      entry.on('data', (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_FILE_BYTES) {
          entry.destroy();
          finish(A_FILE_TOO_BIG);
          return;
        }
        chunks.push(chunk);
      });
      entry.on('error', () => finish(UNREADABLE));
      entry.on('end', () => {
        if (settled) return;
        if (!sink.add(entry.path, chunks)) return finish(sink.error);
      });
    });
    gunzip.pipe(parser);
    gunzip.end(buffer);
  });
}

// ── Rar and 7z: 7-Zip's WASM build ─────────────────────────────────────
// One module instance is made once and used again. It extracts into its own
// in-memory filesystem, so nothing reaches the container's disk, and the
// same path checks and caps are applied to what it wrote.
let sevenZipModule = null;
function sevenZip() {
  if (!sevenZipModule) {
    const SevenZip = require('7z-wasm');
    sevenZipModule = SevenZip({ print: () => {}, printErr: () => {} });
  }
  return sevenZipModule;
}

function walkSevenZip(fs, dir, prefix, sink) {
  for (const name of fs.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const full = `${dir}/${name}`;
    const path = prefix ? `${prefix}/${name}` : name;
    const stat = fs.stat(full);
    if (fs.isDir(stat.mode)) {
      if (!walkSevenZip(fs, full, path, sink)) return false;
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) {
      sink.fail(A_FILE_TOO_BIG);
      return false;
    }
    let content;
    try {
      content = Buffer.from(fs.readFile(full));
    } catch {
      sink.fail(UNREADABLE);
      return false;
    }
    if (!sink.add(path, [content])) return false;
  }
  return true;
}

function removeTree(fs, dir) {
  for (const name of fs.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const full = `${dir}/${name}`;
    try {
      if (fs.isDir(fs.stat(full).mode)) removeTree(fs, full);
      else fs.unlink(full);
    } catch { /* already gone */ }
  }
  try { fs.rmdir(dir); } catch { /* not empty, or gone */ }
}

async function readWithSevenZip(buffer, format) {
  let seven;
  try {
    seven = await sevenZip();
  } catch {
    return { ok: false, error: UNREADABLE };
  }
  // Both names are this read's own: two uploads at once never share one.
  const tag = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const archive = `/upload-${tag}.${format}`;
  const out = `/out-${tag}`;
  const sink = makeSink();
  try {
    seven.FS.writeFile(archive, buffer);
    try { seven.FS.mkdir(out); } catch { /* already there */ }
    // -bso0/-bsp0 keep it quiet; x extracts with the archive's own tree.
    const code = seven.callMain(['x', '-y', '-bso0', '-bsp0', `-o${out}`, archive]);
    if (code !== 0) return { ok: false, error: UNREADABLE };
    if (!walkSevenZip(seven.FS, out, '', sink)) return { ok: false, error: sink.error || UNREADABLE };
  } catch {
    return { ok: false, error: UNREADABLE };
  } finally {
    try { seven.FS.unlink(archive); } catch { /* gone */ }
    try { removeTree(seven.FS, out); } catch { /* gone */ }
  }
  return { ok: true, ...sink };
}

/**
 * One wrapping folder is unwrapped: when every kept file sits inside the same
 * single top folder, that folder's contents are the top level.
 */
function unwrap(files) {
  let top = null;
  let allNested = files.length > 0;
  for (const file of files) {
    const slash = file.path.indexOf('/');
    if (slash <= 0) {
      allNested = false;
      break;
    }
    const first = file.path.slice(0, slash);
    if (top == null) top = first;
    else if (top !== first) {
      allNested = false;
      break;
    }
  }
  if (!allNested) return files;
  return files.map((file) => ({ ...file, path: file.path.slice(top.length + 1) }));
}

/**
 * Read `buffer` (a file called `filename`) into a project's files.
 * Resolves `{ ok: true, files, fileCount }` or `{ ok: false, error }`, one
 * plain sentence. Never throws for a bad archive.
 */
async function read(buffer, filename) {
  try {
    if (!Buffer.isBuffer(buffer) || !buffer.length) return { ok: false, error: WRONG_TYPE };
    if (buffer.length > MAX_ARCHIVE_BYTES) return { ok: false, error: TOO_BIG };
    const format = formatOf(buffer, filename);
    if (!format) return { ok: false, error: WRONG_TYPE };

    const read_ = format === 'zip' ? readZip(buffer)
      : format === 'tgz' ? readTarGz(buffer)
        : await readWithSevenZip(buffer, format);
    const result = await read_;
    if (!result.ok) return result;

    const files = unwrap(result.files);
    const seen = new Set();
    for (const file of files) {
      if (seen.has(file.path)) return { ok: false, error: UNSAFE_PATH };
      seen.add(file.path);
    }
    if (!seen.has('index.html')) return { ok: false, error: NO_INDEX };
    return { ok: true, files, fileCount: files.length };
  } catch {
    return { ok: false, error: UNREADABLE };
  }
}

/** The archive's own index.html, with the Dev console forwarder inserted once. */
function withForwarder(file) {
  const html = file.content.toString('utf8');
  if (html.includes('usernode-dev-console@1')) return file;
  if (!/<\/head\s*>/i.test(html)) return file;
  return {
    ...file,
    content: Buffer.from(html.replace(/<\/head\s*>/i, `${DEV_CONSOLE_FORWARDER}\n</head>`)),
  };
}

/**
 * A new project's first commit: the empty scaffold's files, without its own
 * public/index.html, with every archive file under public/. The scaffold's
 * dapp.json, server.js and the rest stay exactly as the template wrote them.
 */
function projectFiles(scaffold, archiveFiles) {
  const kept = (scaffold || []).filter((file) => file.path !== 'public/index.html');
  const under = archiveFiles.map((file) => {
    const placed = { path: `public/${file.path}`, content: file.content };
    return file.path === 'index.html' ? withForwarder(placed) : placed;
  });
  return [...kept, ...under];
}

module.exports = {
  read,
  projectFiles,
  safePath,
  formatOf,
  MAX_ARCHIVE_BYTES,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
};
