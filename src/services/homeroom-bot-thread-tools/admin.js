'use strict';

// Homeroom bot parity, P7: admin tools in an admin's conversations with the
// bot (see ./index.js for this module's shape).
//
// A full platform admin can ask Homeroom bot what they would ask the
// connector from Claude Code: the bench, the bot's configurations and its own
// settings, test accounts, a project's featured picture, the recent shots.
// These are the connector's own tools (services/mcp-tools.js), reached through
// the in-process MCP shim (mayor/mcp-shim.js) on a delegated grant of their
// own kind, `bot_admin` (services/mcp-audiences.js BOT_ADMIN_TOOLS), so every
// route they call re-checks the admin as it would for the connector, and a
// curated list rather than every admin tool.
//
//   reads   run at once, on a read grant minted for the call and revoked as
//           soon as it returns;
//   writes  never run from the model. The tool checks the input against the
//           real tool's own schema, seals it exactly (services/confirmations,
//           as the agent-session Mayor's cards do), and puts a confirm card
//           under the reply: { type: 'confirm', tool, title, rows, state:
//           'pending', expiresAt }. Only the admin's Confirm tap runs it
//           (homeroom-bot-cards/confirm.js, confirmAction below): the row is
//           claimed once (pending, unexpired, theirs, in this conversation),
//           the admin is checked again, the sealed input is opened and run on
//           a one-action write grant, and the outcome goes on the card and
//           into the conversation, so the bot reads it on its next turn.
//           Typing "yes" confirms nothing: nothing here reads chat text.
//
// The admin is read fresh from the database on every run and every confirm,
// so somebody who lost admin can neither read nor confirm. A person who is not
// an admin is never offered these tools at all.
//
// #6427: two more reads, of live production, which are this module's own
// rather than the connector's: query_prod_db and prod_status (see
// "Production debugging" below). They are offered only in a full admin's own
// chat with the bot, and refused everywhere else.

const crypto = require('node:crypto');
const log = require('../logger');
const confirmations = require('../confirmations');
const audiences = require('../mcp-audiences');
const { READ_SCOPE, WRITE_SCOPE } = require('../mcp-connect-constants');

const READS = audiences.BOT_ADMIN_READ_TOOLS;
const WRITES = audiences.BOT_ADMIN_CONFIRMED_TOOLS;
// A card waits for its Confirm this long (the core's own ceiling).
const CARD_TTL_MS = confirmations.MAX_TTL_MS;
const GRANT_SECONDS = 120;
const MAX_RESULT_CHARS = 12_000;
const MAX_STORED_CHARS = 4_000;
const MAX_ROWS = 16;
const MAX_VALUE_CHARS = 200;
// launch_bench_run's own threshold (mcp-tools.js BENCH_CONFIRM_CAP_USD): a
// cap above it needs the admin's word for that amount, which their Confirm
// on a card that shows it is.
const BENCH_CONFIRM_CAP_USD = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// How each tool is offered to the chat model and named on its card. `say` is
// the model's one line; `title` the card's, in plain words; `looked` the
// "what I looked at" line a read adds. `hidden` inputs are set here, never by
// the model (`fixed`), or shown nowhere; `defaults` are filled in so the card
// says what will run.
const TOOLS = Object.freeze({
  list_bench_runs: {
    say: 'The bench\'s recent runs (status, models, stages, cap and spend), the suites a run can launch on and the launcher\'s defaults.',
    looked: 'Read the bench\'s runs',
  },
  get_bench_run: {
    say: 'One bench run\'s results per stage and model: pass rates, cost, failure reasons and its spend against its cap.',
    looked: 'Read a bench run\'s results',
  },
  launch_bench_run: {
    title: 'Launch a bench run',
    say: 'Launch a bench run on a suite (suiteId from list_bench_runs): its models, stages and capUsd, the most it may spend in dollars, which the admin states. Never guess a cap: ask for one.',
    hidden: ['confirmLargeCap'],
  },
  list_bot_configs: {
    say: 'Homeroom bot\'s configurations in both scopes (first_version, later): each version\'s role, recipe and numbers, and each scope\'s side-build budget.',
    looked: 'Read the bot\'s configurations',
  },
  save_bot_config: {
    title: 'Save a bot configuration',
    say: 'Save a new version of a bot configuration in a scope, with its recipe and role (current, side or retired).',
    defaults: { scope: 'first_version' },
  },
  set_bot_config_role: {
    title: 'Change a configuration\'s role',
    say: 'Make a configuration version current, side or retired, in its scope.',
    defaults: { scope: 'first_version' },
  },
  set_bot_config_budget: {
    title: 'Set the side builds\' weekly budget',
    say: 'Set one scope\'s side builds\' weekly budget in dollars (0 pauses them).',
    defaults: { scope: 'first_version' },
  },
  list_test_accounts: {
    say: 'The live test accounts and the test release emails nobody has signed up from yet.',
    looked: 'Read the test accounts',
  },
  create_test_account: {
    title: 'Make a test account',
    say: 'Make a new test account for first-run testing. Its one-time password is shown once, on the card, to the admin who confirms it.',
    secret: 'password',
  },
  retire_test_account: {
    title: 'Retire a test account',
    say: 'Retire a test account by its userId from list_test_accounts: its apps are taken down and the account is deleted.',
    hidden: ['confirm'],
    fixed: { confirm: 'RETIRE' },
  },
  send_test_release_email: {
    title: 'Send a test release email',
    say: 'Send the waitlist\'s real release email to an address the admin reads (leave email out for a fresh +test alias of their own).',
  },
  get_featured_illustration: {
    say: 'A project\'s featured card picture (Discover, Home, the landing), its framing and tint, and any change to it waiting for a vote.',
    looked: 'Read a project\'s featured picture',
  },
  propose_featured_illustration: {
    title: 'Propose a featured picture',
    say: 'Propose new framing (zoom, x, y) or tint for a project\'s featured picture, or pictures the admin sent ahead by uploadId. It opens a vote in the project\'s group.',
  },
  get_homeroom_bot: {
    say: 'Your own settings, spend, queue, incidents and recent runs, as the admin console shows them (username for one person\'s week).',
    looked: 'Read Homeroom bot\'s console',
  },
  set_homeroom_bot_settings: {
    title: 'Change Homeroom bot\'s settings',
    say: 'Change your own settings: only the fields passed change. Read get_homeroom_bot first and say each old and new value in your reply.',
  },
  list_recent_shots: {
    say: 'The recent before and after shots of merged changes, and what came of each declared change.',
    looked: 'Read the recent shots',
  },
});

