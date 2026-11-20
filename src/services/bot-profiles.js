'use strict';

// Homeroom bot's thread kinds, each with its profile (docs/plans/bot-one-model.md,
// step 5). A thread is the unit the bot answers in: a thread of a person's
// chat with it (a private thread; 14 Nov 2026: Main Chat is gone, and so is
// its kind `main`: every message there is in a thread), or a project's
// thread (a request's, a change's, its chat or a topic, a reply thread).
// Each kind's profile is data: the surface that runs its turn on the turn
// engine, the scope of the tools it offers (src/services/bot-tools/), the
// tools it may offer, its limits, the prompt section it speaks from, and, on
// a project's thread, when it speaks (`speaks`, the rules src/services/
// homeroom-bot-voice.js gate runs in this order). The surfaces read their
// limits from here; tests/bot-profiles.test.js holds each surface to its
// profile.
//
// Step 6 (19 Nov 2026): one agent per private thread. A private thread had
// three speakers (the chat, the designer, the live draft's bot), picked by
// the thread's state before any model read the message. It has one now: the
// private profile, which gains a CAPABILITY by the thread's state (a design
// it holds or starts, a live draft open in it). That capability's tools, its
// prompt section and its limits are added to the chat's own turn, and only
// in those threads (CAPABILITIES below).
//
// When the bot speaks is unchanged (decision 9): today's rules, written down.

const KINDS = Object.freeze(['private', 'request', 'change', 'channel', 'reply']);

// A project's thread kind, by the place type the chat stores it under.
const PLACE_KIND = Object.freeze({ issue: 'request', session: 'change', chat: 'channel', category: 'channel', message: 'reply' });

// A person's chat with the bot: a private thread in it.
const CHAT_LIMITS = Object.freeze({
  rounds: 16,
  readsPerTurn: 8,
  // Task 2020: a long answer's reply carries its words and the same answer
  // laid out as HTML (homeroom-bot-html.js), so a round has twice the room
  // it had (4000, retried at 8000). Every provider of the bot's model takes
  // far more (OpenRouter's endpoints list 131,072 and up, 6 Nov 2026), and
  // room that is not written is not paid for.
  outputTokens: 8000,
  retryOutputTokens: 16000,
  requestTimeoutMs: 90_000,
  turnsPerHour: 120,
  history: 24,
  // Offers under one reply (bot-cards.js MAX_PER_REPLY).
  offers: 3,
  // Cards a reply names (requests, changes, projects).
  cards: 3,
});

// A project's thread: one reply, short and quick, by the place's rules.
const THREAD_LIMITS = Object.freeze({
  rounds: 8,
  readsPerTurn: 4,
  // Task 2020 follow-up: a reply longer than two short lines carries its
  // laid-out copy beside its words (homeroom-bot-html.js), so a round has
  // room for both (it was 900). Room that is not written is not paid for.
  outputTokens: 4000,
  requestTimeoutMs: 45_000,
  turnsPerHour: 30,
  replyChars: 2000,
  offers: 1,
  answerWindowMinutes: 60,
  continueMinutes: 30,
});

// The design capability (design-bot.js openSession): its limits, which the
// turn's grow to once its tools are loaded. Its rounds count from the round
// the design opened in (drawByRound, readUntilRound).
const DESIGN_LIMITS = Object.freeze({
  rounds: 12,
  drawByRound: 8,
  readUntilRound: 7,
  // #6358: a long screen (a recipe home) is drawn to the end. A step gets
  // four times the room it had (4096), a draw cut off at its limit is asked
  // again with twice that, and a step may take three minutes instead of a
  // minute and a half. Room that is not written is not paid for.
  outputTokens: 16000,
  retryOutputTokens: 32000,
  requestTimeoutMs: 180_000,
  history: 16,
  replyChars: 1500,
  editsPerCall: 16,
});

// Artifacts, stage 2 (docs/plans/artifacts.md): the artifact capability
// (artifact-session.js), for a thread that holds a plain page, or a turn
// that starts one. Cheap on purpose: it reads no project code and looks at
// no render, so it needs fewer rounds than a design. A step may still write
// a whole page (16,000 output tokens, twice that when cut off), which is why
// a page is written once and then changed with exact edits; and the model is
// shown, and may edit, a version of at most `versionChars`.
const ARTIFACT_LIMITS = Object.freeze({
  rounds: 8,
  outputTokens: 16000,
  retryOutputTokens: 32000,
  requestTimeoutMs: 180_000,
  history: 16,
  replyChars: 1500,
  editsPerCall: 16,
  versionChars: 120_000,
});

// The draft capability (live-draft-bot.js openSession): a private thread
// with an open live draft (services/live-drafts.js), whose code the turn
// changes while its preview runs beside the chat. It reads some code,
// edits, saves (the preview restarts) and replies; a save that stops the
// app is fixed in the same turn, so it may save a few times. 20 Nov 2026
// (live-draft review, A): it may look at its preview twice a turn
// (look_at_preview, a capture job each), after a save and after its fix.
const DRAFT_LIMITS = Object.freeze({
  rounds: 18,
  appliesPerTurn: 3,
  looksPerTurn: 2,
  editsPerCall: 16,
  outputTokens: 16000,
  retryOutputTokens: 32000,
  requestTimeoutMs: 180_000,
  history: 16,
  replyChars: 1500,
});

