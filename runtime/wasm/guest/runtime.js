'use strict';
// The guest's runtime: what Node gives an app that QuickJS (Javy's default
// plugin, no event loop) does not, and the conversation with the runner.
//
// ONE REQUEST, ONE INSTANCE. The runner starts a fresh instance per request
// and writes one request frame on stdin. This file reads it, sets
// process.env from it, loads the app (server.js runs its top-level code:
// routes are registered), lets that boot settle, hands the request to the
// app's Express app, and runs until nothing is left to do.
//
// AN EVENT LOOP IN JAVASCRIPT. The plugin has no event loop, so Promise is
// replaced (below) by one whose callbacks run from a job queue this file
// drains. Async functions are lowered to generators over it by the build
// (esbuild, --supported:async-await=false). Host calls that wait (a query,
// a release, an outside fetch) are held, and sent to the runner together
// when no job is left to run: queries and fetches an app starts together
// travel as one frame, and the runner runs them concurrently (queries
// outside a transaction as one batch to the data service, fetches at once).
// Timers fire, earliest first, only when nothing else can run and the
// app has not begun its answer; time does not pass for them (no sleeping).
// Timers left when the answer is done are dropped, as if the process had
// stopped. An answer begun but never ended (an event stream) is sent as
// written so far, and closed: live-updates.js's page reconnects after its
// retry (3 s), so a change shows within seconds instead of at once.
//
// THE BOOT. In a request, the app's top-level code runs again (routes are
// registered), but the queries it starts are skipped and answered empty:
// migrations run once per release, in /_wasm/setup, where they are sent.
//
// FRAMES. stdin and stdout carry frames: u32 little-endian length, then the
// payload: one kind byte, a JSON head, and optionally "\n" and raw bytes.
//   runner -> guest  'Q' the request            {m,u,h,ip,env,tok,claims,setup} + body
//                    'A' answers to 'C'          {rs:[...]} + the bodies, in order
//   guest -> runner  'C' host calls             {calls:[...]} + request bodies
//                    'R' the response           {s,h,f} + body (f: a bundled file)
//                    'D' a warm request is done {discard} (WASM_WARM; see run())
// console output goes to stderr (fd 2), which the runner logs.

const ABI = 1;
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------- frames

function readExact(n) {
  const buf = new Uint8Array(n);
  let got = 0;
  while (got < n) {
    const r = Javy.IO.readSync(0, buf.subarray(got));
    if (r <= 0) throw new Error('the runner closed the conversation');
    got += r;
  }
  return buf;
}

function readFrame() {
  const h = readExact(4);
  const len = (h[0] | (h[1] << 8) | (h[2] << 16) | (h[3] << 24)) >>> 0;
  const payload = readExact(len);
  const nl = payload.indexOf(10);
  const head = JSON.parse(dec.decode(payload.subarray(1, nl < 0 ? payload.length : nl)));
  return { kind: String.fromCharCode(payload[0]), head, body: nl < 0 ? new Uint8Array(0) : payload.subarray(nl + 1) };
}

function writeFrame(kind, head, body) {
  const h = enc.encode(JSON.stringify(head));
  const blen = body ? body.length : 0;
  const len = 1 + h.length + (body ? 1 + blen : 0);
  const f = new Uint8Array(4 + len);
  f[0] = len & 255; f[1] = (len >>> 8) & 255; f[2] = (len >>> 16) & 255; f[3] = (len >>> 24) & 255;
  f[4] = kind.charCodeAt(0);
  f.set(h, 5);
  if (body) { f[5 + h.length] = 10; f.set(body, 6 + h.length); }
  writeAll(1, f);
}

// Javy's writeSync writes what it can (up to a line's end, say) and says
// how much: the rest is written again until none is left.
function writeAll(fd, bytes) {
  let off = 0;
  while (off < bytes.length) {
    const n = Javy.IO.writeSync(fd, off ? bytes.subarray(off) : bytes);
    if (!(n > 0)) throw new Error('could not write to fd ' + fd);
    off += n;
  }
}

