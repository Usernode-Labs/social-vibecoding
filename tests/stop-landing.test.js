'use strict';

// A stop that landed: what the run had already committed, as data.
//
// When somebody stops a turn the platform recovered after a restart
// (services/turn-recovery.js), the run may already have committed to the
// change's branch. Saying only "Stopped." would leave the branch silently
// moved, and re-sending the same request would buy a duplicate run. So the
// stop says it twice: once as the sentence ("Stopped by @evan, but it had
// already committed 2 changes to the branch (7c41ab90, pushed)"), which every
// plain-text surface shows, and once as data, `stopLanding`
// (routes/sessions.js stopLandingMeta), persisted on the change's event log
// and emitted with the status, so a reader can draw the facts without
// parsing prose.
//
// The dev chat drew that data as chips on a neutral "stopped" card (#937's
// stop pair); the chat is retired. What this pins is the server half.
//
// Run with: node --test tests/stop-landing.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
// With what a turn's recovery runs, moved out of server.js unchanged
// (services/turn-recovery.js).
const SERVER = read('server.js') + read('src/services/turn-recovery.js');

test('stopLandingMeta is the sentence\'s facts, as data', () => {
  const { stopLandingMeta } = require('../src/routes/sessions');

  // Nothing landed: no sha, so no count and no push claim.
  assert.deepEqual(
    stopLandingMeta({ headline: 'Scout stopped' }),
    { headline: 'Scout stopped', commits: 0, sha: null, pushOk: false },
  );
  // A sha with ahead: 0 is "nothing landed", the same reading
  // describeStoppedLanding has always had, so the two cannot disagree.
  assert.equal(stopLandingMeta({ headline: 'x', sha: 'deadbeefcafe', ahead: 0 }).sha, null);

  // A count, and the sha short.
  assert.deepEqual(
    stopLandingMeta({ headline: 'Claude Code stopped', sha: '7c41ab90de', ahead: 2, pushOk: true }),
    { headline: 'Claude Code stopped', commits: 2, sha: '7c41ab90', pushOk: true },
  );

  // `ahead: null` is the RECOVERED path: durable tail milestones carry a sha
  // and a push flag but no commit COUNT. It must survive as null rather than
  // collapse to a number nobody measured.
  const countless = stopLandingMeta({ headline: 'Stopped', sha: 'deadbeefcafe', ahead: null, pushOk: false });
  assert.equal(countless.commits, null);
  assert.equal(countless.sha, 'deadbeef');
});

test('a recovered stop ships the sentence and the landing, persisted and emitted', () => {
  // The sentence still ships: the data is a second channel, not a
  // replacement for the prose a notification or an export shows.
  assert.match(SERVER, /const text = `Stopped\$\{by \? ` by @\$\{by\}` : ''\}\$\{landed\}\.`;/);
  assert.match(SERVER, /const stopLanding = stopLandingMeta\(\{/);
  // Persisted AND emitted, or a reload and a live turn would disagree.
  assert.match(SERVER, /recovered: true, stopped: true, stopLanding,/);
  assert.match(SERVER, /emit\('status', \{ text, stopLanding \}\)/);
});
