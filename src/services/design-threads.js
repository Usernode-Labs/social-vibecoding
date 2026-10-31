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
 * rootId, conversationId, state, number, app, title, surface, route, width,
 * height, latest, versions } (versions without their HTML), or null when it
 * is not theirs or not a design thread.
 */
async function designFor(pool, { userId, rootId }) {
  const root = id(rootId);
  if (!root || !id(userId)) return null;
  const { rows: [row] } = await pool.query(
    `SELECT p.id, p.root_message_id, p.conversation_id, p.state, p.result_ref,
            a.slug, a.name, d.title, d.surface, d.route, d.width, d.height
       FROM private_threads p
       JOIN design_threads d ON d.private_thread_id = p.id
       LEFT JOIN apps a ON a.id = p.app_id
      WHERE p.root_message_id = $1 AND p.user_id = $2 AND p.kind = 'design'`,
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
    href: `#messages/${Number(opened.conversationId)}/thread/${Number(opened.messageId)}`,
  };
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

/** Pure: the plan a proposed design files with: version 1 and `version`'s screens side by side, and the person's notes. */
function planHtml({ design, title, notes, before, after, version }) {
  const phone = design.width < 768;
  const height = Math.min(PLAN_MAX_HEIGHT, Math.max(phone ? 844 : 800, design.height));
  const where = design.route ? `${design.title} (${design.route})` : design.title;
  const said = notes ? `<p>${escapeHtml(notes).replace(/\n+/g, '</p><p>')}</p>` : '';
  return [
    '<article data-spec>',
    `<h1>${escapeHtml(title)}</h1>`,
    `<p>A design for ${escapeHtml(design.title)}, made in a private design thread with Homeroom bot.</p>`,
    '<section data-spec-tab="user">',
    '<figure data-screens>',
    `<ol data-changes><li data-change="1" data-steps="${escapeHtml(where)}">${escapeHtml(notes ? notes.split('\n')[0] : title)}</li></ol>`,
    `<template data-screen data-size="${phone ? 'phone' : 'desktop'}" data-height="${height}">`,
    `<div data-side="before">${screenMarkup(before)}</div>`,
    `<div data-side="after" data-change="1">${screenMarkup(after)}</div>`,
    '</template>',
    '</figure>',
    said,
    '</section>',
    '<section data-spec-tab="tech">',
    `<p>Before is the screen as it was captured (version 1); after is version ${Number(version)}, a mockup drawn with the`,
    ' screen\'s own stylesheets. Build it in the project\'s own code and components. Scripts the design used for',
    ' its interactive states are left out of this plan.</p>',
    '</section>',
    '</article>',
  ].join('\n');
}

/**
 * Propose it: file a request on the design's project, under the person's
 * name, with a plan of version 1 and `version` (the newest when none) side
 * by side, and say it in the thread. The thread stays private; the request
 * and its plan are public. Resolves { ok, number, href, plan } (`plan`
 * false when the request was filed but its plan could not be attached) or a
 * refusal { ok: false, status, error, code? }.
 */
async function proposeDesign(pool, config, { user, rootId, version = null, title = null, notes = null, deps = {} }) {
  const dm = deps.dm || require('./homeroom-bot-dm');
  const mayor = deps.mayor || require('./homeroom-bot-mayor');
  const specs = deps.requestSpecs || require('./request-specs');
  const design = await designFor(pool, { userId: user?.id, rootId });
  if (!design) return { ok: false, status: 404, error: 'No such design' };
  if (design.state !== 'open') {
    return { ok: false, status: 409, error: 'already_done', state: design.state, number: design.number };
  }
  if (!design.app) return { ok: false, status: 404, error: 'No such project' };
  const app = await mayor.findApp(pool, design.app.slug);
  if (!app || !(await mayor.canView(pool, app, user))) return { ok: false, status: 404, error: 'No such project' };
  if (!(await mayor.canFile(pool, app, user))) {
    return { ok: false, status: 403, error: 'join_required', code: 'join_required', app: { slug: app.slug, name: app.name || app.slug } };
  }
  const after = await versionOf(pool, { userId: user.id, rootId, version });
  const before = await versionOf(pool, { userId: user.id, rootId, version: 1 });
  if (!after || !before) return { ok: false, status: 404, error: 'No such version' };
  const named = clip(title || `Design: ${design.title}`, MAX_TITLE);
  const said = String(notes || '').trim().slice(0, MAX_PROPOSE_NOTES);
  const plan = planHtml({ design, title: named, notes: said, before: before.html, after: after.html, version: after.version });
  // A plan the plans would refuse is said before anything is filed.
  const checked = specs.prepareSpec(plan);
  if (!checked.ok) {
    return { ok: false, status: 413, error: 'This design is too big to go into a plan. Capture a smaller part of the screen.' };
  }
  const settings = await (deps.homeroomBot || require('./homeroom-bot')).readSettings(pool);
  const details = [
    said || `A new design for ${design.title}.`,
    '',
    `Its plan shows the screen as it was and version ${after.version} of the design side by side.`,
  ].join('\n');
  const filed = await mayor.fileRequest(pool, config, {
    user, app, title: named, details, settings, deps, askedText: details,
    footer: `Filed from a design thread in ${user.username}'s chat with Homeroom bot.`,
    fileKey: `design-thread:${design.rootId}`,
  });
  const number = Number(filed.issueNumber);
  await pool.query(
    `UPDATE private_threads SET state = 'filed', result_ref = $2, updated_at = NOW() WHERE id = $1 AND state = 'open'`,
    [design.threadId, number],
  );
  let attached = true;
  try {
    await specs.postRequestSpec(pool, {
      app, repo: require('./repo-ref').ownerRepo(app.repo_url), issueNumber: number, issueTitle: named, user, text: plan,
    }, deps);
  } catch (err) {
    attached = false;
    log.warn('design-threads', 'Filed a design, but could not attach its plan', { app: app.slug, issueNumber: number, err: err.message });
  }
  const name = app.name || app.slug;
  await dm.sendDm(pool, {
    bot: deps.bot || await dm.botAccount(pool), userId: user.id, threadRootId: design.rootId, moment: null,
    idempotencyKey: `design-thread-filed-${design.rootId}`,
    content: attached
      ? `Filed it as request #${number} on ${name}, under your name, with version 1 and version ${after.version} side by side as its plan.`
      : `Filed it as request #${number} on ${name}, under your name. Its plan could not be attached just now.`,
    objects: [{ type: 'issue', appId: Number(app.id), issueNumber: number }],
  }).catch((err) => log.warn('design-threads', 'Could not say a design was filed', { err: err.message }));
  log.info('design-threads', 'Proposed a design', { app: app.slug, issueNumber: number, userId: user.id, version: after.version });
  return {
    ok: true, state: 'filed', number, plan: attached, app: { slug: app.slug, name },
    href: `#app/${encodeURIComponent(app.slug)}/dev/issues/${number}`,
  };
}

module.exports = {
  MAX_HTML_BYTES,
  MAX_VERSIONS,
  MAX_TITLE,
  validHtml,
  threadOf,
  designFor,
  versionOf,
  addVersion,
  noteVersionMessage,
  versionLine,
  startDesign,
  pinFor,
  screenMarkup,
  planHtml,
  proposeDesign,
};
