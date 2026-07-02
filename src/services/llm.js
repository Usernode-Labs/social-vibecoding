const log = require('./logger');

// Single source of truth for the default chat model. Callers that don't
// pass an explicit `model` fall back to this, so bumping the platform's
// default model is a one-line change here rather than a grep-and-replace
// across hardcoded slugs (which is how the conflict-resolver previously
// pinned a stale model). Kept aligned with services/models.js
// DEFAULT_MODEL (the user-facing allowlist default).
const DEFAULT_MODEL = 'claude-opus-4-8';

// ── Fable 5 classifier fallback ─────────────────────────────────────
// claude-fable-5 requests run through Anthropic's safety classifiers,
// which can decline a request (HTTP 200 + stop_reason 'refusal' +
// stop_details.category). Recovery is opt-in and PER REQUEST: the
// server-side fallback beta re-serves a declined request on the fallback
// model inside the same call, with cache-read repricing applied
// automatically. streamChat below is the single funnel for every
// platform-authored Messages call that can run a user-selected model —
// all Mayor phases, the headless runner, and proposal-discuss — so
// opting in here covers every retry/regeneration/continuation path.
// NOTE: any future direct SDK use outside this module bypasses the
// fallback config, the detection, and the billing attribution — route
// new Messages calls through streamChat.
const FABLE_MODEL = 'claude-fable-5';
const FALLBACK_TARGET_MODEL = 'claude-opus-4-8';
const FALLBACK_BETA = 'server-side-fallback-2026-06-01';

// A fallback-served response is detected reliably ONLY via
// usage.iterations carrying a 'fallback_message' entry. A sticky-served
// turn (conversation already pinned to the fallback model) carries NO
// {type:'fallback'} content block, so the block alone under-detects.
function detectFallback(finalMessage) {
  const iterations = finalMessage && finalMessage.usage && finalMessage.usage.iterations;
  if (!Array.isArray(iterations)) return false;
  return iterations.some((entry) => entry && entry.type === 'fallback_message');
}

// The {from, to} of the LAST fallback content block, when present —
// attribution only (absent on sticky-served turns; see detectFallback).
function fallbackBoundary(content) {
  if (!Array.isArray(content)) return null;
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (block && block.type === 'fallback') {
      return {
        from: (block.from && block.from.model) || null,
        to: (block.to && block.to.model) || null,
      };
    }
  }
  return null;
}

// Streaming echo rule for a mid-output fallback: the declined model's
// truncated tool_use / thinking blocks BEFORE the switch boundary are
// invalid in subsequent calls and must be omitted; text blocks and
// everything after the boundary echo normally. The fallback block itself
// is an ignorable audit marker (kept). Content with no fallback block
// passes through untouched.
function sanitizeFallbackContent(content) {
  if (!Array.isArray(content)) return content || [];
  let boundaryIdx = -1;
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i] && content[i].type === 'fallback') { boundaryIdx = i; break; }
  }
  if (boundaryIdx === -1) return content;
  return content.filter((block, i) => {
    if (i >= boundaryIdx) return true;
    const type = block && block.type;
    return type !== 'tool_use' && type !== 'thinking' && type !== 'redacted_thinking';
  });
}

let Anthropic;
let client;

async function init(config) {
  // Always import the SDK so BYOK users can still work even when the
  // admin key is absent — we just don't spin up a shared `client` in
  // that case. Before this change a BYOK-only deployment would throw
  // `Anthropic is not defined` in streamChat.
  const mod = await import('@anthropic-ai/sdk');
  Anthropic = mod.default;

  if (!config.anthropicApiKey) {
    log.warn('llm', 'ANTHROPIC_API_KEY not set — shared admin calls disabled (BYOK still works)');
    return;
  }
  client = new Anthropic({ apiKey: config.anthropicApiKey });
  log.info('llm', 'Anthropic client initialized');
}

function isEnabled() {
  return !!client;
}

