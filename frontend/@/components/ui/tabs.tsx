import * as React from 'react';
import { cva } from 'class-variance-authority';

import { cn } from '@/lib/utils';
import { chipVariants } from '@/components/ui/chip';
import { radioGroupKeys } from '../../../src/lib/radio-group';

/**
 * The platform's tab strip: a row of `<button>`s with a violet underline on the
 * active one, and the caller's own container element.
 *
 * ── Why this is NOT @radix-ui/react-tabs ───────────────────────────────
 *
 * Same reason as Switch. Stock shadcn's Tabs is a Radix wrapper, and Radix
 * renders `role="tablist"` / `role="tab"` / `role="tabpanel"`, generated
 * `id`/`aria-controls` pairs, `aria-selected`, `data-state`, and roving-tabindex
 * arrow-key navigation. The shell's tab strips are plain buttons carrying a
 * `data-*` key and `aria-current="page"`, and #1083 chunk F is a strictly
 * like-for-like conversion — identical rendered DOM, no restyling, no IA
 * changes. Radix would rewrite every attribute on every trigger and change the
 * keyboard behaviour, and dapp.json's declared checks select on the `data-*`
 * keys.
 *
 * It also could not wrap the panels. `TabsContent` mounts and unmounts its
 * children, and the Leaderboard screen's three panes are innerHTML hosts owned
 * by three separate legacy modules with their own lazy-mount and teardown
 * lifecycle (see features/leaderboard/index.tsx). Panel visibility stays where
 * it is; this primitive is the STRIP only.
 *
 * So what it contributes is the part that was actually duplicated: the
 * active/inactive class tables, the `aria-current` convention, and one place
 * that knows a trigger is a button whose click reports a value. The markup it
 * emits is byte-for-byte what the strip's innerHTML template produced.
 *
 * ── Class tables ───────────────────────────────────────────────────────
 *
 * `SECTION_TAB_*` below are the underlined-strip variant the Leaderboard
 * screen's top-level sections use. They live here rather than in the island
 * because they are the strip's identity, not one screen's styling — the next
 * chunk that converts a strip should reuse them, and any that genuinely needs a
 * different shape passes its own strings.
 */

/*
 * ── Three kinds of strip ───────────────────────────────────────────────
 *
 * The primitive began as the Leaderboard's strip and says nothing to
 * assistive tech: `kind="nav"`, plain buttons with `aria-current`. Most
 * strips in the app are not that. They are one of two things, and before
 * this primitive took them each one spelled its own roles:
 *
 * - `kind="tabs"`: views of the same thing (the plan's What you'll see |
 *   How it's built, the bell's Unread | Recent threads | All, the emoji
 *   picker's categories). `role="tablist"` on the strip, `role="tab"` with
 *   `aria-selected` on each trigger. Every trigger is a button in the tab
 *   order, as every hand-built tablist in the app was: no arrow keys, so
 *   nothing a keyboard did before changes.
 * - `kind="radio"`: one setting out of a few (Email code | Password, Form |
 *   Comment). `role="radiogroup"`, `role="radio"` with `aria-checked`, and
 *   the WAI-ARIA radio keyboard the app already gives its radio groups
 *   (#6510, src/lib/radio-group.ts): one tab stop, the arrow keys move the
 *   pick. It needs the options in drawn order, `values`, for that.
 *
 * ── Rendered attribute order ──────────────────────────────────────────
 *
 * Suites pin these strips' prerendered markup, so a `tabs` or `radio`
 * trigger renders `type`, `id`, its role and its state, then the caller's
 * own attributes (the `data-*` keys checks select on), then `tabindex`,
 * `class` and `style`: the order the hand-built strips emitted.
 *
 * ── Looks ─────────────────────────────────────────────────────────────
 *
 * A strip passes its own class strings (the Leaderboard's SECTION_TAB_*
 * below, the landing's story tabs) or takes one of the two looks the app's
 * strips share, set once on `<Tabs>` and read by the list and triggers:
 *
 * - `look="segment"`: the One look's segmented control (`one-seg`, the
 *   design review of 25 Nov 2026 in public/css/app.css: "segmented controls
 *   an ink pill on a light track"). That shared part draws the track and its
 *   options from the roles and states this primitive writes, so the triggers
 *   carry only what it leaves open: a gap for a glyph, `size="md"` for a
 *   sheet's 44px switch, `fill` to take the row's width, `shape="icon"` for
 *   a glyph with no words. Given `values`, the strip sets `--one-seg-n` and
 *   `--one-seg-i`, and the pill slides to the option picked.
 * - `look="chip"`: separate chips, the chosen one inverted, drawn from
 *   @/components/ui/chip.tsx's own class table at its `bar` size, so a tab
 *   strip of chips and the filter chips under it are one look. Only the
 *   roles differ: a chip filter says `aria-pressed`, a tab `aria-selected`.
 */

