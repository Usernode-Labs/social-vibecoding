'use strict';

// #6071: design threads. A person captures a screen they are looking at (a
// Homeroom page, or an app on its App tab) and it opens as a private thread
// in their chat with Homeroom bot: the screen as self-contained HTML, drawn
// beside the chat in a sandboxed preview (frontend/src/features/messages/
// design-pane.tsx). They say what to change, in words or pinned to a point
// on the preview, and the bot edits it (services/design-bot.js): every edit
// is the next version. Nothing in it is public until they tap Propose it,
// which files a request on the screen's project whose plan holds the first
// version and the one they chose, side by side, without their scripts.
//
//   private_threads   kind 'design', the thread's row (services/private-threads.js)
//   design_threads    what it is of: title, Homeroom or an app, route, size
//   design_versions   1 the capture, then each of the bot's edits
//
// Every read is the thread's owner's alone: a design thread is in their
// private chat, and nobody else's request can name one.
//
// 1 Nov 2026 (threads, one loop, C1): a design is something any private
// thread in the chat can hold, not only one opened from a capture: a "+"
// thread, an idea, a thread about a request or a change, a draft. The bot
// draws a screen from words there (design-bot.js write_screen), and the
// first version it writes gives the thread its rows (ensureDesign): a
// private_threads row when it had none (a thread off their own message) and
// its design_threads row. A design for no project yet is drawn with the
// native kit (surface 'new'). Main Chat holds none: asked to draw there,
// the bot opens a private thread for it first (openDrawThread).

const log = require('./logger');
// Artifacts, stage 1 (docs/plans/artifacts.md): a design is one KIND of
// artifact. Its rows, its versions and its pins are the artifact store's
// (./artifacts.js, the one module that reads and writes design_threads and
// design_versions); this file is what is a design's alone: opening a thread
// for a captured screen, the words a version is said with, and the hand-off
// from a design to a plan.
const store = require('./artifacts');

const { MAX_HTML_BYTES, MAX_TITLE, MAX_VERSIONS, validHtml, clipWords, versionOf, addVersion, noteVersionMessage, pinFor } = store;
const MAX_NOTE = store.MAX_NOTE;
const SURFACES = new Set(['platform', 'app']);
// What a design the bot draws is of: Homeroom's own pages, a project's app,
// or a project that does not exist yet (migration 0004).
const DRAWN_SURFACES = store.SURFACES;
// The two sizes a drawn screen comes in (write_screen's `size`), as a plan's
// screens are drawn (spec-html.js).
const SCREEN_SIZES = store.VIEWPORTS;

