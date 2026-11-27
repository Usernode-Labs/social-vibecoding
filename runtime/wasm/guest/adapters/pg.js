'use strict';
// node-postgres (pg 8) over the data service. A Pool's queries go out on any
// connection, and queries started together go as one batch; a client from
// pool.connect() (or a Client) holds one connection until it is released,
// which is what a transaction needs. Values come back as node-pg gives them
// (int8 and numeric as strings, timestamps and dates as Date, json parsed,
// bytea as Buffer, arrays as arrays). The connection string is ignored: the
// runner's pass names the database.

const rt = require('../runtime.js');

function noop() {}
class Emitter {
  constructor() { this._l = new Map(); }
  on(ev, fn) { if (!this._l.has(ev)) this._l.set(ev, []); this._l.get(ev).push(fn); return this; }
  once(ev, fn) { return this.on(ev, fn); }
  off(ev, fn) { const l = this._l.get(ev); if (l) this._l.set(ev, l.filter((f) => f !== fn)); return this; }
  removeListener(ev, fn) { return this.off(ev, fn); }
  removeAllListeners() { this._l.clear(); return this; }
  emit(ev, ...a) { for (const fn of this._l.get(ev) || []) fn(...a); return true; }
}

// query(text, values?, callback?) or query({ text, values, rowMode }, callback?)
function args(text, values, cb) {
  let q = text;
  if (typeof values === 'function') { cb = values; values = undefined; }
  if (q && typeof q === 'object') {
    if (typeof q.submit === 'function') throw new Error('Custom query objects (pg-cursor, pg-query-stream) are not available');
    return { text: q.text, values: values || q.values, rowMode: q.rowMode, cb };
  }
  return { text: q, values, rowMode: undefined, cb };
}
function withCallback(p, cb) {
  if (!cb) return p;
  p.then((r) => cb(null, r), (e) => cb(e));
  return undefined;
}

class Client extends Emitter {
  constructor(config) {
    super();
    this.connectionParameters = config || {};
    this._id = 0;
    this._released = false;
    this._ended = false;
    this.database = 'app';
    this.user = 'app';
    this.port = 5432;
    this.host = 'data-service';
    this.ssl = false;
  }
  connect(cb) {
    if (!this._id) this._id = rt.nextClientId();
    return withCallback(Promise.resolve(), cb);
  }
  query(text, values, cb) {
    const a = args(text, values, cb);
    if (!this._id) this._id = rt.nextClientId();
    if (this._released || this._ended) return withCallback(Promise.reject(new Error('Client was closed and is not queryable')), a.cb);
    return withCallback(rt.query(this._id, a.text, a.values, a.rowMode), a.cb);
  }
  release(err) {
    if (this._released) throw new Error('Release called on client which has already been released to the pool.');
    this._released = true;
    if (this._id) rt.releaseClient(this._id).catch(noop);
    if (this._pool) this._pool._out--;
    void err;
  }
  end(cb) {
    if (!this._ended && this._id && !this._released) rt.releaseClient(this._id).catch(noop);
    this._ended = true;
    return withCallback(Promise.resolve(), cb);
  }
  escapeIdentifier(s) { return escapeIdentifier(s); }
  escapeLiteral(s) { return escapeLiteral(s); }
  setTypeParser(oid, fmt, fn) { types.setTypeParser(oid, fmt, fn); }
  getTypeParser(oid) { return types.getTypeParser(oid); }
  get processID() { return 0; }
}

class Pool extends Emitter {
  constructor(options) {
    super();
    this.options = Object.assign({ max: 10, idleTimeoutMillis: 10000 }, options || {});
    this._out = 0;
    this.ending = false;
    this.ended = false;
  }
  get totalCount() { return this._out; }
  get idleCount() { return 0; }
  get waitingCount() { return 0; }
  get expiredCount() { return 0; }
  query(text, values, cb) {
    const a = args(text, values, cb);
    return withCallback(rt.query(0, a.text, a.values, a.rowMode), a.cb);
  }
  connect(cb) {
    const client = new Client(this.options);
    client._pool = this;
    client._id = rt.nextClientId();
    this._out++;
    const p = Promise.resolve(client);
    if (!cb) return p;
    p.then((c) => cb(null, c, (err) => c.release(err)), (e) => cb(e));
    return undefined;
  }
  end(cb) { this.ending = true; this.ended = true; return withCallback(Promise.resolve(), cb); }
}

function escapeIdentifier(str) { return '"' + String(str).replace(/"/g, '""') + '"'; }
function escapeLiteral(str) {
  let hasBackslash = false;
  let escaped = "'";
  for (const c of String(str)) {
    if (c === "'") escaped += "''";
    else if (c === '\\') { escaped += '\\\\'; hasBackslash = true; } else escaped += c;
  }
  escaped += "'";
  return hasBackslash ? ' E' + escaped : escaped;
}

const builtins = {
  BOOL: 16, BYTEA: 17, CHAR: 18, INT8: 20, INT2: 21, INT4: 23, REGPROC: 24, TEXT: 25, OID: 26, TID: 27, XID: 28, CID: 29,
  JSON: 114, XML: 142, PG_NODE_TREE: 194, SMGR: 210, PATH: 602, POLYGON: 604, CIDR: 650, FLOAT4: 700, FLOAT8: 701,
  ABSTIME: 702, RELTIME: 703, TINTERVAL: 704, CIRCLE: 718, MACADDR8: 774, MONEY: 790, MACADDR: 829, INET: 869,
  ACLITEM: 1033, BPCHAR: 1042, VARCHAR: 1043, DATE: 1082, TIME: 1083, TIMESTAMP: 1114, TIMESTAMPTZ: 1184, INTERVAL: 1186,
  TIMETZ: 1266, BIT: 1560, VARBIT: 1562, NUMERIC: 1700, REFCURSOR: 1790, REGPROCEDURE: 2202, REGOPER: 2203,
  REGOPERATOR: 2204, REGCLASS: 2205, REGTYPE: 2206, UUID: 2950, TXID_SNAPSHOT: 2970, PG_LSN: 3220, PG_NDISTINCT: 3361,
  PG_DEPENDENCIES: 3402, TSVECTOR: 3614, TSQUERY: 3615, GTSVECTOR: 3642, REGCONFIG: 3734, REGDICTIONARY: 3769,
  JSONB: 3802, REGNAMESPACE: 4089, REGROLE: 4096,
};
const types = {
  builtins,
  setTypeParser(oid, fmt, fn) { rt.customParsers.set(Number(oid), typeof fmt === 'function' ? fmt : fn); },
  getTypeParser(oid) { return rt.customParsers.get(Number(oid)) || ((v) => v); },
  arrayParser: { create: () => ({ parse: () => [] }) },
};

class DatabaseError extends Error {}

const defaults = { host: 'localhost', user: 'app', database: 'app', password: null, port: 5432, rows: 0, binary: false, max: 10, idleTimeoutMillis: 30000, client_encoding: '', ssl: false, application_name: undefined, parseInputDatesAsUTC: false };

module.exports = { Pool, Client, types, defaults, escapeIdentifier, escapeLiteral, DatabaseError, native: null, Query: class Query {} };
module.exports.default = module.exports;
