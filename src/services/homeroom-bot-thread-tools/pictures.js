'use strict';

// Homeroom bot parity, P8: pictures from an outside image model, in the
// person's chat with the bot (see ./index.js for this module's shape).
//
// `make_pictures` asks services/bot-pictures.js for up to four options (A to
// D), each in a light and a dark variant when asked for, paid from the
// person's own week of building time and a weekly number of pictures, and
// puts them under the reply as a gallery card (homeroom-bot-cards/gallery.js,
// frontend features/messages/bot-cards/gallery.tsx). The card carries ids
// and addresses only; the pictures are in the media store.

const log = require('../logger');

function pictures(deps = {}) { return deps.botPictures || require('../bot-pictures'); }
function mayor(deps = {}) { return deps.mayor || require('../homeroom-bot-mayor'); }

const TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'make_pictures',
    description: 'Make pictures with an outside picture model: a project\'s card picture, a picture for its app (a hero image, '
      + 'an illustration, an empty state), one for a design, or anything else they ask for. Up to 4 different options (A to D), '
      + 'each in light and dark when it must suit both themes. They are shown as a gallery under your reply. Each picture counts '
      + 'toward their own week of building time and a weekly number of pictures. You cannot see the pictures: never say what one shows.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to draw, in plain words: the subject, the style, the colours and the mood, from what they asked. No words in the picture unless they asked for some.' },
        count: { type: 'integer', description: 'How many different options, 1 to 4. 1 unless they asked for choices.' },
        variants: { type: 'array', items: { type: 'string', enum: ['light', 'dark'] }, description: 'Both, for a picture that must suit a light and a dark theme (a card picture usually does). Leave it out for one picture.' },
        aspect: { type: 'string', enum: ['square', 'wide', 'tall'], description: 'Square unless it is for a wide banner (wide) or a phone screen (tall).' },
        for: { type: 'string', enum: ['featured', 'app', 'design', 'other'], description: 'featured: the project\'s card picture in Discover; app: a picture inside the app; design: for a screen design; other: anything else.' },
        project: { type: 'string', description: 'The project it is for, by name, when it is for one. Needed for a card picture.' },
        like: { type: 'string', description: 'The letter (A to D) of a picture in the last gallery here, to make more like it.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
});

// The card colours a still may be laid on (routes/app-illustrations.js TONES).
const STILL_TONES = Object.freeze(['cream', 'yellow', 'orange', 'coral', 'pink', 'purple',
  'indigo', 'blue', 'teal', 'mint', 'sage', 'gray']);

// A card still: a project's card picture made from a real screenshot of it
// (services/bot-pictures.js makeCardStill). Offered on its own rather than
// as a mode of make_pictures because nothing in it is drawn unless a scene
// is asked for: the screenshot is laid on the card's colour as it is.
const STILL_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'make_card_still',
    description: 'Make a project\'s card picture from a real screenshot of it that they attached here: the moment the project '
      + 'is used (what goes in and what comes out), laid on the card\'s colour at the card\'s own 16:10, in light and dark. The '
      + 'screenshot is used as it is, never redrawn, so its words stay the app\'s own. Shown as a gallery under your reply, from '
      + 'which it can be proposed as the card picture. Free, unless a scene around the screen is asked for (moment), which counts '
      + 'as two pictures.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'The project it is for, by name.' },
        screenshot: { type: 'string', description: 'The id of the screenshot they attached in this chat (a PNG of the app at the moment it is used).' },
        dark_screenshot: { type: 'string', description: 'The id of a screenshot of the same screen in a dark theme, when they attached one, for the dark picture.' },
        focus: {
          type: 'object',
          description: 'The part of the screenshot that matters, so it reads on a small card: the ask and the answer, two or three '
            + 'things. Each a fraction of the screenshot from 0 to 1. Leave it out to use the whole screenshot.',
          properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
          required: ['x', 'y', 'width', 'height'],
          additionalProperties: false,
        },
        tone: { type: 'string', enum: STILL_TONES, description: 'The card colour behind the screen. Leave it out to use the project\'s own colour.' },
        moment: { type: 'string', description: 'Only when they ask for one: a scene drawn around the screen, in plain words (hands on a kitchen counter, a desk by a window). No words in it.' },
      },
      required: ['project', 'screenshot'],
      additionalProperties: false,
    },
  },
});

function offered(ctx) {
  return !!ctx?.user?.id && !ctx.user.isSynthetic && ctx.settings?.mode !== 'off'
    && Number(ctx.settings?.pictureWeeklyCap ?? 1) !== 0;
}

/** A still is offered wherever a person is talking with the bot: it costs nothing without a scene. */
function stillOffered(ctx) {
  return !!ctx?.user?.id && !ctx.user.isSynthetic && ctx.settings?.mode !== 'off' && !!ctx.conversationId;
}

function tools(ctx) {
  return [...(offered(ctx) ? [TOOL] : []), ...(stillOffered(ctx) ? [STILL_TOOL] : [])];
}

