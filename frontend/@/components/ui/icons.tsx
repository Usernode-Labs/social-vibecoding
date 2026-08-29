import * as React from 'react';

/**
 * The shell's icon set, as named components.
 *
 * ── One family, transcribed — NOT a package ───────────────────────────
 *
 * Every glyph below is **lucide v1.35.0** (ISC), transcribed verbatim from
 * `lucide-static`'s own SVGs — children in file order, attributes untouched.
 * The set is lucide's; the dependency is not. `public/vendor/README.md`
 * records the same arrangement for marked, DOMPurify and qrcodejs, and
 * `tests/shell-icon-set.test.js` still forbids an icon package outright: the
 * shell ships its glyphs inline, and `<Glyph>`'s two table-driven callers
 * interpolate shapes into markup that an imported component cannot supply.
 *
 * If a glyph looks wrong, fix it against lucide's file of that name — the
 * `// lucide/<slug>` comment on each line says which — never by redrawing.
 *
 * ── Why the set moved ─────────────────────────────────────────────────
 *
 * It used to be Heroicons "v1/v2 outline, hand-picked over several years",
 * and the years were the problem. Heroicons is really four optical families
 * keyed by size, and v2 redrew every path AND moved the outline weight from
 * 2 to 1.5, so a set assembled across that boundary disagreed with itself:
 * three plusses (one of them Feather's), two checks, and a paperclip drawn
 * TWICE at different decimal precision — `PaperclipIcon` and `PaperClipIcon`,
 * one capital apart. #1120 knew and could not act: a mechanical refactor was
 * not allowed to change pixels, so it recorded the duplicates and shipped
 * them. This is that deferred work.
 *
 * lucide is one family — 24 grid, stroke 2, round caps and joins, 1px of
 * safe padding — with no version boundary to accrete across. Nine names
 * collapsed into the glyph they were always spelling:
 *
 *   ChevronLeftInsetIcon → ChevronLeftIcon   PlusWideIcon  ┐
 *   ArrowRightShortIcon  → ArrowRightIcon    PlusThinIcon  ┴→ PlusIcon
 *   PaperClipIcon        → PaperclipIcon     CheckLongIcon → CheckIcon
 *   TrophyOutlineIcon    → TrophyIcon        DraftSendIcon → SendIcon
 *   ChatBubbleTailIcon   → ChatIcon
 *
 * Eight more went with them, for a different reason: nothing imported them.
 * `Squares2X2Icon` `AppWindowIcon` `BoardIcon` `NewspaperIcon` `ListLinesIcon`
 * `ThumbsUpIcon` `SunIcon` `LightBulbIcon`. Three of those had drawn the
 * App / Board / Activity views before those became a segmented control of
 * three words, and the set had been carrying them since. If a surface wants
 * one back, take it from lucide by the slug the old entry named —
 * `layout-grid`, `app-window`, `kanban`, `newspaper`, `menu`, `thumbs-up`,
 * `sun`, `lightbulb` — rather than redrawing it.
 *
 * `LightBulbIcon` is the first to come back, and it came back that way: #1474
 * gave the Improve button a three-state glyph and the bulb is its idle one, so
 * it is a `lucide/lightbulb` transcription rather than the Heroicons path it
 * was. That is the procedure working, not an exception to it — seven left.
 *
 * ── Two weights, and the rule that picks between them ─────────────────
 *
 * `STROKE` is lucide's own 2, and it is the shell's default. The admin
 * console draws the same family at 1.5 (`NAV_ICONS` in
 * features/admin/admin-console.js) — that is AGENTS.md's density boundary,
 * not drift, and it stays on the admin side of it because
 * `tests/admin-ui-registry.test.js` forbids an admin source from importing
 * this module.
 *
 * A call site overrides `strokeWidth` for ONE reason: to hold the rendered
 * stroke near 1.5px as the box shrinks, which is lucide's own
 * `absoluteStrokeWidth` idea. When a site needs that, this is the table:
 *
 *   w-4 (16px) and up → 2 (the default)   w-3.5 (14px) → 2.5   w-3 (12px) → 3
 *
 * Most small sites do not override and inherit 2, which is legible; the rule
 * governs the ones that DO, and an override outside it is a stray. Four were
 * when the set moved — a `w-6` asking for 2.5, two `w-3.5`s at 3, one `w-3`
 * at 2.5 — plus the two bookmarks, which passed 1.5 because the Heroicons v2
 * glyph was drawn for it. lucide's is drawn for 2.
 *
 * ── Why two renderers and a table, rather than 46 components ──────────
 *
 * `glyph` is lucide's frame with the children slotted in. Note that
 * `strokeLinecap`/`strokeLinejoin` sit on the `<svg>`, where lucide puts
 * them, rather than on each `<path>` — both inherit, so nothing draws
 * differently, and it is what lets a glyph hold `<circle>`, `<rect>` and
 * `<line>` children without repeating attributes on each. 17 of the 46 do;
 * lucide draws primitives as primitives rather than approximating them in
 * path data, which the old `stroked`/`strokedPath` pair could not express.
 *
 * `solid` is the two filled glyphs: the GitHub mark, and the bookmark's
 * saved state.
 *
 * ── Prop order is load-bearing ────────────────────────────────────────
 *
 * React serialises attributes in the order the props are written, and the
 * prerendered public/index.html is compared against the shell attribute by
 * attribute. `id` and `className` are therefore destructured and rendered
 * FIRST, in that order, with `{...rest}` last. `id={undefined}` emits
 * nothing, so the sites without one are unaffected.
 *
 * Size is NOT a variant. Every call site passes its own `className`
 * (`w-4 h-4`, `w-5 h-5`, `w-3.5 h-3.5`, sometimes with `shrink-0` or
 * positioning on top), and a `size` prop would either lose those or have to
 * enumerate them.
 */