// What each input is called on a card. Anything else is its own name in words.
const LABELS = Object.freeze({
  suiteId: 'Suite', models: 'Models', stages: 'Stages', repeats: 'Attempts per task', repeatStages: 'Repeated stages',
  capUsd: 'Spend cap', concurrency: 'Trials at once', note: 'Note', key: 'Key', label: 'Label', recipe: 'Recipe',
  role: 'Role', notes: 'Notes', scope: 'Scope', versionId: 'Version', weeklyUsd: 'Weekly budget', username: 'Username',
  platformAccess: 'Let in at once', welcomeDm: 'Welcome DM', everyTemplate: 'A project from each template',
  userId: 'Account', email: 'Email', slug: 'Project', lightUploadId: 'Light picture', darkUploadId: 'Dark picture',
  zoom: 'Zoom', x: 'Across', y: 'Up and down', tint: 'Card colour', mode: 'Mode', pausedApps: 'Paused projects',
  defaultModel: 'Default model', helperModel: 'Helper model', weeklyLimitCents: 'Bot\'s weekly budget (cents)',
  userWeeklyCents: 'A person\'s week (cents)', adminWeeklyCents: 'An admin\'s week (cents)',
  triage: 'triage', spec: 'spec', build: 'build', followup: 'follow-ups', reviewer: 'reviewer', pack: 'context pack',
  tweaks: 'tweaks', maxRounds: 'most rounds', budgetMinutes: 'minutes', effort: 'effort', minutes: 'minutes',
});

function clip(value, max) {
  const text = String(value == null ? '' : value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// Tool answers wrap member-written text in envelope tags for the model; a
// person reads it without them.
function plainText(value) {
  return String(value == null ? '' : value).replace(/<\/?untrusted-content>/gi, ' ').replace(/\s+/g, ' ').trim();
}

function words(key) {
  const spaced = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase().trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Pure: whether this turn is a full platform admin's, as answer() was handed them. */
function isAdminCtx(ctx) {
  const u = ctx?.user;
  return !!u && u.isAdmin === true && u.adminReadonly !== true && u.canAdminWrite !== false && !u.isSynthetic;
}

/** A full platform admin, read fresh (never from the turn's copy). Never throws: false when it cannot tell. */
async function freshAdmin(pool, userId) {
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  try {
    const { rows: [u] } = await pool.query('SELECT is_admin, admin_readonly, is_synthetic FROM users WHERE id = $1', [id]);
    return !!u && u.is_admin === true && u.admin_readonly !== true && u.is_synthetic !== true;
  } catch (err) {
    log.warn('homeroom-bot-admin', 'Could not read whether a person is an admin', { userId: id, err: err.message });
    return false;
  }
}

// ── The real tools' input schemas ───────────────────────────────────────
//
// Read once per process off the connector's own registry, as the bot_admin
// kind sees it, so a tool's inputs here are its inputs there and nothing is
// written twice. Nothing in them runs: registering a tool only describes it.

let registry = null;
function registrySpecs() {
  if (registry) return registry;
  const specs = new Map();
  require('../mcp-tools').registerTools({ registerTool(name, spec) { specs.set(name, spec); } }, {
    accessToken: 'svmcd_schema', scopes: [READ_SCOPE, WRITE_SCOPE],
    user: { id: 0, username: 'schema', isAdmin: true, canAdminWrite: true },
    clientName: 'schema', clientId: 'schema', origin: '', baseUrl: 'http://127.0.0.1', pool: null, config: {},
    tokenId: 0, grantId: 'schema', delegation: { kind: 'bot_admin', grantId: 'schema' },
  });
  registry = specs;
  return specs;
}

function zodObject(name) {
  const spec = registrySpecs().get(name);
  if (!spec) return null;
  const { z } = require('zod');
  return z.object(spec.inputSchema && typeof spec.inputSchema === 'object' ? spec.inputSchema : {});
}

/** The model's function definition for one curated tool, from the real tool's schema. Null when it is not registered. */
function modelTool(name) {
  const shape = zodObject(name);
  if (!shape) return null;
  const { toJsonSchemaCompat } = require('@modelcontextprotocol/sdk/server/zod-json-schema-compat.js');
  const schema = toJsonSchemaCompat(shape, { strictUnions: true, pipeStrategy: 'input' });
  delete schema.$schema;
  const hidden = new Set(TOOLS[name].hidden || []);
  if (schema.properties) for (const key of hidden) delete schema.properties[key];
  if (Array.isArray(schema.required)) {
    schema.required = schema.required.filter((key) => !hidden.has(key));
    if (!schema.required.length) delete schema.required;
  }
  const write = WRITES.includes(name);
  return {
    type: 'function',
    function: {
      name,
      description: `Admin only. ${TOOLS[name].say}${write
        ? ' It does not run here: it puts a Confirm card under your reply showing exactly this, and only their tap on Confirm runs it.'
        : ''}`,
      parameters: schema,
    },
  };
}

let toolList = null;
function curatedTools() {
  if (toolList) return toolList;
  toolList = [...READS, ...WRITES].filter((name) => TOOLS[name]).map(modelTool).filter(Boolean);
  return toolList;
}

// ── A confirm card's rows ───────────────────────────────────────────────

function valueWords(key, value) {
  if (value == null) return 'None';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (key === 'capUsd') return `$${value}`;
  if (key === 'weeklyUsd') return `$${value} a week`;
  if (Array.isArray(value)) {
    const items = value.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : String(v)));
    return items.length ? items.join(', ') : 'None';
  }
  return String(value);
}

/**
 * Pure: the input a card runs, shown plainly as { label, value } rows, at
 * most MAX_ROWS, nested objects by their path in words ("Recipe models:
 * triage"). Hidden inputs are left out. The inputs here hold no secret: the
 * one secret these tools touch (a test account's password) is an output.
 */
function rowsOf(name, input) {
  const hidden = new Set(TOOLS[name]?.hidden || []);
  const rows = [];
  const walk = (key, value, label) => {
    if (rows.length >= MAX_ROWS) return;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const k of Object.keys(value).sort()) walk(k, value[k], `${label} ${(LABELS[k] || words(k)).toLowerCase()}`);
      return;
    }
    rows.push({ label: clip(label, 80), value: clip(valueWords(key, value), MAX_VALUE_CHARS) });
  };
  for (const key of Object.keys(input || {}).sort()) {
    if (hidden.has(key) || input[key] === undefined) continue;
    walk(key, input[key], LABELS[key] || words(key));
  }
  return rows;
}

