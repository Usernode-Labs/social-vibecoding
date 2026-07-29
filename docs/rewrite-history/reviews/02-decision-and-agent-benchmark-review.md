# Review 2: Decision artifact and agent benchmark

Source: user-supplied review during Candidate A planning. Preserved verbatim
below.

Right — as written, the plan can end Phase 2 with a scored comparison and still no decision, and its "benchmarks" are mostly qualitative spikes. Here's what to change so the output is forced to be a single named decision — DS + harness + skills — backed by numbers someone else could reproduce.

1. Define the decision artifact first — an ADR, not a scorecard

Add to the plan: Phase 2 ends with a signed ADR that names, in one sentence, all three layers:

- Design system: behavioral base + styling layer + registry (e.g., "shadcn chassis, Base UI base, Tailwind, private Usernode registry")
- Agentic harness: the discovery mechanism (MCP/CLI), the enforcement mechanism (lint rules + CI gates), and how much of it is vendor-provided vs Usernode-built
- Skills: the named project-local skill set that ships in v1 (intake, reuse-decision, component-work, screen-composition, review, verification, release) and which vendor skills they wrap

Why: a scorecard describes; an ADR commits. If the template for the final artifact exists before the spikes, every benchmark has to produce an input to it, and "we need more evaluation" stops being an available exit. It also forces the realization that you're choosing three coupled things, not one — a DS with a weak harness and a harness with a weak DS are different failure modes, and the ADR format makes each visible.

2. Replace "a short agent task" with a fixed agentic benchmark battery

This is the core gap: the plan's highest-weighted criterion (20%) currently has no measurement. Specify a battery run identically per candidate — same model, same Claude Code version, fresh clone per run, N=5 runs per task, report medians:

┌─────┬──────────────────────────────────────┬─────────────────┬──────────────────────────────────────┐
│  #  │                 Task                 │    What it      │            Primary metric            │
│     │                                      │    measures     │                                      │
├─────┼──────────────────────────────────────┼─────────────────┼──────────────────────────────────────┤
│ T1  │ "Build screen X using existing       │ Discovery +     │ Reuse rate (existing components used │
│     │ components"                          │ reuse           │  vs duplicated)                      │
├─────┼──────────────────────────────────────┼─────────────────┼──────────────────────────────────────┤
│ T2  │ "Add a destructive variant to        │ Extension       │ pass@1 on: right file, tokens only,  │
│     │ Button"                              │ discipline      │ story added, gates green             │
├─────┼──────────────────────────────────────┼─────────────────┼──────────────────────────────────────┤
│ T3  │ "Build the developer-work card from  │ Compound        │ Conformance pass rate + tokens/time  │
│     │ this spec"                           │ composition     │ to green                             │
├─────┼──────────────────────────────────────┼─────────────────┼──────────────────────────────────────┤
│ T4  │ Task that tempts a raw hex value /   │ Enforcement     │ Did lint/CI catch it; did the agent  │
│     │ arbitrary Tailwind value             │                 │ self-correct                         │
├─────┼──────────────────────────────────────┼─────────────────┼──────────────────────────────────────┤
│ T5  │ "This story fails the a11y check —   │ Repair loop     │ pass@1 using only the harness's own  │
│     │ fix it"                              │                 │ tooling                              │
└─────┴──────────────────────────────────────┴─────────────────┴──────────────────────────────────────┘

Score each run pass/fail against a written rubric, plus tokens and wall time as cost. T4 is the one most people skip and the most important: a harness is only real if it catches the agent doing the wrong thing — prompts alone don't, which the plan itself already asserts ("rules enforced by scripts and CI, not prompts").

Why N=5 and medians: agent runs are high-variance; a single run per candidate is an anecdote, and anecdotes get overridden by whoever liked a candidate beforehand. Five runs is the minimum where a difference between candidates means something, and it's still cheap.

3. Fix the harness confound with an adapter budget

