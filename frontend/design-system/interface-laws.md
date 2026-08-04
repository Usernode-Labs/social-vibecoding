# Usernode shell interface laws

Platform-shell laws were ratified on 2026-07-31 at
`a09473723e988cf309ac12974e45efd8eb749528` and review rubric SHA-256
`3f972005def9e2a580373ae2f14a8836f0f92e78c661bd846107976654ac7a5c`.
Receipt: `a2c93c597a7966312e4edc4798e3d6edea6b7cf66d6e4a442e6ced99fc06dffc`.

Quiet UI was owner-locked on 2026-08-03 in Buzz event
`9626471f2ea679b95328ba4cfa940dcee1bf59cdfbce6dfab5ffa44decabb76c`
from baseline `49e5e47f89329bfbd999cec2ba6b516d622ee712`.

## 1. Surface role

Every view has one Paper. Print content; never stack Cards.

| Role | Separation | Do not |
|---|---|---|
| Canvas | Darker page field; shell navigation prints on it | Treat it as route content |
| Paper | One lighter shell-owned sheet on Canvas | Nest Paper or spell `div` as Card |
| Print | Bare inherited content | Add opaque fill, ring, or shadow |
| Container | Alpha grouping; compounds at any depth | Paint opaque Paper |
| Overlay | Transient; candidate navigation only | Persist another |

`Sheet` is the drawer, never a surface. Wrappers use
`data-surface="canvas|paper|print|container|overlay"`; absent means Print.
Persistent structural fill, edge, ring, shadow, and elevation require a declared
role. Undeclared painters, painted Print, and multiple elevated roles are debt;
primitive anatomy and semantic status, identity, progress, or media ink are not.
Canvas/Paper are opaque. Container alpha darkens light and lightens dark;
nesting is intentional. Only the `platform-bottom-navigation` slot may persist;
`PlatformShell` does not mount it.
Sidebar stays shell navigation on Canvas as Paper moves; never a Rail. Popover
aliases Paper. Container neutral ink is black at 6 percent in light mode and
white at 5 percent in dark; foreground neutral ink is 80, 65, and 57 percent.

Status is ink, not Paper. Metric is one definition list, never a
Card per value. Stream rows use dividers, whitespace, and quiet interaction.

Callers may remove treatment and own layout, but cannot add persistent fill,
border, ring, or shadow. `hover`, `focus`, `focus-visible`, `focus-within`,
`active`, and group/peer forms are ephemeral; attribute states are not. Bare
radius paints nothing. Repeated recipes become variants. Primitive anatomy and
internal state stay owned; governed-to-governed calls still count.

## 2. Radius and spacing

Large radii belong to independent raised surfaces, dialogs, and substantial
media. Medium radii belong to controls, status treatments, and inset sections.
Small radii belong to compact rows, focus contours, and tight nesting. Full
radii are reserved for true pills, circular controls, and content-shaped chips.
Inner geometry stays concentric: a painted outer radius covers its inner radius
plus inset. Use only governed `none`, `sm`–`4xl`, or `full`; arbitrary radii fail.

Spacing uses four semantic densities: tight inline relation, compact control
cluster, standard component rhythm, and generous page-section separation.
Measure governed components before changing token values; do not perform blind
global utility rewrites.

Containers own separation. A caller does not add margin to a governed component
invocation; the parent owns the relationship through `gap`. Macro spacing tokens
remain in outer layout zones. Radius depth is compared only across painted
surfaces, not controls, avatars, status dots, or shape primitives.

## 3. Type and target roles

Use 16 CSS pixels for prose and row titles, 14 for controls and functional
metadata, and 12 only for tertiary non-actionable metadata. Subtitles, alerts,
actions, and mobile-critical facts never fall into the 12-pixel role.

Compact controls may remain visually compact while coarse pointers receive an
effective 44 to 48 CSS-pixel target without overlap. Primary mobile navigation
links are visibly at least 44 CSS pixels high; invisible padding does not make a
36-pixel icon bar primary navigation.

## 4. Action scale

One view or dialog has at most one filled primary action. Secondary actions use
outline or quiet fill. Tertiary utilities use ghost treatment. Navigation keeps
Link or anchor semantics and uses shared link visual variants; an ordinary Link
is not rendered through Button. Destructive color is reserved for irreversible
consequence.

Tabs, ToggleGroup, radio, and select own selection: nested Container on
Container, never opaque Paper, primary fill, shadow, or submission styling.

On narrow screens, the identity anchor remains complete before utilities take
space: application identity anchors application routes, the page name anchors
platform routes, and Back remains available. Caller-owned utilities move to a
secondary row before the identity truncates; wide screens keep the single-row
composition. Responsive placement never changes an action's meaning, emphasis,
or keyboard order.

## 5. Status by consequence

StatusDot owns ambient state. Badge owns category or classification. A progress
owner presents measurable domain progress. Alert owns consequential feedback
and its valid recovery. FieldError stays next to its attributable value.
Persistence failure stays adjacent to the form or region that owns it and
preserves the last confirmed value when relevant.

Neutral StatusDot means absence of consequence. It borrows `--muted`,
`--muted-foreground`, and `--border`; no sixth status-token trio is created.
Work rows that combine a category Badge and spinner for Working, Paused, or In
vote are a counterexample, not precedent.

## 6. Disabled grammar

Preserve the label and readable foreground contrast. Remove action emphasis,
including destructive color. Use native `disabled` where supported; otherwise
use `aria-disabled` with guarded activation. Styling never replaces behavior.
Disabled and selected remain distinct. Pending actions name the active operation
and do not collapse into unlabeled spinners. Field labels and explanatory copy
do not fade merely because one child control is unavailable.
Element opacity is forbidden for disabled controls and labels because it also
fades readable text and focus affordances. Use semantic foreground and fill
tokens for the disabled treatment while preserving native disabled behavior.

## Representative Activity stream-row contract

- One semantic Link owns the row destination. An unread row may add one sibling
  Mark read action; neither interactive element contains the other.
- Destination precedes the secondary action in keyboard order. The secondary
  action mutates read state without navigation.
- Both targets provide non-overlapping 48-by-48 CSS-pixel coarse-pointer reach.
- Anatomy is a stable caller-owned anchor, title, one quiet metadata line,
  optional trailing value, and at most one sibling action. The anchor may show
  unread, rank, identity, or category. Unread rows require the sibling action;
  read rows never carry one. No repeated Open/View control remains.
- A read row renders no secondary action and reserves no dead gutter for it.
  The content anchor remains stable when the mutation lands.
- Evidence covers read/unread, loading, empty, errors, pagination, live and
  read-only states, long content, both themes and widths, focus, navigation,
  and mutation.

The Activity representative passed the Codex engineering gate and Claude craft
gate before route-family adoption. New consumers preserve this anatomy and keep
fetching, mutation, authorization, and destination ownership in their routes.
