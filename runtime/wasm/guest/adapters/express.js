'use strict';
// Express 4, as much of it as Homeroom's generated projects and the apps
// they grow into use: apps and routers, `use` with mount paths, route
// paths with :params, `?`, `*` and regular expressions, error middleware,
// express.json/urlencoded/text/raw/static, and the req/res methods. One
// request per instance: the runtime hands the request to __dispatch.
//
// Left out, on purpose: views (res.render), ETag and 304 answers, trust
// proxy settings beyond reading X-Forwarded-*, and streaming request bodies
// (the whole body arrives with the request).

const rt = require('../runtime.js');
const { Buffer } = rt;

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all'];
const STATUS = {
  100: 'Continue', 101: 'Switching Protocols', 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  206: 'Partial Content', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified',
  307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required',
  403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable', 408: 'Request Timeout',
  409: 'Conflict', 410: 'Gone', 411: 'Length Required', 412: 'Precondition Failed', 413: 'Payload Too Large',
  415: 'Unsupported Media Type', 416: 'Range Not Satisfiable', 418: "I'm a Teapot", 422: 'Unprocessable Entity',
  423: 'Locked', 425: 'Too Early', 426: 'Upgrade Required', 428: 'Precondition Required', 429: 'Too Many Requests',
  431: 'Request Header Fields Too Large', 451: 'Unavailable For Legal Reasons', 500: 'Internal Server Error',
  501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};
const MIME = {
  html: 'text/html', htm: 'text/html', js: 'application/javascript', mjs: 'application/javascript', cjs: 'application/javascript',
  css: 'text/css', json: 'application/json', map: 'application/json', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  xml: 'application/xml', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp', woff: 'font/woff', woff2: 'font/woff2',
  ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject', wasm: 'application/wasm', pdf: 'application/pdf',
  zip: 'application/zip', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm',
  webmanifest: 'application/manifest+json', manifest: 'text/cache-manifest', glb: 'model/gltf-binary', gltf: 'model/gltf+json',
  bin: 'application/octet-stream', form: 'application/x-www-form-urlencoded', urlencoded: 'application/x-www-form-urlencoded',
  text: 'text/plain', octet: 'application/octet-stream',
};
const SHORT = { html: 'text/html', json: 'application/json', text: 'text/plain', js: 'application/javascript', css: 'text/css', xml: 'application/xml', urlencoded: 'application/x-www-form-urlencoded', form: 'application/x-www-form-urlencoded', bin: 'application/octet-stream' };