export type IconProps = Omit<
  React.SVGProps<SVGSVGElement>,
  'children' | 'viewBox' | 'fill' | 'stroke' | 'd'
>;

/** lucide's drawing weight. Every glyph below is optically drawn for it. */
const STROKE = '2';

/** A 24×24 lucide glyph, in the frame lucide itself ships. */
function glyph(name: string, children: React.ReactNode) {
  const Icon = ({ id, className, strokeWidth = STROKE, ...rest }: IconProps) => (
    <svg
      id={id}
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  );
  Icon.displayName = name;
  return Icon;
}

/** A 24×24 solid glyph. */
function solid(name: string, d: string) {
  const Icon = ({ id, className, ...rest }: IconProps) => (
    <svg id={id} className={className} fill="currentColor" viewBox="0 0 24 24" {...rest}>
      <path d={d} />
    </svg>
  );
  Icon.displayName = name;
  return Icon;
}

// ── Navigation and chrome ────────────────────────────────────────────────

export const ChevronLeftIcon = glyph('ChevronLeftIcon', <path d="m15 18-6-6 6-6" />);  // lucide/chevron-left

export const ChevronRightIcon = glyph('ChevronRightIcon', <path d="m9 18 6-6-6-6" />);  // lucide/chevron-right

/** The disclosure caret — the home panels' expand toggle, and the header title tab. */
export const ChevronDownIcon = glyph('ChevronDownIcon', <path d="m6 9 6 6 6-6" />);  // lucide/chevron-down

/**
 * The pencil with a spark — "back to building" on a session screen while its
 * preview is up. The Figma bar names lucide's pencil-sparkles, which lucide
 * does not ship; this is the one COMPOSED glyph in the set — lucide/pencil's
 * two paths, plus the shell's own four-point spark in the freed corner.
 */
export const PencilSparklesIcon = glyph('PencilSparklesIcon', (  // lucide/pencil + spark
  <>
    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    <path d="m15 5 4 4" />
    <path d="M6 3l.75 1.75L8.5 5.5l-1.75.75L6 8l-.75-1.75L3.5 5.5l1.75-.75z" />
  </>
));

