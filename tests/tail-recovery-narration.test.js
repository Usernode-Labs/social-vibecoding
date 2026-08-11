// What the user is TOLD when a turn's tail is interrupted.
//
// Three surfaces, one rule: never ask someone to redo work that already
// landed, and never leave a minutes-long repair silent.
//
//   1. server.js adoption — the tail-aware branches. A running container
//      with a held record resumes; a DEAD container with a held record
//      whose commit was pushed reports what landed and heals the preview,
//      instead of "That coding turn didn't finish — send your request
//      again" (which is what sent session 2954's owner into a duplicate
//      10-minute build).
//   2. staging-recovery — a background rebuild announces itself BEFORE it
//      starts. Cloning the self-app database alone is ~4:45, and until now
//      this path posted nothing until it succeeded.
//   3. recovery-pills — the new wording, and its own matcher (the boot
//      backfill has to recognise a row it wrote without knowing which PR
//      number shaped it).
//
// Run with: node --test tests/tail-recovery-narration.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const recoveryPills = require('../src/services/recovery-pills');

// ── 1. The breadcrumb wording ───────────────────────────────────────────

test('buildCodeLandedBreadcrumb reports what landed and never asks for a resend', () => {
  const withPr = recoveryPills.buildCodeLandedBreadcrumb({ prNumber: 922 });
  assert.equal(withPr, 'Your changes are committed and pushed to PR #922 — rebuilding the preview now.');
  // The whole point: no "send your request again".
  assert.ok(!/again/i.test(withPr));
  // #896: a platform restart is plumbing the user can't act on — it stays
  // out of the text and lives in metadata.recovered / the logs.
  assert.ok(!/restart|platform|deploy/i.test(withPr));

  // A tail can die after the push but before the PR exists; naming a PR
  // that isn't there would be worse than staying vague.
  const noPr = recoveryPills.buildCodeLandedBreadcrumb({});
  assert.equal(noPr, 'Your changes are committed and pushed to your branch — rebuilding the preview now.');

  // Only promise a rebuild when one is actually starting (the watchdog
  // reap doesn't start one — the heal sweep owns that, on its own clock).
  const notRebuilding = recoveryPills.buildCodeLandedBreadcrumb({ prNumber: 7, rebuildingPreview: false });
  assert.equal(notRebuilding, 'Your changes are committed and pushed to PR #7.');
  assert.ok(!/rebuilding/.test(notRebuilding));
});

test('isCodeLandedBreadcrumb recognises every wording the builder produces', () => {
  for (const opts of [
    { prNumber: 922 }, { prNumber: 1 }, {},
    { prNumber: 922, rebuildingPreview: false }, { rebuildingPreview: false },
  ]) {
    const text = recoveryPills.buildCodeLandedBreadcrumb(opts);
    assert.ok(recoveryPills.isCodeLandedBreadcrumb(text),
      `must match its own output: ${text}`);
  }
  // And nothing else — an over-broad matcher would make the boot backfill
  // treat an unrelated row as its own and skip a needed breadcrumb.
  assert.equal(recoveryPills.isCodeLandedBreadcrumb(recoveryPills.TURN_UNFINISHED_BREADCRUMB), false);
  assert.equal(recoveryPills.isCodeLandedBreadcrumb(recoveryPills.UNANSWERED_BREADCRUMB), false);
  assert.equal(recoveryPills.isCodeLandedBreadcrumb('Building staging preview...'), false);
  assert.equal(recoveryPills.isCodeLandedBreadcrumb(null), false);
  assert.equal(recoveryPills.isCodeLandedBreadcrumb(undefined), false);
});

test('the code-landed row pairs with code_done pills, which stay sanitizer-clean', () => {
  const pills = recoveryPills.buildRecoveryQuickReplies('code_done');
  assert.deepEqual(pills, ['Propose it to the group', 'Make a tweak', 'What did it change?']);
  // Same contract every set in this module satisfies: <= 3 entries,
  // <= 80 chars, no dupes (routes/sessions.js sanitizeQuickReplies).
  assert.ok(pills.length <= recoveryPills.QR_MAX_REPLIES);
  for (const p of pills) assert.ok(p.length <= recoveryPills.QR_MAX_REPLY_LEN);
  assert.equal(new Set(pills.map((p) => p.toLowerCase())).size, pills.length);
  // "Try that again" belongs to the unrecoverable set, not this one.
  assert.ok(!pills.some((p) => /again/i.test(p)));
});

// ── 2. Adoption branches ────────────────────────────────────────────────