const CHAT_TOOLS = Object.freeze([
  'progress', 'my_work', 'request_detail', 'my_projects', 'list_source', 'read_source', 'get_spec', 'answer_question',
  'revise_proposal', 'comment_on_request', 'start_request', 'offer_request', 'offer_move_request',
  'offer_copy_request', 'offer_close_request', 'withdraw_proposal', 'start_design', 'write_artifact', 'open_app_preview', 'close_thread',
  'report_problem', 'offer_new_project', 'change_plan', 'reply',
]);
// What each capability adds to the private profile's tools (step 6). The
// design's reads of its project's code and board are its own: they read the
// design's project unless another is named, and stop once its reading is
// over. The chat's own reply, close_thread and offer_request serve it.
const DESIGN_TOOLS = Object.freeze([
  'write_artifact', 'edit_artifact', 'list_source', 'read_source', 'read_plan', 'compare_versions',
  'make_pictures', 'offer_plan', 'offer_project', 'list_requests', 'get_request', 'capture_page',
]);
const DRAFT_TOOLS = Object.freeze([
  'list_files', 'search_code', 'read_file', 'edit_file', 'write_file', 'apply_changes', 'look_at_preview',
]);
// Artifacts, stage 2: what every kind of artifact is written and changed
// with (src/services/bot-tools/artifact.js). The chat's own reply and
// close_thread serve it.
const ARTIFACT_TOOLS = Object.freeze(['write_artifact', 'edit_artifact', 'show_artifact', 'compare_artifacts']);
// Every project thread offers these; each kind adds its own.
const THREAD_TOOLS = Object.freeze([
  'reply', 'stay_quiet', 'request_detail', 'read_message', 'list_source', 'read_source', 'update_change',
  'update_change_description', 'let_try_again', 'tell_me_when', 'get_change', 'get_discussion', 'list_requests',
]);

// The checks every project thread makes first, in this order
// (homeroom-bot-voice.js gate).
const THREAD_CHECKS = Object.freeze([
  'switched_on', 'not_paused', 'a_person', 'a_plain_message', 'connector_place', 'not_relayed', 'has_the_bot', 'connector_loop',
]);

const profile = (kind, fields) => Object.freeze({ kind, ...fields });

const PROFILES = Object.freeze({
  // A private thread in their chat (an ask, a draft, an idea, the bot's
  // hello, a first version, Earlier chat), and a request card's thread from
  // before (decision 10): the chat's turn, told which thread it is in.
  // `scope: 'main'` is the tools' scope (src/services/bot-tools/), which
  // kept its name: the tools of the person's own chat with the bot.
  // Step 6: every message in a private thread is this profile's turn, with
  // the capabilities the thread's state gives it (CAPABILITIES).
  private: profile('private', {
    surface: 'chat', scope: 'main', prompt: 'private', limits: CHAT_LIMITS, tools: CHAT_TOOLS, threadTools: true, platformReads: true,
    capabilities: Object.freeze(['design', 'draft', 'artifact']),
  }),
  request: profile('request', {
    surface: 'thread', scope: 'thread', prompt: 'request', places: ['issue'], limits: THREAD_LIMITS,
    // Step 5 (11 Nov 2026): ask_changed reads it again for a comment that
    // changes what it asks for; nothing else said there does.
    tools: Object.freeze([...THREAD_TOOLS, 'get_spec', 'start_request', 'offer_close_request', 'offer_copy_request', 'offer_withdraw', 'change_plan', 'ask_changed', 'make_pictures', 'attach_files', 'show_change', 'list_change_files']),
    // Words passed on as a change are the follow-up's; the bot's own change
    // up for a vote answers anyone; the requester or an admin straight after
    // a post of the bot's is answering it; else only a mention or a reply,
    // and never one that answers its question (the build reads that).
    speaks: Object.freeze([...THREAD_CHECKS, 'not_queued_as_ask', 'own_change_up', 'followed_a_post', 'go_ahead_reply', 'addressed_or_stop', 'not_an_answer', 'speak_addressed']),
  }),
  change: profile('change', {
    surface: 'thread', scope: 'thread', prompt: 'change', places: ['session'], limits: THREAD_LIMITS,
    // #6389: the change's author (or its request's requester, once it is
    // abandoned) may ask the bot to make its own version of a change made
    // outside Homeroom.
    tools: Object.freeze([...THREAD_TOOLS, 'get_spec', 'offer_withdraw', 'make_own_version', 'make_pictures', 'attach_files', 'show_change', 'list_change_files']),
    speaks: Object.freeze([...THREAD_CHECKS, 'not_queued_as_ask', 'own_change', 'followed_change_post', 'addressed']),
  }),
  channel: profile('channel', {
    surface: 'thread', scope: 'thread', prompt: 'channel', places: ['chat', 'category'], limits: THREAD_LIMITS,
    tools: Object.freeze([...THREAD_TOOLS, 'offer_request', 'offer_close_request']),
    speaks: Object.freeze([...THREAD_CHECKS, 'addressed']),
  }),
  reply: profile('reply', {
    surface: 'thread', scope: 'thread', prompt: 'reply', places: ['message'], limits: THREAD_LIMITS,
    tools: Object.freeze([...THREAD_TOOLS, 'offer_request', 'offer_close_request', 'make_pictures', 'attach_files']),
    speaks: Object.freeze([...THREAD_CHECKS, 'addressed', 'continued']),
  }),
});