function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function id(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const size = store.size;

/**
 * The artifact of the thread a message is in, when it is one of the
 * person's threads that holds one: the artifact (designFor), or null.
 *
 * 20 Nov 2026 (live-draft review, K): a thread holds several, and a turn
 * opens the one the person has open (openArtifactOf), with `opened` saying
 * how that was known. A thread that holds one opens it, as always.
 */
async function threadOf(pool, { userId, conversationId, message }) {
  try {
    let rootId = id(message?.threadRootId ?? message?.thread_root_id);
    if (!rootId && message?.id) {
      const { rows: [row] = [] } = await pool.query(
        'SELECT thread_root_id FROM conversation_messages WHERE id = $1 AND conversation_id = $2',
        [Number(message.id), Number(conversationId)],
      );
      rootId = id(row?.thread_root_id);
    }
    if (!rootId) return null;
    const first = await designFor(pool, { userId, rootId });
    if (!first || (first.artifacts || []).length < 2) return first;
    const open = await openArtifactOf(pool, { conversationId, message, threadId: first.threadId, artifacts: first.artifacts });
    const held = open.artifactId === first.artifactId
      ? first
      : await designFor(pool, { userId, rootId, artifactId: open.artifactId });
    return held ? { ...held, opened: open.by } : { ...first, opened: 'newest' };
  } catch {
    return null;
  }
}

/**
 * 20 Nov 2026 (live-draft review, K): which of a thread's artifacts a
 * message is about, so its turn opens that one: { artifactId, by }. In this
 * order: the one the person's screen showed when they sent it
 * (metadata.showing.artifactId, which the client sends), the one a comment
 * was pinned on (metadata.designPin; a pin from before names none and was
 * on the first), the one whose version the message replies to, else the
 * one the bot wrote last ('newest').
 */
async function openArtifactOf(pool, { conversationId, message, threadId, artifacts = [] }) {
  const has = (n) => !!n && artifacts.some((a) => a.artifactId === n);
  // The stored row's metadata, not the message as a reader was shown it
  // (conversations.js personMetadata keeps only a pin).
  let meta = message?.metadata;
  let replyTo = id(message?.reply?.id ?? message?.replyToId ?? message?.reply_to_id);
  if (id(message?.id)) {
    const { rows: [row] = [] } = await pool.query(
      'SELECT metadata, reply_to_id FROM conversation_messages WHERE id = $1 AND conversation_id = $2',
      [Number(message.id), Number(conversationId)],
    );
    if (row) meta = row.metadata;
    if (!replyTo) replyTo = id(row?.reply_to_id);
  }
  const showing = id(meta?.showing?.artifactId);
  if (has(showing)) return { artifactId: showing, by: 'showing' };
  const pin = meta?.designPin;
  if (pin && typeof pin === 'object') {
    const pinned = pin.artifactId == null ? store.FIRST : id(pin.artifactId);
    if (has(pinned)) return { artifactId: pinned, by: 'pin' };
  }
  if (replyTo) {
    const { rows: [quoted] = [] } = await pool.query(
      'SELECT metadata FROM conversation_messages WHERE id = $1 AND conversation_id = $2', [replyTo, Number(conversationId)]);
    const said = quoted?.metadata?.homeroomBot;
    if (said && id(said.designVersion)) {
      const of = said.artifactId == null ? store.FIRST : id(said.artifactId);
      if (has(of)) return { artifactId: of, by: 'reply' };
    }
  }
  const newest = await store.newestWritten(pool, { threadId });
  return { artifactId: has(newest) ? newest : store.FIRST, by: 'newest' };
}

/**
 * The artifact one of the person's threads holds, by its first message
 * (artifacts.js artifactFor), whatever its kind: { threadId, rootId,
 * conversationId, state, number, kind, about, app, artifactKind, title,
 * surface, route, viewport, width, height, latest, versions } (versions
 * without their HTML), or null when it is not theirs or holds none. 1 Nov
 * 2026: any private thread of theirs, whatever the thread's kind.
 */
const designFor = store.artifactFor;

/**
 * Pure (artifacts, stage 2): whether a thread's artifact is a design, the
 * one kind that may leave its thread: as a plan (postDesignPlan), or as the
 * first screen of a new project (homeroom-bot-dm.js designForProject, the
 * POST /api/apps route). A plain page never does: it is its author's alone.
 * A row from before kinds were stored is a design.
 */
function isDesign(artifact) {
  return !!artifact && store.kindOf(artifact.artifactKind || 'design').kind === 'design';
}

// What a design path answers for a thread whose artifact is not a design.
const NOT_A_DESIGN = Object.freeze({ ok: false, status: 409, error: 'not_a_design' });

/**
 * #6680 (15 Nov 2026): the viewer's own private thread that filed a request,
 * or posted its plan there, by its root message: { rootId } or null. Read for
 * the viewer alone, so nobody else's read can learn a private thread exists
 * (the request page offers the link only to its owner). The newest such
 * thread when more than one is tied to the request. Never throws.
 *
 * Artifacts, stage 4 (light): when the thread holds a design and the
 * viewer's plan on the request was made from it, also the version that plan
 * shows (`designVersion`, stored on the plan since stage 0), so the request
 * page offers its author a door to the design itself, running, at that
 * version. Only its author ever gets it, and the design is read only by its
 * owner (artifacts.js): no path shows it to anyone else.
 */
async function threadForRequest(pool, { userId, appId, number }) {
  const user = id(userId);
  const app = id(appId);
  const request = id(number);
  if (!user || !app || !request) return null;
  try {
    // 20 Nov 2026 (live-draft review, K): and which artifact of the thread
    // it was (design_artifact_id; null on a plan from before: the first).
    const { rows: [row] } = await pool.query(
      `SELECT p.root_message_id, plan.design_version, plan.design_artifact_id
         FROM private_threads p
         LEFT JOIN LATERAL (
           SELECT s.design_version, s.design_artifact_id
             FROM chat_session_specs s
             JOIN chat_sessions cs ON cs.id = s.session_id
            WHERE s.design_thread_id = p.id AND cs.user_id = p.user_id AND cs.app_id = p.app_id
              AND cs.source = 'request_spec' AND cs.created_from_issue_number = p.result_ref
              AND s.shared_to_group_at IS NOT NULL
            ORDER BY s.shared_to_group_at DESC, s.id DESC
            LIMIT 1
         ) plan ON TRUE
        WHERE p.user_id = $1 AND p.app_id = $2 AND p.result_ref = $3 AND p.state IN ('filed', 'posted')
        ORDER BY p.updated_at DESC
        LIMIT 1`,
      [user, app, request],
    );
    if (!row) return null;
    const found = { rootId: Number(row.root_message_id) };
    const version = Number(row.design_version);
    if (!(Number.isSafeInteger(version) && version > 0)) return found;
    const artifactId = id(row.design_artifact_id) || store.FIRST;
    // A design's only: what the thread holds is the store's to say, and a
    // plain page is never a plan's design. `artifactId` only for a later
    // artifact: none means the first.
    const held = await designFor(pool, { userId: user, rootId: found.rootId, artifactId });
    if (!isDesign(held)) return found;
    return { ...found, designVersion: version, ...(artifactId !== store.FIRST ? { artifactId } : {}) };
  } catch (err) {
    log.warn('design-threads', 'Could not read the thread a request came from', { err: err.message });
    return null;
  }
}

/** Pure: what a design for `app` is of: Homeroom's own pages, a project's app, or a project not made yet. */
function surfaceFor(config, app) {
  if (!app?.slug) return 'new';
  return config?.selfAppSlug && app.slug === config.selfAppSlug ? 'platform' : 'app';
}

/**
 * A thread of the person's chat with the bot that the bot may draw a design
 * in, by its first message, whether or not it holds one yet: { rootId,
 * conversationId, threadId, kind, app: { id, slug, name } | null, about }
 * (`threadId` null for a thread with no private_threads row: one off their
 * own message, or off a line of the bot's), or null for anything else: a
 * reply, another chat's, a deleted line, or a row of somebody else's.
 */
async function draftingThread(pool, { userId, botId, rootId }) {
  const root = id(rootId);
  if (!root || !id(userId) || !id(botId)) return null;
  const { rows: [row] } = await pool.query(
    `SELECT m.id, m.conversation_id, p.id AS thread_id, p.user_id AS owner_id, p.kind,
            p.about_kind, p.about_number, a.id AS app_id, a.slug, a.name
       FROM conversation_messages m
       JOIN conversations c ON c.id = m.conversation_id AND c.kind = 'direct'
       JOIN conversation_members me ON me.conversation_id = m.conversation_id AND me.user_id = $2
       JOIN conversation_members b ON b.conversation_id = m.conversation_id AND b.user_id = $3
       LEFT JOIN private_threads p ON p.root_message_id = m.id
       LEFT JOIN apps a ON a.id = p.app_id
      WHERE m.id = $1 AND m.thread_root_id IS NULL AND m.deleted_at IS NULL`,
    [root, Number(userId), Number(botId)],
  );
  if (!row || (row.thread_id != null && Number(row.owner_id) !== Number(userId))) return null;
  return {
    rootId: Number(row.id),
    conversationId: Number(row.conversation_id),
    threadId: row.thread_id == null ? null : Number(row.thread_id),
    kind: row.kind || 'idea',
    app: row.slug ? { id: Number(row.app_id), slug: row.slug, name: row.name || row.slug } : null,
    about: row.about_kind && row.about_number ? { kind: row.about_kind, number: Number(row.about_number) } : null,
  };
}

/**
 * The design a thread holds, made the first time the bot draws in it
 * (artifacts.js ensureArtifact, kind 'design'): its private_threads row
 * when it has none, given `app` when it was in no project, and its artifact
 * row (`title`, the surface its project makes it, the size drawn at). A
 * design it holds already takes the size of its newest screen. Resolves the
 * design (designFor), or null when the thread is not one the person may
 * draw in.
 */
async function ensureDesign(pool, config, {
  user, thread, app = null, title, size: sized = 'phone', surface: givenSurface = null, route = null, artifactId = null, fresh = false,
}) {
  if (!user?.id || !thread?.rootId) return null;
  const project = thread.app || app || null;
  const surface = givenSurface || surfaceFor(config, project);
  // 20 Nov 2026 (live-draft review, K): `artifactId` names the design it
  // draws again; `fresh` makes a new one, the thread's next artifact.
  return store.ensureArtifact(pool, {
    user, thread, app, kind: 'design', title, viewport: SCREEN_SIZES[sized] ? sized : 'phone',
    surface: DRAWN_SURFACES.has(surface) ? surface : 'new', route, artifactId, fresh,
  });
}

/** Pure: a note without a leading "Version N:", which the thread line adds. */
function bareNote(note) {
  let said = String(note ?? '').trim();
  for (;;) {
    const next = said.replace(/^\s*version\s+\d+\s*[:.\-–]\s*/i, '').trim();
    if (next === said) return said;
    said = next;
  }
}

/**
 * Pure: what a version's message says: "Version N: <summary>." Step 6
 * (#6864): the summary is the one line the turn wrote for the version
 * (the reply's summary), never a join of its edits' notes, and it is
 * shortened at a word's end, never mid-word. "Version N." with none.
 *
 * 20 Nov 2026 (live-draft review, K): `title`, given when the thread holds
 * more than one artifact, names which one: "Layouts, version 2: <summary>."
 * A summary that already starts with those words does not say them twice.
 */
function versionLine(version, summary, { title = null } = {}) {
  const name = title ? clipWords(String(title), 60).replace(/[.!?…:,;]+$/, '') : '';
  let said = summary ? bareNote(summary) : '';
  if (name) {
    const lead = `${name}, version ${Number(version)}`.toLowerCase();
    if (said.toLowerCase().startsWith(lead)) said = said.slice(lead.length).replace(/^\s*[:.\-–]\s*/, '').trim();
  }
  said = said ? clipWords(said, MAX_NOTE) : '';
  const head = name ? `${name}, version ${version}` : `Version ${version}`;
  return said ? `${head}: ${said}${/[.!?…]$/.test(said) ? '' : '.'}` : `${head}.`;
}

/**
 * Open a design thread for a screen the person captured. The bot says so in
 * Main ("I opened a design thread…", metadata kind 'opened_design'), the row
 * is written, the capture is version 1, and the thread's first reply says
 * it. Resolves { ok, conversationId, rootId, href } or a refusal { ok: false,
 * status, error }.
 */
async function startDesign(pool, config, {
  user, html, surface, title, route = null, appSlug = null, width, height, deps = {},
}) {
  const dm = deps.dm || require('./homeroom-bot-dm');
  const mayor = deps.mayor || require('./homeroom-bot-mayor');
  if (!user?.id || user.isSynthetic) return { ok: false, status: 403, error: 'Not available for this account' };
  // #6632: a design thread is the bot working for them.
  const locked = await require('./homeroom-bot-verified').refusalFor(pool, user, { botSvc: deps.botSvc });
  if (locked) return locked;
  const body = validHtml(html);
  if (!body) return { ok: false, status: 413, error: 'That screen is too big to capture. Try a smaller part of it.' };
  if (!SURFACES.has(surface)) return { ok: false, status: 400, error: 'Unknown screen' };
  const w = size(width);
  const h = size(height);
  const named = clip(title, MAX_TITLE);
  if (!w || !h || !named) return { ok: false, status: 400, error: 'Say what the screen is' };
  // Homeroom's own pages are Homeroom's project; an app's screen is that app's.
  const slug = surface === 'platform' ? config?.selfAppSlug : appSlug;
  const app = slug ? await mayor.findApp(pool, String(slug)) : null;
  if (!app || !(await mayor.canView(pool, app, user))) return { ok: false, status: 404, error: 'No such project' };
  const bot = deps.bot || await dm.botAccount(pool);
  if (!bot) return { ok: false, status: 503, error: 'Homeroom bot is not available' };
  const name = app.name || app.slug;
  const opened = await dm.sendDm(pool, {
    bot,
    userId: user.id,
    content: `I opened a thread for ${named} that only you can see. Tell me what to change there, `
      + 'or pin a comment on the preview, and I\'ll make the next version. Nothing is public until you propose it.',
    // The thread's first message, its row written with it (sendDm `thread`);
    // they captured the screen themselves, so its line is nothing new.
    thread: { kind: 'design', appId: app.id, read: true },
    moment: null,
    metadata: { kind: 'opened_design', appSlug: app.slug, appName: name, designTitle: named },
  });
  if (!opened?.messageId) return { ok: false, status: 502, error: 'The thread could not be opened just now.' };
  const { rows: [row] } = await pool.query(
    `INSERT INTO private_threads (user_id, conversation_id, root_message_id, app_id, kind, state)
     VALUES ($1, $2, $3, $4, 'design', 'open')
     ON CONFLICT (root_message_id) DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [user.id, opened.conversationId, opened.messageId, app.id],
  );
  await store.createFor(pool, { threadId: row.id, kind: 'design', title: named, surface, route, width: w, height: h });
  const first = await addVersion(pool, { threadId: row.id, html: body, author: 'capture', note: 'As it is now' });
  const said = await dm.sendDm(pool, {
    bot,
    userId: user.id,
    content: `${versionLine(first.version, `${named} as it is now`)} What should change?`,
    threadRootId: opened.messageId,
    moment: null,
    idempotencyKey: `design-${row.id}-v${first.version}`,
    metadata: { kind: 'design_version', appSlug: app.slug, appName: name, designVersion: first.version, artifactId: store.FIRST },
  }).catch((err) => {
    log.warn('design-threads', 'Could not say a design thread\'s first version', { err: err.message });
    return null;
  });
  await noteVersionMessage(pool, { threadId: row.id, version: first.version, messageId: said?.messageId });
  log.info('design-threads', 'Opened a design thread', { userId: user.id, app: app.slug, surface, bytes: Buffer.byteLength(body) });
  return {
    ok: true,
    conversationId: Number(opened.conversationId),
    rootId: Number(opened.messageId),
    // 1 Nov 2026: on the Homeroom bot tab, the chat's only place (frontend/src/features/ai/door.ts).
    href: `#homeroom-bot/thread/${Number(opened.messageId)}`,
  };
}

/**
 * Pure: the bot's line a thread it opened to draw a screen starts with, or,
 * for a plain page (`kind` 'page', artifact-session.js), to write one in.
 */
function drawLine({ title = null, appName = null, kind = 'design' } = {}) {
  if (kind === 'page') {
    return `I'm writing ${title ? `"${clip(title, 80)}"` : 'the page'} in a new thread. Only you can see it.`;
  }
  const what = title ? `"${clip(title, 80)}"` : 'the screen';
  return appName
    ? `I'm drawing ${what} for ${clip(appName, 80)} in a new thread. Only you can see it.`
    : `I'm drawing ${what} in a new thread. Only you can see it.`;
}

/**
 * A private thread opened to draw a screen in, as the "+" opens one
 * (private-threads.js startThread: the bot's line, metadata kind
 * 'opened_thread' with changeKind 'design', its row of kind 'ask'). 14 Nov
 * 2026: every message is in a thread, so a screen asked for is drawn in the
 * thread it was asked in (design-bot.js draw); this is for a caller with no
 * thread at all. Keyed by the message it answers, so a retry finds the same
 * thread. Resolves the thread (draftingThread's shape) or null.
 */
async function openDrawThread(pool, { user, app = null, title = null, messageId = null, kind = 'design', deps = {} }) {
  const dm = deps.dm || require('./homeroom-bot-dm');
  if (!user?.id || user.isSynthetic) return null;
  const bot = deps.bot || await dm.botAccount(pool);
  if (!bot) return null;
  const named = clip(title, MAX_TITLE) || null;
  const appName = app ? app.name || app.slug : null;
  // A plain page is of no project, and its thread is not a design's.
  const page = kind === 'page';
  const said = await dm.sendDm(pool, {
    bot,
    userId: user.id,
    content: drawLine({ title: named, appName, kind }),
    // The thread's first message, its row written with it (sendDm `thread`),
    // quoting what asked for the screen.
    replyToId: id(messageId),
    thread: { kind: 'ask', appId: !page && app?.id ? Number(app.id) : null },
    moment: null,
    idempotencyKey: id(messageId) ? `design-draw-${id(messageId)}` : null,
    metadata: {
      kind: 'opened_thread', changeKind: page ? 'any' : 'design',
      ...(named ? { designTitle: named } : {}),
      ...(app ? { appSlug: app.slug, appName } : {}),
    },
  });
  if (!said?.messageId) return null;
  return draftingThread(pool, { userId: user.id, botId: bot.id, rootId: said.messageId });
}

// ── Propose it ────────────────────────────────────────────────────────────

const MAX_PROPOSE_NOTES = 2000;
// The plan's own limits (spec-html.js): a screen is drawn at one of two
// sizes, and at most this tall.
const PLAN_MAX_HEIGHT = 2400;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Pure: one version as it goes into a plan's screen, script-free: its body's
 * markup inside a box that keeps the body's classes, after the <style>
 * blocks it carried (an app's own CSS travels that way). The plan's frame
 * draws it with the project's stylesheets (spec-html.js specStylesFor) and
 * cleans it again before it is drawn (frontend/src/lib/spec-html.ts).
 */
function screenMarkup(html) {
  const doc = String(html || '').replace(/<script\b[\s\S]*?<\/script\s*>/gi, '').replace(/<script\b[^>]*>/gi, '');
  const styles = (doc.match(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi) || []).join('\n');
  const body = /<body\b([^>]*)>([\s\S]*?)(?:<\/body\s*>|$)/i.exec(doc);
  const inner = body ? body[2] : doc.replace(/<\/?(?:!doctype|html|head)\b[^>]*>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  const bodyClass = body ? /\bclass\s*=\s*"([^"]*)"/i.exec(body[1])?.[1] || '' : '';
  return `${styles}<div class="${escapeHtml(bodyClass)}">${inner.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')}</div>`;
}

/**
 * Pure (#6407): the versions a design draws side by side on its after side:
 * each `[data-variant]` label, and which one carries `data-chosen`. A design
 * that draws one screen has no labels, so nothing is said about a choice.
 */
function designVariants(html) {
  const labels = [];
  let chosen = null;
  for (const m of String(html || '').matchAll(/<[a-z][\w-]*\b[^>]*\bdata-variant\s*=\s*"([^"]*)"[^>]*>/gi)) {
    const label = visibleText(m[1]);
    if (!label || labels.includes(label)) continue;
    labels.push(label);
    if (/\bdata-chosen\b/i.test(m[0])) chosen = label;
  }
  return { labels, chosen };
}