export type TabsKind = 'nav' | 'tabs' | 'radio';

const tabsListVariants = cva('', {
  variants: {
    look: {
      none: '',
      segment: 'one-seg',
      chip: 'flex gap-2 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
    },
    // The One look's control is inline: `fill` stretches it across the row.
    fill: { true: '', false: '' },
  },
  compoundVariants: [
    { look: 'segment', fill: true, className: 'w-full' },
  ],
  defaultVariants: { look: 'none', fill: false },
});

// What `one-seg` leaves to the option: the room between a glyph and its
// words, the glyph's size, a sheet's taller option, and an icon's own width
// (the shared part pads every option for words; a row of glyphs takes it off).
const segmentTrigger = cva('gap-1.5 [&>svg]:h-4 [&>svg]:w-4', {
  variants: {
    size: { sm: '', md: 'h-11' },
    shape: { text: '', icon: '!px-0' },
  },
  defaultVariants: { size: 'sm', shape: 'text' },
});

type TabsLook = 'none' | 'segment' | 'chip';
type TabsSize = 'sm' | 'md';
type TabsShape = 'text' | 'icon';

/** The classes a trigger of a shared look wears, chosen or not. */
function lookTriggerClass(look: TabsLook, size: TabsSize, shape: TabsShape, selected: boolean): string {
  if (look === 'segment') return segmentTrigger({ size, shape });
  if (look === 'chip') return cn(chipVariants({ selected, size: 'bar', shape }), shape === 'text' ? 'px-4 whitespace-nowrap' : '');
  return '';
}

interface RadioKeys {
  tabIndex: (option: string) => 0 | -1;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
}

interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
  kind: TabsKind;
  look: TabsLook;
  size: TabsSize;
  fill: boolean;
  shape: TabsShape;
  /** The options in drawn order, when the strip was given them. */
  values: readonly string[] | null;
  /** A radio strip's keyboard; null for the other kinds. */
  keys: RadioKeys | null;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const context = React.useContext(TabsContext);
  if (!context) {
    throw new Error(`<${component}> must be rendered inside <Tabs>`);
  }
  return context;
}

interface TabsBaseProps {
  /** The active tab's key. Controlled — this primitive holds no state. */
  value: string;
  /** Called with a trigger's `value` when it is clicked (or, in a radio strip, picked with a key). */
  onValueChange: (value: string) => void;
  /** A shared look, for the list and every trigger under it. */
  look?: TabsLook;
  /** `md`: a sheet's own switch, 44px options (segment look). */
  size?: TabsSize;
  /** Take the row's width, shared evenly between the options (segment look). */
  fill?: boolean;
  /** Triggers that are a glyph with no words. */
  shape?: TabsShape;
  children: React.ReactNode;
}

export type TabsProps =
  | (TabsBaseProps & {
    kind?: 'nav' | 'tabs';
    /** The options in drawn order: a segment strip slides its pill with them. */
    values?: readonly string[];
  })
  | (TabsBaseProps & {
    kind: 'radio';
    /** The options in the order they are drawn: the arrow keys walk them. */
    values: readonly string[];
  });

