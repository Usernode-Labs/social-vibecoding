# Shell design authority

The React design system governs the Social Vibecoding platform shell, its
platform-owned routes, reusable shell patterns, and the shell-side hosted-app
frame. It does not govern child-app source, the app-factory scaffold/prompts,
or existing consumers of `usernode-native/v1`.

Read these machine-readable sources instead of inferring rules from prose:

- `frontend/design-system/tokens.json`: canonical DTCG token source.
- `frontend/design-system/authority.json`: scope, defaults, ownership and
  approval roles.
- `frontend/design-system/catalog.json`: resolved component contracts,
  variants, maturity, tokens, accessibility, data boundaries and deprecation.
- `frontend/registry.json`: owned components distributable with the shadcn
  CLI.
- `frontend/design-system/exceptions.json`: exact, expiring migration debt.

Before creating or expanding a pattern, search the catalog and official local
shadcn primitives. Choose exactly one result: reuse, extend, or propose a new
owned pattern. New tokens, primitive categories, and exception categories
require the shell design-system approver.