/** Pure (#6407): the plan's sentence naming the versions a design draws, and which one is chosen. */
function variantsSentence(variants) {
  const labels = variants?.labels || [];
  if (labels.length < 2) return null;
  const named = labels.map((label) => `"${label}"`).join(' and ');
  if (variants.chosen) {
    return `This artifact draws ${labels.length} versions side by side: ${named}. Build "${variants.chosen}", the chosen one; `
      + 'the others are there to compare.';
  }
  return `This artifact draws ${labels.length} versions side by side: ${named}. It does not say which one to build yet.`;
}

/**
 * Pure: the plan a design posts with. A design that began as a capture
 * shows version 1 and `version` side by side. 1 Nov 2026 (threads, one
 * loop: C2.1): one that did not (a screen drawn from words, the code or a
 * photo) is one screen: an empty state on the before side and the design
 * as data-side="after", the plans' rule for a screen that does not exist
 * yet (prompts.js). `before` is null then.
 */
function planHtml({ design, title, notes, before = null, after, version }) {
  const phone = design.width < 768;
  const height = Math.min(PLAN_MAX_HEIGHT, Math.max(phone ? 844 : 800, design.height));
  const where = design.route ? `${design.title} (${design.route})` : design.title;
  const said = notes ? `<p>${escapeHtml(notes).replace(/\n+/g, '</p><p>')}</p>` : '';
  // #6407: a board that draws several versions says which one is chosen, so
  // the choice is in the plan's own words and not only on the drawing.
  const variants = variantsSentence(designVariants(after));
  const chosenLine = variants ? `<p>${escapeHtml(variants)}</p>` : '';
  const captured = typeof before === 'string' && before.trim().length > 0;
  const empty = '<div style="min-height:100%;display:flex;align-items:center;justify-content:center;'
    + 'font:15px/1.4 system-ui,sans-serif;color:#71717a;padding:24px;text-align:center">'
    + `${escapeHtml(design.title)} is not there yet.</div>`;
  return [
    '<article data-spec>',
    `<h1>${escapeHtml(title)}</h1>`,
    captured
      ? `<p>An artifact for ${escapeHtml(design.title)}, made in a private thread with Homeroom bot.</p>`
      : `<p>An artifact for a new screen, ${escapeHtml(design.title)}, made in a private thread with Homeroom bot.</p>`,
    chosenLine,
    '<section data-spec-tab="user">',
    '<figure data-screens>',
    `<ol data-changes><li data-change="1" data-steps="${escapeHtml(where)}">${escapeHtml(notes ? notes.split('\n')[0] : title)}</li></ol>`,
    `<template data-screen data-size="${phone ? 'phone' : 'desktop'}" data-height="${height}">`,
    `<div data-side="before">${captured ? screenMarkup(before) : empty}</div>`,
    `<div data-side="after" data-change="1">${screenMarkup(after)}</div>`,
    '</template>',
    '</figure>',
    said,
    '</section>',
    '<section data-spec-tab="tech">',
    captured
      ? `<p>Before is the screen as it was captured (version 1); after is version ${Number(version)}, a mockup drawn with the`
        + ' screen\'s own stylesheets. Build it in the project\'s own code and components. Scripts the artifact used for'
        + ' its interactive states are left out of this plan.</p>'
      // "after is version N of the design": the words migration plan-design-source and
      // services/plan-design-source.js read a plan's version from (20 Nov 2026, L: kept as they are).
      : `<p>The screen is new: before is what is there today, nothing; after is version ${Number(version)} of the design, a`
        + ` mockup drawn with ${design.surface === 'new' ? 'Homeroom\'s own' : 'the project\'s'} stylesheets. Build it in`
        + ' the project\'s own code and components, as a screen of its own, and keep its words, its layout and what it'
        + ' shows. Scripts the artifact used for its interactive states are left out of this plan.</p>',
    chosenLine,
    '</section>',
    '</article>',
  ].join('\n');
}