/**
 * Provides the active value to the triggers below it and renders NOTHING of its
 * own — no wrapper element. The Leaderboard screen's strip sits inside markup
 * that predates it (`#standings-tabs` inside the screen's max-w-5xl column), and
 * an extra div would be a rendered-DOM change.
 */
function Tabs({
  value, onValueChange, kind = 'nav', values, look = 'none', size = 'sm', fill = false, shape = 'text', children,
}: TabsProps) {
  const keys = kind === 'radio' && values ? radioGroupKeys(values, value, onValueChange) : null;
  const context: TabsContextValue = {
    value, onValueChange, kind, look, size, fill, shape, values: values || null, keys,
  };
  return <TabsContext.Provider value={context}>{children}</TabsContext.Provider>;
}

export type TabsListProps = React.HTMLAttributes<HTMLDivElement>;

/**
 * The strip container, a plain `<div>`. In a `nav` strip it says nothing to
 * assistive tech, as the strips that kind replaced said nothing; a `tabs`
 * strip is a `tablist` and a `radio` strip a `radiogroup` with the radio
 * keyboard on it. `...props` first in a nav strip for the same reason as
 * TabsTrigger — the caller's `id` should render ahead of `class`, which is
 * the order the hand-written markup this replaces had.
 *
 * The look's classes and the caller's are JOINED, not merged: a strip the
 * kit hides by toggling `hidden` (the staging bar's switch) renders `hidden`
 * beside the look's own display, and tailwind-merge would drop one of them.
 * While it is there `hidden` wins: Tailwind's order over a utility, and
 * app.css's `.one-seg.hidden` over the One look's track.
 */
const TabsList = React.forwardRef<HTMLDivElement, TabsListProps>(
  ({ className, children, onKeyDown, style, ...props }, ref) => {
    const context = useTabsContext('TabsList');
    const classes = [
      tabsListVariants({ look: context.look, fill: context.fill }).trim(),
      className,
    ].filter(Boolean).join(' ') || undefined;
    // The One look's sliding pill: how many options, and which is picked.
    // Only while one is: with none picked (the emoji picker while it
    // searches) the pill would sit off the track's start.
    const at = context.look === 'segment' && context.values ? context.values.indexOf(context.value) : -1;
    const slide = at >= 0 && context.values
      ? { ...style, ['--one-seg-n' as string]: String(context.values.length), ['--one-seg-i' as string]: String(at) } as React.CSSProperties
      : style;
    if (context.kind === 'nav') {
      return (
        <div ref={ref} {...props} style={slide} onKeyDown={onKeyDown} className={classes}>
          {children}
        </div>
      );
    }
    const keys = context.keys;
    return (
      <div
        ref={ref}
        role={context.kind === 'radio' ? 'radiogroup' : 'tablist'}
        {...props}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (!event.defaultPrevented) keys?.onKeyDown(event);
        }}
        className={classes}
        style={slide}
      >
        {children}
      </div>
    );
  },
);
TabsList.displayName = 'TabsList';

export interface TabsTriggerProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'value'> {
  /** This trigger's key. Reported to `onValueChange`; compared to `value`. */
  value: string;
  /** Classes on every trigger, active or not. */
  className?: string;
  /** Classes added when this trigger is the active one. */
  activeClassName?: string;
  /** Classes added when it is not. */
  inactiveClassName?: string;
}

/**
 * One trigger.
 *
 * In a `nav` strip: `aria-current="page"` on the active one and `"false"` on
 * the rest — the convention the Leaderboard's strip used, not `aria-selected`
 * (which belongs to `role="tab"`) — and no `type="button"`, since the strips
 * that kind replaced emit none. Anything spread through `...props` lands on
 * the button, which is how a caller passes the `data-*` key its module and
 * dapp.json checks select on. `...props` comes FIRST so the attributes this
 * primitive owns cannot be clobbered by a caller.
 *
 * In a `tabs` or `radio` strip: a `type="button"` with its role and state,
 * and in a radio strip the one tab stop (see the header for the order).
 */