function getSystemPrompt(appName, repoFiles) {
  let prompt = `You are a coding assistant helping modify the app "${appName}". The app is a Node.js/Express server with HTML/JS/Tailwind frontend and a Postgres database.

When the user asks you to make changes, describe what you'll change and output the complete updated file contents using this format for each file:

\`\`\`filepath:path/to/file.js
// complete file contents here
\`\`\`

Important rules:
- Always output COMPLETE file contents, not diffs or partial snippets
- Use the filepath: prefix so the platform can extract and apply changes
- Keep changes minimal — only modify what the user asks for
- If you need to create a new file, use the same format with the new path
- The app has JWT auth from the platform — use req.user for the current user
- The database connection is via a pg Pool using DATABASE_URL env var
- Test your logic mentally before outputting — avoid syntax errors`;

  if (repoFiles) {
    prompt += `\n\nCurrent repository files:\n${repoFiles}`;
  }

  return prompt;
}

async function streamChat({ messages, systemPrompt, model, tools, toolChoice, onToken, onThinking, onDone, onError, signal, apiKey }) {
  // BYOK (#30): when the caller passes a user-provided key, we spin up
  // a transient client for this request instead of reusing the shared
  // one. Otherwise fall back to the admin key. Creating a client per
  // request is fine — Anthropic's SDK is lightweight and the HTTP
  // layer under the hood keeps its own keepalive pool.
  const activeClient = apiKey ? new Anthropic({ apiKey }) : client;
  if (!activeClient) throw new Error('LLM not initialized');

  const requestedModel = model || DEFAULT_MODEL;

  // Pass the abort signal via request options so /api/sessions/:id/stop
  // can cancel an in-flight Mayor call cleanly (instead of us just
  // swallowing tokens locally while the API keeps billing).
  const requestOptions = signal ? { signal } : undefined;

  try {
    let fullText = '';

    // One attempt against `runModel`. Fable 5 requests go through the
    // beta surface with the server-side fallback opt-in (see the module
    // header) so a classifier decline is re-served by Opus 4.8 inside
    // the same call; every other model keeps the plain path byte-for-byte.
    const runStream = async (runModel, { withFallbacks }) => {
      const params = {
        model: runModel,
        max_tokens: 8192,
        system: systemPrompt,
        messages,
        stream: true,
      };
      if (Array.isArray(tools) && tools.length) params.tools = tools;
      // toolChoice lets callers force 'none' on wrap-up turns to prevent
      // the model from calling tools again after a tool_result round-trip.
      if (toolChoice) params.tool_choice = toolChoice;

      const stream = withFallbacks
        ? activeClient.beta.messages.stream({
          ...params,
          betas: [FALLBACK_BETA],
          fallbacks: [{ model: FALLBACK_TARGET_MODEL }],
        }, requestOptions)
        : activeClient.messages.stream(params, requestOptions);

      stream.on('text', (text) => {
        fullText += text;
        if (onToken) onToken(text);
      });

      return stream.finalMessage();
    };

    let finalMessage = await runStream(requestedModel, {
      withFallbacks: requestedModel === FABLE_MODEL,
    });

    // Fallback couldn't run (e.g. Opus rate-limited at that instant):
    // the refusal names a model to retry directly. ONE retry, plain
    // path (no fallbacks param needed); a second refusal is final.
    // Fable's thinking blocks in the replayed history are dropped
    // server-side (unbilled) by the other model — no stripping needed.
    let retriedOnRecommended = false;
    const recommendedModel = finalMessage.stop_reason === 'refusal'
      && finalMessage.stop_details
      && typeof finalMessage.stop_details.recommended_model === 'string'
      && finalMessage.stop_details.recommended_model.trim();
    if (recommendedModel) {
      log.warn('llm', 'Refusal with recommended_model — retrying once directly', {
        requested: requestedModel, retryModel: recommendedModel,
      });
      finalMessage = await runStream(recommendedModel, { withFallbacks: false });
      retriedOnRecommended = true;
    }

    const inputTokens = finalMessage.usage?.input_tokens || 0;
    const outputTokens = finalMessage.usage?.output_tokens || 0;

    // Walk the assembled content blocks so callers can orchestrate a
    // tool-use loop without having to re-derive text vs. tool_use from
    // the raw SDK event shapes. `rawContent` is returned so the caller
    // can echo it back into the next turn's assistant message —
    // Anthropic requires the exact block sequence to round-trip a
    // tool_use → tool_result handoff. It is sanitized per the fallback
    // echo rule first (a no-op when no fallback block is present), and
    // `toolUses` derives from the SANITIZED content so a truncated
    // pre-boundary tool_use can never be dispatched or answered.
    const rawContent = sanitizeFallbackContent(finalMessage.content || []);
    const toolUses = [];
    let assembledText = '';
    for (const block of rawContent) {
      if (block.type === 'text') assembledText += block.text;
      else if (block.type === 'tool_use') {
        toolUses.push({ id: block.id, name: block.name, input: block.input });
      }
    }

    if (onDone) onDone();

    const stopReason = finalMessage.stop_reason;
    return {
      text: assembledText || fullText,
      toolUses,
      stopReason,
      rawContent,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      // Fable 5 fallback surface (see module header). servedModel names
      // the model that actually produced the message; fallbackServed is
      // the usage.iterations detection (plus the recommended_model retry
      // path, where the serving model is by definition not the requested
      // one); stopDetails is populated only on refusals.
      requestedModel,
      servedModel: finalMessage.model || requestedModel,
      fallbackServed: retriedOnRecommended || detectFallback(finalMessage),
      fallbackBoundary: fallbackBoundary(finalMessage.content || []),
      stopDetails: stopReason === 'refusal' ? (finalMessage.stop_details || null) : null,
    };
  } catch (err) {
    if (onError) onError(err);
    throw err;
  }
}