/** Pure: the input that is sealed, from what the model passed: its own fields, the defaults, and what this module fixes. */
function sealedInputOf(name, args) {
  const tool = TOOLS[name];
  const hidden = new Set(tool.hidden || []);
  const own = {};
  for (const [key, value] of Object.entries(args && typeof args === 'object' ? args : {})) {
    if (!hidden.has(key) && value !== undefined) own[key] = value;
  }
  const input = { ...(tool.defaults || {}), ...own, ...(tool.fixed || {}) };
  if (name === 'launch_bench_run' && typeof input.capUsd === 'number' && input.capUsd > BENCH_CONFIRM_CAP_USD) {
    // The card shows the cap, and only their Confirm runs it: that is
    // their word for the amount.
    input.confirmLargeCap = true;
  }
  return input;
}

function issuesOf(error) {
  return (error?.issues || []).slice(0, 4)
    .map((i) => `${(i.path || []).join('.') || 'input'}: ${i.message}`).join('; ');
}

// ── The turn's side ─────────────────────────────────────────────────────

function looked(ctx, what) {
  if (!what) return;
  if (!Array.isArray(ctx.looked)) ctx.looked = [];
  ctx.looked.push({ what });
}

function opener(deps) {
  return deps?.openAdminMcp || require('../mayor/mcp-shim').openMayorMcp;
}

async function readNow(pool, ctx, name, args) {
  const started = Date.now();
  const shim = await opener(ctx.deps)({
    pool, config: ctx.config, userId: Number(ctx.user.id), agentSessionId: null, scopes: [READ_SCOPE],
    ttlSeconds: GRANT_SECONDS, rateSubject: `hrbot-admin-${Number(ctx.user.id)}`, kind: 'bot_admin',
  });
  try {
    const r = await shim.call(name, args && typeof args === 'object' ? args : {});
    looked(ctx, TOOLS[name].looked);
    ctx.lookedMs = (Number(ctx.lookedMs) || 0) + (Date.now() - started);
    return r?.isError ? { ok: false, error: clip(r.text, 2000) } : { result: clip(r?.text, MAX_RESULT_CHARS) };
  } finally {
    await shim.close('turn_finished');
  }
}

