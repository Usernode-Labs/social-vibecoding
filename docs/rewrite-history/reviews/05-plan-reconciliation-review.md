# Review 5: Plan reconciliation and verification

Source: user-supplied review of the revised plan. Preserved verbatim below.

Verification first: the Storybook claims check out and the plan's caution is exactly right — the MCP server and manifests are explicitly preview features, React-only, with an unstable schema the docs say "should not be considered a public API." Treating CSF/MDX/fixtures as the portable assets and the MCP as a replaceable transport is the correct posture.

Verdict

This iteration fixes what the first version lacked: the decision mechanics are now real (hard gates with numbers, T1–T5 battery, adapter budget, ADR template, mechanical rule, anchors, reversal seams). The new problem is the opposite one — the document has grown into three documents wearing one title, and in growing it has developed internal contradictions that would let the evaluation be gamed or stalled: two competing process numberings, two different agent-protocol definitions, two different hard-gate lists, and a benchmark now sequenced behind open-ended discovery stages. None of this needs new thinking; it needs reconciliation and then authorization.

Critical fixes before this can circulate

1. Collapse the two process models into one.
The doc contains a stage table (0–10) and a phase sequence (0, 0.5, 1, 2, 3) describing overlapping work with different names: stage 0 ≈ Phase 0, stage 4 ≈ Phase 0.5, stage 5 ≈ Phase 1, stage 6 ≈ Phase 2, stage 7 ≈ Phase 3 — and stages 1–3 exist in only one of the two models. Why this matters: when two numbering systems disagree about what precedes the benchmark, every schedule dispute gets resolved by citing whichever model is more convenient. Keep the stage table as canonical, delete the phase headings, and fold the phase-section content (which is the better-specified of the two) into the corresponding stage rows.

2. Reconcile the two agent-protocol definitions.
The "Agent-operability protocol" section defines a 3-task protocol (discover/reuse, extend, reject); the "Pre-registered benchmark protocol" defines T1–T5. They overlap but don't match — the 3-task version omits compound composition (T3) and repair (T5) while its metrics list mentions "repair success" anyway. Delete the 3-task section and merge its success-metric list into the T1–T5 battery. Why: an evaluation with two protocol definitions invites each candidate's advocates to quote the friendlier one, and "pre-registered" means nothing if the registered artifact is ambiguous.

3. Reconcile the two hard-gate lists and add pass thresholds.
"Hard gates for every candidate" item 5 disqualifies on failing "the defined agent-operability protocol" wholesale; the "Mechanical decision rule" step 1 disqualifies only on T4. These are materially different rules. Recommendation: the mechanical rule's version is right — T4 detection is the binary gate (a harness that doesn't catch violations is disqualified, e.g. must catch 5/5 runs); T1–T3 and T5 medians feed the 20% weighted criterion. Why: making noisy median pass rates into binary disqualifiers turns sampling variance into elimination, which is exactly what pre-registration exists to prevent. While you're there, add the missing numeric thresholds the gates imply but never state: T4 catch rate, visual flake-rate ceiling, and what "CI stability" must achieve.

4. Fix the chassis fairness problem for Astryx.
The shared chassis is defined as "Vite, TypeScript, canonical tokens, private registry skeleton, Tailwind, Storybook + MCP, MSW…" — but Astryx is StyleX. As written, the shadcn candidates inherit a fully wired chassis while Astryx must re-integrate Storybook, MSW, fixtures, and CI on a different styling toolchain out of its one-day adapter budget. The comparison is structurally rigged before it starts. Fix: define the chassis as two layers — framework-neutral assets (tokens, fixtures, scenario vocabulary, MSW handlers, agent prompts, CI templates, Storybook config patterns) that every candidate consumes free of budget, and candidate-specific glue (styling layer, component wiring) that is the only thing the adapter budget meters. Tailwind moves from the chassis definition into candidates A/B. Why: the challenger exists to keep the leaders honest; a challenger that loses for procedural reasons validates nothing.