// ── What a plan shows, against what the preview drew (#6353) ──────────────
//
// The preview runs a design's scripts (frontend/src/features/design/frame.ts,
// sandbox "allow-scripts"); a plan shows the same HTML through screenMarkup,
// which drops every <script>, and the frame draws it with sandbox "" (nothing
// runs). A screen whose rows a script builds was therefore blank in its plan.
// planGap says so before a plan is posted; planReadout reads a posted plan back.

/** Pure: the words a markup shows, without its tags or styles. */
function visibleText(markup) {
  return String(markup || '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// A script body that writes into the page (rather than, say, toggling a class).
const WRITES_PAGE_RE = /innerHTML\s*\+?=|insertAdjacentHTML|appendChild|\.append\(|replaceChildren|createElement|textContent\s*=|innerText\s*=/;

/** Pure: the visible words a script's string and template literals hold. */
function scriptWords(body) {
  const out = [];
  for (const m of String(body || '').matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)) out.push(m[2]);
  return visibleText(out.join(' ').replace(/\$\{[^}]*\}/g, ' '));
}

/**
 * Pure (#6353): whether a plan made from `html` would show clearly less than
 * the preview drew, because a script builds it: null, or { kind: 'lists' |
 * 'screen', empty, markupChars, scriptChars, reason }. Homeroom cannot run a
 * design's scripts on the server, so this is judged from the design itself: a
 * script that writes into the page and fills a box the plan leaves empty
 * ('lists'), or one that holds more words than the page does ('screen').
 */
function planGap(html) {
  const source = String(html || '');
  const bodies = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)(?:<\/script\s*>|$)/gi)].map((m) => m[1]);
  if (!bodies.length) return null;
  const writing = bodies.filter((body) => WRITES_PAGE_RE.test(body));
  if (!writing.length) return null;
  const stripped = screenMarkup(source);
  const ids = new Set();
  for (const body of writing) {
    for (const m of body.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) ids.add(m[1]);
    for (const m of body.matchAll(/querySelector\(\s*['"]#([^'"\s]+)['"]\s*\)/g)) ids.add(m[1]);
  }
  const empty = [];
  for (const name of ids) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`<([a-z][\\w-]*)[^>]*\\bid=["']${escaped}["'][^>]*>\\s*</\\1\\s*>`, 'i').test(stripped)) empty.push(name);
  }
  const scriptChars = scriptWords(writing.join(' ')).length;
  const markupChars = visibleText(stripped).length;
  if (empty.length) {
    return {
      kind: 'lists', empty, markupChars, scriptChars,
      reason: 'The plan would show its lists empty, because a script builds them.',
    };
  }
  if (scriptChars >= Math.max(40, markupChars)) {
    return {
      kind: 'screen', empty, markupChars, scriptChars,
      reason: 'The plan would show this screen mostly empty, because a script writes its words.',
    };
  }
  return null;
}