function concat(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// ---------------------------------------------------------------- jobs and Promise

let jobs = [];
let jobAt = 0;
function queueJob(fn) { jobs.push(fn); }
function runJobs() {
  while (jobAt < jobs.length) {
    const fn = jobs[jobAt++];
    fn();
    if (state.exit !== null) break;
    if (jobAt > 4096) { jobs = jobs.slice(jobAt); jobAt = 0; }
  }
  if (jobAt >= jobs.length) { jobs = []; jobAt = 0; }
}

// Rejections nobody handled by the time the queue drained: logged, as Node does.
const unhandled = new Set();

const PENDING = 0, FULFILLED = 1, REJECTED = 2;
class P {
  constructor(executor) {
    if (typeof executor !== 'function') throw new TypeError('Promise resolver is not a function');
    this._s = PENDING; this._v = undefined; this._cbs = []; this._handled = false;
    let done = false;
    const resolve = (v) => { if (!done) { done = true; resolveP(this, v); } };
    const reject = (e) => { if (!done) { done = true; settleP(this, REJECTED, e); } };
    try { executor(resolve, reject); } catch (e) { reject(e); }
  }
  then(onFulfilled, onRejected) {
    const parent = this;
    const child = new P(() => {});
    parent._handled = true;
    unhandled.delete(parent);
    const run = () => {
      const h = parent._s === FULFILLED ? onFulfilled : onRejected;
      if (typeof h !== 'function') { if (parent._s === FULFILLED) resolveP(child, parent._v); else settleP(child, REJECTED, parent._v); return; }
      let x;
      try { x = h(parent._v); } catch (e) { settleP(child, REJECTED, e); return; }
      resolveP(child, x);
    };
    if (parent._s === PENDING) parent._cbs.push(run); else queueJob(run);
    return child;
  }
  catch(onRejected) { return this.then(undefined, onRejected); }
  finally(f) {
    if (typeof f !== 'function') return this.then(f, f);
    return this.then((v) => P.resolve(f()).then(() => v), (e) => P.resolve(f()).then(() => { throw e; }));
  }
  static resolve(v) { return v instanceof P && v.constructor === P ? v : new P((r) => r(v)); }
  static reject(e) { return new P((_, r) => r(e)); }
  static withResolvers() { let resolve, reject; const promise = new P((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
  static all(items) {
    return new P((resolve, reject) => {
      const list = Array.from(items); const out = new Array(list.length); let left = list.length;
      if (!left) { resolve(out); return; }
      list.forEach((x, i) => P.resolve(x).then((v) => { out[i] = v; if (--left === 0) resolve(out); }, reject));
    });
  }
  static allSettled(items) {
    return P.all(Array.from(items).map((x) => P.resolve(x).then(
      (value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }))));
  }
  static race(items) { return new P((resolve, reject) => { for (const x of items) P.resolve(x).then(resolve, reject); }); }
  static any(items) {
    return new P((resolve, reject) => {
      const list = Array.from(items); const errors = new Array(list.length); let left = list.length;
      if (!left) { reject(new AggregateErrorShim(errors, 'All promises were rejected')); return; }
      list.forEach((x, i) => P.resolve(x).then(resolve, (e) => { errors[i] = e; if (--left === 0) reject(new AggregateErrorShim(errors, 'All promises were rejected')); }));
    });
  }
}
Object.defineProperty(P.prototype, Symbol.toStringTag, { value: 'Promise' });
const AggregateErrorShim = typeof AggregateError === 'function' ? AggregateError
  : class extends Error { constructor(errors, msg) { super(msg); this.errors = errors; this.name = 'AggregateError'; } };

function resolveP(p, v) {
  if (v === p) { settleP(p, REJECTED, new TypeError('Chaining cycle detected for promise')); return; }
  if (v !== null && (typeof v === 'object' || typeof v === 'function')) {
    let then;
    try { then = v.then; } catch (e) { settleP(p, REJECTED, e); return; }
    if (typeof then === 'function') {
      queueJob(() => {
        let done = false;
        try {
          then.call(v, (x) => { if (!done) { done = true; resolveP(p, x); } }, (e) => { if (!done) { done = true; settleP(p, REJECTED, e); } });
        } catch (e) { if (!done) { done = true; settleP(p, REJECTED, e); } }
      });
      return;
    }
  }
  settleP(p, FULFILLED, v);
}
function settleP(p, s, v) {
  if (p._s !== PENDING) return;
  p._s = s; p._v = v;
  const cbs = p._cbs; p._cbs = null;
  for (const cb of cbs) queueJob(cb);
  if (s === REJECTED && !p._handled) unhandled.add(p);
}
globalThis.Promise = P;

// ---------------------------------------------------------------- state

const state = {
  mode: 'request',     // 'request' or 'setup'
  phase: 'init',       // 'init' while the app boots, then 'request'
  exit: null,          // process.exit's code once called
  exitCode: undefined, // process.exitCode
  responded: false,
  streaming: false,    // the app has written part of its answer (an event stream)
  failed: false,       // something went wrong that Node would stop for (a warm instance is let go)
  skipped: 0,          // queries skipped while booting for a request
  app: null,           // the handler requests go to
  apps: [],            // every express() made, the first is the fallback
  request: null,
};

// ---------------------------------------------------------------- host calls

const held = [];  // waiting host calls: { call, body, resolve, reject }

/** A host call that waits (query, release, fetch): sent with the others at the next idle point. */
function hostCall(call, body) {
  return new P((resolve, reject) => { held.push({ call, body, resolve, reject }); });
}

function sendCalls(items) {
  const bodies = [];
  const calls = items.map((it) => {
    if (it.body && it.body.length) { bodies.push(it.body); return Object.assign({}, it.call, { bl: it.body.length }); }
    return it.call;
  });
  writeFrame('C', { calls }, bodies.length ? concat(bodies) : null);
  const a = readFrame();
  if (a.kind !== 'A') throw new Error('the runner answered with a ' + a.kind + ' frame');
  let off = 0;
  return a.head.rs.map((r) => {
    if (r && typeof r.bl === 'number') { const b = a.body.subarray(off, off + r.bl); off += r.bl; return { r, body: b }; }
    return { r, body: null };
  });
}

/** A host call answered at once (a file, a token, random bytes): never waits on I/O. */
function hostCallSync(call, body) {
  const [{ r, body: b }] = sendCalls([{ call, body }]);
  if (r && r.e !== undefined) {
    const err = new Error(r.e);
    if (r.code) err.code = r.code;
    throw err;
  }
  return { r, body: b };
}

function flush() {
  const batch = held.splice(0, held.length);
  let answers;
  try { answers = sendCalls(batch); } catch (e) { for (const it of batch) it.reject(e); return; }
  batch.forEach((it, i) => { const a = answers[i]; it.resolve(a); });
}

// ---------------------------------------------------------------- timers

let timerSeq = 0;
const timers = new Map(); // id -> { fn, args, at, every }
let clock = 0;            // virtual time: the latest timer that fired
class Timeout {
  constructor(id) { this._id = id; }
  ref() { return this; } unref() { return this; } hasRef() { return true; }
  refresh() { const t = timers.get(this._id); if (t) t.at = clock + t.delay; return this; }
  close() { timers.delete(this._id); return this; }
  [Symbol.toPrimitive]() { return this._id; }
}
function addTimer(fn, delay, args, every) {
  if (typeof fn !== 'function') throw new TypeError('The "callback" argument must be of type function');
  const id = ++timerSeq;
  const d = Math.max(1, Number(delay) || 0);
  timers.set(id, { fn, args, at: clock + d, delay: d, every, seq: id });
  return new Timeout(id);
}
function clearTimer(t) { if (t == null) return; timers.delete(typeof t === 'object' ? t._id : Number(t)); }
function fireNextTimer() {
  let next = null;
  for (const t of timers.values()) if (!next || t.at < next.at || (t.at === next.at && t.seq < next.seq)) next = t;
  if (!next) return false;
  const id = [...timers.entries()].find(([, t]) => t === next)[0];
  clock = next.at;
  if (next.every) next.at = clock + next.delay; else timers.delete(id);
  try { next.fn.apply(undefined, next.args); } catch (e) { uncaught(e); }
  return true;
}
globalThis.setTimeout = (fn, ms, ...args) => addTimer(fn, ms, args, false);
globalThis.setInterval = (fn, ms, ...args) => addTimer(fn, ms, args, true);
globalThis.setImmediate = (fn, ...args) => addTimer(fn, 0, args, false);
globalThis.clearTimeout = clearTimer;
globalThis.clearInterval = clearTimer;
globalThis.clearImmediate = clearTimer;
globalThis.queueMicrotask = (fn) => queueJob(() => { try { fn(); } catch (e) { uncaught(e); } });

// ---------------------------------------------------------------- console

function inspect(v, depth) {
  depth = depth === undefined ? 2 : depth;
  if (typeof v === 'string') return v;
  if (v instanceof Error) {
    // Node's stack starts with "Name: message"; QuickJS's has only the frames.
    const st = v.stack ? String(v.stack) : '';
    const text = st.startsWith(String(v.name)) ? st : `${v.name}: ${v.message}` + (st ? '\n' + st.replace(/\n$/, '') : '');
    return v.cause !== undefined && depth > 0 ? `${text}\n  [cause]: ${inspect(v.cause, depth - 1)}` : text;
  }
  if (v === undefined || v === null || typeof v !== 'object') return String(v);
  try {
    const seen = new Set();
    return JSON.stringify(v, (k, x) => {
      if (typeof x === 'bigint') return x.toString() + 'n';
      if (x && typeof x === 'object') { if (seen.has(x)) return '[Circular]'; seen.add(x); }
      return x;
    });
  } catch (_) { return Object.prototype.toString.call(v); }
}
function format(...args) {
  if (typeof args[0] !== 'string') return args.map((a) => inspect(a)).join(' ');
  let i = 1;
  const first = args[0].replace(/%[sdifjoOc%]/g, (m) => {
    if (m === '%%') return '%';
    if (i >= args.length) return m;
    const a = args[i++];
    switch (m) {
      case '%s': return typeof a === 'string' ? a : inspect(a);
      case '%d': case '%i': return String(parseInt(a, 10));
      case '%f': return String(parseFloat(a));
      case '%j': return JSON.stringify(a);
      case '%c': return '';
      default: return inspect(a);
    }
  });
  return [first].concat(args.slice(i).map((a) => inspect(a))).join(' ');
}
function writeErr(text) { try { writeAll(2, enc.encode(text + '\n')); } catch (_) { /* nowhere to say it */ } }
// What the app prints while it boots for a request ("Listening on :3000")
// was said once by its setup run: it is not repeated for every request.
const booting = () => state.mode === 'request' && state.phase === 'init';
const consoleShim = {};
for (const level of ['log', 'info', 'debug', 'warn', 'error', 'trace']) consoleShim[level] = (...a) => { if (!booting()) writeErr(format(...a)); };
consoleShim.dir = (v) => writeErr(inspect(v));
consoleShim.table = (v) => writeErr(inspect(v));
consoleShim.assert = (ok, ...a) => { if (!ok) writeErr('Assertion failed' + (a.length ? ': ' + format(...a) : '')); };
const counts = new Map();
consoleShim.count = (l = 'default') => { const n = (counts.get(l) || 0) + 1; counts.set(l, n); writeErr(`${l}: ${n}`); };
consoleShim.time = consoleShim.timeEnd = consoleShim.timeLog = consoleShim.group = consoleShim.groupEnd = () => {};
globalThis.console = consoleShim;

function uncaught(e) {
  writeErr('Uncaught ' + inspect(e));
  if (state.mode === 'setup') state.exitCode = state.exitCode || 1;
  // Node stops on an uncaught error: a warm instance is let go after this request.
  if (state.phase === 'request') state.failed = true;
}

// ---------------------------------------------------------------- process

class ExitSignal { constructor(code) { this.code = code; } }
const processShim = {
  env: {},
  argv: ['node', '/app/server.js'],
  argv0: 'node',
  execArgv: [],
  pid: 1,
  ppid: 0,
  platform: 'linux',
  arch: 'wasm32',
  version: 'v22.0.0',
  versions: { node: '22.0.0' },
  release: { name: 'node' },
  title: 'node',
  cwd: () => '/app',
  chdir: () => { throw new Error('process.chdir is not available'); },
  uptime: () => 0,
  memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
  cpuUsage: () => ({ user: 0, system: 0 }),
  hrtime: Object.assign((prev) => {
    const ns = Date.now() * 1e6; const s = Math.floor(ns / 1e9); const n = ns % 1e9;
    if (!prev) return [s, n];
    let ds = s - prev[0], dn = n - prev[1]; if (dn < 0) { ds -= 1; dn += 1e9; } return [ds, dn];
  }, { bigint: () => BigInt(Date.now()) * 1000000n }),
  nextTick: (fn, ...args) => queueJob(() => { try { fn(...args); } catch (e) { uncaught(e); } }),
  exit: (code) => { state.exit = code === undefined ? (state.exitCode || 0) : Number(code) || 0; throw new ExitSignal(state.exit); },
  kill: () => true,
  emitWarning: (w) => writeErr('Warning: ' + (w && w.message ? w.message : w)),
  on() { return processShim; }, once() { return processShim; }, off() { return processShim; },
  addListener() { return processShim; }, removeListener() { return processShim; }, removeAllListeners() { return processShim; },
  listeners() { return []; }, listenerCount() { return 0; }, emit() { return false; },
  stdout: { write: (s) => { writeErr(String(s).replace(/\n$/, '')); return true; }, isTTY: false },
  stderr: { write: (s) => { writeErr(String(s).replace(/\n$/, '')); return true; }, isTTY: false },
};
Object.defineProperty(processShim, 'exitCode', { get: () => state.exitCode, set: (v) => { state.exitCode = v; } });
globalThis.process = processShim;
globalThis.global = globalThis;
globalThis.__dirname = '/app';
globalThis.__filename = '/app/server.js';

// ---------------------------------------------------------------- bytes: base64, Buffer

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_REV = new Int16Array(256).fill(-1);
for (let i = 0; i < 64; i++) B64_REV[B64.charCodeAt(i)] = i;
B64_REV[45] = 62; B64_REV[95] = 63; // '-' '_' (base64url)
function b64encode(bytes, url) {
  let out = '';
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const a = bytes[i], b = i + 1 < n ? bytes[i + 1] : 0, c = i + 2 < n ? bytes[i + 2] : 0;
    const t = (a << 16) | (b << 8) | c;
    out += B64[(t >> 18) & 63] + B64[(t >> 12) & 63] + (i + 1 < n ? B64[(t >> 6) & 63] : '=') + (i + 2 < n ? B64[t & 63] : '=');
  }
  if (url) out = out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return out;
}
function b64decode(str) {
  const s = String(str);
  const out = new Uint8Array(Math.floor(s.length * 3 / 4) + 3);
  let bits = 0, acc = 0, o = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64_REV[s.charCodeAt(i) & 255];
    if (v < 0) continue;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
  }
  return out.subarray(0, o);
}
globalThis.btoa = (s) => { const str = String(s); const b = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); if (c > 255) throw new Error('Invalid character'); b[i] = c; } return b64encode(b); };
globalThis.atob = (s) => { const b = b64decode(String(s).replace(/\s+/g, '')); let o = ''; for (let i = 0; i < b.length; i++) o += String.fromCharCode(b[i]); return o; };

