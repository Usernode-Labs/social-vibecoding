import * as React from 'react';

import { cn } from '@/lib/utils';

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

interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const context = React.useContext(TabsContext);
  if (!context) {
    throw new Error(`<${component}> must be rendered inside <Tabs>`);
  }
  return context;
}

export interface TabsProps {
  /** The active tab's key. Controlled — this primitive holds no state. */
  value: string;
  /** Called with a trigger's `value` when it is clicked. */
  onValueChange: (value: string) => void;
  children: React.ReactNode;
}

/**
 * Provides the active value to the triggers below it and renders NOTHING of its
 * own — no wrapper element. The Leaderboard screen's strip sits inside markup
 * that predates it (`#standings-tabs` inside the screen's max-w-5xl column), and
 * an extra div would be a rendered-DOM change.
 */
function Tabs({ value, onValueChange, children }: TabsProps) {
  const context = React.useMemo<TabsContextValue>(
    () => ({ value, onValueChange }),
    [value, onValueChange],
  );
  return <TabsContext.Provider value={context}>{children}</TabsContext.Provider>;
}

export type TabsListProps = React.HTMLAttributes<HTMLDivElement>;

/**
 * The strip container. A plain `<div>`: deliberately no `role="tablist"`, since
 * the strips this replaces have none and the primitive does not implement the
 * keyboard model that role promises. `...props` first for the same reason as
 * TabsTrigger — the caller's `id` should render ahead of `class`, which is the
 * order the hand-written markup this replaces had.
 */
const TabsList = React.forwardRef<HTMLDivElement, TabsListProps>(
  ({ className, children, ...props }, ref) => (
    <div ref={ref} {...props} className={className}>
      {children}
    </div>
  ),
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
 * One trigger. `aria-current="page"` on the active one and `"false"` on the
 * rest — the convention the shell's strips already use, not `aria-selected`
 * (which belongs to `role="tab"`).
 *
 * Note the absence of `type="button"`: the strips this replaces emit none, no
 * strip sits inside a form, and adding it would be a rendered-DOM change.
 * Anything spread through `...props` lands on the button, which is how a caller
 * passes the `data-*` key its module and dapp.json checks select on. `...props`
 * comes FIRST so the three attributes this primitive owns cannot be clobbered
 * by a caller — and so the rendered attribute order is the `data-*` key, then
 * `aria-current`, then `class`, which is the order the strings these strips
 * replace emitted them in.
 */
const TabsTrigger = React.forwardRef<HTMLButtonElement, TabsTriggerProps>(
  ({ value, className, activeClassName, inactiveClassName, onClick, children, ...props }, ref) => {
    const context = useTabsContext('TabsTrigger');
    const active = context.value === value;
    return (
      <button
        ref={ref}
        {...props}
        aria-current={active ? 'page' : 'false'}
        className={cn(className, active ? activeClassName : inactiveClassName)}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) context.onValueChange(value);
        }}
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
export const SECTION_TABS_LIST =
  'inline-flex items-center gap-0.5 rounded-full bg-white dark:bg-zinc-900 p-0.5 mb-4';

export const SECTION_TAB_BASE =
  'inline-flex items-center justify-center h-8 px-4 rounded-full text-sm font-semibold transition-colors';

export const SECTION_TAB_ACTIVE = 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900';

export const SECTION_TAB_INACTIVE =
  'text-zinc-500 dark:text-zinc-400 '
  + 'hover:text-zinc-900 dark:hover:text-zinc-100';

export { Tabs, TabsList, TabsTrigger };
