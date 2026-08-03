# Shell design authority

The React design system governs the Social Vibecoding platform shell, its
platform-owned routes, reusable shell patterns, and the shell-side hosted-app
frame. It does not govern child-app source, the app-factory scaffold/prompts,
or existing consumers of `usernode-native/v1`.

Read these machine-readable sources instead of inferring rules from prose:

- `frontend/design-system/tokens.json`: canonical DTCG token source.
- `frontend/design-system/authority.json`: scope, defaults, ownership and
  approval roles.
- `frontend/design-system/interface-laws.md`: canonical composition, surface,
  spacing, type and target laws.
- `frontend/design-system/catalog.json`: resolved component contracts,
  variants, maturity, tokens, accessibility, data boundaries, optional
  performance assumptions and deprecation.
- `frontend/registry.json`: owned components distributable with the shadcn
  CLI.
- `frontend/design-system/exceptions.json`: exact, expiring migration debt.
- `frontend/design-system/context-budget.json`: blocking loaded-context
  ratchets and the non-waivable component-review ceiling.

Before creating or expanding a pattern, search the catalog and official local
shadcn primitives. Choose exactly one result: reuse, extend, or propose a new
owned pattern. New tokens, primitive categories, and exception categories
require the shell design-system approver.

Before passing `className` to a governed component, read the interface laws.
Callers may remove surface treatment and may own external layout, but may not
add or intensify a persistent fill, border, ring or shadow. Ephemeral `hover`,
`focus`, `focus-visible`, `focus-within` and `active` modifiers are outside that
surface-direction check; attribute states are not. A bare radius paints no
surface by itself. Promote any caller surface recipe repeated more than once to
a named component variant.

Performance metadata is deliberately sparse. Add it only when a component owns
a collection, streaming or high-frequency updates, or mount continuity. Use it
to record collection class, update frequency, state scope, virtualization
status, mount policy, sensitive interactions, and the point at which profiling
becomes required. A `review-later` flag is a future optimization marker, not a
benchmark result.