function latin1(bytes) { let o = ''; for (let i = 0; i < bytes.length; i += 4096) o += String.fromCharCode.apply(null, bytes.subarray(i, i + 4096)); return o; }
function normEnc(e) { const x = String(e || 'utf8').toLowerCase(); return x === 'utf-8' ? 'utf8' : x === 'binary' ? 'latin1' : x === 'ucs2' || x === 'ucs-2' || x === 'utf-16le' ? 'utf16le' : x; }
function bytesFromString(str, encoding) {
  const e = normEnc(encoding);
  const s = String(str);
  if (e === 'utf8') return enc.encode(s);
  if (e === 'hex') { const n = s.length >> 1; const b = new Uint8Array(n); for (let i = 0; i < n; i++) { const v = parseInt(s.substr(i * 2, 2), 16); if (Number.isNaN(v)) return b.subarray(0, i); b[i] = v; } return b; }
  if (e === 'base64' || e === 'base64url') return b64decode(s);
  if (e === 'latin1' || e === 'ascii') { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; }
  if (e === 'utf16le') { const b = new Uint8Array(s.length * 2); for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); b[i * 2] = c & 255; b[i * 2 + 1] = c >> 8; } return b; }
  throw new TypeError('Unknown encoding: ' + encoding);
}
function stringFromBytes(bytes, encoding) {
  const e = normEnc(encoding);
  if (e === 'utf8') return dec.decode(bytes);
  if (e === 'hex') { let o = ''; for (let i = 0; i < bytes.length; i++) o += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16); return o; }
  if (e === 'base64') return b64encode(bytes);
  if (e === 'base64url') return b64encode(bytes, true);
  if (e === 'latin1') return latin1(bytes);
  if (e === 'ascii') { let o = ''; for (let i = 0; i < bytes.length; i++) o += String.fromCharCode(bytes[i] & 127); return o; }
  if (e === 'utf16le') { let o = ''; for (let i = 0; i + 1 < bytes.length; i += 2) o += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8)); return o; }
  throw new TypeError('Unknown encoding: ' + encoding);
}

