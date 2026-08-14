import * as React from 'react';

/**
 * The shell's icon set, as named components.
 *
 * ── Why this is NOT `lucide-react` ────────────────────────────────────
 *
 * shadcn's own examples import glyphs from `lucide-react`, and every icon
 * below has a lucide counterpart with the same NAME. It does not have the same
 * PATH. The shell's glyphs are Heroicons v1/v2 outline, hand-picked over
 * several years, and lucide draws them on a different grid with a different
 * stroke rhythm — swapping the set would restyle thirty-odd buttons at once,
 * which is precisely the visual change this migration is not allowed to make.
 * It would also be the first runtime dependency added since step 1, for
 * something the shell already ships inline.
 *
 * So: **every `d` string in this file is transcribed verbatim from the markup
 * it replaces.** If a glyph here ever looks wrong, the fix is to correct the
 * path, never to reach for a package.
 *
 * ── Why three renderers and a table, rather than 25 components ────────
 *
 * The 36 inline `<svg>` blocks this replaces differ in exactly three ways,
 * and the three factories below are those three ways:
 *
 *   `stroked`     — `strokeWidth` on the `<svg>`. Twenty-nine of them.
 *   `strokedPath` — `strokeWidth` on the `<path>`. Five of them, all glyphs
 *                   that predate the others; the rendered result is identical
 *                   but the DOM is not, and a like-for-like conversion keeps
 *                   the DOM.
 *   `filled`      — `fill="currentColor"`, no stroke. One: the GitHub mark.
 *
 * Everything else — `fill="none"`, `stroke="currentColor"`,
 * `viewBox="0 0 24 24"`, `strokeLinecap`/`strokeLinejoin` on every path — was
 * already identical at all 36 sites, so it lives in the factory.
 *
 * ── Prop order is load-bearing ────────────────────────────────────────
 *
 * React serialises attributes in the order the props are written, and the
 * prerendered public/index.html is compared against the hand-written shell
 * attribute by attribute. `id` and `className` are therefore destructured and
 * rendered FIRST, in that order, with `{...rest}` last — which is the order
 * all 36 call sites already used. `id={undefined}` emits nothing, so the
 * sites without one are unaffected.
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

function paths(d: string | readonly string[]): readonly string[] {
  return typeof d === 'string' ? [d] : d;
}

/** A 24×24 outline glyph whose stroke width sits on the `<svg>`. */
function stroked(name: string, d: string | readonly string[]) {
  const list = paths(d);
  const Icon = ({ id, className, strokeWidth = '2', ...rest }: IconProps) => (
    <svg
      id={id}
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth={strokeWidth}
      {...rest}
    >
      {list.map((entry) => (
        <path key={entry} strokeLinecap="round" strokeLinejoin="round" d={entry} />
      ))}
    </svg>
  );
  Icon.displayName = name;
  return Icon;
}

/** A 24×24 outline glyph whose stroke width sits on the `<path>`. */
function strokedPath(name: string, d: string) {
  const Icon = ({ id, className, ...rest }: IconProps) => (
    <svg id={id} className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" {...rest}>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d={d} />
    </svg>
  );
  Icon.displayName = name;
  return Icon;
}

/** A 24×24 solid glyph. */
function filled(name: string, d: string) {
  const Icon = ({ id, className, ...rest }: IconProps) => (
    <svg id={id} className={className} fill="currentColor" viewBox="0 0 24 24" {...rest}>
      <path d={d} />
    </svg>
  );
  Icon.displayName = name;
  return Icon;
}

// ── Navigation and chrome ────────────────────────────────────────────────

export const ChevronLeftIcon = strokedPath('ChevronLeftIcon', 'M15 19l-7-7 7-7');

/** The tighter back chevron used in the mobile Messages thread header. */
export const ChevronLeftInsetIcon = stroked('ChevronLeftInsetIcon', 'M15 18l-6-6 6-6');

export const ChevronRightIcon = stroked('ChevronRightIcon', 'M9 5l7 7-7 7');

export const ArrowRightIcon = stroked('ArrowRightIcon', 'M14 5l7 7m0 0l-7 7m7-7H3');

/**
 * The SHORT right arrow, drawn on a tighter inset than ArrowRightIcon. Not a
 * duplicate: this one is the go-into-the-app arrow on #browse-detail-open,
 * where it sits beside a word inside a pill and the long arrow's 3→21 span
 * would crowd the label. Two spellings on purpose, each with one caller.
 */
export const ArrowRightShortIcon = stroked('ArrowRightShortIcon', 'M13 7l5 5m0 0l-5 5m5-5H6');

export const XIcon = stroked('XIcon', 'M6 18L18 6M6 6l12 12');

export const Bars3Icon = stroked('Bars3Icon', 'M4 6h16M4 12h16M4 18h16');

export const PlusIcon = stroked('PlusIcon', 'M12 5v14M5 12h14');

export const HomeIcon = strokedPath(
  'HomeIcon',
  'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1h-2z',
);

