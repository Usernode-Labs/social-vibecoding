'use strict';
// url: the WHATWG URL classes (from the runtime) and the legacy helpers apps still use.
const rt = require('../runtime.js');

function parse(s, parseQuery) {
  const str = String(s);
  let u;
  try { u = new rt.URL(str); } catch (_) { u = new rt.URL(str, 'http://relative.invalid'); u._rel = true; }
  const q = u.search ? u.search.slice(1) : null;
  return {
    protocol: u._rel ? null : u.protocol, slashes: !u._rel, auth: u.username ? u.username + (u.password ? ':' + u.password : '') : null,
    host: u._rel ? null : u.host, port: u._rel ? null : u.port || null, hostname: u._rel ? null : u.hostname,
    hash: u.hash || null, search: u.search || null, query: parseQuery ? Object.fromEntries(new rt.URLSearchParams(q || '')) : q,
    pathname: u.pathname, path: u.pathname + (u.search || ''), href: u._rel ? str : u.href,
  };
}
function format(o) {
  if (o instanceof rt.URL) return o.href;
  if (typeof o === 'string') return o;
  const proto = o.protocol ? o.protocol.replace(/:?$/, ':') : '';
  const host = o.host || (o.hostname ? o.hostname + (o.port ? ':' + o.port : '') : '');
  let search = o.search || '';
  if (!search && o.query && typeof o.query === 'object') { const s = new rt.URLSearchParams(o.query).toString(); search = s ? '?' + s : ''; }
  return proto + (host || o.slashes ? '//' : '') + host + (o.pathname || '') + search + (o.hash || '');
}
module.exports = {
  URL: rt.URL,
  URLSearchParams: rt.URLSearchParams,
  parse,
  format,
  resolve: (from, to) => new rt.URL(to, new rt.URL(from, 'resolve://')).href.replace(/^resolve:\/\//, ''),
  fileURLToPath: (u) => decodeURIComponent(String(u instanceof rt.URL ? u.pathname : String(u).replace(/^file:\/\//, ''))),
  pathToFileURL: (p) => new rt.URL('file://' + String(p)),
  domainToASCII: (d) => String(d).toLowerCase(),
};
module.exports.default = module.exports;
