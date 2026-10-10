'use strict';

// A clock that reads FAKE_NOW instead of the wall, for tests/clock-sweep.
//
// On Saturday 10 October 2026 two tests began to fail on main, paused every
// merge for two hours, and passed again on Monday without a line changing:
// they expected a challenge card's "time left" to count to the card's own
// end, and on a weekend the code shows the end of the week instead (#4648).
// Nothing ran them on a weekend before they merged. This preload lets the
// sweep run a test file at any instant: loaded with `--require` and FAKE_NOW
// set to an ISO time, `Date.now()` and `new Date()` start there and keep
// ticking at the real rate, so timeouts and durations still behave.
//
// Two places a test can reach a clock from:
//
//   * the process's own `Date`, replaced here;
//   * a `node:vm` context. Browser modules are loaded into one, and each
//     context has its own `Date` from its own realm, which a preload cannot
//     reach. So the context functions hand every new context this `Date`,
//     unless the test put its own `Date` on the sandbox.
//
// Without FAKE_NOW this file does nothing.

const vm = require('node:vm');

function install(iso) {
  const RealDate = Date;
  const target = RealDate.parse(iso);
  if (!Number.isFinite(target)) throw new Error(`FAKE_NOW is not a date: ${iso}`);
  const offset = target - RealDate.now();
  const now = () => RealDate.now() + offset;

  function FakeDate(...args) {
    if (!new.target) return new RealDate(now()).toString();
    return Reflect.construct(RealDate, args.length ? args : [now()], new.target);
  }
  // Date.UTC and Date.parse come from the real one; instances are real Dates.
  Object.setPrototypeOf(FakeDate, RealDate);
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = now;
  Object.defineProperty(FakeDate, 'name', { value: 'Date' });
  globalThis.Date = FakeDate;

  const withClock = (sandbox) => {
    const target = sandbox === undefined ? {} : sandbox;
    if (target && typeof target === 'object' && !Object.prototype.hasOwnProperty.call(target, 'Date')
        && !vm.isContext(target)) {
      try { target.Date = FakeDate; } catch { /* a frozen sandbox keeps its realm's clock */ }
    }
    return target;
  };
  const createContext = vm.createContext;
  vm.createContext = function fakeClockCreateContext(sandbox, ...rest) {
    return createContext.call(this, withClock(sandbox), ...rest);
  };
  const runInNewContext = vm.runInNewContext;
  vm.runInNewContext = function fakeClockRunInNewContext(code, sandbox, ...rest) {
    return runInNewContext.call(this, code, withClock(sandbox), ...rest);
  };
  const scriptRunInNewContext = vm.Script.prototype.runInNewContext;
  vm.Script.prototype.runInNewContext = function fakeClockScriptRunInNewContext(sandbox, ...rest) {
    return scriptRunInNewContext.call(this, withClock(sandbox), ...rest);
  };
  return { offset };
}

if (process.env.FAKE_NOW) install(process.env.FAKE_NOW);

module.exports = { install };
