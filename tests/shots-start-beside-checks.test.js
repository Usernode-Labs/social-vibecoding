'use strict';

// The before & after shots start once the preview is up, beside the checks,
// instead of after the whole suite (the first production run of the shots
// agent waited ~3m45s for checks it never reads). The preview machine tells
// the shots machine the head is ready in the transition that publishes the
// preview (src/workflow/preview/machine.ts), and again when the verdict
// settles; the shots machine waits for the proposal's agent itself
// (src/workflow/shots/: waiting_for_agent), so nothing needs to start them a
// second time once a turn has let go of the session.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('the preview machine tells the shots machine its head the moment the preview serves, beside its checks run', () => {
  const machine = read('src/workflow/preview/machine.ts');
  const published = machine.slice(machine.indexOf("return told(startRun({ name: 'preparing', data: d }, d0.trigger, ctx, {"));
  assert.ok(published.length > 0, 'the publish that makes the preview serve starts the checks run');
  assert.match(published.slice(0, 600), /toShots\(d, 'HeadReady', \{ head: served\.head \}\)/);
  assert.doesNotMatch(machine, /\{ kind: WORK\.ready, key:/, 'no hand-off work starts the shots any more');
});

test('a verdict, a skip and a deferral each tell it again for their head: one message is enough', () => {
  const machine = read('src/workflow/preview/machine.ts');
  const told = machine.match(/toShots\(d, 'HeadReady'/g) || [];
  assert.ok(told.length >= 4, 'served, skipped, deferred, settled');
  // The follow-ups item no longer schedules shots (an older release's item
  // hands its head over in its result).
  const services = read('src/workflow/preview/services.ts');
  assert.doesNotMatch(services, /scheduleForSession|startShotsIfIdle|noteNotStarted/);
});

test('the shots machine waits for the proposal\'s agent itself, on its own clock', () => {
  const machine = read('src/workflow/shots/machine.ts');
  assert.match(machine, /if \(f\.session\?\.agentBusy\) \{/);
  assert.match(machine, /timer: clockFor\(ctx, AGENT_RECHECK_MS, 'Recheck', r\.id, 'wait'\)/);
  // No sweep looks for runs to start or retry.
  const server = read('server.js');
  assert.doesNotMatch(server, /shots-retry-interrupted|shots-recover-unstarted|shots-recover-interrupted/);
});