class Buffer extends Uint8Array {
  static from(v, encOrOffset, length) {
    if (typeof v === 'string') return Buffer._wrap(bytesFromString(v, encOrOffset));
    if (v instanceof ArrayBuffer) return new Buffer(v, encOrOffset || 0, length === undefined ? v.byteLength - (encOrOffset || 0) : length);
    if (ArrayBuffer.isView(v)) { const b = new Buffer(v.byteLength); b.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)); return b; }
    if (Array.isArray(v)) { const b = new Buffer(v.length); for (let i = 0; i < v.length; i++) b[i] = v[i] & 255; return b; }
    if (v && v.type === 'Buffer' && Array.isArray(v.data)) return Buffer.from(v.data);
    throw new TypeError('The first argument must be a string, Buffer, ArrayBuffer or array');
  }
  static _wrap(u8) { return new Buffer(u8.buffer, u8.byteOffset, u8.byteLength); }
  static alloc(n, fill) { const b = new Buffer(n); if (fill !== undefined) b.fill(typeof fill === 'string' ? fill.charCodeAt(0) : fill); return b; }
  static allocUnsafe(n) { return new Buffer(n); }
  static allocUnsafeSlow(n) { return new Buffer(n); }
  static isBuffer(b) { return b instanceof Buffer; }
  static isEncoding(e) { return ['utf8', 'hex', 'base64', 'base64url', 'latin1', 'ascii', 'utf16le'].includes(normEnc(e)); }
  static byteLength(v, e) { if (typeof v !== 'string') return v.byteLength; return bytesFromString(v, e).length; }
  static concat(list, total) {
    const b = Buffer._wrap(concat(list));
    return total === undefined ? b : total <= b.length ? b.subarray(0, total) : Buffer.concat([b, Buffer.alloc(total - b.length)]);
  }
  static compare(a, b) { return a.compare(b); }
  toString(encoding, start, end) { return stringFromBytes(this.subarray(start || 0, end === undefined ? this.length : end), encoding); }
  toJSON() { return { type: 'Buffer', data: Array.from(this) }; }
  equals(o) { if (this.length !== o.length) return false; for (let i = 0; i < this.length; i++) if (this[i] !== o[i]) return false; return true; }
  compare(o) { const n = Math.min(this.length, o.length); for (let i = 0; i < n; i++) if (this[i] !== o[i]) return this[i] < o[i] ? -1 : 1; return this.length === o.length ? 0 : this.length < o.length ? -1 : 1; }
  slice(s, e) { return this.subarray(s, e); }
  write(str, offset, length, encoding) {
    if (typeof offset === 'string') { encoding = offset; offset = 0; length = undefined; }
    const b = bytesFromString(str, encoding); const o = offset || 0; const n = Math.min(b.length, this.length - o, length === undefined ? Infinity : length);
    this.set(b.subarray(0, n), o); return n;
  }
  copy(target, targetStart, sourceStart, sourceEnd) {
    const src = this.subarray(sourceStart || 0, sourceEnd === undefined ? this.length : sourceEnd);
    const n = Math.min(src.length, target.length - (targetStart || 0)); target.set(src.subarray(0, n), targetStart || 0); return n;
  }
  readUInt8(o = 0) { return this[o]; }
  readUInt16BE(o = 0) { return (this[o] << 8) | this[o + 1]; }
  readUInt32BE(o = 0) { return ((this[o] << 24) >>> 0) + ((this[o + 1] << 16) | (this[o + 2] << 8) | this[o + 3]); }
  readUInt32LE(o = 0) { return ((this[o + 3] << 24) >>> 0) + ((this[o + 2] << 16) | (this[o + 1] << 8) | this[o]); }
  writeUInt8(v, o = 0) { this[o] = v; return o + 1; }
  writeUInt32BE(v, o = 0) { this[o] = v >>> 24; this[o + 1] = v >>> 16; this[o + 2] = v >>> 8; this[o + 3] = v; return o + 4; }
}
Buffer.poolSize = 8192;
globalThis.Buffer = Buffer;

// ---------------------------------------------------------------- randomness and digests (host)

function randomBytes(n) { return Buffer._wrap(hostCallSync({ k: 'rand', n }).body); }
function randomUUID() {
  const b = randomBytes(16); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function getRandomValues(arr) { const b = randomBytes(arr.byteLength); new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength).set(b); return arr; }
function toBytes(data, encoding) {
  if (typeof data === 'string') return bytesFromString(data, encoding);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('The "data" argument must be a string, Buffer, TypedArray or DataView');
}
function digest(alg, data) { return Buffer._wrap(hostCallSync({ k: 'hash', a: String(alg).toLowerCase() }, data).body); }
function hmac(alg, key, data) { return Buffer._wrap(hostCallSync({ k: 'hmac', a: String(alg).toLowerCase(), kl: key.length }, concat([key, data])).body); }
if (typeof globalThis.crypto !== 'object' || !globalThis.crypto) globalThis.crypto = {};
globalThis.crypto.randomUUID = randomUUID;
globalThis.crypto.getRandomValues = getRandomValues;

// ---------------------------------------------------------------- the bundled files (host)

