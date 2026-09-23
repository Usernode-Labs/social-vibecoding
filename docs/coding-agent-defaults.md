# Coding-agent defaults: OpenRouter model and design guidance

This page records two coding-agent defaults and why they are what they are,
so the next person who wants to change one starts from what was already
checked: the default OpenRouter model (#2819), and the design guidance every
coding agent builds with (#2817).

## Default coding model: GLM 5.3 Flash stays (reviewed 2026-09-23)

#2819 asked whether `xiaomi/mimo-v2.6-pro` should replace the default. It
should not yet. GLM 5.3 Flash (`z-ai/glm-5.3-flash`) remains the default at
`xhigh` reasoning.

What was known about MiMo-V2.6-Pro on 2026-09-23. The research sandbox could
not reach openrouter.ai, Hugging Face or Xiaomi's site directly. The figures
below come from machine-readable mirrors of those sources (LiteLLM's model
registry, the models.dev catalog, snapshots of Artificial Analysis and
LMArena data) and from search results. Xiaomi's own benchmark claims are
left out because nobody has reproduced them yet.

| | MiMo-V2.6-Pro | GLM 5.3 Flash (current default) |
|---|---|---|
| Released | 2026-09-21 | |
| OpenRouter providers | one (Xiaomi) | |
| Price per 1M tokens, in / out | $0.435 / $0.87 | $0.10 / $0.40 in `model-costs.js` |
| Context | 1,048,576 | |
| Reasoning control on OpenRouter | on/off only, no effort levels | effort levels |
| Artificial Analysis Coding Index | not yet published | 71.5 |
| LMArena WebDev rank | not yet ranked (V2.5-Pro: #51) | #18 |
| Time to first answer token | about 38 s | |

Why it is not the default yet:

1. **Tool-loop reliability is unproven.** Issues opened on 2026-09-22 report
   the kind of failure a Codex agent loop hits: 120 parallel tool calls in one
   message, thousands of tool calls in one turn, native tool-call markup
   leaking into text when Codex's `exec` tool is converted to a function
   tool, and a control character corrupting tool-call JSON. Nobody has
   reported running it through Codex over OpenRouter's Responses API.
2. **One provider, no failover.** If Xiaomi's endpoint degrades, every new
   session degrades with it.
3. **No independent coding or UI ranking yet.** The strongest published
   numbers are Xiaomi's own. Its predecessor sits mid-table on WebDev.
4. **Cost and latency.** Roughly 4x GLM 5.3 Flash's input price and 2x its
   output price, with a much slower first token.

Look again when it has an independent Coding Index and a WebDev Arena rank,
has more than one OpenRouter provider, and the tool-loop issues are closed.
Until then it stays selectable like any other model in the user's catalog;
it is just not what a new session starts with.

Changing the default is an operations change, not only a code change:
production reads `OPENROUTER_DEFAULT_CODEX_MODEL` from the deploy workflow's
repository variable, and the value in `src/config.js` is only the fallback
for deployments that set nothing.

One discrepancy seen during the review and not acted on: an Artificial
Analysis snapshot lists GLM 5.3 Flash at $0.15 / $0.50, above the $0.10 /
$0.40 in `src/services/model-costs.js`. The live OpenRouter catalog is what a
turn is priced with; the table only feeds estimates when no catalog is at
hand.

## Design guidance for every coding agent (#2817)

Every build carries `src/prompts/design-guidance.md`, and every scout writes
a plain-language `### Design` subsection into the spec for anything a person
will see (`SPEC_DESIGN_BRIEF` in `src/services/prompts.js`). #2817 asked for
this on OpenRouter agents; Claude gets the same text so the two backends stay
in parity and a difference in their output reflects the model, not the
prompt. Hosted Claude receives it as system context next to the platform
conventions; local Claude and OpenRouter receive it inline with them.

The one line that differs is the self-check. Claude looks at screenshots of
the changed screens; OpenRouter models are given text input only by the
Codex runner, so they read the in-loop browser's accessibility snapshot
instead.

The rules were chosen because they are concrete and checkable in a review,
which is what makes a written brief work across models of different
strength:

- **The app's own kit before anything invented.** Negative instructions
  ("don't use purple") move a model to another fixed palette; an explicit
  system it must reuse is followed. Sources: Anthropic's `frontend-design`
  skill and prompting guidance, OpenAI's GPT-5 prompting guide.
- **A short brief before code**: the screen's one job, one primary action,
  the components reused, the word for each thing. This is the plan step both
  Anthropic's and OpenAI's frontend guidance use.
- **One primary action and one word per concept, checked across
  neighbouring screens.** This is the cross-element coherence #2817 asks for
  (Nielsen Norman Group on internal consistency, OpenAI's frontend skill).
- **Named tells to avoid** (emoji as icons, ALL-CAPS eyebrows, cards around
  everything, taglines inside an app), each with the kit alternative.
- **Empty, loading, error and populated states for every data view.**
- **A self-check against the same checklist before committing**, with
  screenshots for Claude and the accessibility snapshot for text-only
  OpenRouter models. Recent UI-generation studies (seen here only as
  search-result summaries) report self-critique against a written checklist
  beating the other prompting strategies they tried.

Deliberately not changed: reasoning effort (the OpenRouter `xhigh` default
from #2600 still applies) and sampling temperature (Codex does not send one;
no evidence tied it to design quality). For OpenRouter, a vision-capable
reviewer that checks screenshots against the same checklist is the obvious
next step, and it needs its own proposal.