// Dollars per 1k tokens, aligned with services/models.js (the allowlist's
// $/MTok figures: haiku 1/5, sonnet 3/15, opus 5/25, fable 10/50).
// Fable previously matched no branch and silently fell through to sonnet
// pricing — a ~3x underestimate that let fable turns slip past the daily
// budget enforcement. Callers should pass the SERVED model (streamChat's
// `servedModel`) so a fallback-served turn bills at the fallback's rates.
function estimateCostCents(usage, model) {
  const inputPer1k = model?.includes('fable') ? 0.010
    : model?.includes('opus') ? 0.005
      : model?.includes('sonnet') ? 0.003
        : model?.includes('haiku') ? 0.001
          : 0.003;
  const outputPer1k = model?.includes('fable') ? 0.050
    : model?.includes('opus') ? 0.025
      : model?.includes('sonnet') ? 0.015
        : model?.includes('haiku') ? 0.005
          : 0.015;

  return (
    (usage.input_tokens / 1000) * inputPer1k * 100 +
    (usage.output_tokens / 1000) * outputPer1k * 100
  );
}

// Generate a human-readable PR title + description from the user's
// request(s) and Claude Code's own summary of what it built. Runs after
// the worker finishes and before we open/update the GitHub PR so the
// title is accurate (not a guess from the mayor ahead of time). Uses
// Haiku for speed + cost; the call is ~1s and a fraction of a cent per PR.
//
// A single PR/branch accumulates multiple dev turns ("updates"). To keep
// the title reflecting ALL changes in the PR — not just the most recent
// update (#26) — callers may pass the full history as `requests`
// (every user ask, chronological) and `summaries` (each turn's coding
// agent summary). `specs` carries the session's spec doc(s) as a theme
// signal (intended scope, which may run ahead of what's actually built).
// The legacy single `userRequest`/`ccSummary` fields are still accepted
// and treated as a one-entry history.
//
// Returns `{ title, body }` or throws on failure — callers MUST catch
// and fall back to the old template ("<user>'s changes") rather than
// blocking PR creation on LLM downtime.
// Parse + sanitize the model's PR-metadata response into {title, body,
// summary}. Tolerates light fencing / chatter around the JSON even though
// we asked for none — LLMs occasionally add ```json wrappers — by matching
// the first {...} object. `title` is REQUIRED (throws when empty, hard-capped
// at 200 chars). `body` and `summary` are OPTIONAL (empty string when
// missing/malformed) so a short or absent value never blocks PR creation;
// `summary` is the plain-language, user-facing blurb (1-3 sentences) and is
// length-capped defensively so a verbose model response can't dominate the
// proposal view. Exported pure for tests.
function parsePrMetadataText(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object in PR metadata response');
  const parsed = JSON.parse(match[0]);

  let title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  const body = typeof parsed.body === 'string' ? parsed.body.trim() : '';
  let summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  if (summary.length > 600) summary = summary.slice(0, 600).trimEnd();
  if (!title) throw new Error('Empty PR title from LLM');
  if (title.length > 200) title = title.slice(0, 200);
  return { title, body, summary };
}