async function prepare(pool, ctx, name, args) {
  const tool = TOOLS[name];
  if (ctx.adminCard) {
    return { ok: false, error: `One change per reply: a Confirm card for "${ctx.adminCard}" is already under this reply. Ask them to confirm or cancel it first. Nothing more was prepared.` };
  }
  if (!ctx.conversationId) return { ok: false, error: 'There is no conversation to put a Confirm card in. Nothing was prepared.' };
  const input = sealedInputOf(name, args);
  if (name === 'launch_bench_run' && !(typeof input.capUsd === 'number' && input.capUsd > 0)) {
    return { ok: false, error: 'Ask them how much this run may spend, in dollars, and pass it as capUsd. Nothing was prepared.' };
  }
  const shape = zodObject(name);
  const parsed = shape ? shape.safeParse(input) : { success: false, error: { issues: [{ message: 'not available' }] } };
  if (!parsed.success) return { ok: false, error: `That input is not valid (${clip(issuesOf(parsed.error), 400)}). Nothing was prepared.` };
  const { sealed, inputHash } = confirmations.sealAction(input, ctx.config?.dataEncryptionKey);
  const { issuedAt, expiresAt } = confirmations.expiryFor(new Date(), CARD_TTL_MS);
  const id = crypto.randomUUID();
  const rootId = Number(ctx.deps?.threadRequest?.rootId || ctx.deps?.threadRootId) || null;
  await pool.query(
    `INSERT INTO homeroom_bot_admin_actions
       (id, user_id, conversation_id, thread_root_id, tool_name, sealed_input, input_hash, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
    [id, Number(ctx.user.id), Number(ctx.conversationId), rootId, name, JSON.stringify(sealed), inputHash, expiresAt, issuedAt],
  );
  ctx.adminCard = tool.title;
  ctx.card = {
    type: 'confirm', v: 1, confirmId: id, tool: name, title: tool.title,
    rows: rowsOf(name, input), state: 'pending', expiresAt: expiresAt.toISOString(),
  };
  log.info('homeroom-bot-admin', 'Prepared an admin action for its card', { userId: ctx.user.id, tool: name, actionId: id });
  return {
    status: 'pending_confirmation',
    title: tool.title,
    note: 'A Confirm card showing exactly this is under your reply. Nothing has happened yet: it runs only if they tap Confirm, within 15 minutes. Say in one line what it will do and that it waits for their Confirm.',
  };
}

// ── Production debugging (#6427) ────────────────────────────────────────
//
// A full admin can ask the bot to debug production in their own chat with it
// ("is anything stuck right now?", "why is request 6351 held?"):
//
//   query_prod_db  one read-only SQL statement, run as the reviewed
//                  `usernode_debug_ro` role (services/debug-access.js
//                  runQuery), never on the main pool. Its grants are
//                  READABLE_COLUMNS: operational columns only, no contact
//                  details, nothing that signs anyone in, no text people
//                  wrote. A new table or column stays unreadable until
//                  someone reviews it onto that list.
//   prod_status    the platform's health snapshot (services/status.js
//                  gather()), as the agent-session Mayor's get_prod_status
//                  had it, with the words people and agents wrote left out
//                  and contact details masked (statusForModel).
//
// The bot's model runs through OpenRouter, so whatever these return leaves
// the platform. That is why the role reads no personal column, and why the
// snapshot is trimmed before the model sees it.
//
// Where they run: only in a full admin's (isAdminCtx) own conversation with
// the bot, the one whose only two members are the admin and the bot (Main
// Chat and its private threads). beforeTurn reads that before the turn says
// what it offers; every call reads both again (freshAdmin, ownChatWithBot)
// and refuses with PROD_DEBUG_REFUSAL, running nothing, unless both still
// hold. Project threads, request discussions and project chats are answered
// by homeroom-bot-voice.js and homeroom-bot-chat.js, which never load these
// tools; a conversation with a third member is refused here as well.
//
// Every call is recorded before it runs, as the internal prod-debug routes
// record theirs (routes/internal.js): a `prod-debug` log line with the admin,
// the conversation and the SQL text, and a homeroom_bot_admin_actions row with
// the statement sealed, as a confirm card's input is (it starts `running`, so
// no Confirm tap can ever claim it). A call that cannot be recorded does not
// run. The row is also how a card that posts somewhere public knows a
// database read happened in its thread (dbReadIn).

const PROD_DEBUG_TOOLS = Object.freeze(['query_prod_db', 'prod_status']);
const PROD_DEBUG_REFUSAL = 'Only a full platform admin can use that, and only in their own chat with me. Nothing was run.';
const MAX_SQL_CHARS = 4000;
const PROD_STATUS_LOG_LINES = 50;
// Snapshot fields that hold words somebody, or a coding agent, wrote: a
// change's title, a session's title, an agent's last progress line.
const STATUS_FREE_TEXT = new Set(['prTitle', 'sessionTitle', 'lastProgress']);
// Contact details that a log line or a value can still carry, masked before
// the model sees them. Defense in depth: the role reads no such column.
const PERSONAL_PATTERNS = Object.freeze([
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[email]'],
  [/\+\d[\d\s().-]{6,}\d/g, '[phone]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]'],
  [/\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi, '[ip]'],
]);

function debugAccessOf(ctx) { return ctx?.deps?.debugAccess || require('../debug-access'); }
function statusOf(ctx) { return ctx?.deps?.statusSvc || require('../status'); }

/** The thread of the chat a turn is in: its root message, or null for Main. */
function threadRootOf(ctx) {
  return Number(ctx?.deps?.threadRequest?.rootId || ctx?.deps?.threadRootId) || null;
}

/**
 * Whether `conversationId` is `userId`'s own conversation with the bot: a
 * direct conversation whose only two members are them and the bot, both
 * still in it. Every member row counts, whatever its status, so somebody
 * invited, or who left, makes it somebody else's too. Never throws: false
 * when it cannot tell.
 */
async function ownChatWithBot(pool, { conversationId, userId, botId }) {
  const ids = [conversationId, userId, botId].map(Number);
  if (!ids.every((n) => Number.isSafeInteger(n) && n > 0) || ids[1] === ids[2]) return false;
  try {
    const { rows: [m] } = await pool.query(
      `SELECT COUNT(*)::int AS members,
              COUNT(*) FILTER (WHERE cm.user_id = $2 AND cm.status = 'member')::int AS person,
              COUNT(*) FILTER (WHERE cm.user_id = $3 AND cm.status = 'member' AND u.is_synthetic = TRUE)::int AS bot
         FROM conversation_members cm
         JOIN conversations c ON c.id = cm.conversation_id AND c.kind = 'direct'
         JOIN users u ON u.id = cm.user_id
        WHERE cm.conversation_id = $1`,
      ids,
    );
    return !!m && Number(m.members) === 2 && Number(m.person) === 1 && Number(m.bot) === 1;
  } catch (err) {
    log.warn('homeroom-bot-admin', 'Could not read whose conversation this is', { conversationId: ids[0], err: err.message });
    return false;
  }
}

function chatOf(ctx) {
  return { conversationId: ctx?.conversationId, userId: ctx?.user?.id, botId: ctx?.bot?.id };
}

/** Pure: whether this turn offers the production reads (beforeTurn found it is the admin's own chat with the bot). */
function prodDebugOffered(ctx) {
  return isAdminCtx(ctx) && Number(ctx.conversationId) > 0 && ctx.ownChatWithBot === Number(ctx.conversationId);
}

function readableColumnsLine() {
  return Object.entries(debugAccessOf(null).READABLE_COLUMNS)
    .map(([table, columns]) => `${table}(${columns.join(', ')})`).join('; ');
}

/** The model's function definitions for the two production reads. */
function prodDebugTools() {
  const where = 'Admin only, and only here, in their own chat with you.';
  return [
    {
      type: 'function',
      function: {
        name: 'query_prod_db',
        description: `${where} Run ONE read-only SQL statement (PostgreSQL) on Homeroom's live production database, `
          + 'as a read-only role that can read only these reviewed columns, table(columns): '
          + `${readableColumnsLine()}. `
          + 'It reads no email, phone number, real name, address, token, title, body or message text. Name the columns '
          + 'you need (never *): any other column is refused as permission denied. At most 5 seconds and 500 rows.',
        parameters: {
          type: 'object',
          properties: { sql: { type: 'string', description: 'One SELECT statement.' } },
          required: ['sql'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'prod_status',
        description: `${where} Homeroom's production health right now: stuck sessions, workers, staging previews, `
          + 'the checks queue, capacity, the deploy in progress, today\'s spend against its limits, and the recent '
          + 'platform log events.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
  ];
}

/** Pure: `text` with email addresses, phone numbers and IP addresses masked. */
function maskPersonal(text) {
  let out = String(text == null ? '' : text);
  for (const [pattern, replacement] of PERSONAL_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function scrubbed(value) {
  if (typeof value === 'string') return maskPersonal(value);
  if (Array.isArray(value)) return value.map(scrubbed);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const [key, v] of Object.entries(value)) if (!STATUS_FREE_TEXT.has(key)) out[key] = scrubbed(v);
    return out;
  }
  return value;
}

/**
 * Pure: the health snapshot as the model reads it, at most MAX_RESULT_CHARS.
 * The per-app tree is left out (driftContainers names the apps whose runtime
 * is missing, and query_prod_db reads the rest); the log ring is given once,
 * as recentLog, and is the first thing dropped when the snapshot is too long.
 */
function statusForModel(status, recentLog = []) {
  const { apps: _apps, events: _events, ...rest } = status && typeof status === 'object' ? status : {};
  const tries = [
    { ...rest, recentLog },
    { ...rest, recentLog: [], note: 'recentLog left out: the snapshot was too long' },
    {
      ...rest, workers: undefined, llmUsage: undefined, stagingPerUser: undefined, recentLog: [],
      note: 'workers, today\'s spend per person and recentLog left out: the snapshot was too long',
    },
  ];
  let text = '';
  for (const snapshot of tries) {
    text = JSON.stringify(scrubbed(snapshot));
    if (text.length <= MAX_RESULT_CHARS) return text;
  }
  return clip(text, MAX_RESULT_CHARS);
}

/** Pure: query rows as the model reads them, at most MAX_RESULT_CHARS. */
function rowsForModel({ rows = [], rowCount = 0, truncated = false } = {}) {
  const text = maskPersonal(JSON.stringify({ rowCount, truncated, rows }));
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${clip(text, MAX_RESULT_CHARS - 120)} [cut at ${MAX_RESULT_CHARS} characters: ask for fewer rows or columns]`;
}

/**
 * The record of one production read, written before it runs: the log line
 * (with the SQL text, redacted as the internal route redacts it) and the
 * admin-actions row (with it sealed). The row's id, or null when it could not
 * be written, and then nothing runs. Never throws.
 */
async function recordProdDebug(pool, ctx, name, sql) {
  const id = crypto.randomUUID();
  const userId = Number(ctx.user.id);
  const conversationId = Number(ctx.conversationId);
  const threadRootId = threadRootOf(ctx);
  log.info('prod-debug', name === 'query_prod_db' ? 'Homeroom bot SQL query' : 'Homeroom bot status snapshot', {
    userId, conversationId, threadRootId, actionId: id, tool: name,
    ...(sql != null ? { query: log.redactString(sql.slice(0, 2000)) } : {}),
  });
  try {
    const { sealed, inputHash } = confirmations.sealAction(sql != null ? { sql } : {}, ctx.config?.dataEncryptionKey);
    const { issuedAt, expiresAt } = confirmations.expiryFor(new Date(), CARD_TTL_MS);
    await pool.query(
      `INSERT INTO homeroom_bot_admin_actions
         (id, user_id, conversation_id, thread_root_id, tool_name, sealed_input, input_hash, status, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'running', $8, $9)`,
      [id, userId, conversationId, threadRootId, name, JSON.stringify(sealed), inputHash, expiresAt, issuedAt],
    );
    return id;
  } catch (err) {
    log.warn('homeroom-bot-admin', 'Could not record a production read before it ran, so it did not run', {
      userId, tool: name, err: err.message,
    });
    return null;
  }
}

/** What a production read came to, on its row: never the rows it read. Never throws. */
async function settleProdDebug(pool, id, outcome) {
  await pool.query(
    `UPDATE homeroom_bot_admin_actions SET status = $2, result = $3::jsonb, decided_at = NOW()
      WHERE id = $1 AND status = 'running'`,
    [id, outcome.ok ? 'done' : 'failed', JSON.stringify(outcome)],
  ).catch((err) => log.warn('homeroom-bot-admin', 'Could not record what a production read came to', { actionId: id, err: err.message }));
}

function queryError(err) {
  const said = clip(log.redactString(String(err?.message || '')), 400);
  if (err?.code === 'unavailable') return 'Production debugging is not available right now. Nothing was read.';
  if (err?.code === '42501') {
    return `The read-only role refused it (${said}). It reads only the reviewed columns listed in query_prod_db. Nothing was read.`;
  }
  return `The database refused it${said ? ` (${said})` : ''}. Nothing was read.`;
}

async function runProdDebug(pool, ctx, name, args) {
  const allowed = isAdminCtx(ctx)
    && await freshAdmin(pool, ctx.user.id)
    && await ownChatWithBot(pool, chatOf(ctx));
  if (!allowed) {
    log.warn('prod-debug', 'Refused a Homeroom bot production read', {
      userId: Number(ctx?.user?.id) || null, conversationId: Number(ctx?.conversationId) || null, tool: name,
    });
    return { ok: false, error: PROD_DEBUG_REFUSAL };
  }
  ctx.adminToolsUsed = true;
  let sql = null;
  if (name === 'query_prod_db') {
    sql = typeof args?.sql === 'string' ? args.sql.trim() : '';
    if (!sql) return { ok: false, error: 'Pass one read-only SQL statement as sql. Nothing was run.' };
    if (sql.length > MAX_SQL_CHARS) return { ok: false, error: `That statement is over ${MAX_SQL_CHARS} characters. Nothing was run.` };
  }
  const id = await recordProdDebug(pool, ctx, name, sql);
  if (!id) return { ok: false, error: 'I could not record this read, so I did not run it. Nothing was run.' };
  const started = Date.now();
  let outcome = { ok: false, code: 'not_run' };
  try {
    if (name === 'query_prod_db') {
      const r = await debugAccessOf(ctx).runQuery(sql, { config: ctx.config });
      outcome = { ok: true, rowCount: Number(r?.rowCount) || 0, truncated: !!r?.truncated };
      looked(ctx, 'Read production\'s database');
      return { result: rowsForModel(r) };
    }
    const status = await statusOf(ctx).gather(ctx.config, { isAdmin: true });
    outcome = { ok: true };
    looked(ctx, 'Read production\'s health');
    return { result: statusForModel(status, log.tail(PROD_STATUS_LOG_LINES)) };
  } catch (err) {
    outcome = { ok: false, code: typeof err?.code === 'string' ? err.code.slice(0, 32) : 'failed' };
    if (name === 'query_prod_db') return { ok: false, error: queryError(err) };
    log.warn('prod-debug', 'Homeroom bot status snapshot failed', { actionId: id, err: err.message });
    return { ok: false, error: 'The health snapshot could not be read just now. Nothing was read.' };
  } finally {
    ctx.lookedMs = (Number(ctx.lookedMs) || 0) + (Date.now() - started);
    await settleProdDebug(pool, id, outcome);
  }
}

/**
 * #6427: whether a database read (query_prod_db) happened in any of these
 * threads of a person's chat with the bot (null or 0 for Main), so a card
 * that posts somewhere public says so (homeroom-bot-mayor.js offer). Never
 * throws: false when it cannot tell.
 */
async function dbReadIn(pool, { userId, conversationId, threadRootIds = [null] }) {
  const user = Number(userId);
  const conversation = Number(conversationId);
  if (!Number.isSafeInteger(user) || user <= 0 || !Number.isSafeInteger(conversation) || conversation <= 0) return false;
  const roots = [...new Set((Array.isArray(threadRootIds) ? threadRootIds : [threadRootIds])
    .map((r) => (Number.isSafeInteger(Number(r)) && Number(r) > 0 ? Number(r) : 0)))];
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM homeroom_bot_admin_actions
        WHERE user_id = $1 AND conversation_id = $2 AND tool_name = 'query_prod_db'
          AND status IN ('running', 'done') AND COALESCE(thread_root_id, 0) = ANY($3::int[])
        LIMIT 1`,
      [user, conversation, roots],
    );
    return rows.length > 0;
  } catch (err) {
    log.warn('homeroom-bot-admin', 'Could not read whether a database read happened in a thread', { conversationId: conversation, err: err.message });
    return false;
  }
}