export const ArrowRightIcon = glyph('ArrowRightIcon', (  // lucide/arrow-right
  <>
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </>
));

export const XIcon = glyph('XIcon', (  // lucide/x
  <>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </>
));

export const Bars3Icon = glyph('Bars3Icon', (  // lucide/menu
  <>
    <path d="M4 5h16" />
    <path d="M4 12h16" />
    <path d="M4 19h16" />
  </>
));

export const PlusIcon = glyph('PlusIcon', (  // lucide/plus
  <>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </>
));

export const HomeIcon = glyph('HomeIcon', (  // lucide/house
  <>
    <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
    <path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </>
));

export const SearchIcon = glyph('SearchIcon', (  // lucide/search
  <>
    <path d="m21 21-4.34-4.34" />
    <circle cx="11" cy="11" r="8" />
  </>
));

// ── Status and account ───────────────────────────────────────────────────

export const BellIcon = glyph('BellIcon', (  // lucide/bell
  <>
    <path d="M10.268 21a2 2 0 0 0 3.464 0" />
    <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
  </>
));

export const UserIcon = glyph('UserIcon', (  // lucide/user
  <>
    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </>
));

export const WalletIcon = glyph('WalletIcon', (  // lucide/wallet
  <>
    <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
    <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
  </>
));

/** The door to the Leaderboard — the home screen's Challenges bar and its footer. */
export const TrophyIcon = glyph('TrophyIcon', (  // lucide/trophy
  <>
    <path d="M10 14.66V17a1 1 0 0 1-1 1 2 2 0 0 0-2 2v2" />
    <path d="M14 14.66V17a1 1 0 0 0 1 1 2 2 0 0 1 2 2v2" />
    <path d="M17.916 10H19.5A2.5 2.5 0 0 0 22 7.5V5a1 1 0 0 0-1-1h-3" />
    <path d="M4 22h16" />
    <path d="M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z" />
    <path d="M6.084 10H4.5A2.5 2.5 0 0 1 2 7.5V5a1 1 0 0 1 1-1h3" />
  </>
));

/**
 * The bare tick. Every "added / done" affordance on the platform draws this
 * one path — the home launcher's Added badge, the home panels' checklist, the
 * dev chat's completion banner, the app view's step list, the browse row's Add
 * button. Its callers differ only in `strokeWidth`, which the size rule in
 * this file's header governs.
 */
export const CheckIcon = glyph('CheckIcon', <path d="M20 6 9 17l-5-5" />);  // lucide/check

export const ClockIcon = glyph('ClockIcon', (  // lucide/clock
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" />
  </>
));

export const UserCircleIcon = glyph('UserCircleIcon', (  // lucide/circle-user
  <>
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="10" r="3" />
    <path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662" />
  </>
));

export const WarningTriangleIcon = glyph('WarningTriangleIcon', (  // lucide/triangle-alert
  <>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </>
));

export const ShieldCheckIcon = glyph('ShieldCheckIcon', (  // lucide/shield-check
  <>
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    <path d="m9 12 2 2 4-4" />
  </>
));

export const LockIcon = glyph('LockIcon', (  // lucide/lock
  <>
    <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </>
));

export const KeyIcon = glyph('KeyIcon', (  // lucide/key-round
  <>
    <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
    <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
  </>
));

/**
 * The spinning arc, as the sync banner draws it.
 *
 * Not a lucide glyph and not a `glyph()` one: it is a faint ring with a bright
 * quarter-arc laid over it — a `<circle>` and a FILLED `<path>` — so it has no
 * counterpart in an outline set. The colour and the size come from
 * `className`; `animate-spin` is the caller's, so a still frame of it can be
 * rendered where a capture would otherwise be non-deterministic.
 */
export const SpinnerArcIcon = ({ id, className, ...rest }: IconProps) => (
  <svg id={id} className={className} fill="none" viewBox="0 0 24 24" {...rest}>
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
  </svg>
);
SpinnerArcIcon.displayName = 'SpinnerArcIcon';