async function generatePrMetadata({ userRequest, ccSummary, requests, summaries, specs, username, apiKey }) {
  const activeClient = apiKey ? new Anthropic({ apiKey }) : client;
  if (!activeClient) throw new Error('LLM not initialized');

  // Normalize to chronological lists, falling back to the legacy
  // single-value fields. Cap count + per-item length so a long-lived PR
  // with many turns can't blow the prompt budget; the most recent turns
  // matter most so we keep the tail.
  const MAX_TURNS = 20;
  const toList = (arr, single) => {
    const list = (Array.isArray(arr) ? arr : []).map((s) => String(s || '').trim()).filter(Boolean);
    if (list.length) return list.slice(-MAX_TURNS);
    return single && String(single).trim() ? [String(single).trim()] : [];
  };
  const reqList = toList(requests, userRequest);
  const sumList = toList(summaries, ccSummary);
  // Specs are large; keep only the 2 most recent distinct docs (older
  // drafts are usually subsets of the latest) and truncate each.
  const specList = (Array.isArray(specs) ? specs : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .slice(-2);
  const multi = reqList.length > 1 || sumList.length > 1;

  const system = `You write concise GitHub pull request titles and descriptions.

A pull request may bundle several updates made over multiple turns. You are given the FULL history of the user's requests and the coding agent's summaries for this PR, and possibly the session's spec doc(s). Produce metadata that reflects ALL the changes in the PR, not just the latest update:
- A title (max 72 chars, imperative mood, no trailing period, no PR #) that captures the overall scope of the PR. If the updates are related, summarize them as one theme; if they are distinct, lead with the most significant change.
- A short markdown description (2-6 lines): 1 sentence of context, then bullet points covering the concrete changes across all updates. Keep it tight; no filler.
- A summary: 1-3 short sentences in plain, everyday English describing what this change does for the people who USE the app. No file names, no code, no technical jargon, no developer terms — just what changes for a user. This is read by non-technical voters deciding on the change, so contrast it with the developer-oriented description above.

The SPEC section (when present) describes the intended scope and overall theme — useful for framing — but it may describe work that isn't built yet, so base the concrete changes on the requests and coding-agent summaries, not the spec alone.

Respond with ONLY a JSON object: {"title": "...", "body": "...", "summary": "..."}. No prose before or after.`;

  const reqBlock = reqList.length
    ? reqList.map((r, i) => (multi ? `${i + 1}. ${r.slice(0, 1000)}` : r.slice(0, 2000))).join('\n')
    : '(no request available)';
  const sumBlock = sumList.length
    ? sumList.map((s, i) => (multi ? `Update ${i + 1}:\n${s.slice(0, 2000)}` : s.slice(0, 6000))).join('\n\n')
    : '(no summary available)';
  const specBlock = specList.length
    ? specList.map((s, i) => (specList.length > 1 ? `Spec ${i + 1}:\n${s.slice(0, 3000)}` : s.slice(0, 4000))).join('\n\n')
    : '';

  const user = `USER REQUEST${reqList.length > 1 ? 'S (chronological)' : ''}:
${reqBlock}

CODING AGENT SUMMAR${sumList.length > 1 ? 'IES (one per update, chronological)' : 'Y'}:
${sumBlock}
${specBlock ? `\nSPEC${specList.length > 1 ? 'S' : ''} (intended scope / theme):\n${specBlock}\n` : ''}
Author: ${username || 'unknown'}`;

  const model = 'claude-haiku-4-5';
  const resp = await activeClient.messages.create({
    model,
    max_tokens: 512,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const text = (resp.content || []).find((b) => b.type === 'text')?.text || '';
  const { title, body, summary } = parsePrMetadataText(text);
  // Surface usage so callers (pr-metadata.js) can debit the user
  // who triggered the PR. May be undefined if the SDK strips it on
  // some response shapes; callers must tolerate that.
  return { title, body, summary, usage: resp.usage, model };
}

// Clamp an estimate phrase to something safe to inline in the dev-chat
// summary line: single line, trimmed, hard-capped at 90 chars. Pure so
// tests/ai-progress-estimate.test.js can exercise it directly.
function sanitizeEstimate(text) {
  let s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (s.length > 90) s = s.slice(0, 89).trimEnd() + '…';
  return s;
}

// Coerce the model's `remaining_seconds` guess into a safe integer, or
// null when it's unusable. Integer-coerce, reject non-finite/negative,
// and clamp to [0, 7200] (a 2 h ceiling matching the run-bounding posture
// of the 20-tick estimator cap). Pure + exported so
// tests/ai-progress-estimate.test.js can exercise it directly.
function sanitizeRemainingSeconds(v) {
  if (v == null || v === '') return null;
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(7200, n);
}

// Structured-outputs schema for estimateRunProgress (#323). Constrains Haiku
// to emit JSON matching exactly the keys the parser reads — `estimate` (the
// vague phrase) and `remaining_seconds` (a nullable integer). Top-level object
// with additionalProperties:false and both keys required; nullability of
// remaining_seconds is carried by the ["integer","null"] type union, not by
// omitting it from `required`. Numeric range bounds are intentionally absent —
// structured outputs does not enforce minimum/maximum, so the [0,7200] clamp
// and the 90-char cap stay in sanitizeRemainingSeconds / sanitizeEstimate.
const ESTIMATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    estimate: { type: 'string' },
    remaining_seconds: { type: ['integer', 'null'] },
  },
  required: ['estimate', 'remaining_seconds'],
};

// Experimental (#50 follow-up): vague progress/time-remaining guess for an
// in-flight Claude Code run, generated by Haiku from the tail of the
// progress log. Called on a ~60s cadence by runClaudeCodeTool while the
// per-user ai_progress_estimate toggle is ON. Deliberately fuzzy — the
// system prompt forbids precise percentages/ETAs so the output can't be
// mistaken for a real measurement. Throws on any failure; callers MUST
// catch and skip the tick (the estimate is decorative, never load-bearing).
async function estimateRunProgress({ userRequest, progressTail, elapsedMs, steps, apiKey }) {
  const activeClient = apiKey ? new Anthropic({ apiKey }) : client;
  if (!activeClient) throw new Error('LLM not initialized');

  const system = `You are watching the live progress log of an autonomous coding agent working on a small web-app change. Typical runs take roughly 2-10 minutes; simple changes finish faster, sweeping ones slower. The log tail below is the agent's recent activity (file reads/edits, commands, phase markers like [commit]/[push] which come near the end of a run).

Give ONE short, deliberately vague estimate of how far along the run feels and roughly how long is left — e.g. “maybe two-thirds done — a few minutes left” or “still early — several minutes to go”. Use hedged language (“maybe”, “roughly”, “probably”). NEVER give a precise percentage, exact time, or countdown in this phrase. Keep it under 90 characters.

Also give your best numeric guess at how many SECONDS of work remain, as an integer. Bias toward the 2-10 minute (120-600 second) typical-run window. If you genuinely cannot tell, return null for it — don't force a number.

Respond with ONLY a JSON object: {“estimate”: “...”, “remaining_seconds”: <integer or null>}. No prose before or after.`;

  // Cap the prompt: last 60 lines, ~4000 chars total, request to 300 chars.
  const lines = (Array.isArray(progressTail) ? progressTail : [])
    .map((l) => String(l == null ? '' : l))
    .slice(-60);
  let tail = lines.join('\n');
  if (tail.length > 4000) tail = tail.slice(-4000);

  const elapsedSec = Math.max(0, Math.round((Number(elapsedMs) || 0) / 1000));
  const user = `USER REQUEST: ${String(userRequest || '').slice(0, 300)}

ELAPSED: ${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s
TOOL STEPS SO FAR: ${Number(steps) || 0}

PROGRESS LOG (tail):
${tail || '(no output yet)'}`;

  const model = 'claude-haiku-4-5';
  const resp = await activeClient.messages.create({
    model,
    max_tokens: 120,
    system,
    messages: [{ role: 'user', content: user }],
    // Structured outputs (#323): force Haiku to emit schema-matching JSON so
    // the JSON.parse / fence / smart-quote failure class can't occur for normal
    // completions. claude-haiku-4-5 supports structured outputs, and
    // @anthropic-ai/sdk 0.89 accepts output_config.format on messages.create().
    // The schema guarantees type + presence only; the brace-extraction +
    // sanitize path below stays as a defensive fallback for off-schema output
    // (refusal / max_tokens truncation / older models).
    output_config: { format: { type: 'json_schema', schema: ESTIMATE_SCHEMA } },
  });

  const raw = (resp.content || []).find((b) => b.type === 'text')?.text || '';
  // Defensive fallback parse before throwing (#323): with structured outputs
  // the text block normally already holds clean schema-matching JSON, but a
  // refusal, a max_tokens truncation, or an older model can still yield
  // off-schema text — Haiku occasionally wraps the JSON in a ```json code fence
  // or echoes the smart quotes from the system prompt, both of which break a
  // naive JSON.parse. Strip fences and normalise curly quotes to straight ones
  // first; only genuinely unparseable output throws (the caller backs off and
  // retries on the next tick).
  const text = raw
    .replace(/```(?:json)?/gi, '')
    .replace(/[“”]/g, '"')   // “ ” → "
    .replace(/[‘’]/g, "'");  // ‘ ’ → '
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object in progress estimate response');
  const parsed = JSON.parse(match[0]);
  const estimate = sanitizeEstimate(parsed.estimate);
  if (!estimate) throw new Error('Empty progress estimate from LLM');
  const remainingSeconds = sanitizeRemainingSeconds(parsed.remaining_seconds);
  return { text: estimate, remainingSeconds, usage: resp.usage, model };
}

// Parse + sanitize the model's session-title response (#249). Accepts
// the requested {“title”: “...”} JSON shape or raw text (tolerating
// code fences and wrapping quotes, same posture as generatePrMetadata's
// parsing). Collapses whitespace/newlines, strips a trailing period,
// and hard-caps at 256 chars so the value always fits the
// chat_sessions.session_title column. Throws when nothing usable
// survives. Exported for tests.
function parseSessionTitleText(text) {
  let title = '';
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (typeof parsed.title === 'string') title = parsed.title;
    } catch {}
  }
  if (!title) {
    title = String(text || '').replace(/```[a-z]*\n?/gi, '');
  }
  title = title
    .replace(/\s+/g, ' ')
    .trim()
    // Strip surrounding quotes (straight + curly, single + double) then a
    // trailing period — the LLM often wraps a plain-text title in quotes
    // and/or ends it with a sentence period.
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\.+$/, '')
    .trim();
  if (!title) throw new Error('Empty session title from LLM');
  if (title.length > 256) title = title.slice(0, 256);
  return title;
}

