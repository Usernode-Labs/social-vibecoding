'use strict';
// util: format, inspect, promisify and the small type checks.
const rt = require('../runtime.js');

function promisify(fn) {
  if (typeof fn !== 'function') throw new TypeError('The "original" argument must be of type Function');
  if (fn[promisify.custom]) return fn[promisify.custom];
  return function (...a) { return new Promise((resolve, reject) => fn.call(this, ...a, (err, v) => (err ? reject(err) : resolve(v)))); };
}
promisify.custom = Symbol.for('nodejs.util.promisify.custom');
const types = {
  isDate: (v) => v instanceof Date, isRegExp: (v) => v instanceof RegExp, isPromise: (v) => !!v && typeof v.then === 'function',
  isNativeError: (v) => v instanceof Error, isUint8Array: (v) => v instanceof Uint8Array, isMap: (v) => v instanceof Map, isSet: (v) => v instanceof Set,
};
function isDeepStrictEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
const inspect = (v) => rt.inspect(v);
inspect.custom = Symbol.for('nodejs.util.inspect.custom');
module.exports = {
  format: rt.format,
  formatWithOptions: (_o, ...a) => rt.format(...a),
  inspect,
  promisify,
  callbackify: (fn) => (...a) => { const cb = a.pop(); fn(...a).then((v) => cb(null, v), (e) => cb(e)); },
  deprecate: (fn) => fn,
  inherits: (c, p) => { Object.setPrototypeOf(c.prototype, p.prototype); Object.setPrototypeOf(c, p); c.super_ = p; },
  isDeepStrictEqual,
  types,
  isArray: Array.isArray,
  TextEncoder,
  TextDecoder,
  debuglog: () => () => {},
};
module.exports.default = module.exports;