function promptLines(ctx) {
  const still = stillOffered(ctx) ? [
    '- Make a project\'s card still (make_card_still) when they want its card to show what using it is like and they',
    '  attached a screenshot of it here: pass the screenshot\'s id, and a focus on the part that matters (the ask and the',
    '  answer) when you can see the picture. It is laid on the card\'s colour as it is, never redrawn, and shown as a',
    '  gallery they can propose from. Without a screenshot, ask them for one: a PNG of the app at the moment it is used,',
    '  with made-up demo content only, never a real person\'s messages or data. A scene around it (moment) only when',
    '  they ask, since it counts as two pictures.',
  ] : [];
  if (!offered(ctx)) return still;
  return [
    ...still,
    '- Make pictures with an outside picture model (make_pictures): up to 4 options (A to D), in light and dark when they',
    '  need both, for a project\'s card picture, for its app, for a design, or anything else they ask for. They are shown',
    '  as a gallery under your reply, which they tap to propose one as the card picture (only where they may), to use one in',
    '  the app, or to get more like one. Each picture counts toward their own week of building time and a weekly number of',
    '  pictures; say so when they ask what it costs. You cannot see the pictures, so never say what one shows. Content',
    '  rules: nothing sexual or suggestive, no violence or weapons, no gambling, nothing aimed at children, no real',
    '  person\'s likeness and no brands or logos they did not give you. Decline those plainly instead of calling it.',
    '  When they ask to use a picture in the app, offer a request (offer_request) whose details carry the picture\'s link',
    '  exactly as they gave it, on a line of its own, so the build can download it. When they ask for more like one, call',
    '  make_pictures again with like set to its letter and a prompt from their words and the last one.',
  ];
}

/** The picture `letter` of the newest gallery here, as bytes to draw more like it, or { error }. */
async function likePicture(pool, ctx, letter, deps) {
  const p = pictures(deps);
  const gallery = await p.latestGallery(pool, { conversationId: ctx.conversationId, threadRootId: ctx.deps?.threadRootId || null });
  const images = gallery?.images || [];
  const im = images.find((i) => i?.letter === letter && i?.variant !== 'dark') || images.find((i) => i?.letter === letter);
  if (!im) return { error: `There is no picture ${letter} in the last gallery here. Nothing was made.` };
  const row = await p.imageForMember(pool, { userId: ctx.user.id, id: im.id });
  if (!row) return { error: `Picture ${letter} cannot be read just now. Nothing was made.` };
  return { picture: { contentType: row.content_type, data: await p.imageBytes(ctx.config, row, deps) } };
}

async function makePictures(pool, ctx, args) {
  const deps = ctx.deps?.pictures || {};
  const p = pictures(deps);
  const ask = p.normalizeAsk(args);
  if (ask.error) return { ok: false, error: `${ask.error} Nothing was made.` };
  // A refusal on the content rules costs nothing, and comes first.
  const found = p.guard(ask.prompt);
  if (found) return { ok: false, error: p.refusalText(found) };
  let app = null;
  if (typeof args.project === 'string' && args.project.trim()) {
    const m = mayor(ctx.deps);
    app = await m.findApp(pool, args.project);
    if (!app || !(await m.canView(pool, app, ctx.user))) {
      return { ok: false, error: 'There is no project by that name that they can see. Check the name with my_projects. Nothing was made.' };
    }
  }
  if (ask.purpose === 'featured' && !app) {
    return { ok: false, error: 'Say which project the card picture is for (project). Nothing was made.' };
  }
  let like = null;
  if (ask.like) {
    const found2 = await likePicture(pool, ctx, ask.like, deps);
    if (found2.error) return { ok: false, error: found2.error };
    like = found2.picture;
  }
  const made = await p.generate(pool, ctx.config, {
    payerId: ctx.user.id, ask, conversationId: ctx.conversationId, app, settings: ctx.settings, like, deps,
  });
  if (!made.ok) return { ok: false, error: made.error };
  let canFeature = false;
  if (app) {
    canFeature = await (deps.appAdmins || require('../app-admins')).canManageApp(pool, app, ctx.user).catch(() => false);
  }
  ctx.card = p.galleryCard({
    prompt: ask.prompt, images: made.images, variants: ask.variants, purpose: ask.purpose, canFeature,
    project: app ? { slug: app.slug, name: app.name || app.slug } : null,
  });
  const n = made.images.length;
  // "What I looked at" (P1): what this turn did, in plain words.
  ctx.looked = Array.isArray(ctx.looked) ? ctx.looked : [];
  ctx.looked.push({ what: `Made ${n} picture${n === 1 ? '' : 's'} with the picture model` });
  ctx.lookedMs = (Number(ctx.lookedMs) || 0) + (Number(made.ms) || 0);
  ctx.pictures = { made: n };
  return {
    ok: true,
    made: n,
    labels: ctx.card.images.map((im) => im.label),
    shown: 'As a gallery under your reply. Say how many you made and what they are for, in a sentence; you cannot see them.',
    picturesLeftThisWeek: made.left,
    ...(made.failed ? { notMade: `${made.failed} of them could not be made this time.` } : {}),
    ...(canFeature ? { canFeature: 'They may propose one as the project\'s card picture from the gallery.' } : {}),
  };
}

