// #1405 — telling a connector user what their agent did, and what it wants.
//
// A coding agent driving the connector can work for a long time, and the Claude
// app does not tell the person who started it when a turn ends. A client-side
// hook cannot cover it either: hooks are per-machine or per-repo config, so
// they never reach a fresh web session on an arbitrary repo. The platform is
// the only piece with the user's identity, a push channel, and a server that
// outlives the session.
//
// Two paths, and they are NOT of equal reliability — the tests are weighted to
// keep that distinction visible:
//
//   PATH A (submitted work) has no agent discipline in it at all. The trigger
//   points already exist and always run, so these tests are about firing on the
//   right transitions and aiming at the right person.
//
//   PATH B (waiting on you) depends on the agent calling back to stand the
//   reminder down, and an agent may forget. It cannot be made reliable, so the
//   tests here are about the three things that make the failure CHEAP: it fires
//   at most once, any connector call also clears it, and the copy never claims
//   something that stops being true.
//
// Run with: node --test tests/connector-notifications.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const waits = require('../src/services/connector-input-waits');
const pushPolicy = require('../src/services/mobile-push-policy');

// The copy is exercised through buildMessage, the exported entry point, rather
// than the internal builder — so these also prove the kind clears the
// ALLOWED_KINDS gate, which is what actually decides whether a push is sent.
function copyFor(kind, context, now = new Date('2026-01-01T12:10:00Z')) {
  const message = pushPolicy.buildMessage({
    token: 't', notificationId: 5, kind, environment: 'prod',
    installationId: 'i', userId: 3,
    expiresAt: new Date(now.getTime() + 3600 * 1000),
    context, now,
  });
  return message.notification || {};
}
const { KIND_TO_CATEGORY } = require('../src/services/mobile-push-preferences');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const TASKS_SRC = read('src/services/external-agent-tasks.js');
const NOTIF_SRC = read('src/services/notifications.js');
const SCHEMA = read('src/db/schema.sql');
const FE_SRC = read('frontend/src/features/notifications/notifications.js');

// A pool that dispatches on a substring of the SQL, in the style of
// tests/external-agent-tasks.test.js.
function fakePool(handlers, queries = []) {
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      for (const [needle, result] of handlers) {
        if (sql.includes(needle)) {
          const value = typeof result === 'function' ? result(params) : result;
          return Array.isArray(value) ? { rows: value, rowCount: value.length } : value;
        }
      }
      throw new Error(`unstubbed query: ${sql.slice(0, 70)}`);
    },
  };
}

// ── PATH A: your agent put work somewhere ──────────────────────────────