export const SearchIcon = stroked('SearchIcon', 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z');

// ── Status and account ───────────────────────────────────────────────────

export const BellIcon = stroked(
  'BellIcon',
  'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9',
);

export const UserIcon = stroked(
  'UserIcon',
  'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
);

export const WalletIcon = stroked(
  'WalletIcon',
  'M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3',
);

export const TrophyIcon = stroked(
  'TrophyIcon',
  'M16 11V3H8v8M5 7H3v4a2 2 0 002 2h3M19 7h2v4a2 2 0 01-2 2h-3M8 15a4 4 0 008 0h-8z M12 15v3m-3 3h6',
);

/**
 * The bare tick. Every "added / done" affordance on the platform draws this
 * one path — the home launcher's Added badge, the home panels' checklist, the
 * app view's step list — and the browse row's Add button is the first of them
 * to render from the module. Its callers differ only in `strokeWidth`, which
 * is why this is a `stroked` glyph rather than a `strokedPath` one.
 */
export const CheckIcon = stroked('CheckIcon', 'M5 13l4 4L19 7');

export const ShieldCheckIcon = stroked(
  'ShieldCheckIcon',
  'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
);

export const LockIcon = stroked(
  'LockIcon',
  'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
);

export const KeyIcon = stroked(
  'KeyIcon',
  'M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z',
);

// ── Conversation ─────────────────────────────────────────────────────────

/** The chat glyph in the header — a rounded speech bubble with an ellipsis. */
export const ChatIcon = stroked(
  'ChatIcon',
  'M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
);

/** The Messages drawer glyph, whose tail sits outside the bubble. */
export const ChatBubbleTailIcon = stroked(
  'ChatBubbleTailIcon',
  'M8 10h.01M12 10h.01M16 10h.01M21 12a8 8 0 01-8 8H7l-4 2 1.3-4A9 9 0 1121 12z',
);

/** The dev board's discussion glyph — a squared bubble with a tail. */
export const DiscussionIcon = stroked(
  'DiscussionIcon',
  'M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z',
);

export const ThumbsUpIcon = stroked(
  'ThumbsUpIcon',
  'M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5',
);

export const ShareIcon = stroked(
  'ShareIcon',
  'M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z',
);

export const PaperClipIcon = stroked(
  'PaperClipIcon',
  'M21.4 11.6l-8.5 8.5a6 6 0 01-8.5-8.5l9-9a4 4 0 015.7 5.7l-9 9a2 2 0 01-2.8-2.8l8.4-8.4',
);

export const ArrowUpTrayIcon = stroked(
  'ArrowUpTrayIcon',
  'M12 3v12m0-12l-4 4m4-4l4 4M5 13v7h14v-7',
);

export const SendIcon = stroked(
  'SendIcon',
  'M4 4l17 8-17 8 3-8-3-8zm3 8h14',
);

export const UserGroupIcon = stroked(
  'UserGroupIcon',
  'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zm8-1a3 3 0 010 6m4 5v-2a4 4 0 00-3-3.9',
);

// ── Tooling ──────────────────────────────────────────────────────────────

export const TerminalIcon = stroked(
  'TerminalIcon',
  'M8 9l3 3-3 3m5 0h3M4 6h16a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V7a1 1 0 011-1z',
);

export const CogIcon = stroked('CogIcon', [
  'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
  'M15 12a3 3 0 11-6 0 3 3 0 016 0z',
]);

export const SunIcon = stroked(
  'SunIcon',
  'M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z',
);

export const LightBulbIcon = stroked(
  'LightBulbIcon',
  'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z',
);

export const CameraIcon = stroked('CameraIcon', [
  'M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z',
  'M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z',
]);

export const PhotoIcon = stroked(
  'PhotoIcon',
  'M3 16.5l5.25-5.25a2.25 2.25 0 013.182 0L15 14.818m-1.5-1.5 1.068-1.068a2.25 2.25 0 013.182 0L21 15.5m-18 3.75h18A2.25 2.25 0 0023.25 17V6.75A2.25 2.25 0 0021 4.5H3A2.25 2.25 0 00.75 6.75V17A2.25 2.25 0 003 19.25z',
);

export const GitHubIcon = filled(
  'GitHubIcon',
  'M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z',
);

/**
 * The escape hatch, for the two call sites that pick their `d` out of a table
 * at render time rather than naming a glyph: the dev board's view switcher
 * (`VIEW_ICON_PATHS[mode]`) and the app card's visibility chip
 * (`VIS_CHIP_PATHS[vis.icon]`, whose table app-card.js also interpolates into
 * the string renderer, so the path data has to stay there). Same `stroked`
 * shape as everything above.
 */
export const Glyph = ({
  id,
  className,
  d,
  strokeWidth = '2',
  ...rest
}: IconProps & { d: string }) => (
  <svg
    id={id}
    className={className}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    strokeWidth={strokeWidth}
    {...rest}
  >
    <path strokeLinecap="round" strokeLinejoin="round" d={d} />
  </svg>
);
Glyph.displayName = 'Glyph';
