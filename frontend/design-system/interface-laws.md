# Usernode shell interface laws

These laws govern the platform shell. They were ratified on 2026-07-31 against
`a09473723e988cf309ac12974e45efd8eb749528` and review rubric SHA-256
`3f972005def9e2a580373ae2f14a8836f0f92e78c661bd846107976654ac7a5c`.
Receipt: `a2c93c597a7966312e4edc4798e3d6edea6b7cf66d6e4a442e6ced99fc06dffc`.

The Quiet Money amendment was owner-locked on 2026-08-03 in Buzz event
`9626471f2ea679b95328ba4cfa940dcee1bf59cdfbce6dfab5ffa44decabb76c`
against implementation baseline
`49e5e47f89329bfbd999cec2ba6b516d622ee712`.

## 1. Surface role

Every view has one Paper. Print content instead of stacking ceremonial Cards.

| Role | Separation | Do not |
|---|---|---|
| Canvas | Darker page field; nothing prints on it | Treat it as content |
| Paper | One major semantic surface | Nest Paper or spell `div` as Card |
| Print | Type, alignment, divider, whitespace, one quiet wash | Wrap rows, metrics, or sections in Cards |
| Recess | Named input, tab-track, code, or terminal well | Invent caller-owned inset recipes |
| Overlay | Transient; bottom navigation is the persistent tenant | Add another persistent Overlay |

`Sheet` remains the drawer primitive; it is not a surface role. Owned wrappers
use `data-surface="canvas|paper|print|recess|status|overlay"`; absent means Print.
Recess also names `data-recess-role="input|tab-track|code|terminal"`. The only
persistent Overlay is `data-slot="platform-bottom-navigation"`.

Status colour is ink, not Paper. Metric is one definition-list group, never a
Card per value. Stream rows use dividers, whitespace, and quiet interaction.

At a governed invocation, callers may remove treatment and own external layout;
they may not add persistent fill, border, ring, or shadow. `hover`, `focus`,
`focus-visible`, `focus-within`, `active`, and their group/peer forms are
ephemeral exceptions; attribute states are not. Bare radius paints nothing.
Repeated caller recipes become named variants. Primitive roots, variants,
anatomy, and internal state stay owned; governed-to-governed calls still count.

## 2. Radius and spacing

Large radii belong to independent raised surfaces, dialogs, and substantial
media. Medium radii belong to controls, status surfaces, and inset sections.
Small radii belong to compact rows, focus contours, and tight nesting. Full
radii are reserved for true pills, circular controls, and content-shaped chips.
Inner geometry remains visually concentric and never appears rounder than its
container.

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

Selection remains owned by Tabs, ToggleGroup, radio, or select. Its selected
treatment is an elevated pill on a recessed track, never primary filled and
never visually confused with submission.

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

## Representative Activity stream-row contract

- One semantic Link owns the row destination. An unread row may add one sibling
  Mark read action; neither interactive element contains the other.
- Destination precedes the secondary action in keyboard order. The secondary
  action mutates read state without navigation.
- Both targets provide at least 48 by 48 CSS-pixel reach for coarse pointers,
  and their hit regions do not overlap.
- Anatomy is a stable caller-owned left anchor, title, one quiet metadata line,
  optional quiet trailing value, and at most one sibling action. Read-state
  streams may use the anchor for an unread indicator; comparable domain streams
  use rank, identity, or category. Unread rows require a sibling action; read rows
  never carry one. No repeated Open/View control remains.
- A read row renders no secondary action and reserves no dead gutter for it.
  The content anchor remains stable when the mutation lands.
- Evidence covers read/unread side by side, loading, empty, fetch error,
  invitation error, pagination, live connection, read-only, long content,
  light/dark, desktop/mobile, focus, navigation, and mutation.

The Activity representative passed the Codex engineering gate and Claude craft
gate before route-family adoption. New consumers preserve this anatomy and keep
fetching, mutation, authorization, and destination ownership in their routes.