test('both destinations notify, and each says which one it was', () => {
  // #1347 gave submit_work two destinations. A notification that did not
  // distinguish them would be the least useful part of the message: "up for a
  // vote with checks running" and "visible, nobody deciding anything" are
  // different situations to come back to.
  assert.match(TASKS_SRC, /notifyConnectorSubmitted\([\s\S]{0,200}?detail: 'shared'/,
    'the share path notifies, tagged shared');
  assert.match(TASKS_SRC, /notifyConnectorSubmitted\([\s\S]{0,200}?detail: 'submitted'/,
    'and the submit path notifies, tagged submitted');
});

test('re-sharing the same card does not notify again', () => {
  // #1347 deliberately lets an agent push onto one card as often as it likes.
  // The reshare branch returns before reaching the notify call, so the FIRST
  // share is the only one that interrupts anybody.
  const shareBlock = TASKS_SRC.slice(
    TASKS_SRC.indexOf('if (params.share) {'),
    TASKS_SRC.indexOf('// PR-facing text')
  );
  const reshareReturn = shareBlock.indexOf('reshared: true');
  const notifyCall = shareBlock.indexOf('notifyConnectorSubmitted');
  assert.ok(reshareReturn !== -1 && notifyCall !== -1);
  assert.ok(reshareReturn < notifyCall,
    'the reshare path returns before the notify, so only a first share fires one');
});

test('it aims at the task owner — the inverse of the pr_proposed rule', () => {
  // createPrProposedNotifications says "The proposer is always excluded",
  // which is right for a human clicking Promote. The connector breaks the
  // assumption: the proposer is an agent, and the human may be anywhere.
  assert.match(NOTIF_SRC, /The proposer is always excluded/,
    'the rule this inverts is still stated where it applies');
  const fn = NOTIF_SRC.match(
    /async function createConnectorSubmittedNotification[\s\S]*?\n\}/
  );
  assert.ok(fn, 'the creator exists');
  assert.match(fn[0], /\$1, \$2, \$3, NULL, 'connector_submitted'/,
    'source_user_id is NULL — nobody did this TO you, your own agent did it');
  assert.match(fn[0], /n\.detail IS NOT DISTINCT FROM \$4/,
    'deduped per destination, so a later submit of a shared card still notifies');
});

test('a failed notification never fails a submission that already landed', () => {
  const helper = TASKS_SRC.match(/async function notifyConnectorSubmitted[\s\S]*?\n\}/);
  assert.ok(helper, 'the helper exists');
  assert.match(helper[0], /try \{/);
  assert.match(helper[0], /log\.warn/);
  assert.doesNotMatch(helper[0], /throw/,
    'the work is on GitHub by now — a dead push must not turn that into an error');
});

// ── PATH B: arming, and the delay ──────────────────────────────────────

test('the default delay is long enough that being at the keyboard clears it', () => {
  // Two minutes was the first instinct and is wrong: the common path is
  // "answered in thirty seconds, then the agent worked silently", which a
  // two-minute timer turns into a stray push nearly every turn.
  assert.ok(waits.DEFAULT_DELAY_MS >= 5 * 60 * 1000,
    'a short default makes the common path a false alarm');
  assert.equal(waits.resolveDelayMs(null), waits.DEFAULT_DELAY_MS);
  assert.equal(waits.resolveDelayMs(0), waits.DEFAULT_DELAY_MS);
  assert.equal(waits.resolveDelayMs(-5), waits.DEFAULT_DELAY_MS);
  // Clamped at both ends: a caller cannot arm a one-second alarm or a
  // reminder that lands next week.
  assert.equal(waits.resolveDelayMs(1), waits.MIN_DELAY_MS);
  assert.equal(waits.resolveDelayMs(10 ** 12), waits.MAX_DELAY_MS);
});

test('arming supersedes rather than stacks, and reports that it did', async () => {
  const queries = [];
  const pool = fakePool([
    ['SELECT 1 FROM connector_input_waits', [{ '?column?': 1 }]],
    ['UPDATE connector_input_waits', { rows: [], rowCount: 1 }],
    ['SELECT id FROM apps', [{ id: 7 }]],
    ['INSERT INTO connector_input_waits', [{
      id: 3, user_id: 5, app_id: 7, question: 'q', armed_at: new Date(), notify_at: new Date(),
    }]],
  ], queries);

  const row = await waits.arm(pool, { userId: 5, slug: 'recipe-box', question: 'q' });
  assert.equal(row.id, 3);
  assert.equal(row.superseded, true, 'an agent that armed twice is told so');
  // The clear runs BEFORE the insert, so the partial unique index never sees
  // two live rows for one user.
  const clearAt = queries.findIndex((q) => q.sql.includes('SET cleared_at'));
  const insertAt = queries.findIndex((q) => q.sql.includes('INSERT INTO connector_input_waits'));
  assert.ok(clearAt !== -1 && insertAt !== -1 && clearAt < insertAt);
});

test('a slug that names nothing still arms, with no app', async () => {
  // The question may be about nothing in particular. Refusing to arm because a
  // slug did not resolve would drop the notification over a detail.
  const pool = fakePool([
    ['SELECT id FROM apps', []],
    ['SELECT 1 FROM connector_input_waits', []],
    ['UPDATE connector_input_waits', { rows: [], rowCount: 0 }],
    ['INSERT INTO connector_input_waits', (params) => {
      assert.equal(params[1], null, 'app_id is null rather than a guess');
      return [{ id: 4, user_id: 5, app_id: null, armed_at: new Date(), notify_at: new Date() }];
    }],
  ]);
  const row = await waits.arm(pool, { userId: 5, slug: 'no-such-app' });
  assert.equal(row.id, 4);
  assert.equal(row.superseded, false);
});

// ── PATH B: the three properties that make a missed clear cheap ─────────

test('ONE-SHOT — a fired wait is never reconsidered', () => {
  // The property that bounds the damage. Clearing depends on the agent
  // calling back, which it may forget; one-shot turns that from a repeating
  // alarm into one stray nudge.
  const fn = waits.sweepDue.toString();
  assert.match(fn, /SET fired_at = NOW\(\)/);
  assert.match(fn, /fired_at IS NULL/, 'a fired row is excluded from every later sweep');
  // Stamped in the SAME statement that selects, so two overlapping sweeps
  // cannot both send one wait.
  assert.match(fn, /UPDATE connector_input_waits[\s\S]*?SET fired_at[\s\S]*?WHERE id IN \(/);
  assert.match(SCHEMA, /connector_input_waits_live_idx[\s\S]*?WHERE cleared_at IS NULL AND fired_at IS NULL/,
    'and the database holds one live wait per user, so arming twice cannot stack');
});

test('the sweep fires each due wait once and survives one that throws', async () => {
  const pool = fakePool([
    ['UPDATE connector_input_waits', [
      { id: 1, user_id: 5, app_id: null, armed_at: new Date() },
      { id: 2, user_id: 6, app_id: null, armed_at: new Date() },
    ]],
  ]);
  const pushed = [];
  const sent = await waits.sweepDue(pool, {
    notifications: {
      createAgentAwaitingInputNotification: async (_p, { userId }) => {
        if (userId === 5) throw new Error('boom');
        return [{ id: 99, user_id: userId }];
      },
      hydrateAndPush: async (_p, row) => { pushed.push(row.id); },
    },
  });
  assert.equal(sent, 1, 'the healthy one still went');
  assert.deepEqual(pushed, [99]);
  // The thrower is already stamped fired, so it is lost rather than retried
  // forever — the right way round for something whose job is to not be annoying.
});

test('ANY connector call clears, as a supplement to the explicit one', () => {
  const SRC = read('src/services/mcp-tools.js');
  assert.match(SRC, /notify_input_received/, 'the explicit clear exists');
  // And the explicit one is not optional. An agent can reply and then work
  // silently for a long time without calling anything, which is exactly the
  // case the delay exists for — so the tool description has to say so rather
  // than implying the incidental clear is enough.
  const idx = SRC.indexOf("server.registerTool('notify_input_received'");
  const body = SRC.slice(idx, SRC.indexOf('server.registerTool(', idx + 10));
  assert.match(body, /do not rely on that/i,
    'the description warns against leaning on the incidental clear');
});

test('THE COPY never claims something that stops being true', () => {
  // The most important line in this feature. "Claude is waiting on you" is
  // FALSE once you have answered, and a stale notification making a false
  // claim reads as broken. "asked you something N minutes ago" is about when
  // the question was asked and stays true either way — which is what turns
  // the failure this design cannot prevent into a mild redundancy.
  const now = new Date('2026-01-01T12:10:00Z');
  const copy = copyFor('agent_awaiting_input', { armedAt: '2026-01-01T12:00:00Z' }, now);
  assert.match(copy.title, /asked you something/i);
  assert.doesNotMatch(`${copy.title} ${copy.body}`, /is waiting (on|for) you/i,
    'never a claim that is false the moment they reply');
  assert.match(copy.body, /10 minutes ago/, 'it states when, which cannot go stale');

  // Singular/plural, and a missing timestamp degrades rather than rendering
  // "NaN minutes ago".
  const oneMin = copyFor('agent_awaiting_input', { armedAt: '2026-01-01T12:09:00Z' }, now);
  assert.match(oneMin.body, /1 minute ago/);
  const noStamp = copyFor('agent_awaiting_input', {}, now);
  assert.doesNotMatch(noStamp.body || '', /NaN/);
});

test('the submitted copy leads with the destination', () => {
  const shared = copyFor('connector_submitted', { detail: 'shared' });
  const submitted = copyFor('connector_submitted', { detail: 'submitted' });
  assert.match(shared.body, /in-progress/i);
  assert.match(shared.body, /no vote/i, 'nobody is being asked to decide anything');
  assert.match(submitted.body, /vote/i);
  assert.notEqual(shared.body, submitted.body, 'the two destinations do not read alike');
});

// ── Both kinds are wired into the surfaces that render them ────────────

test('both kinds ride the developer-sessions push category', () => {
  // "Interactive and unattended coding sessions that finish while you are
  // away" already describes both, so they join it rather than adding a switch
  // a connector user would have to find separately.
  assert.equal(KIND_TO_CATEGORY.get('connector_submitted'), 'developer_sessions');
  assert.equal(KIND_TO_CATEGORY.get('agent_awaiting_input'), 'developer_sessions');
  // And the closed database registry agrees with the service.
  assert.match(SCHEMA, /\('connector_submitted', 'developer_sessions', TRUE\)/);
  assert.match(SCHEMA, /\('agent_awaiting_input', 'developer_sessions', TRUE\)/);
});

test('the drawer renders both, and its waiting row uses the same safe wording', () => {
  assert.match(FE_SRC, /n\.kind === 'connector_submitted'/);
  assert.match(FE_SRC, /n\.kind === 'agent_awaiting_input'/);
  const block = FE_SRC.slice(FE_SRC.indexOf("n.kind === 'agent_awaiting_input'"));
  const row = block.slice(0, block.indexOf('#161'));
  assert.match(row, /asked you something/i);
  assert.doesNotMatch(row, /is waiting (on|for) you/i,
    'the row and the push must not disagree about what is being claimed');
});

test('the wait table is private — it stores what somebody was asked', () => {
  assert.match(SCHEMA, /COMMENT ON TABLE connector_input_waits IS 'staging:private'/,
    'the question is personal content, so staging gets the schema and none of the rows');
});