/** Before the turn says what it offers: whether this is a full admin's own chat with the bot. Never throws. */
module.exports.beforeTurn = async function beforeTurn(pool, ctx) {
  if (!ctx || !isAdminCtx(ctx)) return;
  if (await ownChatWithBot(pool, chatOf(ctx))) ctx.ownChatWithBot = Number(ctx.conversationId);
};

/** The production reads are this module's to refuse, offered or not, so a call by name gets their refusal. */
module.exports.claims = function claims(name) {
  return PROD_DEBUG_TOOLS.includes(name);
};

module.exports.tools = function tools(ctx) {
  if (!isAdminCtx(ctx)) return [];
  let list = [];
  try {
    list = curatedTools();
  } catch (err) {
    log.warn('homeroom-bot-admin', 'Could not describe the admin tools', { err: err.message });
  }
  if (!prodDebugOffered(ctx)) return list;
  try {
    return [...list, ...prodDebugTools()];
  } catch (err) {
    log.warn('homeroom-bot-admin', 'Could not describe the production reads', { err: err.message });
    return list;
  }
};

module.exports.run = async function run(pool, ctx, name, args) {
  if (PROD_DEBUG_TOOLS.includes(name)) return runProdDebug(pool, ctx, name, args);
  if (!Object.prototype.hasOwnProperty.call(TOOLS, name)) return undefined;
  if (!isAdminCtx(ctx) || !(await freshAdmin(pool, ctx.user?.id))) {
    return { ok: false, error: 'Only a full platform admin can use that. Nothing was run.' };
  }
  ctx.adminToolsUsed = true;
  if (READS.includes(name)) return readNow(pool, ctx, name, args);
  if (WRITES.includes(name)) return prepare(pool, ctx, name, args);
  return undefined;
};

