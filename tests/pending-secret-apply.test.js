// The merge-time half of the declare-a-new-variable flow: where the
// merge-followups machine (src/workflow/merge-followups/machine.ts) applies
// the value a proposal carried, and how the staging build and the pre-merge
// check treat a value that hasn't landed yet.
//
// ORDER IS THE WHOLE POINT of the first test. A child app's newly
// `required` secret must be in `app_secrets` BEFORE app-delivery's deploy
// runs mergeForDeploy, otherwise the deploy throws MissingSecretsError and
// parks the app in `awaiting_secrets` over its own change, which looks
// exactly like a broken feature.
//
// The machine's behaviour against PostgreSQL (the values written, the lines
// said, a refused value discarded) is in
// tests/workflow-merge-followups-postgres.test.js; this file pins the shape
// of the source like tests/platform-env-vote.test.js.
//
// Run with: node --test tests/pending-secret-apply.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const machineTs = fs.readFileSync(path.join(root, 'src/workflow/merge-followups/machine.ts'), 'utf8');
const stagingJs = fs.readFileSync(path.join(root, 'src/services/staging.js'), 'utf8');
const proposalTs = fs.readFileSync(path.join(root, 'src/workflow/proposal/machine.ts'), 'utf8');

const slice = (src, from, to) => {
  const start = src.indexOf(from);
  assert.notStrictEqual(start, -1, `${from} not found`);
  const end = src.indexOf(to, start + from.length);
  assert.notStrictEqual(end, -1, `end of ${from} not found`);
  return src.slice(start, end);
};

// The transition that marks a change merged, and the write that applies its
// declared values.
const merged = slice(machineTs, 'function merged(', '\n}\n');
const writeSecrets = slice(machineTs, 'async function writeSecrets(', '\n}\n');

test('the pending value is applied in the transition that asks for the deploy', () => {
  assert.match(machineTs, /secrets: \(tx, w, ctx\) => writeSecrets\(tx, w, deps\.dataKey, ctx\)/,
    'the secrets write is the machine\'s own domain write');
  assert.match(writeSecrets, /applyInTransaction\(tx, \{ sessionId: w\.sessionId, dataKey \}\)/,
    'applied inside the transition\'s transaction');
  // The deploy is a message to app-delivery, sent by the outbox only once
  // the transition (and so the values) has committed.
  assert.match(merged, /writes: \[\{ type: 'secrets', eventId: e\.id, sessionId: d\.sessionId, appId: d\.appId \}/);
  // The proposal machine hears it merged, and the app's merge queue goes
  // on, in the same outcome.
  assert.match(merged, /const messages = \[toProposal\(d\), \.\.\.\(d\.delivery \? \[deliveryRequest\(d, reuse\)\] : \[\]\), toQueue\(d, 'merged'\)\]/);
  assert.match(merged, /work, messages, push,/, 'the same outcome carries both');
});

test('a value that cannot be written is said in the thread, not swallowed', () => {
  assert.match(writeSecrets, /for \(const r of refused\)/);
  assert.match(writeSecrets, /Couldn't apply the value declared with this proposal for \$\{r\.key\}: \$\{r\.reason\}/);
});

test('the chat wording tells the truth about when each scope takes effect', () => {
  // Promising a redeploy the platform path deliberately never performs is
  // how someone concludes the feature is broken while watching for an
  // immediate change.
  assert.match(writeSecrets, /takes effect on the platform's next deploy/);
  assert.match(writeSecrets, /was declared and set by this proposal; redeploying…/);
});

test('a platform apply records the platform-env event with its own appliedBy', () => {
  assert.match(writeSecrets, /'platform_env_changed'/);
  assert.match(writeSecrets, /appliedBy: 'declaration-proposal'/,
    'so the audit trail distinguishes it from admin-direct and group-vote');
  const eventBlock = writeSecrets.slice(writeSecrets.indexOf("'platform_env_changed'"),
    writeSecrets.indexOf("appliedBy: 'declaration-proposal'") + 60);
  assert.ok(!/value/.test(eventBlock.replace(/valueApplied|hadValue/g, '')),
    'the event carries the key and its privacy flag, never the value');
});

test('only the platform\'s own app is not delivered by app-delivery (unchanged behaviour)', () => {
  assert.match(merged, /\.\.\.\(!app\.selfHosted \? \{ delivery: DELIVERY \} : \{\}\)/);
  assert.match(merged, /app\.selfHosted \? \[\{ kind: WORK\.nudge/, 'the host deployer is nudged instead');
});

test('staging injects pending NON-private values into the proposal\'s own preview', () => {
  const build = stagingJs.slice(
    stagingJs.indexOf('const stagingStored = await appSecrets.getRawValues('),
    stagingJs.indexOf('const stagingMerge = appSecrets.mergeForDeploy(')
  );
  assert.match(build, /pendingSecrets\.rawValuesForSession\(/);
  assert.match(build, /session\.id/, 'scoped to THIS proposal, not every pending row');
  assert.ok(!/includePrivate/.test(build),
    'the default omits private values — an unreviewed PR container never gets a credential');
  assert.match(build, /hasOwnProperty\.call\(stagingStored, k\)/,
    'a real stored value still wins over a proposed one');
  assert.match(build, /catch \(err\)/, 'best-effort: never fails a build that would otherwise succeed');
});

test('a withdrawn proposal discards its held value', () => {
  // A close is the proposal machine's (src/workflow/proposal/machine.ts):
  // the held value is discarded in the close's own transaction, so it
  // cannot outlive the proposal and cannot fail the close half-way.
  const closed = slice(proposalTs, '  closed: async (tx: Tx, w: any, ctx: WriteContext) => {', '\n  },\n');
  assert.match(closed, /UPDATE pending_secret_declarations SET status = 'discarded', value_enc = NULL\s+WHERE session_id = \$1 AND status = 'pending'/);
  assert.match(closed, /\[w\.sessionId\]/, 'scoped to THIS proposal');
});

test('the pre-merge check counts a value carried by THIS session', () => {
  const checkJs = fs.readFileSync(path.join(root, 'src/services/platform-env-check.js'), 'utf8');
  assert.match(checkJs, /pendingSecrets\.keysForSession\(pool, session\.id\)/);
  assert.match(checkJs, /p\.scope === 'platform' && p\.hasValue && wanted\.has\(p\.key\)/,
    'platform scope only, value only, and only for a key this branch adds');
  assert.match(checkJs, /!stored\.has\(e\.key\) && !pendingValues\.has\(e\.key\)/,
    'a carried value is not "missing", so the proposal cannot block itself');
  assert.match(checkJs, /pendingValues: carried/, 'and the Checks card is told which ones');
});