/** A path the app names ('/app/public/x', './words.json', 'public/x') as the bundle's key ('public/x'). */
function fileKey(p) {
  let s = String(p);
  if (s.startsWith('file://')) s = s.slice(7);
  const abs = s.startsWith('/') ? s : '/app/' + s;
  const parts = [];
  for (const seg of abs.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  if (parts[0] !== 'app') return null; // outside the app's tree: nothing there
  return parts.slice(1).join('/');
}
function fileStat(p) {
  const key = fileKey(p);
  if (key === null) return null;
  const { r } = hostCallSync({ k: 'stat', p: key });
  return r.t ? { key, dir: r.t === 'd', size: r.z || 0 } : null;
}
function fileRead(p) {
  const key = fileKey(p);
  const err = () => { const e = new Error(`ENOENT: no such file or directory, open '${p}'`); e.code = 'ENOENT'; e.errno = -2; e.syscall = 'open'; e.path = String(p); return e; };
  if (key === null) throw err();
  const { r, body } = sendCalls([{ call: { k: 'file', p: key } }])[0];
  if (!r || r.e !== undefined) throw err();
  return Buffer._wrap(body);
}
function fileList(p) {
  const key = fileKey(p);
  const { r } = hostCallSync({ k: 'ls', p: key === null ? '\u0000' : key });
  if (!r.n) { const e = new Error(`ENOENT: no such file or directory, scandir '${p}'`); e.code = 'ENOENT'; throw e; }
  return r.n;
}

// ---------------------------------------------------------------- the database (host)

// node-pg's own conversions of what the data service sends: it decodes each
// column by type into JSON, and these finish what JSON cannot say (a Date,
// a Buffer, an interval, an array's elements).
const customParsers = new Map(); // oid -> fn(text) (pg.types.setTypeParser)
const DATE_OIDS = new Set([1114, 1184]);
const ARRAY_ELEM = new Map([[1000, 16], [1001, 17], [1005, 21], [1007, 23], [1016, 20], [1009, 25], [1015, 1043], [1014, 1042],
  [1021, 700], [1022, 701], [1231, 1700], [1115, 1114], [1185, 1184], [1182, 1082], [1183, 1083], [199, 114], [3807, 3802], [2951, 2950], [1187, 1186], [1028, 26]]);
function pad(n, w) { return String(n).padStart(w, '0'); }
function tsText(ms, tz) {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)} ${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}.${pad(d.getUTCMilliseconds(), 3)}${tz ? '+00' : ''}`;
}
function convert(oid, v) {
  if (v === null) return null;
  const custom = customParsers.get(oid);
  if (custom) {
    let text = v;
    if (DATE_OIDS.has(oid) && typeof v === 'number') text = tsText(v, oid === 1184);
    else if (typeof v !== 'string') text = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return custom(text);
  }
  if (DATE_OIDS.has(oid)) return typeof v === 'number' ? new Date(v) : v;
  if (oid === 1082) { const m = /^(\d{4,})-(\d\d)-(\d\d)$/.exec(v); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : v; }
  if (oid === 17) return Buffer._wrap(b64decode(v));
  if (oid === 700 || oid === 701) return typeof v === 'string' ? parseFloat(v) : v;
  const elem = ARRAY_ELEM.get(oid);
  if (elem !== undefined && Array.isArray(v)) return v.map(function each(x) { return Array.isArray(x) ? x.map(each) : convert(elem, x); });
  return v;
}
function pgError(r) {
  const err = new Error(r.e);
  for (const k of ['code', 'detail', 'hint', 'position', 'severity', 'schema', 'table', 'column', 'constraint', 'where', 'routine']) if (r[k] != null) err[k] = r[k];
  if (err.code && !err.severity) err.severity = 'ERROR';
  return err;
}
function finishResult(r, rowMode) {
  if (r.e !== undefined) throw pgError(r);
  const fields = (r.f || []).map((name, i) => ({ name, dataTypeID: r.t[i] }));
  const rows = (r.rows || []).map((row) => {
    if (rowMode === 'array') return row.map((v, i) => convert(r.t[i], v));
    const o = {};
    for (let i = 0; i < row.length; i++) o[r.f[i]] = convert(r.t[i], row[i]);
    return o;
  });
  return { command: r.cmd || null, rowCount: r.n === undefined ? rows.length : r.n, rows, fields, oid: null, rowAsArray: rowMode === 'array' };
}

function arrayLiteral(a) {
  return '{' + a.map((x) => {
    if (x === null || x === undefined) return 'NULL';
    if (Array.isArray(x)) return arrayLiteral(x);
    if (x instanceof Buffer) return '"\\\\x' + x.toString('hex') + '"';
    const s = paramText(x);
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }).join(',') + '}';
}
function dateParam(d) {
  // node-pg sends a Date as its local time with the offset (the instance's zone is UTC).
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}T${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(a / 60), 2)}:${pad(a % 60, 2)}`;
}
function paramText(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Buffer || v instanceof Uint8Array) return '\\x' + Buffer.from(v).toString('hex');
  if (v instanceof Date) return dateParam(v);
  if (Array.isArray(v)) return arrayLiteral(v);
  if (typeof v === 'object') {
    if (typeof v.toPostgres === 'function') return paramText(v.toPostgres(paramText));
    return JSON.stringify(v);
  }
  return String(v);
}

/** One statement; `c` 0 is the pool, any other number a client holding its connection. */
function query(c, text, values, rowMode) {
  const p = (values || []).map(paramText);
  if (state.mode === 'request' && state.phase === 'init') {
    // The app's boot (its migrate) runs once per release, in setup: here it is skipped.
    state.skipped++;
    return P.resolve({ command: null, rowCount: 0, rows: [], fields: [], oid: null });
  }
  return hostCall({ k: 'q', c, s: String(text), p }).then(({ r }) => finishResult(r, rowMode));
}
let nextClient = 1;
function releaseClient(c) { return hostCall({ k: 'rel', c }).then(() => undefined); }

// ---------------------------------------------------------------- tokens (host)

function verifyToken(token) {
  const req = state.request;
  if (req && req.tok && req.tok === token && req.claims) return { payload: JSON.parse(JSON.stringify(req.claims)), alg: req.alg || 'RS256' };
  const { r } = sendCalls([{ call: { k: 'jwt', t: String(token) } }])[0];
  if (r.e !== undefined) { const e = new Error(r.e); e.name = 'JsonWebTokenError'; throw e; }
  return { payload: r.payload, alg: r.alg };
}

// ---------------------------------------------------------------- fetch (host)

class Headers {
  constructor(init) {
    this._m = new Map();
    if (!init) return;
    if (init instanceof Headers) init.forEach((v, k) => this.append(k, v));
    else if (Array.isArray(init) || typeof init[Symbol.iterator] === 'function') for (const [k, v] of init) this.append(k, v);
    else for (const k of Object.keys(init)) this.append(k, init[k]);
  }
  append(k, v) { const n = String(k).toLowerCase(); const l = this._m.get(n); if (l) l.push(String(v)); else this._m.set(n, [String(v)]); }
  set(k, v) { this._m.set(String(k).toLowerCase(), [String(v)]); }
  get(k) { const l = this._m.get(String(k).toLowerCase()); return l ? l.join(', ') : null; }
  getSetCookie() { return (this._m.get('set-cookie') || []).slice(); }
  has(k) { return this._m.has(String(k).toLowerCase()); }
  delete(k) { this._m.delete(String(k).toLowerCase()); }
  forEach(fn, self) { for (const [k, l] of [...this._m.entries()].sort()) fn.call(self, l.join(', '), k, this); }
  *entries() { for (const [k, l] of [...this._m.entries()].sort()) yield [k, l.join(', ')]; }
  *keys() { for (const [k] of this.entries()) yield k; }
  *values() { for (const [, v] of this.entries()) yield v; }
  [Symbol.iterator]() { return this.entries(); }
  _pairs() { const out = []; for (const [k, l] of this._m) for (const v of l) out.push([k, v]); return out; }
}