const TabsTrigger = React.forwardRef<HTMLButtonElement, TabsTriggerProps>(
  ({ value, className, activeClassName, inactiveClassName, onClick, children, ...props }, ref) => {
    const context = useTabsContext('TabsTrigger');
    const active = context.value === value;
    const classes = cn(
      lookTriggerClass(context.look, context.size, context.shape, active),
      className,
      active ? activeClassName : inactiveClassName,
    );
    const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      if (!event.defaultPrevented) context.onValueChange(value);
    };
    if (context.kind === 'nav') {
      return (
        <button
          ref={ref}
          {...props}
          aria-current={active ? 'page' : 'false'}
          className={classes}
          onClick={handleClick}
        >
          {children}
        </button>
      );
    }
    const { id, style, tabIndex, ...rest } = props;
    const state = context.kind === 'radio'
      ? { role: 'radio', 'aria-checked': active }
      : { role: 'tab', 'aria-selected': active };
    return (
      <button
        ref={ref}
        type="button"
        id={id}
        {...state}
        {...rest}
        tabIndex={context.keys ? context.keys.tabIndex(value) : tabIndex}
        className={classes}
        style={style}
        onClick={handleClick}
      >
        {children}
      </button>
    );
  },
);
TabsTrigger.displayName = 'TabsTrigger';

/** The underlined-strip variant: container, then the trigger's three parts. */
/*
 * The strip is a SEGMENTED CONTROL now, not an underlined tab row.
 *
 * The underline — a rule under the whole strip with a thicker accent segment
 * under the active label — is the shape the widget language replaces
 * everywhere: it separates by RULE, and the language separates by
 * figure/ground. The selected state is the language's one high-contrast
 * treatment (near-black fill, page-coloured ink), the same inversion
 * @/components/ui/chip.tsx documents and features/improve/view-toggle.tsx
 * already ships. Two strips in one product reading the same way is the point.
 *
 * Deliberately NOT routed through Chip: these are tabs. Chip's header explains
 * why sharing the LOOK is not a reason to share the SEMANTICS — a chip is a
 * toggle and says `aria-pressed`, a tab is selected and says `aria-current`.
 * This strip keeps every attribute it had; only the classes changed, so
 * dapp.json's checks on the `data-*` keys are untouched.
 *
 * The track is `inline-flex` rather than `flex` so it shrinks to its labels
 * instead of spanning the page: a full-width track under a `max-w-5xl` table
 * would read as a header bar rather than as a control.
 */
/*
 * WHITE track, not zinc-100. In this palette zinc-100 IS the page ground
 * (#eaeaea), and a recessed grey track is a shape that only exists on a white
 * card — on the ground itself it disappears and the strip reads as three loose
 * labels with one of them blacked out. The language's controls FLOAT on the
 * ground, so the track is a raised white surface, like the header's hamburger
 * disc and an unselected chip.
 */
/*
 * Two spellings of the same track. `SECTION_TABS_LIST` is the one a strip on
 * its own line wants, margin included. `SECTION_TABS_LIST_BASE` is the same
 * surface WITHOUT that margin, for a strip that shares a flex row with
 * something else — the Kudos pane's sub-strip sits opposite its window pills
 * in an `items-center` row, where a bottom margin on one flex item lifts it
 * off the row's centre line. The surface classes live in one string either
 * way, so a track can never half-change.
 */
export const SECTION_TABS_LIST_BASE =
  'inline-flex items-center gap-0.5 rounded-full bg-white dark:bg-zinc-900 p-0.5 '
  + 'dark:ring-1 dark:ring-inset dark:ring-zinc-700';

export const SECTION_TABS_LIST = SECTION_TABS_LIST_BASE + ' mb-4';

export const SECTION_TAB_BASE =
  'inline-flex items-center justify-center h-8 px-4 rounded-full text-sm font-semibold transition-colors';

export const SECTION_TAB_ACTIVE = 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900';

export const SECTION_TAB_INACTIVE =
  'text-zinc-500 dark:text-zinc-300 '
  + 'hover:text-zinc-900 dark:hover:text-zinc-100';

export { Tabs, TabsList, TabsTrigger };
