# App-stage craft spec — v1, implementation-ready

Ratification chain: owner proposal a5228172 (with mockup, archived `.scratch/owner-app-shell-mock.png`) → confirmation + defaults 5877e0a2 → owner ratification aae98088 ("all good lets make it ready for codex"). Defaults D1–D3 are therefore ratified; assumption A4 below is new and overridable.
Supersedes: the floating-bar decision in `hosted-app.tsx` ("no viewport estate is spent on chrome") — recorded reversal, owner intent.
Slice name: `app-stage`. Lands in-repo as this spec under `RESEARCH/`, token additions, component recomposition, stories, and contracts. One writer: codex implements; lead-claude gates.

Owner correction: comments at 14:35 and 14:40, then the live-page ruling at 15:23, supersede the route-wide paint described in the original ratification. Keep the existing platform shell and navigation; remove the hosted header divider; give only the hosted-app container a distinct surface and radius. The corrective boundary was accepted by lead-claude in event `6bcff7456b42f77e035a3d110f72b2583870dd30f5b13e8c7d26622084e2272e`. The rendered outcome below includes that correction.

## 1. Intent

Every hosted app gets an ownable place. The platform contributes its ordinary frame — header strip, identity, actions and navigation — without repainting the route. Every pixel inside the distinct rounded app container belongs to the app.

## 2. Rendered outcome (normative)

### 2.1 Desktop and large viewports (at least `sm`)

- The hosted-app route retains the ordinary platform shell and navigation surfaces. The `stage` pair is local to the hosted-app card; it never remaps shell or sidebar semantics.
- The header strip sits on the ordinary page surface without a bottom divider: app name anchor and actions (Improve, Close, and console trigger when visible). PI-07 applies: the anchor never truncates; utilities overflow first.
- Below the strip is the app card: a rounded container (`rounded-xl`, matching the platform's large-container radius family) filling the remaining viewport and containing exactly `FocusedAppFrame`. No border is required in the light theme because contrast carries the boundary; the dark theme follows section 2.3.
- The platform sidebar remains byte-identical in paint and geometry to ordinary routes.

### 2.2 Mobile and narrow viewports (below `sm`)

- The ordinary page surface remains full bleed around the hosted card.
- The stack is platform navigation, header strip and actions, then the app container. The app container keeps rounded top corners and may run to the viewport edge at the bottom.
- PI-07 narrow-header rules apply to the strip: two-row stack and a break-words identity.

### 2.3 Theming (token law)

- Add a `stage` and `stage-foreground` token pair in both theme blocks of `tokens.json`, using OKLCH and following the background/card convention.
  - Light theme `stage` is a subtle neutral card surface distinct from the white page background.
  - Dark theme `stage` is a step above `background`, so the hosted card reads by contrast without a border.
  - `stage-foreground` remains legible on `stage` in both themes.
- Components contain no hard-coded colors. The page/card boundary is token-only. This load-bearing intersection requires a computed-style contract asserting that the resolved hosted-card and ordinary page backgrounds differ in both themes and both hosted routes.

### 2.4 States (ratified D3)

- Ready: `FocusedAppFrame` inside the card.
- Loading: skeleton inside the rounded card. The card is present from first paint.
- Error (`loadError` or `tokenError`): destructive alert inside the card. Platform chrome stays stable.
- Staged preview (ratified D1): the shared wrapper applies, with the PI-06 info status surface and persistent Staged chip between the ordinary page and card. This must remain legible in both themes.

## 3. Hard constraints (gate-blocking)

1. **Iframe byte identity:** the `<iframe>` element in `focused-app-frame.tsx` keeps its exact attribute set: `allow`, `sandbox`, `src` construction, `onLoad`, `data-testid`, and `className="size-full border-0"`. Only the surround recomposes. The diff must contain zero iframe-element lines.
2. **PI-06 at the card boundary:** staged tint and chip are verified in rendered pixels in light and dark, desktop and phone.
3. **PI-07 on the strip:** narrow means stacked identity and utilities; the anchor wraps and never truncates.
4. **Token-pair only:** `stage` and `stage-foreground` appear in both theme blocks; grep for hard-coded OKLCH or hexadecimal colors in the component diff is empty.
5. **Reach:** every strip control keeps the accepted coarse-pointer expansion contract.
6. **No behavior drift:** navigation, Close, console trigger, token fetching, offline/retry logic, and history remain behaviorally equivalent. The seven-route single-exit repair was completed separately in Block 6 at `2ad0ddd38d168e49ae4dfa4c6f5b899b94bbe247` before this slice.

## 4. Assumption A4 (overridable before boundary)

The hosted-card pattern is scoped to standard Use and staged preview. The global sidebar, route surface and theme remain untouched.

## 5. Storybook and contracts (required)

- App-stage matrix stories: ready, loading, error, and staged, across desktop and mobile, in light and dark (8 named stories minimum, mirroring the Challenges matrix pattern the owner accepted).
- Computed contracts:
  - hosted card versus ordinary page resolved background inequality in both themes and both hosted routes;
  - card border radius on desktop and narrow top corners;
  - iframe source-block equality, locking constraint 1 in the build.
- Existing owning browser files are updated where the surround changes selectors; assertions are updated, not loosened.

## 6. Acceptance gate (pre-registered; lead-claude rules on receipt)

1. Diff inspection: the iframe element is untouched; no hard-coded colors; scope is hosted-app surround, tokens, stories, and tests only.
2. Token pair present in both theme blocks; no other token edits.
3. Full owning files and new contracts rerun at the exact commit with revision pinned, followed by the full `check:ui` gate.
4. Eight-story matrix viewed in light and dark; staged-boundary legibility ruled explicitly; mobile stack order verified as navigation, actions, card.
5. Grade recorded against the Wealthsimple bar, as with the flagships.

## 7. Out of scope

- Any change inside hosted apps.
- Router or exit-model changes.
- Development simplification, which the owner deferred for a later radical simplification.
- Global sidebar theming beyond the hosted routes.
