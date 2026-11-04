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

// The most one version may be: the column allows 1 MB, and a version is
// drawn whole in a frame and read whole by the model that edits it.
const MAX_HTML_BYTES = 900 * 1024;
const MAX_TITLE = 120;
const MAX_NOTE = 300;
const MAX_ROUTE = 500;
const MAX_VERSIONS = 80;
const SIZE = Object.freeze({ min: 200, max: 4000 });
const SURFACES = new Set(['platform', 'app']);
// What a design the bot draws is of: Homeroom's own pages, a project's app,
// or a project that does not exist yet (migration 0004).
const DRAWN_SURFACES = new Set(['platform', 'app', 'new']);
// The two sizes a drawn screen comes in (write_screen's `size`), as a plan's
// screens are drawn (spec-html.js).
const SCREEN_SIZES = Object.freeze({
  phone: Object.freeze({ width: 390, height: 844 }),
  desktop: Object.freeze({ width: 1280, height: 800 }),
});
// A pinned comment's point, as fractions of the version's drawn size, and
// the element under it in a few words (comment-pin's describeElement).
const MAX_PIN_TEXT = 80;

function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function id(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function size(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(SIZE.max, Math.max(SIZE.min, n)) : null;
}

/** Pure: the HTML a version may hold, or null when it is empty or too big. */
function validHtml(html) {
  const text = typeof html === 'string' ? html : '';
  if (!text.trim()) return null;
  return Buffer.byteLength(text, 'utf8') <= MAX_HTML_BYTES ? text : null;
}

/** The thread a message is in, when it is one of the person's design threads: its row, or null. */
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
    return await designFor(pool, { userId, rootId });
  } catch {
    return null;
  }
}

/**
 * One of the person's design threads, by its first message: { threadId,
 * rootId, conversationId, state, number, kind, about, app, title, surface,
 * route, width, height, latest, versions } (versions without their HTML),
 * or null when it is not theirs or holds no design. 1 Nov 2026: any private
 * thread of theirs with a design_threads row, whatever its kind.
 */