module.exports.promptLines = function promptLines(ctx) {
  if (!isAdminCtx(ctx)) return [];
  return [
    '- You are talking with a full Homeroom admin, so you also have admin tools, the ones their connector has:',
    '  the bench (list_bench_runs, get_bench_run, launch_bench_run), your configurations (list_bot_configs,',
    '  save_bot_config, set_bot_config_role, set_bot_config_budget), test accounts (list_test_accounts,',
    '  create_test_account, retire_test_account, send_test_release_email), featured pictures',
    '  (get_featured_illustration, propose_featured_illustration), your own settings (get_homeroom_bot,',
    '  set_homeroom_bot_settings) and the recent before and after shots (list_recent_shots).',
    '  Reads run at once. Anything that changes something never runs from here: calling it puts a Confirm card',
    '  under your reply showing exactly what will run, and only their tap on Confirm runs it, within 15 minutes.',
    '  So say in one line what the card will do and that it waits for their Confirm; never say it is done. One',
    '  change per reply. Typing "yes" confirms nothing: if they type it, point them to the card. A bench run',
    '  always needs the most it may spend from them, in dollars: ask, never guess. Read before you change',
    '  settings, and say each old and new value.',
    ...(prodDebugOffered(ctx) ? [
      '- Here, in their own chat with you, you can also read live production, read-only: prod_status (its health',
      '  now) and query_prod_db (one read-only SQL statement, on reviewed operational columns only). Use them to',
      '  answer what they ask about production from what is there, not from guesses, and say what you read.',
      '  Never copy query results (rows, values, lists of ids) into anything that will be posted: a request, a',
      '  reply on a request or a change, a plan, or a thread filed as a request. Describe what you found in your',
      '  own words instead.',
    ] : []),
  ];
};