/**
 * One of the person's own pictures in this chat, by its attachment id:
 * { data, contentType } or { error }. Only a picture they attached here, on
 * a message still standing, as offer_request's attachmentIds are read.
 */
async function ownScreenshot(pool, ctx, id, what = 'screenshot') {
  const want = String(id ?? '').trim();
  if (!want) return { error: `Say which picture they attached is the ${what} (its id). Nothing was made.` };
  const { rows: [row] } = await pool.query(
    `SELECT a.content_type, a.data FROM conversation_message_attachments a
       JOIN conversation_messages m ON m.id = a.message_id
      WHERE a.id = $1 AND a.kind = 'image' AND a.conversation_id = $2 AND a.user_id = $3
        AND m.deleted_at IS NULL AND m.moderation_hidden_at IS NULL`,
    [want, Number(ctx.conversationId), Number(ctx.user.id)],
  );
  if (!row || !Buffer.isBuffer(row.data)) {
    return { error: `${want} is not a picture they attached in this chat. Pass the id of their own ${what}. Nothing was made.` };
  }
  return { data: row.data, contentType: row.content_type };
}

async function makeCardStill(pool, ctx, args) {
  const deps = ctx.deps?.pictures || {};
  const p = pictures(deps);
  const ask = p.normalizeStillAsk(args, STILL_TONES);
  if (ask.error) return { ok: false, error: `${ask.error} Nothing was made.` };
  const m = mayor(ctx.deps);
  const app = typeof args.project === 'string' && args.project.trim() ? await m.findApp(pool, args.project) : null;
  if (!app || !(await m.canView(pool, app, ctx.user))) {
    return { ok: false, error: 'There is no project by that name that they can see. Check the name with my_projects. Nothing was made.' };
  }
  const shot = await ownScreenshot(pool, ctx, args.screenshot);
  if (shot.error) return { ok: false, error: shot.error };
  let darkShot = null;
  if (args.dark_screenshot) {
    darkShot = await ownScreenshot(pool, ctx, args.dark_screenshot, 'dark screenshot');
    if (darkShot.error) return { ok: false, error: darkShot.error };
  }
  // The card colour: the one asked for, else the one its picture already
  // wears, else (null) the project's own colour.
  const worn = app.featured_illustration && typeof app.featured_illustration.tint === 'string' ? app.featured_illustration.tint : null;
  const made = await p.makeCardStill(pool, ctx.config, {
    payerId: ctx.user.id, app, screenshot: shot.data, darkScreenshot: darkShot ? darkShot.data : null,
    focus: ask.focus, moment: ask.moment, tone: ask.tone || (STILL_TONES.includes(worn) ? worn : null),
    conversationId: ctx.conversationId, settings: ctx.settings, deps,
  });
  if (!made.ok) return { ok: false, error: made.error };
  const canFeature = await (deps.appAdmins || require('../app-admins')).canManageApp(pool, app, ctx.user).catch(() => false);
  ctx.card = p.galleryCard({
    prompt: `Card still of ${app.name || app.slug}`, images: made.images, variants: ['light', 'dark'], purpose: 'featured',
    canFeature, project: { slug: app.slug, name: app.name || app.slug },
  });
  ctx.looked = Array.isArray(ctx.looked) ? ctx.looked : [];
  ctx.looked.push({ what: made.scene ? 'Made a card still, with a scene from the picture model' : 'Made a card still from their screenshot' });
  ctx.pictures = { made: made.images.length };
  return {
    ok: true,
    made: made.images.length,
    labels: ctx.card.images.map((im) => im.label),
    shown: 'As a gallery under your reply: the still in light and dark. Say in a sentence that it is their screenshot on the card\'s colour; you cannot see it.',
    ...(made.left != null ? { picturesLeftThisWeek: made.left } : { cost: 'Nothing: no picture model was used.' }),
    ...(canFeature
      ? { canFeature: 'They may propose it as the project\'s card picture from the gallery; the project\'s group votes on it.' }
      : { canFeature: 'Only the project\'s creator and its admins can propose it as the card picture; they can share it with them.' }),
  };
}

async function run(pool, ctx, name, args) {
  if (name === 'make_card_still') {
    try {
      return await makeCardStill(pool, ctx, args || {});
    } catch (err) {
      log.warn('homeroom-bot-pictures', 'make_card_still failed', { userId: ctx?.user?.id, err: err.message });
      return { ok: false, error: 'The still could not be made just now. Try again in a minute.' };
    }
  }
  if (name !== 'make_pictures') return undefined;
  try {
    return await makePictures(pool, ctx, args || {});
  } catch (err) {
    log.warn('homeroom-bot-pictures', 'make_pictures failed', { userId: ctx?.user?.id, err: err.message });
    return { ok: false, error: 'The pictures could not be made just now. Try again in a minute.' };
  }
}

module.exports = { TOOL, STILL_TOOL, STILL_TONES, tools, run, promptLines, offered, stillOffered, makePictures, makeCardStill };