/** Pure: a markup's shape, as planReadout reports it. */
function markupCounts(part) {
  const html = String(part || '');
  let emptyLists = 0;
  for (const m of html.matchAll(/<(ul|ol|table|tbody)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
    if (!/<(?:li|tr)\b/i.test(m[2])) emptyLists += 1;
  }
  return {
    elements: (html.match(/<[a-z][\w-]*\b/gi) || []).length,
    lists: (html.match(/<(?:ul|ol|table|tbody)\b/gi) || []).length,
    rows: (html.match(/<(?:li|tr)\b/gi) || []).length,
    emptyLists,
  };
}

/**
 * Pure (#6353): a plan as it is drawn, since Homeroom bot cannot see a
 * picture: [{ size, sides: [{ side, text, elements, lists, rows, emptyLists }] }],
 * one per <template data-screen> and one per data-side part in it. Text is
 * the first 1500 characters of what the side shows.
 */
function planReadout(plan) {
  const source = String(plan || '');
  const screens = [];
  for (const m of source.matchAll(/<template\b[^>]*\bdata-screen\b[^>]*>([\s\S]*?)<\/template\s*>/gi)) {
    const open = m[0].slice(0, m[0].indexOf('>') + 1);
    const size = /\bdata-size\s*=\s*"([^"]*)"/i.exec(open)?.[1] || null;
    const body = m[1];
    const marks = [...body.matchAll(/<div\b[^>]*\bdata-side\s*=\s*"(before|after)"[^>]*>/gi)];
    const sides = marks.map((mark, i) => {
      const start = mark.index + mark[0].length;
      const end = i + 1 < marks.length ? marks[i + 1].index : body.length;
      const part = body.slice(start, end);
      return { side: mark[1], text: visibleText(part).slice(0, 1500), ...markupCounts(part) };
    });
    screens.push({ size, sides });
  }
  return screens;
}