test('a running container with a held tail record goes down the resume path', () => {
  // Same branch as a mid-exec resume, deliberately: the tail is the same
  // tail, and the journal (kept by holdTurnRecord) is what makes the
  // replay possible.
  assert.match(SERVER_SRC,
    /if \(activeTurn && activeTurn\.journal\) \{\s*\n\s*worker\.adoptWarmWorker\(sessionId, containerName\);\s*\n\s*await resumeDetachedTurn\(/,
    'a record with a journal resumes, whatever its phase');
  const caseC = SERVER_SRC.slice(
    SERVER_SRC.indexOf('// Case (c): detached turn with a durable record'),
    SERVER_SRC.indexOf('const busy = await worker.isWorkerExecuting(containerName);')
  );
  assert.match(caseC, /phase 'tail'/, 'the tail shape is documented at the branch');
});

test('a dead worker with a landed tail reports the commit and heals the preview', () => {
  const branch = SERVER_SRC.slice(
    SERVER_SRC.indexOf('} else if (session.active_turn) {'),
    SERVER_SRC.indexOf("recoveredReason: 'worker_gone',")
  );
  assert.ok(branch.length > 0, 'the container-gone branch is still there');

  // "Landed" is decided from the record's own seed milestones — the worker
  // is gone, so there is nothing else to ask.
  assert.match(branch, /const codeLanded = !!goneTail\.sha && goneTail\.pushOk === true;/);
  assert.match(branch, /recoveryPills\.buildCodeLandedBreadcrumb\(\{/);
  assert.match(branch, /recoveredReason: 'tail_worker_gone'/,
    'distinguishable from a mid-exec worker_gone in SQL');
  // The preview is the only missing artefact, and rebuildSessionStaging is
  // the shared path that also re-runs the proposal checks.
  assert.match(branch, /stagingRecovery\.rebuildSessionStaging\(\{[\s\S]{0,160}reason: 'tail_worker_gone'/);
  // It must NOT fall through into the resend breadcrumb below.
  assert.match(branch, /return;\s*\n\s*\}\s*\n\s*\/\/ #786: pills on the breadcrumb/);
});

test('a successful mid-exec replay stamps tail_pending before the tail writes milestones', () => {
  // Session 3180: a journal that detached MID-EXEC leaves active_turn in
  // 'executing'. execInWorker's finally hands the record to the tail
  // (markTurnTail → tail_pending), but the resume path had no analogue —
  // so the recovery tail's first noteTailMilestone hit mergeTailMilestones'
  // phase guard ('milestone attempted from executing'), the tail aborted
  // with the turn retained, and the retained-recovery timer replayed the
  // whole tail (narration included) every minute, forever.
  const fn = SERVER_SRC.slice(
    SERVER_SRC.indexOf('async function resumeDetachedTurnInner('),
    SERVER_SRC.indexOf('// Idle-eviction sweeper for warm worker containers.')
  );
  assert.ok(fn.length > 0, 'resumeDetachedTurnInner is still there');

  const resumeAt = fn.indexOf('worker.resumeTurnFromJournal(');
  const stampGuardAt = fn.indexOf(
    'turnLifecycle.phaseOf(recoveryActiveTurn) === turnLifecycle.PHASE_EXECUTING'
  );
  const stampAt = fn.indexOf('worker.markTurnTail(');
  const firstTailWorkAt = fn.indexOf('resumeRecoveredCodexFreshRetry');

  assert.ok(stampGuardAt > 0, 'the mid-exec phase guard exists');
  assert.ok(stampAt > stampGuardAt, 'and it gates the tail_pending stamp');
  assert.ok(resumeAt > 0 && resumeAt < stampGuardAt,
    'the stamp happens only after the journal replay succeeded');
  assert.ok(firstTailWorkAt > stampAt,
    'and lands before the first tail step that can write a milestone');

  // The guard must stay narrow: an interrupted TAIL is already
  // tail_pending, and re-stamping would clobber its milestone map with the
  // fresh seed (redoing non-idempotent tail steps on the next resume).
  assert.match(fn, /=== turnLifecycle\.PHASE_EXECUTING\) \{/,
    'only the executing phase is stamped');
});

test('the warm-idle branch narrates a dangling tail instead of returning silently', () => {
  // This branch is where the 2954 incident landed. It stays (an idle
  // container really is the common case) but no longer swallows a
  // transcript whose last word is an unfinished tail step.
  assert.match(SERVER_SRC, /const dangling = await findDanglingTail\(pool, sessionId\);/);
  assert.match(SERVER_SRC, /if \(dangling\) \{[\s\S]{0,400}await narrateDanglingTail\(/);
  assert.match(SERVER_SRC, /Adopting warm-idle worker with a DANGLING tail — narrating/);

  // The in-progress texts it looks for are exactly the tail's own status
  // wordings.
  assert.match(SERVER_SRC, /\/\^Building staging preview\/i/);
  assert.match(SERVER_SRC, /\/\^PR #\\d\+ created\$\/i/);
  // ...and any completion artefact means the tail finished after all.
  assert.match(SERVER_SRC,
    /meta\.ccOutput \|\| meta\.stagingUrl \|\| meta\.changesReady[\s\S]{0,120}return null;/);
  // An assistant row after the status row is the Mayor's wrap-up — also
  // proof the tail completed.
  assert.match(SERVER_SRC, /if \(!row \|\| row\.role !== 'system'\) return null;/);
});

test('the dangling-tail fallback picks its wording from the session row', () => {
  const fn = SERVER_SRC.slice(
    SERVER_SRC.indexOf('async function narrateDanglingTail('),
    SERVER_SRC.indexOf('async function appendTerminalProgressLine(')
  );
  // No milestone map here (that's the whole reason this path exists), so
  // pr_number is the evidence: a PR cannot exist without a successful push.
  assert.match(fn, /const landed = !!session\.pr_number;/);
  assert.match(fn, /landed \? 'code_done' : 'unrecoverable'/);
  assert.match(fn, /recoveredReason: 'dangling_tail'/);
  // The card must stop reading as in-flight.
  assert.match(fn, /appendTerminalProgressLine\(pool, sessionId, '\[interrupted\]'\)/);
  // Don't promise a rebuild without starting one.
  assert.match(fn, /if \(!landed\) return;[\s\S]{0,400}rebuildSessionStaging/);
});

// ── 3. Background rebuilds announce themselves ──────────────────────────

const STAGING_RECOVERY_SRC = fs.readFileSync(
  path.join(__dirname, '../src/services/staging-recovery.js'), 'utf8'
);

function loadStagingRecovery() {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    ws: require.resolve('../src/services/ws'),
    subject: require.resolve('../src/services/staging-recovery'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  const noop = () => {};
  require.cache[ids.logger] = {
    id: ids.logger, filename: ids.logger, loaded: true, paths: [],
    exports: { info: noop, warn: noop, error: noop, debug: noop },
  };
  const bus = { broadcasts: [], sessionUpdates: [], systemMessages: [] };
  require.cache[ids.ws] = {
    id: ids.ws, filename: ids.ws, loaded: true, paths: [],
    exports: {
      broadcastGlobal: (m) => bus.broadcasts.push(m),
      pushSessionUpdate: (m) => bus.sessionUpdates.push(m),
      sendSystemMessage: async (pool, appId, body, kind, metadata, thread) => {
        bus.systemMessages.push({ appId, body, kind, metadata, thread });
      },
    },
  };
  delete require.cache[ids.subject];
  const subject = require('../src/services/staging-recovery');
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k];
      else delete require.cache[id];
    }
  };
  return { subject, bus, restore };
}

test('a native session gets an in-progress row + a spinner hint before the build', async () => {
  const { subject, bus, restore } = loadStagingRecovery();
  try {
    const inserts = [];
    const pool = {
      query: async (sql, params) => { inserts.push({ sql: String(sql), params }); return { rows: [] }; },
    };
    await subject.announceRebuildStarted({
      pool,
      session: { id: 2954, app_id: 10, app_slug: 'usernode-2d5619', pr_number: 922 },
      imported: false,
    });

    assert.equal(inserts.length, 1);
    assert.match(inserts[0].sql, /INSERT INTO chat_session_messages/);
    assert.equal(inserts[0].params[1], 'Building staging preview...');
    // Same wording as the live dev-turn path, so the client's existing
    // status-row rendering applies with no special case.
    assert.equal(subject.STAGING_REBUILD_IN_PROGRESS, 'Building staging preview...');
    const meta = JSON.parse(inserts[0].params[2]);
    assert.equal(meta.stagingBuild, 'running');
    assert.equal(meta.recovered, true, 'findable in SQL as recovery-written');
    assert.equal(meta.prNumber, 922);

    const status = bus.broadcasts.find((b) => b.event === 'status');
    assert.ok(status, 'open tabs get a live row');
    assert.equal(status.text, 'Building staging preview...');
    assert.equal(status.sessionId, 2954);
    // No turn is in flight for /status to report, so the spinner has to be
    // asked for explicitly.
    assert.equal(status.active, true);
    assert.equal(status.stagingBuild, 'running');
    assert.deepEqual(bus.sessionUpdates, [{
      action: 'staging_building', sessionId: 2954, appSlug: 'usernode-2d5619',
    }]);
    assert.equal(bus.systemMessages.length, 0, 'native rows do not use the thread');
  } finally { restore(); }
});

test('an imported proposal is narrated in its thread, not a dev chat it lacks', async () => {
  const { subject, bus, restore } = loadStagingRecovery();
  try {
    const inserts = [];
    const pool = {
      query: async (sql, params) => { inserts.push({ sql: String(sql), params }); return { rows: [] }; },
    };
    await subject.announceRebuildStarted({
      pool,
      session: { id: 2869, app_id: 4, app_slug: 'opinion-market', pr_number: 41, pr_title: 'Tier colors' },
      imported: true,
    });
    assert.equal(inserts.length, 0, 'no chat_session_messages row — nobody could open it');
    assert.equal(bus.systemMessages.length, 1);
    const msg = bus.systemMessages[0];
    assert.match(msg.body, /Rebuilding the staging preview for PR #41 — Tier colors/);
    assert.deepEqual(msg.thread, { type: 'session', ref: 2869 });
    assert.equal(msg.metadata.stagingBuild, 'running');
  } finally { restore(); }
});

test('narration failures never fail the rebuild', async () => {
  const { subject, restore } = loadStagingRecovery();
  try {
    const pool = { query: async () => { throw new Error('db down'); } };
    // Must resolve, not reject: a lost breadcrumb is a cosmetic problem, a
    // thrown one costs the user their preview.
    await subject.announceRebuildStarted({
      pool, session: { id: 1, app_id: 1 }, imported: false,
    });
  } finally { restore(); }
});

test('the announcement runs before the build, and every outcome posts after it', () => {
  const announce = STAGING_RECOVERY_SRC.indexOf('await announceRebuildStarted(');
  const build = STAGING_RECOVERY_SRC.indexOf('stagingResult = await staging.buildAndDeployStaging(');
  assert.ok(announce > 0 && build > announce,
    'the in-progress row lands before the ~5-minute build, or it is pointless');
  // Success appends 'Staging preview rebuilt'; failure appends
  // recordStagingBootFailure's explanation. Either way the in-progress row
  // is superseded rather than left as the transcript's last word.
  assert.match(STAGING_RECOVERY_SRC, /'Staging preview rebuilt'/);
  assert.match(STAGING_RECOVERY_SRC, /recordStagingBootFailure\(\{ config, pool, session, commitHash, err \}\)/);
});

// ── 4. The client honours the hint ──────────────────────────────────────

const DEV_CHAT_SRC = fs.readFileSync(
  path.join(__dirname, '../public/js/dev-chat.js'), 'utf8'
);

test('a persisted running-rebuild row re-spins on load, but only while trailing', () => {
  assert.match(DEV_CHAT_SRC, /if \(m\.metadata\.stagingBuild\) m\.stagingBuild = m\.metadata\.stagingBuild;/,
    'the hint survives rehydration');
  assert.match(DEV_CHAT_SRC, /DevChat\._activateTrailingStagingBuild\(\);/,
    'and is applied after the history map');

  const fn = DEV_CHAT_SRC.slice(
    DEV_CHAT_SRC.indexOf('_activateTrailingStagingBuild() {'),
    DEV_CHAT_SRC.indexOf('_deactivateLastStatus() {')
  );
  // A finished rebuild has a row after it — re-spinning that would claim
  // work that is over.
  assert.match(fn, /if \(m\.ccOutput \|\| m\.stagingUrl \|\| m\.changesReady \|\| m\.stagingFailed\) return;/);
  assert.match(fn, /if \(m\.stagingBuild === 'running'\) \{ m\._active = true; return; \}/);
  assert.match(fn, /if \(m\.role === 'user' \|\| m\.role === 'assistant'\) return;/,
    'a later user/assistant turn ends the search');
});

test('every live status channel carries the rebuild hint onto the row', () => {
  const APP_SRC = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  // POST-SSE + resumable (dev-chat.js) and WebSocket (app.js): all three
  // push status rows, and all three must keep the flag so a re-render after
  // the row was pushed doesn't drop the spinner.
  assert.equal((DEV_CHAT_SRC.match(/stagingBuild: data\.stagingBuild/g) || []).length, 2);
  assert.equal((APP_SRC.match(/stagingBuild: data\.stagingBuild/g) || []).length, 1);
});