class Body {
  _bytes() { if (this.bodyUsed) return P.reject(new TypeError('Body is unusable: Body has already been read')); this.bodyUsed = true; return P.resolve(this._b || new Uint8Array(0)); }
  text() { return this._bytes().then((b) => dec.decode(b)); }
  json() { return this.text().then((t) => JSON.parse(t)); }
  arrayBuffer() { return this._bytes().then((b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
  bytes() { return this._bytes().then((b) => new Uint8Array(b)); }
  blob() { return P.reject(new Error('Blob is not available')); }
  formData() { return P.reject(new Error('FormData is not available')); }
}
function bodyBytes(body, headers) {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') { if (headers && !headers.has('content-type')) headers.set('content-type', 'text/plain;charset=UTF-8'); return enc.encode(body); }
  if (body instanceof URLSearchParams) { if (headers && !headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8'); return enc.encode(body.toString()); }
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError('This body type is not available here');
}
class Response extends Body {
  constructor(body, init) {
    super(); init = init || {};
    this.status = init.status === undefined ? 200 : init.status;
    this.statusText = init.statusText || '';
    this.headers = new Headers(init.headers);
    this._b = bodyBytes(body, this.headers);
    this.ok = this.status >= 200 && this.status < 300;
    this.url = ''; this.redirected = false; this.type = 'default'; this.bodyUsed = false;
  }
  clone() { const r = new Response(this._b, this); r.url = this.url; return r; }
  static json(data, init) { const h = new Headers(init && init.headers); h.set('content-type', 'application/json'); return new Response(JSON.stringify(data), Object.assign({}, init, { headers: h })); }
  static error() { const r = new Response(null, { status: 0 }); r.type = 'error'; return r; }
  static redirect(url, status) { return new Response(null, { status: status || 302, headers: { location: String(url) } }); }
}
class Request extends Body {
  constructor(input, init) {
    super(); init = init || {};
    const from = input instanceof Request ? input : null;
    this.url = from ? from.url : String(input);
    this.method = String(init.method || (from && from.method) || 'GET').toUpperCase();
    this.headers = new Headers(init.headers || (from && from.headers));
    this.signal = init.signal || (from && from.signal) || null;
    this.redirect = init.redirect || (from && from.redirect) || 'follow';
    this._b = init.body !== undefined ? bodyBytes(init.body, this.headers) : from ? from._b : null;
    this.bodyUsed = false;
  }
  clone() { return new Request(this); }
}

class AbortSignal {
  constructor() { this.aborted = false; this.reason = undefined; this._l = []; this.onabort = null; this._timeout = null; }
  addEventListener(t, fn) { if (t === 'abort') this._l.push(fn); }
  removeEventListener(t, fn) { this._l = this._l.filter((f) => f !== fn); }
  throwIfAborted() { if (this.aborted) throw this.reason; }
  _abort(reason) {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason === undefined ? abortError('This operation was aborted') : reason;
    const ev = { type: 'abort', target: this };
    if (typeof this.onabort === 'function') this.onabort(ev);
    for (const fn of this._l) fn(ev);
  }
  static abort(reason) { const s = new AbortSignal(); s._abort(reason); return s; }
  // Passed on to the runner as the fetch's time limit; no timer runs here.
  static timeout(ms) { const s = new AbortSignal(); s._timeout = Number(ms); return s; }
  static any(signals) {
    const s = new AbortSignal();
    for (const x of signals) {
      if (x.aborted) { s._abort(x.reason); break; }
      if (x._timeout != null) s._timeout = s._timeout == null ? x._timeout : Math.min(s._timeout, x._timeout);
      x.addEventListener('abort', () => s._abort(x.reason));
    }
    return s;
  }
}
class AbortController { constructor() { this.signal = new AbortSignal(); } abort(reason) { this.signal._abort(reason); } }
function abortError(msg) { const e = new Error(msg); e.name = 'AbortError'; e.code = 20; return e; }

function fetchShim(input, init) {
  let req;
  try { req = new Request(input, init); } catch (e) { return P.reject(e); }
  const signal = req.signal;
  if (signal && signal.aborted) return P.reject(signal.reason);
  const call = { k: 'f', u: String(req.url), m: req.method, h: req.headers._pairs(), r: req.redirect };
  if (signal && signal._timeout != null) call.t = signal._timeout;
  const p = hostCall(call, req._b);
  const answered = p.then(({ r, body }) => {
    if (r.e !== undefined) {
      if (r.timeout) { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; e.code = 23; throw e; }
      const e = new TypeError('fetch failed'); e.cause = new Error(r.e); throw e;
    }
    const res = new Response(null, { status: r.s, statusText: r.st || '', headers: r.h });
    res._b = body; res.url = r.u || call.u; res.redirected = !!r.rd; res.type = 'basic';
    return res;
  });
  if (!signal) return answered;
  // An abort before the calls are sent takes the fetch back out.
  return new P((resolve, reject) => {
    signal.addEventListener('abort', () => {
      const i = held.findIndex((h) => h.call === call);
      if (i >= 0) held.splice(i, 1);
      reject(signal.reason);
    });
    answered.then(resolve, reject);
  });
}
globalThis.fetch = fetchShim;
globalThis.Headers = Headers;
globalThis.Request = Request;
globalThis.Response = Response;
globalThis.AbortController = AbortController;
globalThis.AbortSignal = AbortSignal;

// ---------------------------------------------------------------- URL

const DEFAULT_PORTS = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443', 'ftp:': '21' };
function encodeQS(s) { return encodeURIComponent(s).replace(/%20/g, '+').replace(/[!'()~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }
function decodeQS(s) { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch (_) { return s; } }
class URLSearchParams {
  constructor(init) {
    this._p = [];
    this._url = null;
    if (init === undefined || init === null) return;
    if (typeof init === 'string') this._parse(init);
    else if (init instanceof URLSearchParams) this._p = init._p.map((x) => x.slice());
    else if (Array.isArray(init) || typeof init[Symbol.iterator] === 'function') for (const [k, v] of init) this._p.push([String(k), String(v)]);
    else for (const k of Object.keys(init)) this._p.push([k, String(init[k])]);
  }
  _parse(s) {
    this._p = [];
    for (const kv of String(s).replace(/^\?/, '').split('&')) {
      if (!kv) continue;
      const i = kv.indexOf('=');
      this._p.push(i < 0 ? [decodeQS(kv), ''] : [decodeQS(kv.slice(0, i)), decodeQS(kv.slice(i + 1))]);
    }
  }
  _changed() { if (this._url) { const s = this.toString(); this._url._search = s ? '?' + s : ''; } }
  get size() { return this._p.length; }
  append(k, v) { this._p.push([String(k), String(v)]); this._changed(); }
  delete(k) { this._p = this._p.filter(([x]) => x !== String(k)); this._changed(); }
  get(k) { const f = this._p.find(([x]) => x === String(k)); return f ? f[1] : null; }
  getAll(k) { return this._p.filter(([x]) => x === String(k)).map(([, v]) => v); }
  has(k) { return this._p.some(([x]) => x === String(k)); }
  set(k, v) {
    const key = String(k); const i = this._p.findIndex(([x]) => x === key);
    if (i < 0) this._p.push([key, String(v)]);
    else { this._p[i][1] = String(v); this._p = this._p.filter(([x], j) => x !== key || j === i); }
    this._changed();
  }
  sort() { this._p.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); this._changed(); }
  forEach(fn, self) { for (const [k, v] of this._p) fn.call(self, v, k, this); }
  *entries() { for (const p of this._p) yield [p[0], p[1]]; }
  *keys() { for (const p of this._p) yield p[0]; }
  *values() { for (const p of this._p) yield p[1]; }
  [Symbol.iterator]() { return this.entries(); }
  toString() { return this._p.map(([k, v]) => encodeQS(k) + '=' + encodeQS(v)).join('&'); }
}
function normalizePath(path) {
  const out = [];
  const segs = path.split('/');
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s === '..') { if (out.length > 1) out.pop(); if (i === segs.length - 1) out.push(''); }
    else if (s === '.') { if (i === segs.length - 1) out.push(''); }
    else out.push(s);
  }
  const p = out.join('/');
  return p.startsWith('/') ? p : '/' + p;
}
function encodePath(p) { return p.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@/%]/g, (c) => encodeURIComponent(c)); }
class URL {
  constructor(input, base) {
    const s = String(input).trim();
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/.exec(s);
    if (m) this._abs(m[1].toLowerCase() + ':', m[2]);
    else {
      if (base === undefined) throw new TypeError('Invalid URL');
      const b = base instanceof URL ? base : new URL(base);
      this._protocol = b._protocol; this._username = b._username; this._password = b._password;
      this._hostname = b._hostname; this._port = b._port;
      let rest = s;
      if (rest.startsWith('//')) { this._abs(b._protocol, rest); return; }
      let hash = ''; let search = '';
      const hi = rest.indexOf('#'); if (hi >= 0) { hash = rest.slice(hi); rest = rest.slice(0, hi); }
      const qi = rest.indexOf('?'); if (qi >= 0) { search = rest.slice(qi); rest = rest.slice(0, qi); }
      if (rest === '') { this._pathname = b._pathname; this._search = search || (s.startsWith('#') ? b._search : search); }
      else if (rest.startsWith('/')) { this._pathname = normalizePath(encodePath(rest)); this._search = search; }
      else { this._pathname = normalizePath(b._pathname.replace(/[^/]*$/, '') + encodePath(rest)); this._search = search; }
      this._hash = hash;
      if (this._search === '?') this._search = '';
    }
  }
  _abs(protocol, rest) {
    this._protocol = protocol;
    this._username = ''; this._password = ''; this._hostname = ''; this._port = '';
    let hash = ''; let search = '';
    const hi = rest.indexOf('#'); if (hi >= 0) { hash = rest.slice(hi); rest = rest.slice(0, hi); }
    const qi = rest.indexOf('?'); if (qi >= 0) { search = rest.slice(qi); rest = rest.slice(0, qi); }
    if (rest.startsWith('//')) {
      rest = rest.slice(2);
      const si = rest.indexOf('/');
      let auth = si < 0 ? rest : rest.slice(0, si);
      rest = si < 0 ? '' : rest.slice(si);
      const at = auth.lastIndexOf('@');
      if (at >= 0) { const cred = auth.slice(0, at); auth = auth.slice(at + 1); const ci = cred.indexOf(':'); this._username = ci < 0 ? cred : cred.slice(0, ci); this._password = ci < 0 ? '' : cred.slice(ci + 1); }
      const pm = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(auth);
      if (!pm) throw new TypeError('Invalid URL');
      this._hostname = pm[1].toLowerCase();
      this._port = pm[2] && pm[2] !== DEFAULT_PORTS[protocol] ? String(Number(pm[2])) : '';
      if (!this._hostname && (protocol === 'http:' || protocol === 'https:')) throw new TypeError('Invalid URL');
      this._pathname = rest ? normalizePath(encodePath(rest)) : (DEFAULT_PORTS[protocol] ? '/' : '');
    } else {
      this._pathname = rest;
    }
    this._search = search === '?' ? '' : search;
    this._hash = hash === '#' ? '' : hash;
  }
  get protocol() { return this._protocol; }
  set protocol(v) { this._protocol = String(v).replace(/:?$/, ':'); }
  get username() { return this._username; }
  get password() { return this._password; }
  get hostname() { return this._hostname; }
  set hostname(v) { this._hostname = String(v).toLowerCase(); }
  get port() { return this._port; }
  set port(v) { this._port = String(v) === DEFAULT_PORTS[this._protocol] ? '' : String(v); }
  get host() { return this._hostname + (this._port ? ':' + this._port : ''); }
  set host(v) { const [h, p] = String(v).split(':'); this._hostname = h.toLowerCase(); this._port = p || ''; }
  get origin() { return DEFAULT_PORTS[this._protocol] ? this._protocol + '//' + this.host : 'null'; }
  get pathname() { return this._pathname; }
  set pathname(v) { const s = String(v); this._pathname = normalizePath(encodePath(s.startsWith('/') ? s : '/' + s)); }
  get search() { return this._search; }
  set search(v) { const s = String(v); this._search = !s || s === '?' ? '' : s.startsWith('?') ? s : '?' + s; if (this._sp) this._sp._parse(this._search); }
  get searchParams() { if (!this._sp) { this._sp = new URLSearchParams(this._search); this._sp._url = this; } return this._sp; }
  get hash() { return this._hash; }
  set hash(v) { const s = String(v); this._hash = !s || s === '#' ? '' : s.startsWith('#') ? s : '#' + s; }
  get href() {
    const auth = this._username ? this._username + (this._password ? ':' + this._password : '') + '@' : '';
    const slashes = this._hostname || DEFAULT_PORTS[this._protocol] ? '//' : '';
    return this._protocol + slashes + auth + this.host + this._pathname + this._search + this._hash;
  }
  set href(v) { const u = new URL(v); Object.assign(this, u); this._sp = null; }
  toString() { return this.href; }
  toJSON() { return this.href; }
  static canParse(u, b) { try { new URL(u, b); return true; } catch (_) { return false; } }
}
globalThis.URL = URL;
globalThis.URLSearchParams = URLSearchParams;

// ---------------------------------------------------------------- odds and ends

globalThis.structuredClone = function clone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Date) return new Date(v.getTime());
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [clone(k), clone(x)]));
  if (v instanceof Set) return new Set([...v].map(clone));
  if (ArrayBuffer.isView(v)) return v.slice();
  if (Array.isArray(v)) return v.map(clone);
  const o = {};
  for (const k of Object.keys(v)) o[k] = clone(v[k]);
  return o;
};
const started = Date.now();
if (typeof globalThis.performance !== 'object') globalThis.performance = { now: () => Date.now() - started, timeOrigin: started, mark() {}, measure() {} };
if (typeof globalThis.Event !== 'function') {
  globalThis.Event = class Event { constructor(type) { this.type = type; } };
  globalThis.EventTarget = class EventTarget {
    constructor() { this._l = new Map(); }
    addEventListener(t, fn) { if (!this._l.has(t)) this._l.set(t, []); this._l.get(t).push(fn); }
    removeEventListener(t, fn) { const l = this._l.get(t); if (l) this._l.set(t, l.filter((f) => f !== fn)); }
    dispatchEvent(ev) { for (const fn of this._l.get(ev.type) || []) fn.call(this, ev); return true; }
  };
}