// What a design may post from: a thread put away posts nothing.
const POSTABLE = new Set(['open', 'posted', 'filed']);

// #6151 (2 Nov 2026): a design filed as a request is Homeroom bot's to
// build: fileRequest queues it (reason dm_request) and the bot builds it a
// minute later. The line that said it was filed stopped at "…as its plan",
// and asked "will you build this now?" the design bot answered that it
// could not. The line now says what happens next, read off the new
// request's track (homeroom-bot-track.js standingOf): whether the bot has it
// in hand, and the limits it waits at.
// #6156: 'builds', the project's builds all under way, among them.
const FILED_LIMITS = new Set(['builds', 'slots', 'bot_wide', 'allowance']);

/**
 * Pure (#6151): what the filed line says happens next, from the new
 * request's track (null when the bot has none) and whether fileRequest
 * queued it: { say: 'builds', version } (Homeroom bot reads it next and
 * builds it from that version), { say: 'held', limit } (it builds it once
 * that limit frees), { say: 'person' } (the bot is off for the project, or
 * a person has it or must decide), or null for any other track. Codes,
 * never words: the client words them (frontend/locales/en/messages.json
 * bot.track.filed.*), as it words the track.
 */
function filedNext(track, { queued = false, version = null } = {}) {
  const v = Number(version);
  const builds = Number.isSafeInteger(v) && v > 0 ? { say: 'builds', version: v } : null;
  if (!track) return queued ? builds : { say: 'person' };
  const standing = require('./homeroom-bot-track').standingOf(track);
  if (standing.say === 'builds') return builds;
  if (standing.say === 'held') return FILED_LIMITS.has(standing.limit) ? { say: 'held', limit: standing.limit } : { say: 'person' };
  if (standing.say === 'person') return { say: 'person' };
  return null;
}

/**
 * 1 Nov 2026 (C2.1): the open request a design's plan goes on when nobody
 * names one: the request its thread is about (phase B's about columns), or
 * the request the design already posted on. Null for none.
 */
async function planTargetOf(pool, design) {
  if (!design?.threadId) return null;
  const { rows: [row] } = await pool.query(
    `SELECT p.about_kind, p.about_number, p.result_ref, p.state FROM private_threads p WHERE p.id = $1`,
    [design.threadId],
  );
  if (!row) return null;
  if (row.about_kind === 'request' && row.about_number) return Number(row.about_number);
  if (['posted', 'filed'].includes(row.state) && row.result_ref) return Number(row.result_ref);
  return null;
}

/**
 * Post a design as a plan (C2.1): `version` (the newest when none) of the
 * person's design thread `rootId`, under their name, on its project. With
 * `issueNumber`, on that open request, as the next version of their plan
 * there; null files a new request with the plan, as Propose it did. Said
 * in the thread; the thread stays private, the request and its plan are
 * public. Posted, the thread is 'posted' (or 'filed', a request it filed)
 * with the number, and may post again: the plan's next version. A plan on
 * the request lifts the bot's wait for one (request-specs.js
 * postRequestSpec, private-threads.js liftHold). Resolves { ok, state,
 * number, href, plan, version, app } or a refusal { ok: false, status,
 * error, code? }.
 *
 * 20 Nov 2026 (live-draft review, K): `artifactId` is which of the thread's
 * artifacts (none: its first), and the plan stores it beside the version.
 */