function lookup(type) {
  const t = String(type);
  if (t.includes('/')) return t;
  const ext = t.replace(/^.*[./]/, '').toLowerCase();
  return MIME[ext] || SHORT[ext] || 'application/octet-stream';
}
/** A file's Content-Type as send (express.static, res.sendFile) sets it. */
function fileType(path) {
  const ext = String(path).replace(/^.*\//, '').replace(/^[^.]*$/, '').replace(/^.*\./, '').toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const text = type.startsWith('text/') || ['application/javascript', 'application/json', 'application/xml', 'image/svg+xml', 'application/manifest+json'].includes(type);
  return text ? type + '; charset=UTF-8' : type;
}
function withCharset(type) {
  if (/;\s*charset=/i.test(type)) return type;
  const base = type.split(';')[0].trim().toLowerCase();
  if (base.startsWith('text/') || base === 'application/json' || base === 'application/javascript' || base === 'application/xml' || base === 'image/svg+xml' || base === 'application/manifest+json') return type + '; charset=utf-8';
  return type;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function errorPage(msg) {
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>${msg}</pre>\n</body>\n</html>\n`;
}

// ---------------------------------------------------------------- paths (path-to-regexp 0.1, as Express 4 uses it)

function compile(path, end, sensitive) {
  const keys = [];
  if (path instanceof RegExp) {
    const n = new RegExp(path.source + '|').exec('').length - 1;
    for (let i = 0; i < n; i++) keys.push({ name: i, optional: false });
    return { re: path, keys };
  }
  if (Array.isArray(path)) {
    const parts = path.map((p) => compile(p, end, sensitive));
    const all = []; parts.forEach((p) => all.push(...p.keys));
    return { re: new RegExp(parts.map((p) => p.re.source).join('|'), sensitive ? '' : 'i'), keys: all };
  }
  let src = String(path);
  if (!end) src = src.replace(/\/$/, '');
  let out = '';
  let i = 0;
  let star = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === ':') {
      const m = /^\/:([A-Za-z0-9_$]+)(\([^)]*\))?(\?)?/.exec(src.slice(i));
      keys.push({ name: m[1], optional: !!m[3] });
      const capture = m[2] ? m[2] : '([^/]+?)';
      out += m[3] ? `(?:/${capture})?` : `/${capture}`;
      i += m[0].length;
      continue;
    }
    if (c === ':') {
      const m = /^:([A-Za-z0-9_$]+)(\([^)]*\))?(\?)?/.exec(src.slice(i));
      keys.push({ name: m[1], optional: !!m[3] });
      out += (m[2] ? m[2] : '([^/]+?)') + (m[3] ? '?' : '');
      i += m[0].length;
      continue;
    }
    if (c === '*') { keys.push({ name: star++, optional: false }); out += '(.*)'; i++; continue; }
    if (c === '(') { const j = src.indexOf(')', i); out += src.slice(i, j + 1); i = j + 1; continue; }
    if (c === '?' && i > 0) { out += '?'; i++; continue; }
    out += /[.+^${}|[\]\\]/.test(c) ? '\\' + c : c;
    i++;
  }
  const tail = end ? '\\/?$' : '(?:\\/(?=$))?(?=\\/|$)';
  return { re: new RegExp('^' + out + tail, sensitive ? '' : 'i'), keys };
}
function decodeParam(v) {
  if (v === undefined) return undefined;
  try { return decodeURIComponent(v); } catch (e) { const err = new URIError(`Failed to decode param '${v}'`); err.status = err.statusCode = 400; throw err; }
}

// ---------------------------------------------------------------- query strings (qs, as Express's "extended" parser does)

function parseQuery(qs) {
  const out = {};
  if (!qs) return out;
  for (const kv of qs.split('&')) {
    if (!kv) continue;
    const i = kv.indexOf('=');
    const dk = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch (_) { return s; } };
    const k = dk(i < 0 ? kv : kv.slice(0, i));
    const v = i < 0 ? '' : dk(kv.slice(i + 1));
    const m = /^([^[\]]+)((?:\[[^[\]]*\])+)$/.exec(k);
    if (!m) { put(out, k, v); continue; }
    let target = out;
    const path = [m[1]].concat(m[2].slice(1, -1).split(']['));
    for (let j = 0; j < path.length - 1; j++) {
      const key = path[j];
      const nextIsArray = path[j + 1] === '';
      if (target[key] === undefined || typeof target[key] !== 'object') target[key] = nextIsArray ? [] : {};
      target = target[key];
    }
    const last = path[path.length - 1];
    if (last === '' && Array.isArray(target)) target.push(v);
    else if (Array.isArray(target) && /^\d+$/.test(last)) target[Number(last)] = v;
    else put(target, last, v);
  }
  return out;
}
function put(o, k, v) {
  if (k === '__proto__' || k === 'constructor' || k === 'prototype') return;
  if (Object.prototype.hasOwnProperty.call(o, k)) o[k] = [].concat(o[k], v); else o[k] = v;
}

// ---------------------------------------------------------------- the request and the response

function contentType(req) { return String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase(); }
function typeIs(req, types) {
  const ct = contentType(req);
  if (!ct) return false;
  for (const t of [].concat(types)) {
    const want = t.includes('/') ? t.toLowerCase() : (SHORT[t] || lookup(t));
    if (want === ct) return t;
    if (want.endsWith('/*') && ct.startsWith(want.slice(0, -1))) return t;
    if (want.startsWith('*/') && ct.endsWith(want.slice(1))) return t;
    if (want.startsWith('+') && ct.endsWith(want)) return t;
    if (t === '*/*') return t;
  }
  return false;
}

function makeRequest(app, q, body) {
  const headers = {};
  const raw = [];
  for (const [k, v] of q.h || []) {
    const n = k.toLowerCase();
    raw.push(k, v);
    if (n === 'set-cookie') headers[n] = (headers[n] || []).concat(v);
    else if (headers[n] !== undefined) headers[n] = n === 'cookie' ? headers[n] + '; ' + v : headers[n] + ', ' + v;
    else headers[n] = v;
  }
  const url = q.u || '/';
  const qi = url.indexOf('?');
  const listeners = new Map();
  const req = {
    app,
    method: String(q.m || 'GET').toUpperCase(),
    url,
    originalUrl: url,
    baseUrl: '',
    headers,
    rawHeaders: raw,
    httpVersion: '1.1',
    params: {},
    query: parseQuery(qi < 0 ? '' : url.slice(qi + 1)),
    body: undefined,
    _body: body || new Uint8Array(0),
    route: undefined,
    cookies: undefined,
    signedCookies: undefined,
    socket: { remoteAddress: q.ip || '127.0.0.1', encrypted: false },
    complete: true,
    readable: false,
    get(name) { const n = String(name).toLowerCase(); if (n === 'referer' || n === 'referrer') return headers.referer || headers.referrer; return headers[n]; },
    header(name) { return this.get(name); },
    is(types) { return typeIs(this, Array.isArray(types) ? types : [].slice.call(arguments)); },
    accepts(...types) {
      const list = [].concat(...types);
      const accept = String(headers.accept || '*/*');
      if (!list.length) return accept.split(',').map((s) => s.split(';')[0].trim());
      for (const t of list) { const m = lookup(t); if (accept.includes('*/*') || accept.includes(m) || accept.includes(m.split('/')[0] + '/*')) return t; }
      return false;
    },
    acceptsLanguages() { return String(headers['accept-language'] || '').split(',').map((s) => s.split(';')[0].trim()).filter(Boolean); },
    acceptsEncodings() { return String(headers['accept-encoding'] || '').split(',').map((s) => s.split(';')[0].trim()).filter(Boolean); },
    acceptsCharsets() { return ['utf-8']; },
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(fn);
      // A handler reading the body by hand gets it in one chunk.
      if (ev === 'end' && !req._ended) { req._ended = true; rt.queueJob(() => { if (this._body.length) for (const f of listeners.get('data') || []) f(Buffer._wrap(this._body)); for (const f of listeners.get('end') || []) f(); }); }
      return this;
    },
    once(ev, fn) { return this.on(ev, fn); },
    off() { return this; },
    removeListener() { return this; },
    setEncoding() { return this; },
    pipe(dest) { dest.end && dest.end(Buffer._wrap(this._body)); return dest; },
    resume() { return this; },
    pause() { return this; },
    unpipe() { return this; },
    [Symbol.asyncIterator]() { let done = false; const b = this._body; return { next: () => Promise.resolve(done || !b.length ? { done: true, value: undefined } : (done = true, { done: false, value: Buffer._wrap(b) })) }; },
  };
  Object.defineProperty(req, 'path', { get() { const u = this.url; const i = u.indexOf('?'); return i < 0 ? u : u.slice(0, i); }, enumerable: true });
  Object.defineProperty(req, 'protocol', { get() { const p = headers['x-forwarded-proto']; return p ? String(p).split(',')[0].trim() : 'http'; } });
  Object.defineProperty(req, 'secure', { get() { return this.protocol === 'https'; } });
  Object.defineProperty(req, 'ip', { get() { return this.ips[0] || q.ip || '127.0.0.1'; } });
  Object.defineProperty(req, 'ips', { get() { const f = headers['x-forwarded-for']; return f && app.enabled('trust proxy') ? String(f).split(',').map((s) => s.trim()) : []; } });
  Object.defineProperty(req, 'hostname', { get() { const h = headers['x-forwarded-host'] && app.enabled('trust proxy') ? headers['x-forwarded-host'] : headers.host; return h ? String(h).split(',')[0].trim().replace(/:\d+$/, '') : undefined; } });
  Object.defineProperty(req, 'host', { get() { return headers.host; } });
  Object.defineProperty(req, 'subdomains', { get() { const h = this.hostname || ''; return h.split('.').reverse().slice(2); } });
  Object.defineProperty(req, 'xhr', { get() { return String(headers['x-requested-with'] || '').toLowerCase() === 'xmlhttprequest'; } });
  Object.defineProperty(req, 'fresh', { get() { return false; } });
  Object.defineProperty(req, 'stale', { get() { return true; } });
  Object.defineProperty(req, 'connection', { get() { return this.socket; } });
  return req;
}

function makeResponse(app, req) {
  const headers = new Map(); // lower name -> [name, value]
  const chunks = [];
  const listeners = new Map();
  let file = null;
  const emit = (ev) => { for (const fn of listeners.get(ev) || []) { try { fn(); } catch (e) { console.error(e); } } };
  const res = {
    app,
    req,
    locals: Object.create(null),
    statusCode: 200,
    statusMessage: '',
    headersSent: false,
    finished: false,
    writableEnded: false,
    writableFinished: false,
    status(code) { this.statusCode = Number(code); return this; },
    sendStatus(code) { const body = STATUS[code] || String(code); this.statusCode = code; this.type('txt'); return this.send(body); },
    set(field, value) {
      if (typeof field === 'object' && field) { for (const k of Object.keys(field)) this.set(k, field[k]); return this; }
      let v = Array.isArray(value) ? value.map(String) : String(value);
      if (String(field).toLowerCase() === 'content-type') {
        if (Array.isArray(v)) throw new TypeError('Content-Type cannot be set to an Array');
        v = withCharset(v);
      }
      headers.set(String(field).toLowerCase(), [field, v]);
      return this;
    },
    header(field, value) { return this.set(field, value); },
    setHeader(field, value) { headers.set(String(field).toLowerCase(), [field, Array.isArray(value) ? value.map(String) : String(value)]); return this; },
    get(field) { const h = headers.get(String(field).toLowerCase()); return h ? h[1] : undefined; },
    getHeader(field) { return this.get(field); },
    getHeaders() { const o = {}; for (const [k, [, v]] of headers) o[k] = v; return o; },
    getHeaderNames() { return [...headers.keys()]; },
    hasHeader(field) { return headers.has(String(field).toLowerCase()); },
    removeHeader(field) { headers.delete(String(field).toLowerCase()); return this; },
    append(field, value) {
      const prev = this.get(field);
      const v = prev === undefined ? value : [].concat(prev, value);
      return String(field).toLowerCase() === 'set-cookie' ? this.setHeader(field, [].concat(v)) : this.set(field, v);
    },
    type(t) { return this.set('Content-Type', lookup(t)); },
    contentType(t) { return this.type(t); },
    vary(field) { const prev = this.get('Vary'); const list = prev ? String(prev).split(/\s*,\s*/) : []; if (!list.includes(field)) list.push(field); return this.set('Vary', list.join(', ')); },
    location(url) { return this.set('Location', url === 'back' ? (req.get('referer') || '/') : encodeURI(url).replace(/%25([0-9A-Fa-f]{2})/g, '%$1')); },
    links(links) { const prev = this.get('Link') || ''; const add = Object.keys(links).map((r) => `<${links[r]}>; rel="${r}"`).join(', '); return this.set('Link', prev ? prev + ', ' + add : add); },
    attachment(filename) { if (filename) this.type(filename.replace(/^.*\./, '')); return this.set('Content-Disposition', filename ? `attachment; filename="${String(filename).replace(/^.*\//, '')}"` : 'attachment'); },
    cookie(name, value, opts) {
      const o = Object.assign({ path: '/' }, opts || {});
      let v = typeof value === 'object' ? 'j:' + JSON.stringify(value) : String(value);
      v = encodeURIComponent(v);
      let c = `${name}=${v}`;
      if (o.maxAge != null) { const ms = Number(o.maxAge); o.expires = new Date(Date.now() + ms); c += `; Max-Age=${Math.floor(ms / 1000)}`; }
      if (o.domain) c += `; Domain=${o.domain}`;
      if (o.path) c += `; Path=${o.path}`;
      if (o.expires) c += `; Expires=${new Date(o.expires).toUTCString()}`;
      if (o.httpOnly) c += '; HttpOnly';
      if (o.secure) c += '; Secure';
      if (o.partitioned) c += '; Partitioned';
      if (o.sameSite) c += `; SameSite=${o.sameSite === true ? 'Strict' : String(o.sameSite).charAt(0).toUpperCase() + String(o.sameSite).slice(1).toLowerCase()}`;
      return this.append('Set-Cookie', c);
    },
    clearCookie(name, opts) { return this.cookie(name, '', Object.assign({ expires: new Date(1) }, opts || {}, { maxAge: undefined })); },
    redirect(a, b) {
      let status = 302; let url = a;
      if (b !== undefined) { if (typeof a === 'number') { status = a; url = b; } else { status = b; } }
      this.location(url);
      const loc = this.get('Location');
      this.statusCode = status;
      if (req.accepts('html') && !String(req.headers.accept || '').startsWith('text/plain') && String(req.headers.accept || '').includes('html')) {
        this.set('Content-Type', 'text/html');
        return this.end(`<p>${STATUS[status]}. Redirecting to <a href="${escapeHtml(loc)}">${escapeHtml(loc)}</a></p>`);
      }
      this.set('Content-Type', 'text/plain');
      return this.end(`${STATUS[status]}. Redirecting to ${loc}`);
    },
    json(obj) {
      if (arguments.length === 2 && typeof arguments[1] === 'number') { this.statusCode = arguments[1]; } else if (arguments.length === 2 && typeof obj === 'number') { this.statusCode = obj; obj = arguments[1]; }
      const body = JSON.stringify(obj, app.get('json replacer'), app.get('json spaces'));
      if (!this.get('Content-Type')) this.set('Content-Type', 'application/json');
      return this.send(body === undefined ? '' : body);
    },
    jsonp(obj) { return this.json(obj); },
    send(body) {
      let chunk = body;
      if (arguments.length === 2) { if (typeof body !== 'number' && typeof arguments[1] === 'number') { this.statusCode = arguments[1]; } else { this.statusCode = body; chunk = arguments[1]; } }
      if (typeof chunk === 'number' && arguments.length === 1) { if (!this.get('Content-Type')) this.type('txt'); this.statusCode = chunk; chunk = STATUS[chunk] || String(chunk); }
      if (chunk === null || chunk === undefined) chunk = '';
      if (typeof chunk === 'boolean' || (typeof chunk === 'object' && !(chunk instanceof Uint8Array))) return this.json(chunk);
      if (typeof chunk === 'string') { if (!this.get('Content-Type')) this.type('html'); }
      else if (!this.get('Content-Type')) this.type('bin');
      if (this.statusCode === 204 || this.statusCode === 304) { this.removeHeader('Content-Type'); chunk = ''; }
      return this.end(chunk);
    },
    sendFile(path, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      opts = opts || {};
      const full = opts.root ? String(opts.root).replace(/\/$/, '') + '/' + String(path).replace(/^\//, '') : String(path);
      if (!opts.root && !String(path).startsWith('/')) throw new TypeError('path must be absolute or specify root to res.sendFile');
      const st = rt.fileStat(full);
      if (!st || st.dir) {
        const err = new Error(`ENOENT: no such file or directory, stat '${full}'`); err.code = 'ENOENT'; err.status = err.statusCode = 404;
        if (cb) { rt.queueJob(() => cb(err)); return; }
        return req.next(err);
      }
      if (!this.get('Content-Type')) this.setHeader('Content-Type', fileType(full));
      if (!this.get('Accept-Ranges')) this.setHeader('Accept-Ranges', 'bytes');
      if (!this.get('Cache-Control')) this.setHeader('Cache-Control', `public, max-age=${Math.floor(parseBytesMs(opts.maxAge || 0) / 1000)}`);
      if (opts.headers) this.set(opts.headers);
      file = st.key;
      this.end();
      if (cb) rt.queueJob(() => cb());
    },
    download(path, filename, opts, cb) { this.attachment(filename || String(path)); return this.sendFile(path, typeof opts === 'object' ? opts : {}, typeof opts === 'function' ? opts : cb); },
    format(obj) {
      const keys = Object.keys(obj).filter((k) => k !== 'default');
      const pick = req.accepts(keys);
      if (pick) { this.vary('Accept'); this.type(pick); obj[pick](req, this, req.next); }
      else if (obj.default) obj.default(req, this, req.next);
      else { const err = new Error('Not Acceptable'); err.status = err.statusCode = 406; req.next(err); }
      return this;
    },
    render() { throw new Error('res.render is not available: views are not supported in Wasm previews'); },
    writeHead(code, msg, hdrs) {
      this.statusCode = code;
      rt.state.streaming = true;
      const h = typeof msg === 'object' ? msg : hdrs;
      if (Array.isArray(h)) for (let i = 0; i < h.length; i += 2) this.setHeader(h[i], h[i + 1]);
      else if (h) for (const k of Object.keys(h)) this.setHeader(k, h[k]);
      this.headersSent = true;
      return this;
    },
    flushHeaders() { this.headersSent = true; rt.state.streaming = true; },
    write(chunk, encoding, cb) {
      if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
      rt.state.streaming = true;
      if (chunk !== undefined && chunk !== null) chunks.push(typeof chunk === 'string' ? rt.bytesFromString(chunk, encoding) : rt.toBytes(chunk));
      this.headersSent = true;
      if (cb) rt.queueJob(cb);
      return true;
    },
    end(chunk, encoding, cb) {
      if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
      if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
      if (this.writableEnded) return this;
      if (chunk !== undefined && chunk !== null && chunk !== '') this.write(chunk, encoding);
      finish();
      if (cb) rt.queueJob(cb);
      return this;
    },
    on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(fn); return this; },
    once(ev, fn) { return this.on(ev, fn); },
    off(ev, fn) { const l = listeners.get(ev); if (l) listeners.set(ev, l.filter((f) => f !== fn)); return this; },
    removeListener(ev, fn) { return this.off(ev, fn); },
    emit(ev) { emit(ev); return true; },
    setTimeout() { return this; },
    cork() {}, uncork() {},
    get writable() { return !this.writableEnded; },
  };
  function finish() {
    if (res.writableEnded) return;
    res.writableEnded = res.finished = res.writableFinished = true;
    res.headersSent = true;
    const hs = [];
    for (const [, [name, v]] of headers) { if (Array.isArray(v)) for (const x of v) hs.push([name, x]); else hs.push([name, v]); }
    const body = req.method === 'HEAD' ? null : chunks.length === 1 ? chunks[0] : chunks.length ? concatChunks(chunks) : null;
    rt.respond(res.statusCode, hs, body, req.method === 'HEAD' ? null : file);
    rt.queueJob(() => { emit('finish'); emit('close'); });
  }
  res._finish = finish;
  // A static file: the runner sends its bytes; they never enter the instance.
  res._staticFile = (key) => res.sendFile('/app/' + key);
  return res;
}
function concatChunks(list) { let n = 0; for (const c of list) n += c.length; const o = new Uint8Array(n); let i = 0; for (const c of list) { o.set(c, i); i += c.length; } return o; }

// ---------------------------------------------------------------- routers

function flat(fns) { const out = []; for (const f of fns) { if (Array.isArray(f)) out.push(...flat(f)); else out.push(f); } return out; }

function makeRouter(opts) {
  const options = opts || {};
  const stack = [];
  const router = function (req, res, next) { router.handle(req, res, next); };
  router.stack = stack;
  router.params = {};
  router.mergeParams = !!options.mergeParams;
  router.caseSensitive = !!options.caseSensitive;
  router.use = function (path, ...fns) {
    let p = '/';
    if (typeof path === 'function' || Array.isArray(path) && path.length && typeof path[0] === 'function') fns.unshift(path);
    else p = path;
    for (const fn of flat(fns)) {
      if (typeof fn !== 'function') throw new TypeError('Router.use() requires a middleware function but got a ' + typeof fn);
      for (const one of Array.isArray(p) ? p : [p]) {
        const m = compile(one, false, router.caseSensitive);
        stack.push({ kind: 'use', path: one, re: m.re, keys: m.keys, fn });
        if (fn.__isApp) { fn.mountpath = one; fn.parent = router.__app || router; }
      }
    }
    return router;
  };
  router.route = function (path) {
    const m = compile(path, true, router.caseSensitive);
    const route = { path, methods: {}, stack: [] };
    const layer = { kind: 'route', path, re: m.re, keys: m.keys, route };
    stack.push(layer);
    for (const method of METHODS) {
      route[method] = function (...fns) {
        for (const fn of flat(fns)) {
          if (typeof fn !== 'function') throw new Error(`Route.${method}() requires a callback function but got a ${Object.prototype.toString.call(fn)}`);
          route.stack.push({ method: method === 'all' ? null : method.toUpperCase(), fn });
          route.methods[method] = true;
        }
        return route;
      };
    }
    return route;
  };
  for (const method of METHODS) {
    router[method] = function (path, ...fns) { router.route(path)[method](...fns); return router; };
  }
  router.param = function (name, fn) { (router.params[name] = router.params[name] || []).push(fn); return router; };

  router.handle = function (req, res, out) {
    let idx = 0;
    const parentUrl = req.url;
    const parentBase = req.baseUrl;
    const parentParams = req.params;
    let removed = '';
    const restore = () => { req.url = parentUrl; req.baseUrl = parentBase; req.params = parentParams; };
    const next = (err) => {
      if (err === 'route') err = undefined;
      if (err === 'router') { restore(); return out && out(); }
      if (removed) { req.url = parentUrl; req.baseUrl = parentBase; removed = ''; }
      req.params = parentParams;
      if (res.writableEnded) { if (err && !res.__logged) { res.__logged = true; console.error(err); } return; }
      while (idx < stack.length) {
        const layer = stack[idx++];
        const path = req.path;
        const m = layer.re.exec(path);
        if (!m) continue;
        let params;
        try {
          params = router.mergeParams ? Object.assign({}, parentParams) : {};
          layer.keys.forEach((k, i) => { const v = decodeParam(m[i + 1]); if (v !== undefined || !(k.name in params)) params[k.name] = v; });
        } catch (e) { err = err || e; continue; }
        if (layer.kind === 'route') {
          const route = layer.route;
          const method = req.method === 'HEAD' && !route.methods.head ? 'GET' : req.method;
          if (!route.stack.some((s) => s.method === null || s.method === method)) continue;
          req.params = params;
          req.route = route;
          return runParams(req, res, params, err, () => runRoute(req, res, route, method, err, next), next);
        }
        // middleware (use): strip the matched prefix
        const isError = layer.fn.length === 4;
        if (err && !isError) continue;
        if (!err && isError) continue;
        req.params = params;
        const matched = m[0];
        if (matched && matched !== '/') {
          removed = matched.replace(/\/$/, '');
          req.baseUrl = parentBase + removed;
          const rest = parentUrl.slice(removed.length);
          req.url = rest.startsWith('/') ? rest : '/' + rest;
        }
        return call(layer.fn, err, req, res, next);
      }
      restore();
      if (out) return out(err);
    };
    req.next = next;
    next();
  };
  function runParams(req, res, params, err, done, next) {
    const names = Object.keys(params).filter((n) => router.params[n]);
    if (err || !names.length) return done();
    let i = 0;
    const step = (e) => {
      if (e) return next(e);
      if (i >= names.length) return done();
      const name = names[i++];
      let j = 0;
      const fns = router.params[name];
      const inner = (e2) => { if (e2) return next(e2); if (j >= fns.length) return step(); const fn = fns[j++]; try { fn(req, res, inner, params[name], name); } catch (x) { next(x); } };
      inner();
    };
    step();
  }
  function runRoute(req, res, route, method, err, done) {
    let i = 0;
    const next = (e) => {
      if (e === 'route') return done();
      if (e === 'router') return done('router');
      if (e) err = e;
      while (i < route.stack.length) {
        const s = route.stack[i++];
        if (s.method !== null && s.method !== method) continue;
        const isError = s.fn.length === 4;
        if (err && !isError) continue;
        if (!err && isError) continue;
        return call(s.fn, err, req, res, next);
      }
      return done(err);
    };
    next(err);
  }
  function call(fn, err, req, res, next) {
    try {
      const r = err ? fn(err, req, res, next) : fn(req, res, next);
      // Express 4 leaves a rejected promise unhandled (the request hangs, and
      // Node 22 stops the process); here it goes to the error handlers.
      if (r && typeof r.then === 'function') r.then(undefined, (e) => { if (!res.headersSent) next(e); else console.error(e); });
    } catch (e) {
      next(e);
    }
  }
  return router;
}

// ---------------------------------------------------------------- the app

function finalHandler(req, res, err) {
  if (res.headersSent) { if (!res.writableEnded) res._finish(); return; }
  if (err) {
    let status = err.status || err.statusCode;
    if (!(status >= 400 && status < 600)) status = 500;
    if (status >= 500) console.error(err);
    res.statusCode = status;
    res.set('Content-Security-Policy', "default-src 'none'");
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Type', 'text/html');
    // Node's stack starts with "Name: message"; QuickJS's has only the frames.
    const stack = err && err.stack ? (String(err.stack).startsWith(String(err.name)) ? String(err.stack) : `${err.name}: ${err.message}\n${err.stack}`) : String(err);
    const msg = process.env.NODE_ENV === 'production' ? escapeHtml(STATUS[status] || String(status)) : escapeHtml(stack).replace(/\n/g, '<br>').replace(/ {2}/g, ' &nbsp;');
    return res.end(errorPage(msg));
  }
  res.statusCode = 404;
  res.set('Content-Security-Policy', "default-src 'none'");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Type', 'text/html');
  res.end(errorPage(`Cannot ${escapeHtml(req.method)} ${escapeHtml(req.originalUrl.split('?')[0])}`));
}

function createApplication() {
  const router = makeRouter();
  const settings = { env: process.env.NODE_ENV || 'development', 'x-powered-by': true, 'trust proxy': false, 'json spaces': undefined, 'json replacer': undefined, 'query parser': 'extended', 'subdomain offset': 2 };
  const app = function (req, res, next) { app.handle(req, res, next); };
  app.__isApp = true;
  router.__app = app;
  app._router = router;
  app.locals = Object.create(null);
  app.locals.settings = settings;
  app.mountpath = '/';
  app.settings = settings;
  app.set = function (k, v) { if (arguments.length === 1) return settings[k]; settings[k] = v; return app; };
  app.enable = (k) => { settings[k] = true; return app; };
  app.disable = (k) => { settings[k] = false; return app; };
  app.enabled = (k) => !!settings[k];
  app.disabled = (k) => !settings[k];
  app.engine = () => app;
  app.param = (name, fn) => { router.param(name, fn); return app; };
  app.use = (...a) => { router.use(...a); return app; };
  app.route = (p) => router.route(p);
  for (const m of METHODS) {
    app[m] = function (path, ...fns) {
      if (m === 'get' && arguments.length === 1 && typeof path === 'string') return settings[path];
      router[m](path, ...fns);
      return app;
    };
  }
  app.del = app.delete;
  app.handle = (req, res, out) => {
    if (app.parent) {
      // Mounted under another app: its own settings, the same request.
      req.app = app; res.app = app;
    }
    router.handle(req, res, out || ((err) => finalHandler(req, res, err)));
  };
  app.listen = function (...args) {
    rt.serveWith(app);
    const cb = args.find((a) => typeof a === 'function');
    const server = makeServer(app);
    if (cb) rt.queueJob(() => cb.call(server));
    return server;
  };
  app.path = () => app.mountpath === '/' ? '' : app.mountpath;
  app.__dispatch = (q, body) => {
    const req = makeRequest(app, q, body);
    const res = makeResponse(app, req);
    req.res = res; res.req = req;
    if (settings['x-powered-by']) res.setHeader('X-Powered-By', 'Express');
    app.handle(req, res);
    app.__current = res;
  };
  // The request ended with headers written but never ended (an event stream): send what was written.
  app.__unfinished = () => { const res = app.__current; if (res && res.headersSent && !res.writableEnded) res._finish(); };
  rt.registerApp(app);
  return app;
}

function makeServer(app) {
  const server = {
    keepAliveTimeout: 5000,
    headersTimeout: 60000,
    requestTimeout: 300000,
    timeout: 0,
    maxHeadersCount: null,
    listening: true,
    listen(...a) { const cb = a.find((x) => typeof x === 'function'); if (cb) rt.queueJob(() => cb.call(server)); return server; },
    close(cb) { server.listening = false; if (cb) rt.queueJob(() => cb()); return server; },
    closeIdleConnections() {},
    closeAllConnections() {},
    address() { return { address: '::', family: 'IPv6', port: Number(process.env.PORT || 3000) }; },
    on() { return server; }, once() { return server; }, off() { return server; }, emit() { return false; },
    setTimeout() { return server; },
    ref() { return server; }, unref() { return server; },
    getConnections(cb) { if (cb) cb(null, 0); },
  };
  server.__app = app;
  return server;
}

// ---------------------------------------------------------------- body parsers and static files

function parseBytes(v) {
  if (typeof v === 'number') return v;
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(String(v || '100kb'));
  if (!m) return 102400;
  return Math.floor(Number(m[1]) * { b: 1, kb: 1024, mb: 1048576, gb: 1073741824 }[(m[2] || 'b').toLowerCase()]);
}
function bodyParser(kind, defaults, parse) {
  return function (options) {
    const o = Object.assign({}, defaults, options || {});
    const limit = parseBytes(o.limit);
    const types = [].concat(o.type);
    return function bodyParserMiddleware(req, _res, next) {
      if (req._bodyParsed) return next();
      req.body = req.body || {};
      if (!req._body.length && !req.headers['transfer-encoding'] && !req.headers['content-length']) return next();
      const match = types.some((t) => typeof t === 'function' ? t(req) : typeIs(req, [t]));
      if (!match) return next();
      if (req._body.length > limit) { const e = new Error('request entity too large'); e.status = e.statusCode = 413; e.type = 'entity.too.large'; return next(e); }
      req._bodyParsed = true;
      try { req.body = parse(req._body, o, req); } catch (e) { e.status = e.statusCode = e.status || 400; e.type = e.type || 'entity.parse.failed'; e.body = rt.decoder.decode(req._body); return next(e); }
      next();
    };
  };
}
const json = bodyParser('json', { type: 'application/json', limit: '100kb', strict: true }, (b, o) => {
  const text = rt.decoder.decode(b);
  if (!text) return {};
  if (o.strict !== false && !/^[\s﻿ ]*[[{]/.test(text)) {
    const first = text.trim().charAt(0);
    const e = new SyntaxError(`Unexpected token ${first} in JSON at position 0`); throw e;
  }
  return JSON.parse(text, o.reviver);
});
const urlencoded = bodyParser('urlencoded', { type: 'application/x-www-form-urlencoded', limit: '100kb', extended: true }, (b) => parseQuery(rt.decoder.decode(b)));
const text = bodyParser('text', { type: 'text/plain', limit: '100kb' }, (b) => rt.decoder.decode(b));
const raw = bodyParser('raw', { type: 'application/octet-stream', limit: '100kb' }, (b) => Buffer._wrap(b));

function serveStatic(root, options) {
  const o = Object.assign({ index: 'index.html', redirect: true, fallthrough: true, dotfiles: 'ignore', maxAge: 0 }, options || {});
  const base = String(root).replace(/\/+$/, '');
  const indexes = o.index === false ? [] : [].concat(o.index);
  return function serveStaticMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return o.fallthrough ? next() : (res.set('Allow', 'GET, HEAD'), res.status(405).end());
    let path;
    try { path = decodeURIComponent(req.path); } catch (_) { return next(); }
    if (path.split('/').some((s) => s.startsWith('.') && s !== '.' && s !== '..') && o.dotfiles !== 'allow') return next();
    if (path.includes('\0')) return next();
    const full = base + (path.startsWith('/') ? path : '/' + path);
    const bk = rt.fileKey(base);
    const fk = rt.fileKey(full);
    if (fk === null || bk === null || (bk !== '' && fk !== bk && !fk.startsWith(bk + '/'))) return next();
    let st = rt.fileStat(full);
    if (st && st.dir) {
      if (!path.endsWith('/')) {
        if (o.redirect && indexes.length) { res.statusCode = 301; res.set('Location', req.originalUrl.replace(/^([^?]*)/, '$1/')); res.set('Content-Type', 'text/html'); return res.end(errorPage(`Redirecting to ${escapeHtml(req.originalUrl.split('?')[0] + '/')}`)); }
        return next();
      }
      st = null;
      for (const ix of indexes) { const s = rt.fileStat(full.replace(/\/?$/, '/') + ix); if (s && !s.dir) { st = s; break; } }
      if (!st) return next();
    }
    if (!st) return next();
    res.setHeader('Accept-Ranges', 'bytes');
    if (!res.get('Cache-Control')) res.setHeader('Cache-Control', `public, max-age=${Math.floor(parseBytesMs(o.maxAge) / 1000)}${o.immutable ? ', immutable' : ''}`);
    res.setHeader('Content-Type', fileType(st.key));
    if (typeof o.setHeaders === 'function') o.setHeaders(res, '/app/' + st.key, { size: st.size, isFile: () => true, isDirectory: () => false, mtime: new Date(0) });
    res._staticFile(st.key);
  };
}
function parseBytesMs(v) { if (typeof v === 'number') return v; const m = /^(\d+)\s*(ms|s|m|h|d|y)?$/.exec(String(v)); if (!m) return 0; return Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, y: 31536000000 }[m[2] || 'ms']; }

function express() { return createApplication(); }
express.json = json;
express.urlencoded = urlencoded;
express.text = text;
express.raw = raw;
express.static = serveStatic;
express.Router = (opts) => makeRouter(opts);
express.application = {};
express.request = {};
express.response = {};
express.query = () => (req, _res, next) => next();
express.__lookup = lookup;
express.__compile = compile;
express.__parseQuery = parseQuery;
express.__statusText = STATUS;
module.exports = express;
module.exports.default = express;