Problem: shadcn ships skills + MCP today; Astryx ships a CLI (MCP unverified); Park UI ships neither. If you benchmark raw out-of-box, you measure vendor marketing. If you build a full Usernode harness per candidate first, you measure your own effort, and the comparison takes months.

Rule to add: each candidate gets vendor tooling as-is plus a fixed adapter budget (e.g., one day of glue: a discovery script, a lint config, a skill wrapper) before the battery runs. Log what the budget was spent on per candidate.

Why: this makes the benchmark measure the question you actually have — "how operable is this system for our agents at realistic integration cost" — and the spend log itself becomes evidence: if Park UI needs its whole budget just to become discoverable, that is the agent-operability result.

4. Make the system benchmarks numeric

Each spike scenario already exists; instrument it. Per candidate, record:

- Bundle: JS and CSS gzipped for the scenario shell, against the hard budget from step 2 of my previous review
- Runtime: INP / LCP / TBT measured in the actual Flutter WebView on one reference mid-range Android device — not desktop Lighthouse
- Accessibility: axe-core violation count across all stories (target: zero serious/critical)
- Stability: visual-baseline flake rate over 10 consecutive CI runs, and total CI wall time for the full gate suite
- Coexistence: the legacy-route mount scenario passes with service worker + App-Bound Domains live — pass/fail

Why each: bundle and runtime are where the candidates physically differ (StyleX pre-compiled vs Tailwind vs Panda) and where the WebView punishes mistakes; axe count converts "accessible" from adjective to number; flake rate and CI time determine whether the team keeps the gates on or starts skipping them six months in — a flaky gate is worse than no gate; coexistence is binary and disqualifying.

5. Write the decision rule so a winner falls out mechanically

Add to Phase 2, verbatim-style:

1. Gates first (pass/fail, any failure disqualifies): bridge compatibility, coexistence scenario, performance budget, zero serious a11y violations, T4 enforcement works.
2. Among survivors, weighted score with the anchors pre-registered before Phase 1 starts, evaluators scoring independently before discussion.
3. Tie-break (scores within 0.3 weighted points): higher agentic battery pass rate wins; if still tied, lower migration cost wins.
4. The DRI signs the ADR by the decision date regardless — "insufficient data" is only a valid outcome if a named benchmark could not be run, in which case the ADR names the smallest additional experiment and a new date, once.

Why: every clause removes a stall or a rigging path. Gates-before-scores stops a high aggregate from papering over a fatal flaw; pre-registered anchors and independent scoring stop post-hoc rationalization; the explicit tie-break stops "let's keep both leaders" from surviving Phase 2 (the current plan's "two equal leaders" framing makes that outcome likely by default); the once-only extension clause allows honest gaps without permitting a loop.

6. Concrete next steps

1. Add three sections to the plan doc — "Decision artifact (ADR template)", "Benchmark protocol" (battery + system metrics + adapter budget), "Decision rule" — replacing the current Phase 2 prose. The scoring table stays but becomes step 2 of the rule.
2. Pre-register before any spike code: rubric anchors, task prompts for T1–T5, the reference Android device, the bundle budget numbers, the DRI, and the decision date. Commit them to the repo so they're timestamped and can't drift mid-evaluation.
3. Build the benchmark scaffolding once, candidate-agnostically: the T1–T5 prompt files, the axe/visual/CI harness, the WebView measurement setup, and the shared token schema. Why now: this is ~a week of work that every candidate reuses, it's where most of the "actual benchmarks" credibility lives, and none of it is wasted regardless of who wins.
4. Then run Phase 1 as previously restructured: one shadcn chassis with a Base UI vs React Aria bake-off on the two behavior-heavy scenarios, Astryx as challenger against its written win condition, Park UI only if fleet distribution becomes decisive.

The test for whether the revised plan is good enough: hand it to someone outside the team and ask "who decides, by when, and what numbers decide it?" If the doc answers all three without you in the room, it will deliver the decision. Right now it answers none of them.

If you want, I can restructure the full plan document with these sections integrated so it's ready to circulate.