// ── The Confirm tap (homeroom-bot-cards/confirm.js) ──────────────────────

function boundedResult(result, secretKey = null) {
  const structured = result?.structured && typeof result.structured === 'object' ? { ...result.structured } : null;
  if (structured && secretKey) delete structured[secretKey];
  let json = structured ? JSON.stringify(structured) : null;
  if (json && json.length > MAX_STORED_CHARS) json = null;
  let text = String(result?.text || '');
  // The text is the structured payload as JSON for a successful call: a
  // secret in it never reaches what is kept.
  if (secretKey) text = json || '';
  return {
    ok: !result?.isError,
    code: result?.isError && structured && typeof structured.code === 'string' ? structured.code : null,
    structured: json ? structured : null,
    text: clip(text, MAX_STORED_CHARS),
  };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** Pure: what a confirmed action did, in one plain line for the card. */
function outcomeLine(name, stored) {
  const s = stored?.structured || {};
  if (!stored?.ok) {
    const said = plainText(stored?.text).replace(/^[a-z_]+:\s*/, '');
    return `It did not go through${said ? `: ${clip(said, 280)}` : '.'}`;
  }
  switch (name) {
    case 'launch_bench_run':
      return `Launched run ${num(s.runId) ?? ''}: ${num(s.trials) ?? 0} trials, about $${num(s.estimateUsd) ?? 0} against a cap of $${num(s.capUsd) ?? 0}.`;
    case 'save_bot_config':
      return `Saved version ${num(s.version?.id) ?? ''}${s.version?.role ? ` as ${plainText(s.version.role)}` : ''}.`;
    case 'set_bot_config_role':
      return `Version ${num(s.version?.id) ?? ''} is ${plainText(s.version?.role) || 'changed'} now.`;
    case 'set_bot_config_budget':
      return `Set the ${plainText(s.scope) || 'scope'}'s side builds' weekly budget.`;
    case 'create_test_account':
      return `Made test account @${plainText(s.username) || '?'} (account ${num(s.userId) ?? '?'}). Its one-time password was shown once, on the screen that confirmed it.`;
    case 'retire_test_account': {
      const apps = Array.isArray(s.appsDeleted) ? s.appsDeleted.length : 0;
      return `Retired @${plainText(s.username) || '?'}${apps ? `, and took down ${apps} ${apps === 1 ? 'app' : 'apps'}` : ''}.`;
    }
    case 'send_test_release_email': {
      // services/mail: failed, no_transport, no_template and suppressed_* mean it did not go.
      const status = plainText(s.mail?.status) || 'unknown';
      return /^(failed|no_transport|no_template|suppressed|unknown)/.test(status)
        ? `The release email to ${plainText(s.email)} did not go out (${status.replace(/_/g, ' ')}).`
        : `Sent the release email to ${plainText(s.email)}.`;
    }
    case 'propose_featured_illustration':
      return `Proposed the new picture for ${plainText(s.slug)}: it changes once the project's group votes it in.`;
    case 'set_homeroom_bot_settings': {
      const changed = Array.isArray(s.changed) ? s.changed.map(plainText).filter(Boolean) : [];
      return changed.length ? `Changed: ${clip(changed.join(', '), 240)}.` : 'Saved.';
    }
    default:
      return 'Done.';
  }
}

async function appendToConversation(pool, { userId, botId, threadRootId, content, actionId, tool, deps = {} }) {
  try {
    const dm = deps.dm || require('../homeroom-bot-dm');
    const bot = botId ? { id: Number(botId) } : await dm.botAccount(pool);
    if (!bot?.id) return null;
    return await dm.sendDm(pool, {
      bot, userId: Number(userId), content, moment: null,
      ...(threadRootId ? { threadRootId: Number(threadRootId) } : { threadRootId: false }),
      idempotencyKey: `hrbot-admin-action-${actionId}`,
      metadata: { kind: 'admin_result', tool },
    });
  } catch (err) {
    log.warn('homeroom-bot-admin', 'Could not say an admin action\'s outcome in the conversation', { actionId, err: err.message });
    return null;
  }
}

/**
 * The admin's Confirm on a confirm card: claimed once, run as them, its
 * outcome on the card and in the conversation. Resolves
 *   { ok: true, state: 'done' | 'failed', result, secret? }     ran (secret: shown once, kept nowhere)
 *   { ok: false, status, error, expired? }                       refused, nothing ran
 * Never throws.
 */
async function confirmAction(pool, config, { user, actionId, conversationId, botId = null, threadRootId = null, deps = {} }) {
  if (typeof actionId !== 'string' || !UUID_RE.test(actionId)) return { ok: false, status: 404, error: 'No such card' };
  if (!(await freshAdmin(pool, user?.id))) {
    return { ok: false, status: 403, error: 'Only a full platform admin can confirm this.' };
  }
  let claimed;
  try {
    ({ rows: [claimed] } = await pool.query(
      `UPDATE homeroom_bot_admin_actions
          SET status = 'running', decided_at = NOW()
        WHERE id = $1 AND user_id = $2 AND conversation_id = $3 AND status = 'pending' AND expires_at > NOW()
        RETURNING tool_name, sealed_input, input_hash, thread_root_id`,
      [actionId, Number(user.id), Number(conversationId)],
    ));
  } catch (err) {
    log.warn('homeroom-bot-admin', 'Could not claim an admin action', { actionId, err: err.message });
    return { ok: false, status: 500, error: 'That did not work just now' };
  }
  if (!claimed) {
    const { rows: [had] } = await pool.query(
      'SELECT status, expires_at FROM homeroom_bot_admin_actions WHERE id = $1 AND user_id = $2 AND conversation_id = $3',
      [actionId, Number(user.id), Number(conversationId)],
    ).catch(() => ({ rows: [] }));
    if (!had) return { ok: false, status: 404, error: 'No such card' };
    if (had.status !== 'pending') return { ok: false, status: 409, error: 'This card was already used or cancelled.' };
    return { ok: false, status: 410, expired: true, error: 'This card expired. Ask again for a new one.' };
  }
  const name = claimed.tool_name;
  const tool = TOOLS[name];
  let stored;
  let secret = null;
  try {
    if (!tool || !WRITES.includes(name)) throw new confirmations.ActionConfirmationError('invalid_action', 'That is not an admin action.');
    const { input } = confirmations.openAction(claimed.sealed_input, claimed.input_hash, config?.dataEncryptionKey);
    const shim = await opener(deps)({
      pool, config, userId: Number(user.id), agentSessionId: null, scopes: [READ_SCOPE, WRITE_SCOPE],
      ttlSeconds: GRANT_SECONDS, rateSubject: `hrbot-admin-${Number(user.id)}`, kind: 'bot_admin',
    });
    let result;
    try {
      result = await shim.call(name, input);
    } finally {
      await shim.close('action_done');
    }
    if (tool.secret && !result?.isError && result?.structured && result.structured[tool.secret]) {
      secret = { label: 'One-time password', value: String(result.structured[tool.secret]) };
    }
    stored = boundedResult(result, tool.secret || null);
  } catch (err) {
    stored = {
      ok: false, code: err.code || 'action_failed', structured: null,
      text: err instanceof confirmations.ActionConfirmationError ? err.message : 'The action could not run.',
    };
    if (!(err instanceof confirmations.ActionConfirmationError)) {
      log.warn('homeroom-bot-admin', 'A confirmed admin action failed to run', { actionId, tool: name, err: err.message });
    }
  }
  const state = stored.ok ? 'done' : 'failed';
  const line = outcomeLine(name, stored);
  await pool.query(
    'UPDATE homeroom_bot_admin_actions SET status = $2, result = $3::jsonb WHERE id = $1',
    [actionId, state, JSON.stringify(stored)],
  ).catch((err) => log.warn('homeroom-bot-admin', 'Could not record an admin action\'s outcome', { actionId, err: err.message }));
  const label = tool?.title || name;
  await appendToConversation(pool, {
    // Said where the card is: its message's thread, else where the turn was.
    userId: user.id, botId, threadRootId: threadRootId || claimed.thread_root_id, actionId, tool: name, deps,
    content: stored.ok ? `Confirmed: ${label}. ${line}` : `${label}: ${line}`,
  });
  log.info('homeroom-bot-admin', 'Ran a confirmed admin action', { userId: user.id, tool: name, actionId, ok: stored.ok });
  return { ok: true, state, result: line, ...(secret ? { secret } : {}) };
}

/** The admin's Cancel: the card's action is dismissed, nothing runs. Never throws. */
async function cancelAction(pool, { user, actionId, conversationId }) {
  if (typeof actionId !== 'string' || !UUID_RE.test(actionId)) return { ok: false, status: 404, error: 'No such card' };
  try {
    const { rows } = await pool.query(
      `UPDATE homeroom_bot_admin_actions SET status = 'dismissed', decided_at = NOW()
        WHERE id = $1 AND user_id = $2 AND conversation_id = $3 AND status = 'pending'
        RETURNING tool_name`,
      [actionId, Number(user?.id), Number(conversationId)],
    );
    if (!rows.length) return { ok: false, status: 409, error: 'This card was already used or cancelled.' };
    return { ok: true, state: 'cancelled', result: 'Cancelled. Nothing was changed.' };
  } catch (err) {
    log.warn('homeroom-bot-admin', 'Could not cancel an admin action', { actionId, err: err.message });
    return { ok: false, status: 500, error: 'That did not work just now' };
  }
}

Object.assign(module.exports, {
  TOOLS,
  READS,
  WRITES,
  CARD_TTL_MS,
  PROD_DEBUG_TOOLS,
  PROD_DEBUG_REFUSAL,
  isAdminCtx,
  freshAdmin,
  ownChatWithBot,
  prodDebugOffered,
  prodDebugTools,
  maskPersonal,
  statusForModel,
  rowsForModel,
  dbReadIn,
  curatedTools,
  modelTool,
  rowsOf,
  sealedInputOf,
  outcomeLine,
  boundedResult,
  confirmAction,
  cancelAction,
});
