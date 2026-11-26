'use strict';

// A smaller copy of an app's icon or a community's picture (request #7165,
// point 5, measured 25 Nov 2026).
//
// /app-icons/<id> and /app-illustrations/<id> sent the stored file whatever
// it was drawn at: icons of 100 to 140 KB in 48 to 64 px tiles, community
// pictures of up to 936 KB in cards about 110 px wide. Either address now
// takes `?w=`, and answers with a WebP no wider than one of WIDTHS.
//
// The rules that keep this from being a way to make the server work:
//   - Only the widths in WIDTHS exist. A number between two of them gets the
//     next one up, so a tile asking for twice its drawn size is never handed
//     a softer picture; anything that is not a whole number is no request at
//     all, and the route answers with the stored file as it always did.
//   - A copy is made once and kept in memory (CACHE_BYTES at most, the least
//     recently used dropped first), under the picture's id AND the hash of
//     its stored bytes. The route reads the stored row on every request, as
//     it does with no `w`, before a kept copy is looked at: a picture that
//     is gone answers 404 whatever is kept (and its copies are dropped), and
//     bytes that changed under an id never match a copy of the old ones.
//   - Two requests for the same copy share one resize, at most CONCURRENT
//     resizes run at once and at most QUEUE wait; past that the stored file
//     is sent instead.
//   - Never enlarged, and a copy no smaller than its source is not a copy:
//     the stored file is sent.
//   - Any failure (the library missing, bytes it cannot read) falls back to
//     the stored file, and is remembered so it is not tried again.
//
// The copy is always WebP, which every browser the shell supports draws, so
// nothing is negotiated and no `Vary` is sent. A request with no `w` is
// untouched: the phone app, a link preview and the colour read off an icon
// (frontend/src/lib/community-color.ts) keep the whole picture.
//
// `sharp` is the library the shots' sized copies already use
// (services/shots-sized.js).

const crypto = require('node:crypto');
const log = require('./logger');

const WIDTHS = Object.freeze([96, 192, 512, 1024]);
const WEBP = 'image/webp';
const QUALITY = 80;
// The types a copy is made from. Anything else (an SVG, a GIF) is sent as
// stored.
const SIZABLE = new Set(['image/png', 'image/jpeg', 'image/webp']);
// A stored picture is at most 1 MB (routes/app-illustrations.js) and an icon
// 256 KB (services/app-manifest.js), but a small file can still claim a huge
// canvas: nothing over this many pixels is decoded.
const MAX_PIXELS = 40 * 1000 * 1000;
const CACHE_BYTES = 48 * 1024 * 1024;
const CACHE_ENTRIES = 4000;
const CONCURRENT = 2;
const QUEUE = 32;

/**
 * The width a request's `w` asks for: one of WIDTHS, or null when it asks for
 * none. Only a plain whole number counts ("192", never "192px", "1e3", a
 * repeated parameter or a negative one).
 */
function widthFor(raw) {
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,5}$/.test(raw)) return null;
  const asked = Number(raw);
  return WIDTHS.find((width) => width >= asked) || WIDTHS[WIDTHS.length - 1];
}

function createSizer({ sharp: given, cacheBytes = CACHE_BYTES, cacheEntries = CACHE_ENTRIES,
  concurrent = CONCURRENT, queue = QUEUE } = {}) {
  // key -> { data, contentType } for a copy, or null for "send the stored
  // file" (already small enough, or it could not be read). A Map keeps
  // insertion order, so the first key is the least recently used.
  const kept = new Map();
  const making = new Map();
  const waiting = [];
  let bytes = 0;
  let running = 0;

  function library() {
    if (given !== undefined) return given;
    try {
      return require('sharp');
    } catch (err) {
      log.warn('pictures', 'Sized pictures unavailable', { err: err.message });
      return null;
    }
  }

  function keep(key, copy) {
    if (kept.has(key)) bytes -= kept.get(key)?.data.length || 0;
    kept.delete(key);
    kept.set(key, copy);
    bytes += copy?.data.length || 0;
    while (kept.size > 1 && (bytes > cacheBytes || kept.size > cacheEntries)) {
      const [oldest, dropped] = kept.entries().next().value;
      kept.delete(oldest);
      bytes -= dropped?.data.length || 0;
    }
  }

  function turn() {
    if (running < concurrent) { running += 1; return Promise.resolve(true); }
    if (waiting.length >= queue) return Promise.resolve(false);
    return new Promise((resolve) => { waiting.push(resolve); });
  }
  function done() {
    const next = waiting.shift();
    if (next) next(true);
    else running -= 1;
  }

  async function resize(sharp, source, width) {
    const input = () => sharp(source.data, { limitInputPixels: MAX_PIXELS });
    const meta = await input().metadata();
    // An animated picture would lose its frames, and one already this narrow
    // has nothing to gain.
    if (!meta.width || meta.width <= width || (meta.pages || 1) > 1) return null;
    const data = await input().rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: QUALITY })
      .toBuffer();
    return data.length < source.data.length ? { data, contentType: WEBP } : null;
  }

  /**
   * The copy of picture `key` at `width`, or null when the stored file is
   * what to send. `source` is the stored file the route has just read,
   * `{ contentType, data }`: a copy is only ever answered for bytes that are
   * there now. A null from a busy queue is not remembered.
   */
  async function sized(key, width, source) {
    if (!source || !Buffer.isBuffer(source.data) || !source.data.length) return null;
    const version = crypto.createHash('sha256').update(source.data).digest('hex');
    const name = `${key}:${version}:${width}`;
    if (kept.has(name)) {
      const copy = kept.get(name);
      kept.delete(name);
      kept.set(name, copy);
      return copy;
    }
    if (making.has(name)) return making.get(name);
    const work = (async () => {
      const sharp = library();
      if (!sharp) return null;
      if (!(await turn())) return null;
      try {
        let copy = null;
        if (SIZABLE.has(source.contentType)) {
          try {
            copy = await resize(sharp, source, width);
          } catch (err) {
            log.warn('pictures', 'A sized picture could not be made', { key, width, err: err.message });
          }
        }
        keep(name, copy);
        return copy;
      } finally {
        done();
      }
    })();
    making.set(name, work);
    try {
      return await work;
    } finally {
      making.delete(name);
    }
  }

  /** Drops every kept copy of picture `key`: its row is gone. */
  function forget(key) {
    for (const [name, copy] of kept) {
      if (!name.startsWith(`${key}:`)) continue;
      kept.delete(name);
      bytes -= copy?.data.length || 0;
    }
  }

  return { sized, forget, stats: () => ({ entries: kept.size, bytes, running, waiting: waiting.length }) };
}

// The one the routes share: a pod keeps one set of copies.
const shared = createSizer();

module.exports = { WIDTHS, WEBP, widthFor, createSizer, sized: shared.sized, forget: shared.forget };
