'use strict';

// Homeroom bot's tools, each defined once (docs/plans/bot-one-model.md,
// step 2). A tool is a name, a description and a JSON schema for the model,
// the scopes it is offered in, and the handler a call runs. A thread kind's
// profile names the tools it offers (src/services/bot-profiles/); a surface
// builds the model's tool array with `toolsFor` and runs a call with `run`.
//
// Scopes are where the tool is offered, by what the thread already knows:
//   main     a person's chat with the bot (Main, and a private thread in it)
//   design   a design thread
//   thread   a project's own thread: a request's, a change's, its chat, a
//            reply thread, and the already-done check; the project is the
//            thread's
// A tool may say more or less in each (`schemaFor`): on a project's thread
// the project is never an argument, in Main it always is.
//
// Names the model already uses are kept, so the prompts and what they teach
// it do not move.

const SCOPES = Object.freeze(['main', 'design', 'thread']);

const TOOLS = new Map();

/**
 * Define a tool once: { name, scopes, schemaFor(scope) → { description,
 * parameters }, run(args, ctx) }. `ctx` is the surface's: { pool, user,
 * scope, app (the thread's project), deps }. A second definition of a name
 * is a mistake, and throws.
 */
function define(tool) {
  if (!tool || typeof tool.name !== 'string' || !/^[a-z][a-z0-9_]{1,63}$/.test(tool.name)) {
    throw new Error('bot-tools: a tool needs a snake_case name');
  }
  if (TOOLS.has(tool.name)) throw new Error(`bot-tools: ${tool.name} is defined twice`);
  const scopes = Array.isArray(tool.scopes) ? tool.scopes : [];
  if (!scopes.length || scopes.some((s) => !SCOPES.includes(s))) {
    throw new Error(`bot-tools: ${tool.name} names no known scope`);
  }
  if (typeof tool.schemaFor !== 'function' || typeof tool.run !== 'function') {
    throw new Error(`bot-tools: ${tool.name} needs schemaFor and run`);
  }
  TOOLS.set(tool.name, Object.freeze({ ...tool, scopes: Object.freeze([...scopes]) }));
  return TOOLS.get(tool.name);
}

/** The defined tool `name`, or null. */
function get(name) {
  return TOOLS.get(String(name || '')) || null;
}

/** Pure: the model's entry for one tool in one scope, in the chat-completions shape every surface sends. */
function entry(tool, scope) {
  const { description, parameters } = tool.schemaFor(scope);
  return { type: 'function', function: { name: tool.name, description, parameters } };
}

/**
 * The model's tool array for `names` in `scope`, in that order. A name not
 * defined, or not offered in the scope, throws: a profile that lists one is
 * a mistake found at its first turn, not a tool the model never sees.
 */
function toolsFor(names, scope) {
  if (!SCOPES.includes(scope)) throw new Error(`bot-tools: no scope ${scope}`);
  return (names || []).map((name) => {
    const tool = get(name);
    if (!tool) throw new Error(`bot-tools: no tool ${name}`);
    if (!tool.scopes.includes(scope)) throw new Error(`bot-tools: ${name} is not offered in ${scope}`);
    return entry(tool, scope);
  });
}

/** Whether `name` is a defined tool offered in `scope`. */
function offers(name, scope) {
  const tool = get(name);
  return !!tool && tool.scopes.includes(scope);
}

/** Run a call: the tool's handler with its arguments and the surface's context. */
async function run(name, args, ctx) {
  const tool = get(name);
  if (!tool) return { error: `There is no tool called ${name}.` };
  if (!ctx || !tool.scopes.includes(ctx.scope)) return { error: `${name} is not offered here.` };
  return tool.run(args && typeof args === 'object' && !Array.isArray(args) ? args : {}, ctx);
}

/** The defined names, for tests and the admin console. */
function names() {
  return [...TOOLS.keys()];
}

module.exports = { SCOPES, define, get, entry, toolsFor, offers, run, names };