// ---------------------------------------------------------------- the run

function respond(status, headers, body, file) {
  if (state.responded) return false;
  state.responded = true;
  const head = { s: status, h: headers };
  if (file) head.f = file;
  writeFrame('R', head, body && body.length ? body : null);
  return true;
}

function reportUnhandled() {
  for (const p of unhandled) {
    writeErr('Unhandled promise rejection: ' + inspect(p._v));
    if (state.mode === 'setup' && state.phase === 'init') state.exitCode = state.exitCode || 1;
    // Node 22 stops on one too.
    if (state.phase === 'request') state.failed = true;
  }
  unhandled.clear();
}

// Runs jobs and host calls until nothing is left; timers too while `timersToo()`.
function drain(timersToo) {
  for (;;) {
    try { runJobs(); } catch (e) { if (e instanceof ExitSignal) break; throw e; }
    if (state.exit !== null) break;
    reportUnhandled();
    if (held.length) { flush(); continue; }
    if (timersToo() && fireNextTimer()) continue;
    break;
  }
}

function applyEnv(req) {
  // In place, so a reference the app kept to process.env sees this request's.
  const env = processShim.env;
  for (const k of Object.keys(env)) delete env[k];
  Object.assign(env, req.env || {});
}

function run(load) {
  let q = readFrame();
  if (q.kind !== 'Q') throw new Error('expected a request frame, got ' + q.kind);
  state.request = q.head;
  state.mode = q.head.setup ? 'setup' : 'request';
  applyEnv(q.head);

  // Boot: the app's top-level code, then everything it started (its migrate).
  let bootError = null;
  try { load(); } catch (e) { if (e instanceof ExitSignal) state.exit = e.code; else bootError = e; }
  if (state.exit === null) drain(() => false);
  // Timers the boot set (a cleanup every hour) belong to a long-running process.
  timers.clear();

  if (state.mode === 'setup') {
    let error = null;
    if (bootError) error = inspect(bootError);
    else if (state.exit !== null && state.exit !== 0) error = 'the app called process.exit(' + state.exit + ')';
    else if (state.exitCode) error = 'the app set process.exitCode ' + state.exitCode + ' while starting';
    const body = enc.encode(JSON.stringify({ ok: !error, error, abi: ABI }));
    respond(200, [['content-type', 'application/json']], body);
    return;
  }

  state.phase = 'request';
  if (bootError || state.exit !== null) {
    if (bootError) writeErr('The app failed to start: ' + inspect(bootError));
    respond(500, [['content-type', 'application/json; charset=utf-8']], enc.encode(JSON.stringify({ error: 'The app failed to start.' })));
    if (q.head.warm) writeFrame('D', { discard: true });
    return;
  }
  // WARM (q.head.warm): the runner keeps this instance for more requests of
  // the same app and database. After each one it says so ('D'), says whether
  // the instance is still sound, and waits for the next request; the app's
  // globals stay, what belonged to the request (its answer, timers,
  // environment, identity) does not.
  for (;;) {
    serve(q);
    if (!q.head.warm) return;
    const discard = state.exit !== null || state.failed;
    writeFrame('D', { discard });
    if (discard) return;
    state.responded = false;
    state.streaming = false;
    state.request = null;
    timers.clear();
    unhandled.clear();
    try { q = readFrame(); } catch (_) { return; } // the runner let the instance go
    if (q.kind !== 'Q') return;
    state.request = q.head;
    applyEnv(q.head);
  }
}

