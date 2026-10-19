# Coding-agent defaults: OpenRouter model and design guidance

This page records two coding-agent defaults and why they are what they are,
so the next person who wants to change one starts from what was already
checked: the default OpenRouter model (#2819), and the design guidance every
coding agent builds with (#2817).

## Default coding model: DeepSeek V4.1 Flash 1017 (decided 2026-10-19)

`deepseek/deepseek-v4.1-flash-1017` replaces GLM 5.3 Flash as the default
OpenRouter coding model. It is the model a new agent chat session starts
with, and the one the Homeroom bot's chat replies use, which read the same
default. It runs in Claude Code (`OPENROUTER_MODEL_HARNESSES`) on its
Parasail and InferenceNet host shortlist
(`worker/claude-openrouter-request.js` `PROVIDER_ROUTING_BY_MODEL`). Since
#5507, agent chat's conversation is routed to the same hosts.

What decided it, on the Homeroom bot bench (blind judge, both models in
Claude Code):

| | DeepSeek V4.1 Flash 1017 | GLM 5.3 Flash |
|---|---|---|
| Core build tasks, runs 210 to 212 (54 trials each) | 33 passed | 26 passed |
| Of those, on the Homeroom repository (30 each) | 17 | 12 |
| Core triage accuracy, run 217 (129 trials each) | 65.1% | 62.8% |
| Triage tasks right all three times (of 43) | 26 | 17 |
| Triage answers with no readable verdict | 0 | 11 |
| Triage latency, median / 95th percentile | 23 s / 77 s | 34 s / 108 s |
| First versions passing the taste judge, App bench run 216 (of 10) | 9 | 6 |

The triage difference, paired, is +2.3 points with a 95% interval of -12.7 to
+10.3: no worse, not shown to be better. What it costs: about 3.4 times GLM
per triage call ($0.011 against $0.0034), and a first version's build and
review fixes about $0.17 more ($0.41 against $0.24, the Opus plan aside).
Where it is weaker: it asks a clarifying question less often (29% against 42%
on the triage tasks whose right answer is a question), and its first
versions kept 0.8 tap targets under 44px a build to GLM's none, which the
first-version review now raises as an issue to fix (#5529).

Not covered by this default: the build model of later changes (the `later`
configuration in `services/bot-configs.js`, still GLM while a 1017 version
is compared blind beside it), and the Homeroom bot's per-stage models
(triage, follow-up), which an admin sets in the bot's console settings.

Changing the default is an operations change, not only a code change.
Production takes `OPENROUTER_DEFAULT_CODEX_MODEL` from the deploy: a value
set in the Homeroom project's Platform variables panel wins (appended last
by `scripts/dump-platform-env.js`), else the deploy workflow's repository
variable, whose own fallback is still `z-ai/glm-5.3-flash`. The value in
`src/config.js` is the fallback for runs that set nothing (local runs and
tests), and dapp.json's `default` is what the panel shows.
`OPENROUTER_RECOMMENDED_MODELS` works the same way.

## Before 2026-10-19: GLM 5.3 Flash stays (reviewed 2026-09-23)

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

One discrepancy seen during the review and not acted on: an Artificial
Analysis snapshot lists GLM 5.3 Flash at $0.15 / $0.50, above the $0.10 /
$0.40 in `src/services/model-costs.js`. The live OpenRouter catalog is what a
turn is priced with; the table only feeds estimates when no catalog is at
hand.

## Which CLI runs each OpenRouter model (#3296)

An OpenRouter model used to mean the Codex CLI: `codex_openrouter` was the
only way any OpenRouter model ran. #3296 reported that GLM 5.3 Flash does
better in Claude Code, while DeepSeek v4.1 Flash does better in Codex, and
asked for the harness to follow the model. So the platform now picks the CLI
per model from `OPENROUTER_MODEL_HARNESSES` (`src/config.js`
`openrouterModelHarnesses`):

| Model | Harness |
|---|---|
| `z-ai/glm-5.3-flash` | Claude Code |
| `deepseek/deepseek-v4.1-flash` | Codex |
| `deepseek/deepseek-v4.1-flash-1017` | Claude Code |
| anything not listed | Codex |

#3296's evidence was one admin's impression ("apparently"), not a measured
run. The 2 Oct Core bench runs (3, 4 and 5) then put DeepSeek V4.1 Flash, in
Codex, level with GLM 5.3 Flash on triage (73% and 74%), and found it cost
1.4 to 10 times as much per attempt across triage, DM, checks fix and build,
although the two models' token prices are almost the same.

### DeepSeek V4.1 Flash 1017 (17 Oct 2026)

The 1017 snapshot runs in Claude Code. DeepSeek documents both Claude Code
and Codex without preferring either, but it measured 1017's Terminal-Bench 4.0
score in Claude Code. Core bench run 205, launched the same day, is the
"before": 1017 and the 0910 snapshot both in Codex, routed by OpenRouter's
defaults. Its other settings follow DeepSeek's own documentation:

- **Host:** Parasail, then InferenceNet, fastest first
  (`PROVIDER_ROUTING_BY_MODEL` in both worker listeners), with the
  shortlist's usual fallback to every host. It first named DeepSeek's own
  host alone, but the platform's OpenRouter account excludes endpoints that
  may train on prompts, and DeepSeek's is one: every request was refused
  (404, "Paid model training violation") and sent again to every host, so
  bench run 206's 1017 builds ran on InferenceNet and Parasail with a round
  trip lost per call. Allowing it would open every such endpoint, for every
  model and all of the platform's traffic. Of the hosts left, both kept
  1017's thinking across a tool call and gave the same three effort levels
  (17 Oct probes, below), and Parasail ran 130 to 150 tokens/s and 3.1 s a
  call in a build. InferenceNet's window is 262k tokens, so a longer prompt
  goes to Parasail alone (measured). Left out: Cloudflare (rate-limited in
  bursts, and recalled its thinking 2 times of 3), DeepInfra (its base slug
  includes the slow flex tier, 40 to 80 tokens/s) and Baseten (untested).
  Parasail costs $0.30/$1.20 per million tokens in and out, InferenceNet
  $0.08/$0.50, against GLM's usual hosts at $0.15/$0.50. A turn's ledger row
  keeps every host its requests used and how many left the shortlist
  (`routed_providers`, `shortlist_fallbacks`), and the bench's build and
  plan speed show both, so a shortlist that never holds is visible at once.
- **Compaction in Claude Code:** at 786,432 tokens, DeepSeek's own
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (`worker/claude-openrouter-request.js`
  `autoCompactLimit`), for every `deepseek/` model. A first version's
  `roomy_context` tweak never lowers it. Codex keeps its 200k limit.
- **Thinking level:** unchanged. The platform default `xhigh` is what
  DeepSeek's API runs as `high`, the level its Codex guide sets, and on
  OpenRouter it is the same: over 15 calls a level across four hosts, the
  same prompt took 3.0k output tokens at `low`, 3.9k at `high`, 3.8k at
  `xhigh` and 4.6k at `max`. DeepSeek's Claude Code guide sets `max`.
- **Sampling:** nothing to send. DeepSeek ignores temperature in thinking
  mode and clamps top_p to 0.95 to 1.0.
- **Reasoning across tool calls:** with tools, DeepSeek's API refuses (400) a
  request that does not send back the earlier reasoning; Parasail and
  InferenceNet accept it, and the model then has silently lost its own
  reasoning. Claude Code sends the thinking back, unsigned, with its text,
  and the listeners pass it through: asked for a number it had chosen only in
  its thinking, before a tool call, 1017 recalled it 4 times of 4 with the
  thinking sent back and 0 of 6 without, and 2 of 2 through Claude Code
  itself (17 Oct). Claude Code asks for at most 32,000 output tokens a
  request.

Users do not choose it. The model picker marks the Claude Code models, and the
OpenRouter settings description says what that mark means. The transcript
names the CLI that actually ran. That description is written at runtime by
`settings.js` `_normalizeOpenRouterCopy()`, over the static
`sections/openrouter.tsx` markup, so an edit to one is an edit to both; a test
holds them equal.

What stays the same for either harness, because `codex_openrouter` is still
the session's backend id and it identifies the OpenRouter venue: the user's
key (included or personal), the `agent_turns` ledger and its cost estimate,
the narrow capability tokens (push-only for a build, no general worker token,
no production-debug grant), the model catalog, and the inline conventions
block in the prompt.

How a Claude Code turn reaches OpenRouter. `run-cc.sh` runs with
`AGENT_PROVIDER=openrouter` and wraps `claude` in
`worker/claude-openrouter-request.js`. That wrapper is the counterpart of
Codex's request adapter: a listener on 127.0.0.1 for one invocation, holding
that turn's key, forwarding Anthropic Messages requests to OpenRouter's
`/messages` endpoint. There is still no platform relay. Claude Code gets the
listener's address and a random local token, never the key. The wrapper
scrubs the key and the Homeroom grant from everything Claude prints, and
`run-cc.sh` removes the key from its own environment before git, the in-loop
database, the commit or the push run. Every request is pinned to the
session's model, because Claude Code's background calls ask for a Haiku
alias that would bill a different model. Replies are capped at the catalog's
output limit. Images and PDFs in a request are replaced with a short note: the
platform runs OpenRouter models on text only, as Codex's model catalog does,
and a text-only model would refuse the whole request.

The thinking level still applies. The adapter sends the session's reasoning
effort as the Messages API's `output_config.effort`. OpenRouter documents that
field as its unified `reasoning.effort`, translated to each model's own levels,
and ranks it above Claude Code's `thinking`. A `thinking: disabled` would
still switch reasoning off for a non-Anthropic model, so the adapter drops it
when an effort is set.

Web search works, which it never did on this venue: Codex's OpenRouter model
catalog declares `supports_search_tool: false`. Claude Code's WebSearch sends
Anthropic's server-side search tool (`web_search_20250305`), which only
Anthropic runs. The adapter swaps it for OpenRouter's `openrouter:web_search`
server tool, which the Messages API accepts for any model. OpenRouter runs
the search with the model's native search, or with Exa (about $0.007 a search,
billed to the key) for models without one, GLM included. Searches are capped
at 5 per WebSearch call. Claude Code sends that tool only on WebSearch's own
sub-request, so a reply Claude Code cannot read fails that search, not the
turn. OpenRouter's server tools are in beta.

Known differences from a Codex turn:

- **Usage covers the run, not the thread.** Claude Code reports totals for one
  invocation, and Anthropic's `input_tokens` excludes cache reads and writes.
  The ledger adds the three and skips the thread-delta step Codex's cumulative
  totals need.
- **Search fees are not in the ledger estimate.** The estimate prices tokens
  from the catalog. OpenRouter bills each web search separately, and the key's
  own limit still covers it.
- **Scout and build only.** The dev chat and agent chats dispatch through the
  same scout and build, so both use the map. Before & after shots and the Homeroom
  bot still run Codex. They call the runtime without `harness: 'auto'`, and a
  thread written by the other CLI is not resumed there.

Changing the map mid-conversation is safe. The ledger records which CLI wrote
each thread (`agent_turns.metadata.harness`). A turn whose harness differs
from its saved thread's starts a fresh agent context instead of asking one
CLI to resume the other's thread. The branch and the conversation are kept.

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
