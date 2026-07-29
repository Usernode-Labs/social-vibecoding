# UI review

Review in this order:

1. Run the task-specific mechanical checks from the workflow resolver.
2. Inspect the registered Storybook states at narrow and wide viewports, both
   themes, keyboard focus, reduced motion, and applicable loading/error states.
   Use Storybook MCP when the executing environment exposes it; otherwise use
   the normal Storybook browser and tests.
3. Exercise the integrated route with fixture-driven browser tests.
4. If available, use the `design` (ui.sh) or `taste` skill for one bounded
   composition and polish pass. Record findings by component/state. These tools
   are reviewers, not design authority.
5. Rerun the affected mechanical checks. A taste suggestion that conflicts
   with tokens, component relationships, accessibility, content authority, or
   compatibility contracts is rejected or escalated.

For handoff, report:

- states inspected and viewports/themes used;
- mechanical checks and outcomes;
- accepted and rejected taste findings with reasons;
- unresolved evidence or explicitly deferred profiling.