// Generate a short human-readable session title from the user's
// request(s) and, optionally, the session's spec excerpt or a GitHub
// issue title (#249). This is the display-name layer for sessions that
// don't have a PR yet — once a PR exists, applyPrMetadata mirrors the
// PR title instead and this is never called again for the session.
//
// Same error contract as generatePrMetadata: throws on failure, and
// callers MUST catch and leave the title unset (the UI falls back to
// the branch name). Title generation must never block or fail a turn.
//
// Returns { title, usage, model } so callers can debit the cost to the
// requesting user exactly like the PR-metadata call.
async function generateSessionTitle({ requests, specs, issueTitle, apiKey }) {
  const activeClient = apiKey ? new Anthropic({ apiKey }) : client;
  if (!activeClient) throw new Error('LLM not initialized');

  const MAX_TURNS = 10;
  const reqList = (Array.isArray(requests) ? requests : [])
    .map((s) => String(s || '').trim()).filter(Boolean).slice(-MAX_TURNS);
  // Specs are large; only the most recent draft matters as a theme signal.
  const spec = (Array.isArray(specs) ? specs : [])
    .map((s) => String(s || '').trim()).filter(Boolean).pop() || '';
  const issue = String(issueTitle || '').trim();
  if (!reqList.length && !spec && !issue) throw new Error('Nothing to title the session from');

  const system = `You name development chat sessions. Based on the user's request(s) — and, when present, a spec excerpt or issue title — produce a short descriptive session title: a noun phrase of 3-8 words, at most 60 characters, no trailing period, no quotes, no markdown.

Respond with ONLY a JSON object: {“title”: “...”}. No prose before or after.`;

  const parts = [];
  if (reqList.length) {
    parts.push(`USER REQUEST${reqList.length > 1 ? 'S (chronological)' : ''}:\n${
      reqList.map((r, i) => (reqList.length > 1 ? `${i + 1}. ${r.slice(0, 1000)}` : r.slice(0, 2000))).join('\n')}`);
  }
  if (issue) parts.push(`ISSUE TITLE:\n${issue.slice(0, 300)}`);
  if (spec) parts.push(`SPEC (intended scope):\n${spec.slice(0, 3000)}`);

  const model = 'claude-haiku-4-5';
  const resp = await activeClient.messages.create({
    model,
    max_tokens: 64,
    system,
    messages: [{ role: 'user', content: parts.join('\n\n') }],
  });

  const text = (resp.content || []).find((b) => b.type === 'text')?.text || '';
  const title = parseSessionTitleText(text);
  // Usage rides along so callers can debit the requesting user; may be
  // undefined on some response shapes — callers must tolerate that.
  return { title, usage: resp.usage, model };
}

// Test hook: swap the shared client for a stub so streamChat's fallback
// plumbing is unit-testable without the SDK or network. Returns the
// previous client so tests can restore it.
function _setClientForTests(fakeClient) {
  const prev = client;
  client = fakeClient;
  return prev;
}

module.exports = {
  init, isEnabled, getSystemPrompt, streamChat, estimateCostCents,
  generatePrMetadata, parsePrMetadataText, generateSessionTitle,
  parseSessionTitleText, estimateRunProgress, sanitizeEstimate,
  sanitizeRemainingSeconds, DEFAULT_MODEL,
  // Fable 5 classifier-fallback surface (+ tests)
  detectFallback, sanitizeFallbackContent, fallbackBoundary,
  FABLE_MODEL, FALLBACK_TARGET_MODEL, FALLBACK_BETA,
  _setClientForTests,
};
