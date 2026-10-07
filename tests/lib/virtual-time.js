'use strict';

// Run code that waits on timers without waiting for them.
//
// Several suites drive real product code whose behaviour IS its timing: a
// retry backoff, a poll loop, a settle window, a deadline. Run on the real
// clock they spend most of their time asleep (31 s for one of them). node:test
// can mock the timers, but something still has to move the mocked clock, and
// moving it in one jump is wrong for code that chains waits: the continuation
// after the first `await sleep()` only runs once the jump is over, so every
// later wait starts late and elapsed time stops meaning anything.
//
// `inVirtualTime` moves it one millisecond at a time and lets the event loop
// turn between steps, so each timer fires at its own moment, the code it wakes
// runs before the clock moves again, and anything that reads the clock sees
// the time it would have seen. A deadline of 25 s still loses to a wait of
// 60 s and still beats one of 20 s; it just takes microseconds to find out.
//
// The mocked clock starts at the real time and runs ahead of it from there,
// so a timestamp taken before stays in the past. Elapsed time is only
// meaningful between two readings taken inside `start`: once this returns,
// `Date.now()` is the real clock again, which the virtual one has overtaken.
//
// It suits code whose waits are all timers and promises. It does NOT suit
// code that also waits on real I/O (a socket, a child process, a file): the
// mocked clock runs far ahead of the wire, so a timeout would beat a response
// that is on time. Keep those on the real clock.

/**
 * Run `start()` to completion with `setTimeout`, `setInterval` and `Date`
 * mocked, advancing the mocked clock `stepMs` at a time. Returns what `start`
 * resolves to, or throws what it rejects with. The timers are real again when
 * this returns.
 *
 * `apis` is what node:test mocks, for code that must keep one of the three
 * real. `maxMs` bounds the virtual time spent, so code that never settles
 * fails here and says so.
 */
async function inVirtualTime(t, start, { apis = ['setTimeout', 'setInterval', 'Date'], stepMs = 1, maxMs = 30 * 60 * 1000 } = {}) {
  t.mock.timers.enable(apis.includes('Date') ? { apis, now: Date.now() } : { apis });
  try {
    let settled = false;
    let value;
    let failure = null;
    Promise.resolve().then(start).then(
      (result) => { settled = true; value = result; },
      (err) => { settled = true; failure = err; },
    );
    for (let elapsed = 0; ; elapsed += stepMs) {
      // setImmediate is deliberately left real: one full turn of the event
      // loop, so every promise continuation the last step woke has run.
      await new Promise((resolve) => setImmediate(resolve));
      if (settled) break;
      if (elapsed >= maxMs) throw new Error(`still waiting after ${maxMs}ms of virtual time`);
      t.mock.timers.tick(stepMs);
    }
    if (failure) throw failure;
    return value;
  } finally {
    t.mock.timers.reset();
  }
}

module.exports = { inVirtualTime };
