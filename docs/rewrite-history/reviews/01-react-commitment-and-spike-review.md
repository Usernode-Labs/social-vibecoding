# Review 1: React commitment and spike design

Source: user-supplied review during Candidate A planning. Preserved verbatim
below.

1. Make the React commitment explicit in the doc.
All four bundles are React; the plan silently forecloses Preact/Lit/Svelte/an upgraded vanilla system. That's probably the right call — but a hidden decision resurfaces later as "why didn't we consider X," usually mid-migration. Add one paragraph stating React is decided and why (ecosystem, agent familiarity, shadcn/Astryx availability), so the spikes are comparing systems, not relitigating the framework.

2. Add a performance budget as a hard gate, not a criterion.
The product is a mobile WebView app where Flutter owns first load. Nothing in the rubric measures JS bundle size, CSS strategy runtime cost, or INP/LCP on mid-range Android — yet this is precisely where the candidates genuinely differ (StyleX ships pre-compiled CSS; Tailwind needs purge discipline; Panda has its own runtime model; React itself is a cost over today's vanilla SPA). Set a numeric budget (e.g., shell JS ≤ N KB gzipped, INP/LCP targets on a reference device) and make exceeding it a disqualifier like the bridge/a11y gates. Without this, the rubric structurally favors the richest system rather than the one that survives the WebView.

3. Kick off Phase 0 now as tracked issues with named owners.
The four Phase 0 items (iframe relay privilege fix, readiness handshake, logout/SW/offline ownership, telemetry + bridge contract tests) are platform-independent, mostly native/bridge-side, and gate every candidate equally. There is zero regret in starting them today, and they're the only part of the plan that fixes a live correctness issue. If these land in this org's repos, apply the matching init:* label and link the tracker per the Matrix convention.

4. Pull the token schema (Phase 3, step 1) ahead of Phase 1.
Every spike "must include tokens," so either each spike invents its own (making visual comparison meaningless) or you define the canonical schema once, mapped from usernode-native/v1, and all spikes consume it. The token schema is also your most durable, platform-agnostic asset — building it first means the eventual platform choice risks less.

5. Collapse leaders A and B into one spike plus a behavioral-base bake-off.
Bundles A and B share the registry, shadcn CLI, Tailwind, Storybook, CI, and agent workflow — only the behavioral base differs, and shadcn's verified --base aria support means switching bases within the same chassis is cheap. Running all five scenarios twice measures the identical 80% twice. Instead: build the shared chassis once with all five scenarios on Base UI, then re-run only scenarios 2 and 3 (mobile sheet/menu, typed async form) on React hat actually stress composition-model and interaction differences. This roughly halves Phase 1 effort with no information loss.

6. Add a sixth scenario: coexistence in the real monolith.
Scenario 5 tests WebView shell states iests the actual migration mechanic:mounting the new stack inside the existing hash-routed vanilla SPA on one legacy route, with the service
worker and iOS App-Bound Domain constrag usernode-native/v1 consumers. This isthe hardest, least-fakeable risk in the whole plan — a platform that aces isolated spikes but can't
incrementally coexist with the legacy Slegacy route per serious candidate isenough.

7. Define the agent-operability test protocol before running it.
This is your highest-weighted criterionvaguest ("a short agent task").Standardize it: same task prompts (one discover-and-reuse, one extend-a-variant, one that should be
rejected by conformance gates), same moon discovery success,reuse-vs-duplication, and whether CI gates caught the violation. Otherwise the noisiest measurement
decides the outcome.

8. Fix the scoring protocol and name a
Write anchor descriptions per criterion (what a 2 vs a 4 looks like) before spikes begin, have evaluators
score independently before discussing, dominate weighted scores. Add a singledecision owner and a calendar date for Phase 2. Why: post-hoc 1–5 scoring reliably confirms whichever
candidate the team already favored, andd a date become permanent evaluations.

9. Give Astryx an explicit win conditio
As the challenger it needs a bar: e.g., "Astryx wins only if it beats the shadcn chassis decisively on
agent-operability and compound coverageto offset beta status, StyleX lock-in,and unproven WebView/fleet distribution." Also verify the MCP and usability-evaluation claims (not on the
cited page) and check Meta's stability/ the beta. A challenger without a defined bar either wastes a spike or wins on novelty.

10. Add reversal seams to Phase 3.
State which assets must stay UI-library, registry metadata format, the typedbridge package, and the Storybook scenario vocabulary. If the chosen base disappoints in a year, the swap
should be contained to component internce and it lowers the stakes of Phase 2,which makes the decision easier to actually make.

Smaller edits

- Add the staging iframe host / child-iframe auth path as an explicit spike surface — Phase 0 fixes the
privilege bug, but the new platform sho.
- Write a coexistence/deprecation policy for hosted usernode-native/v1: who consumes it, whether new
compounds may, and when it freezes. "Prtly a phrase, not a policy.
- In the step-9 learning loop, wire defect classifications to the registry status model so
legacy/deprecated components have owner
- Correct the Astryx bullet to reflect verified facts: beta, MIT, Meta-maintained, CLI-based docs browsing
confirmed; MCP unconfirmed.

The one-line summary: the plan already e steps make sure the process can'tquietly rig or stall the decision — explicit priors (1), hard physical constraints (2, 6), cheaper evidence (4, 5), measurable criteria (73, 8).