// Step 6: what a private thread's turn adds by the thread's state. Each is
// loaded only where it applies (a thread that holds a design, or a turn that
// starts one with start_design; a thread whose live draft is open, or a turn
// that opens one with open_app_preview), so an ordinary chat costs what it
// did: its tools, its prompt section (`prompt`) and its limits, which the
// turn's rounds, room and clock grow to while it is loaded. `scope` is its
// tools' scope (src/services/bot-tools/; a draft's tools are its own).
const CAPABILITIES = Object.freeze({
  design: Object.freeze({ capability: 'design', scope: 'design', prompt: 'design', limits: DESIGN_LIMITS, tools: DESIGN_TOOLS }),
  draft: Object.freeze({ capability: 'draft', scope: 'draft', prompt: 'draft', limits: DRAFT_LIMITS, tools: DRAFT_TOOLS }),
  // Artifacts, stage 2: a thread that holds a plain page, or a turn that
  // writes one (write_artifact). A design is an artifact too, of the design
  // kind, and keeps its own capability and tools above.
  artifact: Object.freeze({ capability: 'artifact', scope: 'artifact', prompt: 'artifact', limits: ARTIFACT_LIMITS, tools: ARTIFACT_TOOLS }),
});

/** A thread kind's profile; throws for a kind there is none of. */
function profileOf(kind) {
  const found = PROFILES[kind];
  if (!found) throw new Error(`bot-profiles: no thread kind ${kind}`);
  return found;
}

/** The kind of a project's thread, by its place ({ type, ref }), or null. */
function kindOfPlace(place) {
  return PLACE_KIND[place?.type] || null;
}

/** A project thread's profile, by its place. */
function profileOfPlace(place) {
  const kind = kindOfPlace(place);
  return kind ? PROFILES[kind] : null;
}

/**
 * The kind of a thread in a person's chat with the bot: always private (a
 * request card's thread from before among them). 14 Nov 2026: there is no
 * Main Chat; a message in no other thread is its own thread's first
 * (homeroom-bot-dm.js messageThread). Step 6: a design or a live draft in
 * the thread is a capability of its turn (capabilitiesInChat), never a kind.
 */
function kindInChat() {
  return 'private';
}

/** A capability's profile data (CAPABILITIES); throws for one there is none of. */
function capabilityOf(name) {
  const found = CAPABILITIES[name];
  if (!found) throw new Error(`bot-profiles: no capability ${name}`);
  return found;
}

/**
 * Step 6: the capabilities a private thread's turn starts with, by what the
 * chat found in the thread (homeroom-bot-dm.js answerUserMessage):
 * `threadDesign` (the artifact it holds: a design, or a plain page, by its
 * `artifactKind`) and `threadLiveDraft` (a live draft open in it). A turn
 * may load one as it runs (start_design, write_artifact, open_app_preview).
 */
function capabilitiesInChat({ threadDesign = null, threadLiveDraft = null } = {}) {
  const held = threadDesign ? [threadDesign.artifactKind === 'page' ? 'artifact' : 'design'] : [];
  return [...held, ...(threadLiveDraft ? ['draft'] : [])];
}

/**
 * Step 6: the limits a private thread's turn runs with while `loaded` (the
 * capabilities its tools are loaded for): each the larger of the chat's and
 * theirs, so a turn grows only where a capability needs it.
 */
function turnLimits(loaded = []) {
  const caps = (Array.isArray(loaded) ? loaded : []).map(capabilityOf);
  const most = (key) => Math.max(CHAT_LIMITS[key] || 0, ...caps.map((c) => c.limits[key] || 0));
  return {
    rounds: most('rounds'),
    outputTokens: most('outputTokens'),
    retryOutputTokens: most('retryOutputTokens'),
    requestTimeoutMs: most('requestTimeoutMs'),
  };
}

module.exports = {
  KINDS, PLACE_KIND, CHAT_LIMITS, THREAD_LIMITS, DESIGN_LIMITS, DRAFT_LIMITS, ARTIFACT_LIMITS, THREAD_CHECKS, PROFILES, CAPABILITIES,
  CHAT_TOOLS, DESIGN_TOOLS, DRAFT_TOOLS, ARTIFACT_TOOLS,
  profileOf, kindOfPlace, profileOfPlace, kindInChat, capabilityOf, capabilitiesInChat, turnLimits,
};
