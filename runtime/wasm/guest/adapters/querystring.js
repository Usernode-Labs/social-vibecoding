'use strict';
// querystring: parse and stringify.
const rt = require('../runtime.js');
function parse(s, sep, eq) {
  const out = {};
  for (const kv of String(s || '').split(sep || '&')) {
    if (!kv) continue;
    const i = kv.indexOf(eq || '=');
    const d = (x) => { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch (_) { return x; } };
    const k = d(i < 0 ? kv : kv.slice(0, i)); const v = i < 0 ? '' : d(kv.slice(i + 1));
    if (Object.prototype.hasOwnProperty.call(out, k)) out[k] = [].concat(out[k], v); else out[k] = v;
  }
  return out;
}
function stringify(o, sep, eq) {
  return Object.keys(o || {}).map((k) => [].concat(o[k]).map((v) => encodeURIComponent(k) + (eq || '=') + encodeURIComponent(v == null ? '' : v)).join(sep || '&')).filter(Boolean).join(sep || '&');
}
module.exports = { parse, stringify, decode: parse, encode: stringify, escape: encodeURIComponent, unescape: decodeURIComponent };
void rt;
