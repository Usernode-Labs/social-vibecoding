'use strict';

// #6354 (Part 2): the real sizes of Homeroom's own pages, for the design bot
// when it has to draw one from the code. A redraw that guesses its columns
// comes out wider than the page it is a design of: asked to "render" the
// Homeroom bot page, the bot drew it at a made-up width and it took another
// round of reading to find the real 430px column (private thread 16876).
//
// Every number below is read off the stylesheet named beside it and off the
// components' own classes. Phone is 390 wide, desktop 1280, the two sizes the
// design bot draws at (design-threads.js SCREEN_SIZES).

const PHONE = 390;
const DESKTOP = 1280;
// The desktop rail is `--platform-rail-full` from 768px (public/css/app.css,
// THE RAIL); below that the rail is 0 and the tab bar is the way around.
const RAIL_FULL = 212;
// The AI page's own rules (public/css/app.css, `#ai-screen`):
//   --ai-list-min: 480px
//   --ai-main-auto: max(400px, calc(var(--ai-room) - 720px))
//   --ai-main-w: max(320px, min(...))
// the room is the window less the rail, and the list's content is capped at
// 672px (`max-w-2xl`, frontend/src/features/ai/index.tsx). At 1280:
// room 1068, Main 400 and the list 668.
const AI_ROOM = DESKTOP - RAIL_FULL;
const AI_MAIN_MIN = 400;
const AI_LIST_MIN = 480;
const AI_LIST_CONTENT_MAX = 672;
const AI_MAIN_DESKTOP = Math.max(AI_MAIN_MIN, AI_ROOM - 720);
const AI_LIST_DESKTOP = AI_ROOM - Math.min(AI_MAIN_DESKTOP, AI_ROOM - AI_LIST_MIN);

// Messages: the list is a fixed pane and the thread takes the rest
// (public/css/app.css `.messages-list-pane` and `.messages-layout`).
const MESSAGES_LIST_DESKTOP = 360;
// The Workshop's places list and its side panel
// (frontend/src/features/dev-board/workshop/project-places.tsx, `.dev-ws-side`).
const WORKSHOP_PLACES_DESKTOP = 232;
// A project's or request's page content column, and the local side-panel
// width a page opened beside the AI list takes (features/side-panel).
const PAGE_CONTENT_MAX = 768;
// A phone has no rail and no columns: every one of these pages is the whole
// 390px screen, or a full-screen drawer.
const PHONE_FULL = PHONE;

/**
 * Frozen: each page a person could ask for a design of, at the two sizes the
 * bot draws, with the selector each number comes from. `columns` are widths
 * a drawn page must not exceed.
 */
const WIDTHS = Object.freeze({
  shell: Object.freeze({
    name: 'the shell around every page',
    phone: Object.freeze({ full: PHONE_FULL, rail: 0, tabBar: true }),
    desktop: Object.freeze({ full: DESKTOP, rail: RAIL_FULL, usable: DESKTOP - RAIL_FULL, tabBar: false }),
    source: '--platform-rail-full (212px from 768px), --platform-usable-w',
  }),
  'homeroom-bot': Object.freeze({
    name: 'the Homeroom bot page',
    phone: Object.freeze({ list: PHONE_FULL, mainChat: PHONE_FULL, drawer: true }),
    desktop: Object.freeze({
      list: AI_LIST_DESKTOP, listContent: AI_LIST_CONTENT_MAX, mainChat: AI_MAIN_DESKTOP, mainChatMin: 320,
    }),
    source: '#ai-screen --ai-list-min (480px), --ai-main-auto (max 400px, room - 720px), max-w-2xl (672px)',
  }),
  'main-chat': Object.freeze({
    name: 'Main Chat',
    phone: Object.freeze({ thread: PHONE_FULL, drawer: true }),
    desktop: Object.freeze({ thread: AI_MAIN_DESKTOP, besideList: AI_LIST_DESKTOP }),
    source: '#ai-screen --ai-main-w (400px at 1280)',
  }),
  messages: Object.freeze({
    name: 'Messages',
    phone: Object.freeze({ list: PHONE_FULL, thread: PHONE_FULL, drawer: true }),
    desktop: Object.freeze({ list: MESSAGES_LIST_DESKTOP, thread: DESKTOP - RAIL_FULL - MESSAGES_LIST_DESKTOP }),
    source: '.messages-list-pane, .messages-layout',
  }),
  communities: Object.freeze({
    name: 'Communities',
    phone: Object.freeze({ full: PHONE_FULL }),
    desktop: Object.freeze({ full: DESKTOP - RAIL_FULL }),
    source: '#home-screen / the community hub',
  }),
  project: Object.freeze({
    name: 'a project page',
    phone: Object.freeze({ full: PHONE_FULL }),
    desktop: Object.freeze({ places: WORKSHOP_PLACES_DESKTOP, content: DESKTOP - RAIL_FULL - WORKSHOP_PLACES_DESKTOP }),
    source: 'features/dev-board/workshop/project-places.tsx, .dev-ws-side',
  }),
  request: Object.freeze({
    name: 'a request page',
    phone: Object.freeze({ full: PHONE_FULL }),
    desktop: Object.freeze({ content: PAGE_CONTENT_MAX, places: WORKSHOP_PLACES_DESKTOP }),
    source: 'the request page\'s content column and .dev-ws-side',
  }),
  workshop: Object.freeze({
    name: 'the Workshop',
    phone: Object.freeze({ full: PHONE_FULL }),
    desktop: Object.freeze({ places: WORKSHOP_PLACES_DESKTOP, content: DESKTOP - RAIL_FULL - WORKSHOP_PLACES_DESKTOP }),
    source: 'features/workshop/index.tsx, .dev-ws-side',
  }),
});

function describe(page) {
  const parts = [];
  for (const [key, size] of [['phone', page.phone], ['desktop', page.desktop]]) {
    const widths = Object.entries(size)
      .filter(([, value]) => typeof value === 'number' && value > 0)
      .map(([what, value]) => `${what} ${value}px`);
    parts.push(`${key} (${size.full ? `${size.full}px wide; ` : ''}${widths.join(', ')})`);
  }
  return parts.join('; ');
}

/**
 * Pure: the REAL SIZES lines designPrompt adds for Homeroom's own designs.
 * One page a line, the numbers from WIDTHS, and the one rule that matters.
 */
function layoutLines() {
  const lines = [
    'REAL SIZES (the widths Homeroom\'s own pages actually use; never make a column wider than the real one):',
  ];
  for (const page of Object.values(WIDTHS)) {
    lines.push(`- ${page.name}: ${describe(page)}. From ${page.source}.`);
  }
  lines.push('A phone has no rail: those pages are the whole 390px screen, or a full-screen drawer.');
  return lines;
}

module.exports = { WIDTHS, layoutLines, PHONE, DESKTOP, RAIL_FULL };
