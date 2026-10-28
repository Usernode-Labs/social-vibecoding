'use strict';

// Waiting for the event, not a fixed number of milliseconds.
//
// A Postgres suite that sleeps "long enough" is a suite that fails on a busy
// machine and passes on a race it meant to catch. `waitFor` polls a condition
// until it holds and then fails with a message saying what never happened.
// This module owns the only timers in that pattern; that is why the guard in
// tests/postgres-fixed-waits.test.js does not scan it.

const { AssertionError } = require('node:assert');

async function waitFor(check, { label, timeoutMs = 5000, everyMs = 10, detail } = {}) {
  if (typeof label !== 'string' || !label) throw new Error('waitFor needs a label saying what it waits for');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) {
      let extra = '';
      if (typeof detail === 'function') {
        try { extra = await detail(); } catch { /* the detail is a courtesy, not the failure */ }
      }
      throw new AssertionError({ message: `timed out after ${timeoutMs} ms waiting for ${label}${extra ? ` (${extra})` : ''}` });
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

async function within(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new AssertionError({ message: `${label} did not settle within ${ms} ms` })), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

module.exports = { waitFor, within, deferred };
