'use strict';
// Small Node modules: buffer, timers, timers/promises, process, os, assert, string_decoder, fs/promises.
const rt = require('../runtime.js');
const later = (ms, v) => new Promise((resolve) => setTimeout(() => resolve(v), ms));
function assert(ok, msg) { if (!ok) { const e = new Error(msg || 'Assertion failed'); e.code = 'ERR_ASSERTION'; throw e; } }
assert.ok = assert;
assert.equal = (a, b, m) => assert(a == b, m || `${a} == ${b}`); // eslint-disable-line eqeqeq
assert.strictEqual = (a, b, m) => assert(a === b, m || `${a} === ${b}`);
assert.notStrictEqual = (a, b, m) => assert(a !== b, m || `${a} !== ${b}`);
assert.deepStrictEqual = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), m || 'values are not deeply equal');
assert.deepEqual = assert.deepStrictEqual;
assert.fail = (m) => assert(false, m || 'Failed');
assert.throws = (fn, _e, m) => { let threw = false; try { fn(); } catch (_) { threw = true; } assert(threw, m || 'Missing expected exception'); };
assert.strict = assert;
module.exports = {
  buffer: { Buffer: rt.Buffer, constants: { MAX_LENGTH: 2 ** 31 - 1 }, kMaxLength: 2 ** 31 - 1 },
  timers: { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate },
  timersPromises: { setTimeout: (ms, v) => later(ms, v), setImmediate: (v) => later(0, v), scheduler: { wait: (ms) => later(ms) } },
  process: globalThis.process,
  os: {
    EOL: '\n', platform: () => 'linux', type: () => 'Linux', arch: () => 'wasm32', release: () => '0', hostname: () => 'wasm',
    homedir: () => '/app', tmpdir: () => '/tmp', cpus: () => [{ model: 'wasm', speed: 0 }], totalmem: () => 0, freemem: () => 0,
    uptime: () => 0, loadavg: () => [0, 0, 0], networkInterfaces: () => ({}), userInfo: () => ({ username: 'app', uid: 1000, gid: 1000, shell: null, homedir: '/app' }),
    endianness: () => 'LE', availableParallelism: () => 1,
  },
  assert,
  stringDecoder: { StringDecoder: class StringDecoder { constructor(e) { this.e = e || 'utf8'; } write(b) { return rt.Buffer.from(b).toString(this.e); } end(b) { return b ? this.write(b) : ''; } } },
};