5. Don't gate the benchmark on stages 1–3 finishing.
The stage table sequences pattern discovery, analysis, and manual design exploration before portable authority and benchmarking. Full pattern taxonomy and a chosen visual direction are genuinely valuable — and genuinely not prerequisites for choosing between Base UI, React Aria, and Astryx, which is a question of interaction mechanics, enforcement, and WebView survival. The benchmark needs exactly three inputs from those stages: the six scenario specifications, the canonical tokens, and a light design-intent brief. State that explicitly, run stages 1–3 in parallel with 0/0.5, and timebox them. Why: stages involving "work through the shell with product/design stakeholders" have no natural endpoint; as sequenced, they hand anyone ambivalent about the decision an indefinite delay mechanism — the exact failure the mechanical decision rule was added to prevent.

6. Instantiate the authorizations the plan demands of itself.
The plan now says "assign the decision owner and the Phase 2 decision date before Phase 1 starts; otherwise the evaluation is not authorized to begin" — and still names neither. It also never estimates cost: stages 0–6 as specified are plausibly 6–10 engineer-weeks, and whoever approves that spend needs the number. Add: named DRI, named evaluators (how many, who), decision date, per-stage timeboxes, and an effort estimate. Why: this is now the single remaining blocker — by its own rule, the plan cannot start.

Structural recommendation: split into three documents

1. The Decision Plan — gates, battery, budgets, anchors, decision rule, ADR template, dates. Small, frozen, committed as the pre-registration pack.
2. The Programme — the stage table, roles, authority map, heuristic calibration, precedents (Buzz/Orbit move to an appendix here).
3. System Policies — the accessibility, performance, and tooling sections, which describe the v1 system after selection and will keep evolving.

Why: pre-registration only works on an immutable artifact, and a 10,000-word living document cannot be immutable. The accessibility and performance sections are good — genuinely — but they are Phase-3+ policy, and their presence in the decision doc creates ambiguity about how much of that machinery spikes must implement (answer, which should be stated: axe serious/critical, keyboard tests, WCAG pair validation on spike tokens, and the numeric budgets — nothing more at spike time).

Smaller fixes

- The tool lineup should pass its own "Complexity Must Be Earned" test: add an adoption phase column to the main lineup table (the adjacent-tools table already has one). The spike-time set is small: shadcn CLI/registry/MCP, Storybook + MCP + Test, MSW, the custom ESLint rules, axe, one visual-diff path, Chrome DevTools MCP opt-in. Everything else — ui.sh, Impeccable, Stitch, Playwright agents, Figma, React Doctor — is post-ADR.
- Remove or cite the unnamed external references: "the supplied 'systems that tell the truth early' heuristics" and "the attached research" point at materials a reader of this doc doesn't have. Either inline the relevant content or link it; dangling references undermine an otherwise evidence-heavy document.
- Migration/operational cost dropped from 10% to 5% while a new 10% criterion was added. Defensible given the coexistence hard gate and the cost tie-break, but state that rationale in one sentence — a silently changed weight looks like tuning the rubric toward a preferred outcome, which is the perception the whole protocol is designed to avoid.
- "Storybook 10.5" — pin versions in the pre-registration pack (where they belong, per snapshot reproducibility), not in the plan prose, where they'll rot.

Next steps, in order

1. Apply fixes 1–4 (reconciliation edits — a few hours of editing, no new decisions required).
2. Split the document and commit the pre-registration pack: battery prompts, anchors, thresholds, budgets, device/network profile, pinned versions.
3. Name the DRI, evaluators, dates, timeboxes, and effort estimate; get the spend approved.
4. Open the Phase 0 issues (bridge privilege, readiness handshake, logout/SW ownership, telemetry) with owners — still the only work with zero dependency on any of the above.
5. Start stage 0/0.5 and stages 1–3 in parallel, benchmark when the three named inputs exist.

The one-line summary: the plan now knows how to decide — the remaining risks are that it disagrees with itself in four places, quietly rigs the challenger's lane, and has not yet granted itself permission to start. All three are editing problems, not research problems, and the sooner they're fixed the sooner Phase 0 stops being the only thing anyone can legitimately work on.