async function designFor(pool, { userId, rootId }) {
  const root = id(rootId);
  if (!root || !id(userId)) return null;
  const { rows: [row] } = await pool.query(
    `SELECT p.id, p.root_message_id, p.conversation_id, p.state, p.result_ref, p.kind,
            p.about_kind, p.about_number,
            a.slug, a.name, d.title, d.surface, d.route, d.width, d.height
       FROM private_threads p
       JOIN design_threads d ON d.private_thread_id = p.id
       LEFT JOIN apps a ON a.id = p.app_id
      WHERE p.root_message_id = $1 AND p.user_id = $2`,
    [root, Number(userId)],
  );
  if (!row) return null;
  const { rows: versions } = await pool.query(
    `SELECT version, author, note, message_id, created_at FROM design_versions
      WHERE private_thread_id = $1 ORDER BY version`,
    [row.id],
  );
  return {
    threadId: Number(row.id),
    rootId: Number(row.root_message_id),
    conversationId: Number(row.conversation_id),
    state: row.state,
    number: row.result_ref == null ? null : Number(row.result_ref),
    kind: row.kind,
    about: row.about_kind && row.about_number ? { kind: row.about_kind, number: Number(row.about_number) } : null,
    app: row.slug ? { slug: row.slug, name: row.name || row.slug } : null,
    title: row.title,
    surface: row.surface,
    route: row.route || null,
    width: Number(row.width),
    height: Number(row.height),
    latest: versions.length ? Number(versions[versions.length - 1].version) : 0,
    versions: versions.map((v) => ({
      version: Number(v.version), author: v.author, note: v.note || null,
      messageId: v.message_id == null ? null : Number(v.message_id), at: v.created_at,
    })),
  };
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
 * The design a thread holds, made the first time the bot draws in it: its
 * private_threads row when it has none (an idea, as a thread with no row
 * is), given `app` when it was in no project, and its design_threads row
 * (`title`, the surface its project makes it, the size drawn at). A design
 * it holds already takes the size of its newest screen. Resolves the design
 * (designFor), or null when the thread is not one the person may draw in.
 */
async function ensureDesign(pool, config, { user, thread, app = null, title, size: sized = 'phone' }) {
  if (!user?.id || !thread?.rootId) return null;
  const named = clip(title, MAX_TITLE) || 'Screen';
  const { width, height } = SCREEN_SIZES[sized] || SCREEN_SIZES.phone;
  const project = thread.app || app || null;
  const surface = surfaceFor(config, project);
  const { rows: [row] } = await pool.query(
    `INSERT INTO private_threads (user_id, conversation_id, root_message_id, app_id, kind, state)
     VALUES ($1, $2, $3, $4, 'idea', 'open')
     ON CONFLICT (root_message_id) DO UPDATE
       SET app_id = COALESCE(private_threads.app_id, EXCLUDED.app_id), updated_at = NOW()
     RETURNING id, user_id`,
    [Number(user.id), Number(thread.conversationId), Number(thread.rootId), project?.id ? Number(project.id) : null],
  );
  if (!row || Number(row.user_id) !== Number(user.id)) return null;
  await pool.query(
    `INSERT INTO design_threads (private_thread_id, title, surface, width, height)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (private_thread_id) DO UPDATE SET width = EXCLUDED.width, height = EXCLUDED.height`,
    [row.id, named, DRAWN_SURFACES.has(surface) ? surface : 'new', width, height],
  );
  return designFor(pool, { userId: user.id, rootId: thread.rootId });
}

/** One version's HTML, for the thread's owner: { version, html } or null. */
async function versionOf(pool, { userId, rootId, version = null }) {
  const design = await designFor(pool, { userId, rootId });
  if (!design || !design.latest) return null;
  const want = version == null ? design.latest : id(version);
  if (!want) return null;
  const { rows: [row] } = await pool.query(
    'SELECT version, html FROM design_versions WHERE private_thread_id = $1 AND version = $2',
    [design.threadId, want],
  );
  return row ? { version: Number(row.version), html: row.html, design } : null;
}

/**
 * The next version of a design thread, written once: { version } or null
 * when the HTML is not one a version may hold, or the thread has reached
 * MAX_VERSIONS. Numbered under the thread's own row lock, so two edits never
 * take one number.
 */
async function addVersion(pool, { threadId, html, author = 'bot', note = null, messageId = null }) {
  const body = validHtml(html);
  if (!body || !id(threadId) || !['capture', 'bot'].includes(author)) return null;
  const client = typeof pool.connect === 'function' ? await pool.connect() : null;
  const db = client || pool;
  try {
    await db.query('BEGIN');
    await db.query('SELECT id FROM private_threads WHERE id = $1 FOR UPDATE', [Number(threadId)]);
    const { rows: [last] } = await db.query(
      'SELECT COALESCE(MAX(version), 0) AS n FROM design_versions WHERE private_thread_id = $1', [Number(threadId)]);
    const version = Number(last.n) + 1;
    if (version > MAX_VERSIONS) {
      await db.query('ROLLBACK');
      return null;
    }
    await db.query(
      `INSERT INTO design_versions (private_thread_id, version, html, author, note, message_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [Number(threadId), version, body, author, note ? clip(note, MAX_NOTE) : null, id(messageId)],
    );
    await db.query('UPDATE private_threads SET updated_at = NOW() WHERE id = $1', [Number(threadId)]);
    await db.query('COMMIT');
    return { version };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client?.release();
  }
}

/** The message that says a version, once it is sent: its id on the version's row. */
async function noteVersionMessage(pool, { threadId, version, messageId }) {
  if (!id(messageId)) return;
  await pool.query(
    'UPDATE design_versions SET message_id = $3 WHERE private_thread_id = $1 AND version = $2 AND message_id IS NULL',
    [Number(threadId), Number(version), Number(messageId)],
  ).catch((err) => log.warn('design-threads', 'Could not note a version\'s message', { err: err.message }));
}

/** Pure: what a version's message says. */
function versionLine(version, note) {
  const said = note ? clip(note, MAX_NOTE) : '';
  return said ? `Version ${version}: ${said}${/[.!?…]$/.test(said) ? '' : '.'}` : `Version ${version}.`;
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
    content: `I opened a design thread for ${named}, in a thread only you can see. Tell me what to change there, `
      + 'or pin a comment on the preview, and I\'ll make the next version. Nothing is public until you propose it.',
    threadRootId: false,
    moment: null,
    metadata: { kind: 'opened_design', appSlug: app.slug, appName: name, designTitle: named },
  });
  if (!opened?.messageId) return { ok: false, status: 502, error: 'The design thread could not be opened just now.' };
  const { rows: [row] } = await pool.query(
    `INSERT INTO private_threads (user_id, conversation_id, root_message_id, app_id, kind, state)
     VALUES ($1, $2, $3, $4, 'design', 'open')
     ON CONFLICT (root_message_id) DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [user.id, opened.conversationId, opened.messageId, app.id],
  );
  await pool.query(
    `INSERT INTO design_threads (private_thread_id, title, surface, route, width, height)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (private_thread_id) DO NOTHING`,
    [row.id, named, surface, route ? clip(route, MAX_ROUTE) : null, w, h],
  );
  const first = await addVersion(pool, { threadId: row.id, html: body, author: 'capture', note: 'As it is now' });
  const said = await dm.sendDm(pool, {
    bot,
    userId: user.id,
    content: `${versionLine(first.version, `${named} as it is now`)} What should change?`,
    threadRootId: opened.messageId,
    moment: null,
    idempotencyKey: `design-${row.id}-v${first.version}`,
    metadata: { kind: 'design_version', appSlug: app.slug, appName: name, designVersion: first.version },
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

/** Pure: the bot's line in Main that a thread it opened to draw a screen hangs off. */
function drawLine({ title = null, appName = null } = {}) {
  const what = title ? `"${clip(title, 80)}"` : 'the screen';
  return appName
    ? `I'm drawing ${what} for ${clip(appName, 80)} in a new thread. Only you can see it.`
    : `I'm drawing ${what} in a new thread. Only you can see it.`;
}

/**
 * Main Chat holds no design (1 Nov 2026): asked there to draw a screen, the
 * bot opens a private thread for it as the "+" does (private-threads.js
 * startThread: the bot's line in Main, metadata kind 'opened_thread' with
 * changeKind 'design', its row of kind 'ask'), quoting what they asked, and
 * draws there. Keyed by the message it answers, so a retry finds the same
 * thread. Resolves the thread (draftingThread's shape) or null.
 */
async function openDrawThread(pool, { user, app = null, title = null, messageId = null, deps = {} }) {
  const dm = deps.dm || require('./homeroom-bot-dm');
  if (!user?.id || user.isSynthetic) return null;
  const bot = deps.bot || await dm.botAccount(pool);
  if (!bot) return null;
  const named = clip(title, MAX_TITLE) || null;
  const appName = app ? app.name || app.slug : null;
  const said = await dm.sendDm(pool, {
    bot,
    userId: user.id,
    content: drawLine({ title: named, appName }),
    threadRootId: false,
    replyToId: id(messageId),
    moment: null,
    idempotencyKey: id(messageId) ? `design-draw-${id(messageId)}` : null,
    metadata: {
      kind: 'opened_thread', changeKind: 'design',
      ...(named ? { designTitle: named } : {}),
      ...(app ? { appSlug: app.slug, appName } : {}),
    },
  });
  if (!said?.messageId) return null;
  await pool.query(
    `INSERT INTO private_threads (user_id, conversation_id, root_message_id, app_id, kind, state)
     VALUES ($1, $2, $3, $4, 'ask', 'open') ON CONFLICT (root_message_id) DO NOTHING`,
    [user.id, said.conversationId, said.messageId, app?.id ? Number(app.id) : null],
  );
  return draftingThread(pool, { userId: user.id, botId: bot.id, rootId: said.messageId });
}

/**
 * Pure-ish: a pinned comment's point as it rides on the person's message
 * (metadata.designPin), checked against their design thread `threadRootId`:
 * { version, x, y, element? } or null when anything about it is wrong.
 */
async function pinFor(pool, { user, conversationId, threadRootId, pin }) {
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) return null;
  const design = await designFor(pool, { userId: user?.id, rootId: threadRootId });
  if (!design || design.conversationId !== Number(conversationId)) return null;
  const version = id(pin.version);
  const x = Number(pin.x);
  const y = Number(pin.y);
  if (!version || version > design.latest || !(x >= 0 && x <= 1) || !(y >= 0 && y <= 1)) return null;
  const el = pin.element && typeof pin.element === 'object' ? pin.element : null;
  const element = el ? {
    tag: /^[a-z][a-z0-9-]{0,30}$/.test(String(el.tag || '')) ? String(el.tag) : '',
    id: clip(el.id, 60),
    text: clip(el.text, MAX_PIN_TEXT),
  } : null;
  return {
    version, x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000,
    ...(element && (element.tag || element.text) ? { element } : {}),
  };
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
  const captured = typeof before === 'string' && before.trim().length > 0;
  const empty = '<div style="min-height:100%;display:flex;align-items:center;justify-content:center;'
    + 'font:15px/1.4 system-ui,sans-serif;color:#71717a;padding:24px;text-align:center">'
    + `${escapeHtml(design.title)} is not there yet.</div>`;
  return [
    '<article data-spec>',
    `<h1>${escapeHtml(title)}</h1>`,
    captured
      ? `<p>A design for ${escapeHtml(design.title)}, made in a private design thread with Homeroom bot.</p>`
      : `<p>A design for a new screen, ${escapeHtml(design.title)}, made in a private thread with Homeroom bot.</p>`,
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
        + ' screen\'s own stylesheets. Build it in the project\'s own code and components. Scripts the design used for'
        + ' its interactive states are left out of this plan.</p>'
      : `<p>The screen is new: before is what is there today, nothing; after is version ${Number(version)} of the design, a`
        + ` mockup drawn with ${design.surface === 'new' ? 'Homeroom\'s own' : 'the project\'s'} stylesheets. Build it in`
        + ' the project\'s own code and components, as a screen of its own, and keep its words, its layout and what it'
        + ' shows. Scripts the design used for its interactive states are left out of this plan.</p>',
    '</section>',
    '</article>',
  ].join('\n');
}

// What planHtml's tech section says its after side is, in either of its two wordings.
const PLAN_VERSION_RE = /\bafter is version (\d+)(?:, a mockup| of the design)\b/;

/**
 * Pure (#6153): the design version a plan made by planHtml shows as its
 * after side, read back from its words (its HTML or the markdown made from
 * it), or null for any other plan: what Homeroom bot's line in the design
 * thread says it builds from ("building #14 from version 4").
 */
function planDesignVersion(text) {
  const match = PLAN_VERSION_RE.exec(String(text || ''));
  const version = match ? Number(match[1]) : null;
  return Number.isSafeInteger(version) && version > 0 ? version : null;
}

// What a design may post from: a thread put away posts nothing.
const POSTABLE = new Set(['open', 'posted', 'filed']);

// #6151 (2 Nov 2026): a design filed as a request is Homeroom bot's to
// build: fileRequest queues it (reason dm_request) and the bot builds it a
// minute later. The line that said it was filed stopped at "…as its plan",
// and asked "will you build this now?" the design bot answered that it
// could not. The line now says what happens next, read off the new
// request's track (homeroom-bot-track.js): the track states in which the bot
// has it in hand, and the limits it waits at.
const FILED_BUILDS = new Set(['queued', 'planning', 'building']);
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
  if (FILED_BUILDS.has(track.state)) return builds;
  const why = track.held?.limit || track.why || null;
  if (track.state === 'held') return FILED_LIMITS.has(why) ? { say: 'held', limit: why } : { say: 'person' };
  if (track.state === 'stopped' && why === 'needs_person') return { say: 'person' };
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
 */
async function postDesignPlan(pool, config, {
  user, rootId, version = null, issueNumber = null, title = null, notes = null, appId = null, deps = {},
}) {
  const dm = deps.dm || require('./homeroom-bot-dm');
  const mayor = deps.mayor || require('./homeroom-bot-mayor');
  const specs = deps.requestSpecs || require('./request-specs');
  const design = await designFor(pool, { userId: user?.id, rootId });
  if (!design) return { ok: false, status: 404, error: 'No such design' };
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
    return { ok: false, status: 404, error: 'This design has no project yet.' };
  }
  if (!app || !(await mayor.canView(pool, app, user))) return { ok: false, status: 404, error: 'No such project' };
  if (!(await mayor.canFile(pool, app, user))) {
    return { ok: false, status: 403, error: 'join_required', code: 'join_required', app: { slug: app.slug, name: app.name || app.slug } };
  }
  const after = await versionOf(pool, { userId: user.id, rootId, version });
  if (!after) return { ok: false, status: 404, error: 'No such version' };
  // Version 1 is "before" only when it was the screen as it was.
  const captured = design.versions[0]?.author === 'capture';
  const before = captured ? await versionOf(pool, { userId: user.id, rootId, version: 1 }) : null;
  if (captured && !before) return { ok: false, status: 404, error: 'No such version' };
  const n = issueNumber == null ? null : Number(issueNumber);
  if (n != null && !(Number.isSafeInteger(n) && n > 0 && n <= 2147483647)) return { ok: false, status: 400, error: 'Invalid request number' };
  const named = clip(title || `Design: ${design.title}`, MAX_TITLE);
  const said = String(notes || '').trim().slice(0, MAX_PROPOSE_NOTES);
  const plan = planHtml({
    design, title: named, notes: said, before: before ? before.html : null, after: after.html, version: after.version,
  });
  // A plan the plans would refuse is said before anything is filed.
  const checked = specs.prepareSpec(plan);
  if (!checked.ok) {
    return { ok: false, status: 413, error: 'This design is too big to go into a plan. Make the screen smaller, then post it again.' };
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
    await dm.sendDm(pool, {
      bot, userId: user.id, threadRootId: design.rootId, moment: null,
      idempotencyKey: `design-plan-${design.threadId}-${n}-s${posted.sessionId}v${posted.version}`,
      content: `Posted version ${after.version} as a plan on request #${n} on ${name}, under your name`
        + `${posted.version > 1 ? ` (the plan's version ${posted.version})` : ''}.`,
      objects: [{ type: 'issue', appId: Number(app.id), issueNumber: n }],
    }).catch((err) => log.warn('design-threads', 'Could not say a design was posted as a plan', { err: err.message }));
    log.info('design-threads', 'Posted a design as a plan', { app: app.slug, issueNumber: n, userId: user.id, version: after.version });
    return {
      ok: true, state: 'posted', number: n, plan: true, version: after.version, planVersion: posted.version,
      app: { slug: app.slug, name }, href: `#app/${encodeURIComponent(app.slug)}/dev/issues/${n}`,
    };
  }
  const settings = await (deps.homeroomBot || require('./homeroom-bot')).readSettings(pool);
  const details = [
    said || `A new design for ${design.title}.`,
    '',
    captured
      ? `Its plan shows the screen as it was and version ${after.version} of the design side by side.`
      : `Its plan shows version ${after.version} of the design, a screen that is not there yet.`,
  ].join('\n');
  const filed = await mayor.fileRequest(pool, config, {
    user, app, title: named, details, settings, deps, askedText: details,
    footer: `Filed from a design thread in ${user.username}'s chat with Homeroom bot.`,
    fileKey: `design-thread:${design.rootId}`,
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
      app, repo, issueNumber: number, issueTitle: named, user, text: plan, webPath: webPath(number),
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
  await dm.sendDm(pool, {
    bot, userId: user.id, threadRootId: design.rootId, moment: null,
    idempotencyKey: `design-thread-filed-${design.rootId}${planVersion > 1 ? `-v${planVersion}` : ''}`,
    content: !attached
      ? `Filed it as request #${number} on ${name}, under your name. Its plan could not be attached just now.`
      : captured
        ? `Filed it as request #${number} on ${name}, under your name, with version 1 and version ${after.version} side by side as its plan.`
        : `Filed it as request #${number} on ${name}, under your name, with version ${after.version} as its plan.`,
    ...(next ? { metadata: { kind: 'design_filed', appSlug: app.slug, appName: name, filedNext: next } } : {}),
    objects: [{ type: 'issue', appId: Number(app.id), issueNumber: number }],
  }).catch((err) => log.warn('design-threads', 'Could not say a design was filed', { err: err.message }));
  log.info('design-threads', 'Proposed a design', { app: app.slug, issueNumber: number, userId: user.id, version: after.version });
  return {
    ok: true, state: 'filed', number, plan: attached, version: after.version, planVersion, app: { slug: app.slug, name },
    href: `#app/${encodeURIComponent(app.slug)}/dev/issues/${number}`,
  };
}

/**
 * Propose it, the design pane's own button (C2.2): what the card does,
 * posted on the request the thread is about (or the design posted on), else
 * filed as a new request.
 */
async function proposeDesign(pool, config, { user, rootId, version = null, title = null, notes = null, deps = {} }) {
  const design = await designFor(pool, { userId: user?.id, rootId });
  if (!design) return { ok: false, status: 404, error: 'No such design' };
  const issueNumber = await planTargetOf(pool, design);
  return postDesignPlan(pool, config, { user, rootId, version, issueNumber, title, notes, deps });
}

module.exports = {
  MAX_HTML_BYTES,
  MAX_VERSIONS,
  MAX_TITLE,
  SCREEN_SIZES,
  validHtml,
  threadOf,
  designFor,
  surfaceFor,
  draftingThread,
  ensureDesign,
  drawLine,
  openDrawThread,
  versionOf,
  addVersion,
  noteVersionMessage,
  versionLine,
  startDesign,
  pinFor,
  screenMarkup,
  planHtml,
  planDesignVersion,
  planTargetOf,
  filedNext,
  postDesignPlan,
  proposeDesign,
};
