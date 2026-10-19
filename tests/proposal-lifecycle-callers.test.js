'use strict';

// The proposal machine's callers (src/workflow/proposal/), read from source:
// every move names what its caller read, nothing writes a proposal's status
// outside the machine, and the flows that used to write it themselves now
// ask the machine. The machine's own guarantees are
// tests/workflow-proposal-postgres.test.js's.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function sources(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(rel));
    else if (/\.(js|ts)$/.test(e.name)) out.push(rel);
  }
  return out;
}

// The text of each call of `name(` in `text`: its arguments, up to the
// parenthesis that closes it.
function calls(text, name) {
  const out = [];
  const re = new RegExp(`\\b${name}\\(`, 'g');
  let m;
  while ((m = re.exec(text))) {
    if (/function\s+$/.test(text.slice(Math.max(0, m.index - 20), m.index))) continue;
    let depth = 0;
    let i = m.index + name.length;
    for (; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')' && --depth === 0) break;
    }
    out.push({ at: text.slice(0, m.index).split('\n').length, args: text.slice(m.index + name.length + 1, i) });
  }
  return out;
}

// A status move that names no `from` fails at the append (the machine's
// decoders require it). This finds the call that would, before it runs.
const MOVES = ['archiveSession', 'pauseSession', 'closeProposal', 'pauseProposal', 'resumeProposal', 'reopenProposal',
  'unpromoteProposal', 'promoteProposal', 'promoteInTransaction', 'forceMerge'];

test('every proposal move in the platform names what its caller read (`from`)', () => {
  const files = [...sources('src'), 'server.js'];
  const missing = [];
  for (const file of files) {
    const text = read(file);
    for (const name of MOVES) {
      for (const c of calls(text, name)) {
        // The wrappers' own forwarding (`from,` / `from: x`) counts.
        if (!/\bfrom\b/.test(c.args)) missing.push(`${file}:${c.at} ${name}(${c.args.slice(0, 80).replace(/\s+/g, ' ')}…)`);
      }
    }
  }
  assert.deepEqual(missing, [], `calls without \`from\`:\n${missing.join('\n')}`);
});

test('no code outside the workflow machines writes a proposal\'s status: the scanner finds no other writer', () => {
  // The staging seeds that touch it leave the rows the machine holds alone
  // (wf_holds), which the scanner reads as no other writer.
  const { boundary } = require('./lib/workflow-boundary');
  const listed = [...(boundary().get('proposal') || new Map()).keys()].filter((e) => e.startsWith('ownership | chat_sessions.status ←'));
  assert.deepEqual(listed, [], 'a writer of status outside the machine');
});

test('the bot\'s build session keeps its slot between turns until the build ends (bug 22)', () => {
  const live = read('src/services/homeroom-bot-live.js');
  const turn = live.slice(live.indexOf("durableSteps.rethrowStop(err, 'build turn');"));
  const fin = turn.slice(0, turn.indexOf('return { routed: turnRouted, stopped: turnStopped };'));
  // The build's instance holds the session (workflow_owner, buildHoldSql),
  // its turns and the time between them included; no process memory does.
  assert.match(fin, /session-work\.ts buildHoldSql/);
  assert.doesNotMatch(fin, /activeWorkers/);
  const code = fin.replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /status|pause|restSession/i, 'nothing gives its slot back after a turn');
});

test('the bot\'s and the bench\'s own endings close through the machine (bug 15)', () => {
  const live = read('src/services/homeroom-bot-live.js');
  for (const reason of ['bot-failed', 'bot-plan-only', 'not-proposed']) {
    assert.match(live, new RegExp(`closeOwnSession\\(\\{ pool, sessionId: session\\.id, reason: '${reason}' \\}\\)`), reason);
  }
  assert.match(read('src/services/homeroom-bot.js'), /archiveSession\(\{ pool, sessionId: session\.id, reason: 'bot-recovered', from: now\.status \}\)/);
  assert.match(read('src/services/bench/lane.js'), /closeOwnSession\(\{ pool, sessionId: id, reason: 'bench' \}\)/);
  assert.match(read('src/services/bench/studio.js'), /closeOwnSession\(\{ pool, sessionId: r\.session_id, reason: 'bench-preview-expired' \}\)/);
  assert.match(read('server.js'), /closeProposal\(\{ sessionId: Number\(sessionId\), reason: 'bench', from: now\.status \}\)/);
  // proposal_start's predecessor is closed in the successor's own transaction.
  assert.match(read('src/routes/proposal-handoff.js'), /closeProposal\(\{\s*sessionId: Number\(replacementSession\.id\)[^}]*reason: 'proposal-replaced'[^}]*db: client/);
});