// ── Conversation ─────────────────────────────────────────────────────────

/** A speech bubble with an ellipsis — the header's chat, and the Messages drawer. */
export const ChatIcon = glyph('ChatIcon', (  // lucide/message-circle-more
  <>
    <path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" />
    <path d="M8 12h.01" />
    <path d="M12 12h.01" />
    <path d="M16 12h.01" />
  </>
));

export const ShareIcon = glyph('ShareIcon', (  // lucide/share-2
  <>
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <line x1="8.59" x2="15.42" y1="13.51" y2="17.49" />
    <line x1="15.41" x2="8.59" y1="6.51" y2="10.49" />
  </>
));

export const PaperclipIcon = glyph('PaperclipIcon', <path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551" />);  // lucide/paperclip

export const ArrowUpTrayIcon = glyph('ArrowUpTrayIcon', (  // lucide/upload
  <>
    <path d="M12 3v12" />
    <path d="m17 8-5-5-5 5" />
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
  </>
));

export const SendIcon = glyph('SendIcon', (  // lucide/send
  <>
    <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
    <path d="m21.854 2.147-10.94 10.939" />
  </>
));

export const UserGroupIcon = glyph('UserGroupIcon', (  // lucide/users
  <>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <path d="M16 3.128a4 4 0 0 1 0 7.744" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <circle cx="9" cy="7" r="4" />
  </>
));

// ── The dev chat's draft rows ────────────────────────────────────────────

export const SaveDraftIcon = glyph('SaveDraftIcon', (  // lucide/save
  <>
    <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
    <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
    <path d="M7 3v4a1 1 0 0 0 1 1h7" />
  </>
));

export const DraftEditIcon = glyph('DraftEditIcon', (  // lucide/pencil
  <>
    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    <path d="m15 5 4 4" />
  </>
));

export const DraftTrashIcon = glyph('DraftTrashIcon', (  // lucide/trash-2
  <>
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M3 6h18" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </>
));

// ── Tooling ──────────────────────────────────────────────────────────────

export const TerminalIcon = glyph('TerminalIcon', (  // lucide/square-terminal
  <>
    <path d="m7 11 2-2-2-2" />
    <path d="M11 13h4" />
    <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
  </>
));

export const CogIcon = glyph('CogIcon', (  // lucide/settings
  <>
    <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
    <circle cx="12" cy="12" r="3" />
  </>
));

/**
 * An ⓘ in a circle — a help affordance beside a heading, not a status. The
 * home screen's widget strip uses it for "how do I add this to my home
 * screen?", and the ring is what keeps it from reading as an error.
 */
export const InfoCircleIcon = glyph('InfoCircleIcon', (  // lucide/info
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4" />
    <path d="M12 8h.01" />
  </>
));

/**
 * The Improve button's two settled states (#1474). The bulb is idle — "there
 * is something here you could change" — and the cyclic arrows are "a new build
 * is ready, reload onto it". `SpinnerArcIcon` above is the third state and the
 * only one of the three that is not a lucide file.
 *
 * The bulb came BACK here rather than being redrawn. It left the set when the
 * Improve pill went text-only and nothing imported it; the note at the head of
 * this module says to take a retired glyph from lucide by the slug the old
 * entry named, and `lightbulb` is that slug.
 */
export const LightBulbIcon = glyph('LightBulbIcon', (  // lucide/lightbulb
  <>
    <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
    <path d="M9 18h6" />
    <path d="M10 22h4" />
  </>
));

/**
 * The only CYCLIC arrow in the set — `ArrowRightIcon` is directional, and the
 * distinction is the whole reason this one exists separately. lucide spells it
 * `refresh-cw`; Heroicons called the same two-arc glyph `arrow-path`, which is
 * where this export's name comes from.
 */
export const ArrowPathIcon = glyph('ArrowPathIcon', (  // lucide/refresh-cw
  <>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M8 16H3v5" />
  </>
));

// ── Media ────────────────────────────────────────────────────────────────

export const CameraIcon = glyph('CameraIcon', (  // lucide/camera
  <>
    <path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" />
    <circle cx="12" cy="13" r="3" />
  </>
));

export const PhotoIcon = glyph('PhotoIcon', (  // lucide/image
  <>
    <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
  </>
));

/**
 * #1280: saving a message. The outline/solid PAIR is the point — this is the
 * only glyph in the set that has to render two states, and hollow-versus-
 * filled says which one at 12px, where an opacity difference does not.
 *
 * lucide ships no solid variant, so the saved state is lucide/bookmark's own
 * path filled rather than stroked. Same drawing, two treatments.
 */
export const BookmarkIcon = glyph('BookmarkIcon', <path d="M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z" />);  // lucide/bookmark

export const BookmarkSolidIcon = solid(
  'BookmarkSolidIcon',
  'M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z',
);

/**
 * The ⋮ and ⋯ overflow controls.
 *
 * lucide draws each dot as a stroked `<circle>` of radius 1: at stroke 2 the
 * stroke closes the circle, so it reads as a solid 4px dot. That is what
 * retired the set's last 20-grid outlier — these two used to be the only
 * glyphs drawn on a viewBox other than 24.
 */
export const EllipsisVerticalIcon = glyph('EllipsisVerticalIcon', (  // lucide/ellipsis-vertical
  <>
    <circle cx="12" cy="12" r="1" />
    <circle cx="12" cy="5" r="1" />
    <circle cx="12" cy="19" r="1" />
  </>
));

export const EllipsisHorizontalIcon = glyph('EllipsisHorizontalIcon', (  // lucide/ellipsis
  <>
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
    <circle cx="5" cy="12" r="1" />
  </>
));

/** "Open the staging preview" — the eye, and the same eye struck through. */
export const EyeIcon = glyph('EyeIcon', (  // lucide/eye
  <>
    <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
    <circle cx="12" cy="12" r="3" />
  </>
));

export const EyeOffIcon = glyph('EyeOffIcon', (  // lucide/eye-off
  <>
    <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
    <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
    <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
    <path d="m2 2 20 20" />
  </>
));

/** The author-only inline title edit: a pencil over a document corner. */
export const PencilSquareIcon = glyph('PencilSquareIcon', (  // lucide/square-pen
  <>
    <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
  </>
));

/**
 * The GitHub mark. lucide removed brand icons in 2023, so this one stays the
 * shell's own — a brand mark is not a drawing anyone may normalise anyway.
 */
export const GitHubIcon = solid(
  'GitHubIcon',
  'M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z',
);

/**
 * One glyph's worth of shapes: `['path', { d: '…' }]`, `['circle', { … }]`.
 * lucide's children, as data rather than as JSX.
 */
export type GlyphShapes = ReadonlyArray<readonly [string, Record<string, string | number>]>;

/**
 * The escape hatch, for the two call sites that pick their glyph out of a
 * table at render time rather than naming one: the app card's visibility chip
 * (`VIS_CHIP_SHAPES`) and the Dev card's per-kind icon (`DEV_CARD_ICONS`,
 * whose glyph is the fallback behind an OpenMoji illustration).
 *
 * It takes SHAPES, not a `d`, because 35 of the lucide glyphs in this file
 * are not path-only — and both of those tables are also read by a string
 * renderer in `public/js/**` or `features/apps/app-card.js`, which cannot
 * import a component. One table, two renderers, no second copy of the data.
 */
export const Glyph = ({
  id,
  className,
  shapes,
  strokeWidth = STROKE,
  ...rest
}: IconProps & { shapes: GlyphShapes }) => (
  <svg
    id={id}
    className={className}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...rest}
  >
    {shapes.map(([tag, attrs], i) => React.createElement(tag, { key: i, ...attrs }))}
  </svg>
);
Glyph.displayName = 'Glyph';
