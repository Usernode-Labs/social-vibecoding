const log = require('./logger');

// Single source of truth for the default chat model. Callers that don't
// pass an explicit `model` fall back to this, so bumping the platform's
// default model is a one-line change here rather than a grep-and-replace
// across hardcoded slugs (which is how the conflict-resolver previously
// pinned a stale model).
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

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

  const params = {
    model: model || DEFAULT_MODEL,
    max_tokens: 8192,
    system: systemPrompt,
    messages,
    stream: true,
  };
  if (Array.isArray(tools) && tools.length) params.tools = tools;
  // toolChoice lets callers force 'none' on wrap-up turns to prevent the
  // model from calling tools again after a tool_result round-trip.
  if (toolChoice) params.tool_choice = toolChoice;

  try {
    let fullText = '';

    // Pass the abort signal via request options so /api/sessions/:id/stop
    // can cancel an in-flight Mayor call cleanly (instead of us just
    // swallowing tokens locally while the API keeps billing).
    const requestOptions = signal ? { signal } : undefined;
    const stream = activeClient.messages.stream(params, requestOptions);

    stream.on('text', (text) => {
      fullText += text;
      if (onToken) onToken(text);
    });

    const finalMessage = await stream.finalMessage();
    const inputTokens = finalMessage.usage?.input_tokens || 0;
    const outputTokens = finalMessage.usage?.output_tokens || 0;

    // Walk the assembled content blocks so callers can orchestrate a
    // tool-use loop without having to re-derive text vs. tool_use from
    // the raw SDK event shapes. `rawContent` is returned verbatim so the
    // caller can echo it back into the next turn's assistant message —
    // Anthropic requires the exact block sequence to round-trip a
    // tool_use → tool_result handoff.
    const toolUses = [];
    let assembledText = '';
    for (const block of finalMessage.content || []) {
      if (block.type === 'text') assembledText += block.text;
      else if (block.type === 'tool_use') {
        toolUses.push({ id: block.id, name: block.name, input: block.input });
      }
    }

    if (onDone) onDone();

    return {
      text: assembledText || fullText,
      toolUses,
      stopReason: finalMessage.stop_reason,
      rawContent: finalMessage.content || [],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    };
  } catch (err) {
    if (onError) onError(err);
    throw err;
  }
}

function estimateCostCents(usage, model) {
  const inputPer1k = model?.includes('opus') ? 0.015
    : model?.includes('sonnet') ? 0.003
    : model?.includes('haiku') ? 0.00025
    : 0.003;
  const outputPer1k = model?.includes('opus') ? 0.075
    : model?.includes('sonnet') ? 0.015
    : model?.includes('haiku') ? 0.00125
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

The SPEC section (when present) describes the intended scope and overall theme — useful for framing — but it may describe work that isn't built yet, so base the concrete changes on the requests and coding-agent summaries, not the spec alone.

Respond with ONLY a JSON object: {"title": "...", "body": "..."}. No prose before or after.`;

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
  // Tolerate light fencing / chatter around the JSON even though we
  // asked for none — LLMs occasionally add ```json wrappers.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object in PR metadata response');
  const parsed = JSON.parse(match[0]);

  let title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  let body = typeof parsed.body === 'string' ? parsed.body.trim() : '';
  if (!title) throw new Error('Empty PR title from LLM');
  if (title.length > 200) title = title.slice(0, 200);
  // Surface usage so callers (pr-metadata.js) can debit the user
  // who triggered the PR. May be undefined if the SDK strips it on
  // some response shapes; callers must tolerate that.
  return { title, body, usage: resp.usage, model };
}

module.exports = { init, isEnabled, getSystemPrompt, streamChat, estimateCostCents, generatePrMetadata, DEFAULT_MODEL };