test('an import going straight to a vote goes up through the machine, under the cap (bugs 10, 11)', () => {
  const votes = read('src/routes/votes.js');
  const route = votes.slice(votes.indexOf("router.post('/api/apps/:slug/pr-import', drainGuard"), votes.indexOf("router.post('/api/apps/:slug/pr-import/_mock/advance'"));
  assert.match(route, /promoteInTransaction\(\{[\s\S]*?db: importClient/);
  assert.match(route, /cap: effectiveSessionCaps\(config, req\.user\)\.promotedSessions/);
  assert.match(route, /draft: !!pr\.draft/, 'the draft GitHub reports is what the machine refuses');
  assert.doesNotMatch(route, /'promoted'\s*(?:,|\))/, 'nothing inserts a row born in review');
});

test('a close vote\'s withdrawal is the machine\'s close: its durable work finishes what a crash cut off (bug 16)', () => {
  const closed = read('src/services/homeroom-bot-closed-requests.js');
  assert.match(closed, /lifecycle\.archiveSession\(\{ pool, sessionId: Number\(session\.id\), reason: REASON, from: 'promoted' \}\)/);
  const lifecycle = read('src/services/session-lifecycle.js');
  assert.doesNotMatch(lifecycle, /finalizeArchivedSession|github\.closePR|destroyWorker\(/, 'nothing of a close runs after it, in the calling process');
});

test('a resume reads that the session is the caller\'s and paused before it evicts anybody (bug 23)', () => {
  const sessions = read('src/routes/sessions.js');
  const fn = sessions.slice(sessions.indexOf('async function resumePausedSession('), sessions.indexOf('// What a stop forwarded from another platform process'));
  const refused = fn.indexOf("if (!own || own.status !== 'paused') return { ok: false, status: 404");
  assert.ok(refused > 0, 'a session that is not the caller\'s, or not paused, is refused first');
  for (const evicts of ['freeGlobalSlot(', 'freeUserSlot(', 'resumeProposal(']) {
    assert.ok(fn.indexOf(evicts) > refused, `${evicts} only after it`);
  }
  // The caps are the machine's, counted under its locks; the route only asks
  // a session to pause when the machine refused for a cap.
  assert.doesNotMatch(fn, /SELECT COUNT\(\*\)/);
  assert.match(fn, /reason === 'user_cap'/);
  assert.match(fn, /reason === 'global_cap'/);
});

// ── After the adversarial review (design §9.1) ──────────────────────────

test('a promote GitHub has not answered yet (202) is waited on, never read as refused or as up for a vote (review 3)', () => {
  const live = read('src/services/homeroom-bot-live.js');
  const fn = live.slice(live.indexOf('async function promoteOwnBuild('), live.indexOf('async function buildAndPropose('));
  assert.match(fn, /out\.status === 202\) out = await steps\.race\(require\('\.\.\/workflow\/platform\.ts'\)\.promoteSettled\(/);
  assert.match(read('src/routes/votes.js'), /req\.user\.is_synthetic \? \{ waitMs: 120000 \}/, 'the bot\'s own promote waits longer');
  const mcp = read('src/services/mcp-tools.js');
  assert.equal((mcp.match(/status === 202 \? goingUpSentence\(/g) || []).length, 3, 'each connector tool that promotes says it is being put up');
});

test('a move its caller waits on carries a deadline, and a resume not applied in time is not reported as done (review 4)', () => {
  const platform = read('src/workflow/platform.ts');
  for (const name of ['unpromoteProposal', 'resumeProposal', 'moveReviewHead', 'clearProposalApprovals']) {
    const at = platform.indexOf(`export function ${name}(`);
    assert.ok(at > 0, name);
    assert.match(platform.slice(at, platform.indexOf('\nexport ', at + 10)), /deadlineMs: ANSWER_MS/, name);
  }
  const sessions = read('src/routes/sessions.js');
  assert.match(sessions, /if \(out\.status === 'pending' \|\| out\.reason === 'expired'\) return RESUME_NOT_DECIDED;/);
  assert.match(sessions, /const RESUME_NOT_DECIDED = Object\.freeze\(\{\n\s*ok: false, status: 503, code: 'not_decided',/,
    'a retryable 503 (tests/session-not-decided-routes.test.js pins its answer)');
  assert.doesNotMatch(sessions, /out\.status === 'replayed' \|\| out\.status === 'pending'\) break/);
});

test('sessions are adopted on a host with the idle pause off (review 8); caps lock the owner without blocking its rows\' inserts (review 9)', () => {
  const server = read('server.js');
  const fn = server.slice(server.indexOf('function startSessionAutoPauseSweeper('), server.indexOf('sessionSweeperHandle = setInterval(singleFlight(\'session-sweeper\''));
  assert.match(fn, /singleFlight\('proposal-adopt'[\s\S]*adoptProposals\(\)/);
  assert.match(read('src/workflow/proposal/facts.ts'), /FROM users WHERE id = \$1 FOR NO KEY UPDATE/);
});

test('a preview teardown nobody called final is final for a proposal that has ended, not one being merged (review 11)', () => {
  const staging = read('src/services/staging.js');
  assert.match(staging, /terminal == null \? \(!row \|\| row\.status === 'archived' \|\| row\.status === 'merged'\) : !!terminal/);
});

test('a resume or a reopen refused while teardown runs is asked again once it reports, for a bounded time (second review)', () => {
  const platform = read('src/workflow/platform.ts');
  assert.match(platform, /return afterTeardown\(p\.sessionId, \(\) => proposalEvent\('Resume'/);
  assert.match(platform, /return afterTeardown\(p\.sessionId, \(\) => proposalEvent\('Reopen'/);
  const fn = platform.slice(platform.indexOf('async function afterTeardown('), platform.indexOf('export function closeProposal('));
  assert.match(fn, /out\.reason !== 'tearing_down' \|\| Date\.now\(\) >= until\) return out/);
  assert.doesNotMatch(fn, /setTimeout/, 'it waits on the instance, not on a timer of its own');
  assert.match(read('src/routes/sessions.js'), /if \(busy\) return res\.status\(503\)/);
});