/** One request: hand it to the app, run until it has its answer and nothing is left to do. */
function serve(q) {
  const req = q.head;
  const handler = state.app || state.apps[0];
  if (!handler) {
    respond(502, [['content-type', 'application/json; charset=utf-8']], enc.encode(JSON.stringify({ error: 'The app made no Express app or server.' })));
    state.failed = true;
    return;
  }
  try {
    handler.__dispatch(req, q.body);
  } catch (e) {
    if (!(e instanceof ExitSignal)) uncaught(e);
  }
  // Timers run while the request waits for its answer; not once an answer
  // has begun (an event stream's heartbeat would run for ever): that answer
  // is sent as written so far.
  drain(() => !state.responded && !state.streaming && state.exit === null);
  if (!state.responded && handler.__unfinished) handler.__unfinished();
  if (!state.responded) {
    respond(500, [['content-type', 'application/json; charset=utf-8']],
      enc.encode(JSON.stringify({ error: state.exit !== null ? 'The app stopped before answering.' : 'The app finished without answering.' })));
    state.failed = true;
  }
}

module.exports = {
  ABI,
  run,
  state,
  respond,
  queueJob,
  hostCall,
  hostCallSync,
  query,
  releaseClient,
  nextClientId: () => nextClient++,
  customParsers,
  verifyToken,
  fileStat,
  fileRead,
  fileList,
  fileKey,
  randomBytes,
  randomUUID,
  getRandomValues,
  digest,
  hmac,
  toBytes,
  b64encode,
  b64decode,
  bytesFromString,
  stringFromBytes,
  format,
  inspect,
  encoder: enc,
  decoder: dec,
  Buffer,
  URL,
  URLSearchParams,
  ExitSignal,
  registerApp(app) { state.apps.push(app); },
  serveWith(app) { state.app = app; },
};
