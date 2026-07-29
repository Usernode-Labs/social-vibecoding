# UI evidence contract

Run `node tool/ui-workflow.mjs --task "<task>"` from the repository root before
editing. It classifies work and returns the smallest relevant context, checks,
evidence, and stop condition.

Mechanical checks are authoritative:

- token generation and validation;
- resolved catalog and Storybook state validation;
- shadcn registry reproducibility;
- semantic-style policy with exact, owned exceptions;
- architecture boundaries for API, storage, event, bridge and service-worker
  access;
- route/browser, Storybook accessibility, bundle and cutover checks.

For reusable presentation, record deterministic Storybook states. For route
or integration behavior, use fixture-driven Playwright evidence. For bridge,
iframe, authentication, history, or offline changes, preserve the legacy path
until a real host-level proof exists.

The Candidate A battery proves harness enforcement, not product completeness.
Its result must identify actor/model visibility, token-accounting visibility,
wall time, retries, interventions, commands, outcomes, and the 5/5 deliberate
style-violation result. Never invent telemetry the executing host does not
expose.