async function postDesignPlan(pool, config, {
  user, rootId, artifactId = null, version = null, issueNumber = null, title = null, notes = null, appId = null, allowEmptier = false,
  deps = {},
  // 18 Nov 2026: false when the offer's card that was tapped says it in
  // place (homeroom-bot-mayor.js settleOnCard): its line comes back as
  // `said`, and no message says it again.
  notice = true,
}) {
  const dm = deps.dm || require('./homeroom-bot-dm');
  const mayor = deps.mayor || require('./homeroom-bot-mayor');
  const specs = deps.requestSpecs || require('./request-specs');
  const design = await designFor(pool, { userId: user?.id, rootId, artifactId });
  if (!design) return { ok: false, status: 404, error: 'No such artifact' };
  // A plain page stays in its thread: nothing posts it, whoever asks.
  if (!isDesign(design)) return { ...NOT_A_DESIGN };
  if (!POSTABLE.has(design.state)) {
    return { ok: false, status: 409, error: 'already_done', state: design.state, number: design.number };
  }
  let app = null;
  if (design.app) {
    app = await mayor.findApp(pool, design.app.slug);
  } else if (Number.isSafeInteger(Number(appId)) && Number(appId) > 0) {
    // A screen with no project yet, filed on a project they named: the card
    // stored it on the action (homeroom-bot-mayor.js sendDesignOffer).
    const { rows: [row] } = await pool.query(
      `SELECT ${require('./app-access').nonSecretAppColumnList()} FROM apps WHERE id = $1`, [Number(appId)],
    );
    app = row || null;
  } else {
    return { ok: false, status: 404, error: 'This artifact has no project yet.' };
  }
  if (!app || !(await mayor.canView(pool, app, user))) return { ok: false, status: 404, error: 'No such project' };
  if (!(await mayor.canFile(pool, app, user))) {
    return { ok: false, status: 403, error: 'join_required', code: 'join_required', app: { slug: app.slug, name: app.name || app.slug } };
  }
  const after = await versionOf(pool, { userId: user.id, rootId, artifactId: design.artifactId, version });
  if (!after) return { ok: false, status: 404, error: 'No such version' };
  // #6353: the preview runs the design's scripts, the plan does not. A plan
  // that would show clearly less than the preview says so, and offers the
  // fix, instead of posting silently. A tap on the card that showed the
  // warning, and a first version's automatic plan, pass allowEmptier.
  const gap = planGap(after.html);
  if (gap && !allowEmptier) {
    return {
      ok: false, status: 409, code: 'plan_emptier', gap,
      error: `${gap.reason} Ask Homeroom bot to write them into the screen, then post it again.`,
    };
  }
  if (gap) {
    log.info('design-threads', 'Posted a plan emptier than its preview', {
      app: app.slug, userId: user.id, kind: gap.kind, empty: gap.empty,
    });
  }
  // Version 1 is "before" only when it was the screen as it was.
  const captured = design.versions[0]?.author === 'capture';
  const before = captured ? await versionOf(pool, { userId: user.id, rootId, artifactId: design.artifactId, version: 1 }) : null;
  if (captured && !before) return { ok: false, status: 404, error: 'No such version' };
  const n = issueNumber == null ? null : Number(issueNumber);
  if (n != null && !(Number.isSafeInteger(n) && n > 0 && n <= 2147483647)) return { ok: false, status: 400, error: 'Invalid request number' };
  const named = clip(title || `${design.title}`, MAX_TITLE);
  const said = String(notes || '').trim().slice(0, MAX_PROPOSE_NOTES);
  const plan = planHtml({
    design, title: named, notes: said, before: before ? before.html : null, after: after.html, version: after.version,
  });
  // Artifacts, stage 0: the plan's version stores which design it came from
  // (request-specs.js postRequestSpec), so nothing reads it out of its words.
  // K (20 Nov 2026): and which artifact of the thread.
  const source = { threadId: design.threadId, version: after.version, artifactId: design.artifactId || store.FIRST };
  // A later artifact files a request of its own: the keys below name it.
  const which = (design.artifactId || store.FIRST) === store.FIRST ? '' : `-a${design.artifactId}`;
  // A plan the plans would refuse is said before anything is filed.
  const checked = specs.prepareSpec(plan);
  if (!checked.ok) {
    return { ok: false, status: 413, error: 'This artifact is too big to go into a plan. Make the screen smaller, then post it again.' };
  }
  const name = app.name || app.slug;
  const repo = require('./repo-ref').ownerRepo(app.repo_url);
  const domain = deps.domain !== undefined ? deps.domain : require('./caddy').USERNODE_DOMAIN;
  const webPath = (number) => (domain ? `https://${domain}/#app/${app.slug}/dev/issues/${number}` : null);
  const bot = deps.bot || await dm.botAccount(pool);
  if (n != null) {
    // On a request: only one open now, as the plan route asks.
    const open = await specs.openRequest(app, n, deps);
    if (!open.ok) return { ok: false, status: open.status, error: open.error };
    let posted;
    try {
      posted = await specs.postRequestSpec(pool, {
        app, repo: open.repo, issueNumber: n, issueTitle: open.issue.title || null, user, text: plan, webPath: webPath(n),
        design: source,
      }, deps);
    } catch (err) {
      if (err instanceof specs.SpecError) return { ok: false, status: err.status, error: err.message };
      throw err;
    }
    await pool.query(
      `UPDATE private_threads
          SET state = CASE WHEN state = 'filed' AND result_ref = $2 THEN state ELSE 'posted' END,
              result_ref = $2, app_id = COALESCE(app_id, $3), updated_at = NOW()
        WHERE id = $1`,
      [design.threadId, n, app.id],
    );
    const postedLine = `Posted version ${after.version} as a plan on request #${n} on ${name}, under your name`
      + `${posted.version > 1 ? ` (the plan's version ${posted.version})` : ''}.`;
    if (notice) {
      await dm.sendDm(pool, {
        bot, userId: user.id, threadRootId: design.rootId, moment: null,
        idempotencyKey: `design-plan-${design.threadId}${which}-${n}-s${posted.sessionId}v${posted.version}`,
        content: postedLine,
        objects: [{ type: 'issue', appId: Number(app.id), issueNumber: n }],
      }).catch((err) => log.warn('design-threads', 'Could not say a design was posted as a plan', { err: err.message }));
    }
    log.info('design-threads', 'Posted a design as a plan', { app: app.slug, issueNumber: n, userId: user.id, version: after.version });
    return {
      ok: true, state: 'posted', number: n, plan: true, version: after.version, planVersion: posted.version,
      app: { slug: app.slug, name }, href: `#app/${encodeURIComponent(app.slug)}/dev/issues/${n}`,
      ...(notice ? {} : { said: postedLine }),
    };
  }
  const settings = await (deps.homeroomBot || require('./homeroom-bot')).readSettings(pool);
  const details = [
    said || `A new artifact for ${design.title}.`,
    '',
    captured
      ? `Its plan shows the screen as it was and version ${after.version} of the artifact side by side.`
      : `Its plan shows version ${after.version} of the artifact, a screen that is not there yet.`,
  ].join('\n');
  const filed = await mayor.fileRequest(pool, config, {
    user, app, title: named, details, settings, deps, askedText: details,
    footer: `Filed from a thread in ${user.username}'s chat with Homeroom bot.`,
    fileKey: `design-thread:${design.rootId}${which}`,
  });
  const number = Number(filed.issueNumber);
  await pool.query(
    `UPDATE private_threads SET state = 'filed', result_ref = $2, app_id = COALESCE(app_id, $3), updated_at = NOW() WHERE id = $1`,
    [design.threadId, number, app.id],
  );
  let attached = true;
  let planVersion = null;
  try {
    const posted = await specs.postRequestSpec(pool, {
      app, repo, issueNumber: number, issueTitle: named, user, text: plan, webPath: webPath(number), design: source,
    }, deps);
    planVersion = posted.version;
  } catch (err) {
    attached = false;
    log.warn('design-threads', 'Filed a design, but could not attach its plan', { app: app.slug, issueNumber: number, err: err.message });
  }
  // #6151: what happens next, from the new request's track, said after the
  // line in the reader's language (filedNext). Only with its plan attached:
  // without it there is no version to build from. Never throws.
  const tracks = attached
    ? await (deps.track || require('./homeroom-bot-track')).tracksForRequests(pool, { appId: app.id, numbers: [number], deps })
    : null;
  const next = attached ? filedNext(tracks?.get(number) || null, { queued: !!filed.queueId, version: after.version }) : null;
  const filedLine = !attached
    ? `Filed it as request #${number} on ${name}, under your name. Its plan could not be attached just now.`
    : captured
      ? `Filed it as request #${number} on ${name}, under your name, with version 1 and version ${after.version} side by side as its plan.`
      : `Filed it as request #${number} on ${name}, under your name, with version ${after.version} as its plan.`;
  if (notice) {
    await dm.sendDm(pool, {
      bot, userId: user.id, threadRootId: design.rootId, moment: null,
      idempotencyKey: `design-thread-filed-${design.rootId}${which}${planVersion > 1 ? `-v${planVersion}` : ''}`,
      content: filedLine,
      ...(next ? { metadata: { kind: 'design_filed', appSlug: app.slug, appName: name, filedNext: next } } : {}),
      objects: [{ type: 'issue', appId: Number(app.id), issueNumber: number }],
    }).catch((err) => log.warn('design-threads', 'Could not say a design was filed', { err: err.message }));
  }
  log.info('design-threads', 'Proposed a design', { app: app.slug, issueNumber: number, userId: user.id, version: after.version });
  return {
    ok: true, state: 'filed', number, plan: attached, version: after.version, planVersion, app: { slug: app.slug, name },
    href: `#app/${encodeURIComponent(app.slug)}/dev/issues/${number}`,
    ...(notice ? {} : { said: filedLine, ...(next ? { filedNext: next } : {}) }),
  };
}

/**
 * Propose it, the design pane's own button (C2.2): what the card does,
 * posted on the request the thread is about (or the design posted on), else
 * filed as a new request. K (20 Nov 2026): of the artifact shown
 * (`artifactId`; none is the thread's first).
 */
async function proposeDesign(pool, config, { user, rootId, artifactId = null, version = null, title = null, notes = null, deps = {} }) {
  const design = await designFor(pool, { userId: user?.id, rootId, artifactId });
  if (!design) return { ok: false, status: 404, error: 'No such artifact' };
  if (!isDesign(design)) return { ...NOT_A_DESIGN };
  const issueNumber = await planTargetOf(pool, design);
  return postDesignPlan(pool, config, { user, rootId, artifactId, version, issueNumber, title, notes, deps });
}

module.exports = {
  MAX_HTML_BYTES,
  MAX_VERSIONS,
  MAX_TITLE,
  SCREEN_SIZES,
  validHtml,
  threadOf,
  openArtifactOf,
  designFor,
  isDesign,
  threadForRequest,
  surfaceFor,
  draftingThread,
  ensureDesign,
  drawLine,
  openDrawThread,
  versionOf,
  addVersion,
  noteVersionMessage,
  bareNote,
  clipWords,
  versionLine,
  startDesign,
  pinFor,
  screenMarkup,
  visibleText,
  designVariants,
  planGap,
  planReadout,
  planHtml,
  planTargetOf,
  filedNext,
  postDesignPlan,
  proposeDesign,
};
