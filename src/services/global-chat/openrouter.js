'use strict';

// Minimal OpenRouter Chat Completions transport for Global Chat. It accepts
// only server-built messages and strict tools, streams SSE safely, and returns a
// bounded OpenAI-compatible assistant message plus content-free usage facts.

const { platformHeaders } = require('../openrouter-client');
const { modelId, reasoningEffort } = require('./profile');

// A Global Chat turn may make more than one short tool-planning call. Letting
// any single provider request occupy the UI for 90 seconds made a transient
// failure look like a frozen application and multiplied badly with retries.
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 800;
const MAX_OUTPUT_TOKENS = 4_096;
const MAX_MESSAGES = 100;
const MAX_TOOLS = 80;
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_CHARS = 512 * 1024;
const MAX_TOOL_ARGUMENT_CHARS = 256 * 1024;

class GlobalChatProviderError extends Error {
  constructor(code, message, { status = null, dispatched = false } = {}) {
    super(message);
    this.name = 'GlobalChatProviderError';
    this.code = code;
    this.status = status;
    this.dispatched = dispatched;
  }
}

function boundedInteger(value, fallback, min, max, field) {
  const chosen = value == null ? fallback : Number(value);
  if (!Number.isInteger(chosen) || chosen < min || chosen > max) {
    throw new GlobalChatProviderError('invalid_request', `${field} is out of range`);
  }
  return chosen;
}

function boundedNumber(value, fallback, min, max, field) {
  const chosen = value == null ? fallback : Number(value);
  if (!Number.isFinite(chosen) || chosen < min || chosen > max) {
    throw new GlobalChatProviderError('invalid_request', `${field} is out of range`);
  }
  return chosen;
}

function jsonArray(value, field, maxItems) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new GlobalChatProviderError(
      'invalid_request',
      `${field} must be an array with at most ${maxItems} entries`,
    );
  }
  // The caller owns schemas/messages, but cloning here prevents a concurrent
  // tool loop from mutating the request while fetch serializes it.
  try {
    return structuredClone(value);
  } catch {
    throw new GlobalChatProviderError('invalid_request', `${field} must be JSON-serializable`);
  }
}

function buildRequest({
  model,
  reasoning,
  messages,
  tools,
  sessionId,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
  temperature = 0.1,
  parallelToolCalls = true,
  toolChoice = 'auto',
}) {
  const copiedTools = jsonArray(tools, 'tools', MAX_TOOLS);
  const availableToolNames = new Set(copiedTools.map((tool) => tool?.function?.name).filter(Boolean));
  let normalizedToolChoice = toolChoice;
  if (toolChoice && typeof toolChoice === 'object' && !Array.isArray(toolChoice)) {
    const name = toolChoice.function?.name;
    if (toolChoice.type !== 'function' || typeof name !== 'string' || !availableToolNames.has(name)) {
      throw new GlobalChatProviderError('invalid_request', 'toolChoice must select an available tool');
    }
    normalizedToolChoice = structuredClone(toolChoice);
  } else if (!['auto', 'required', 'none'].includes(toolChoice)) {
    throw new GlobalChatProviderError('invalid_request', 'toolChoice is invalid');
  }
  const request = {
    model: modelId(model),
    messages: jsonArray(messages, 'messages', MAX_MESSAGES),
    tools: copiedTools,
    tool_choice: normalizedToolChoice,
    reasoning: { effort: reasoningEffort(reasoning) },
    max_tokens: boundedInteger(
      maxOutputTokens,
      DEFAULT_MAX_OUTPUT_TOKENS,
      1,
      MAX_OUTPUT_TOKENS,
      'maxOutputTokens',
    ),
    stream: true,
    // OpenRouter adds token and cost accounting to the stream when requested.
    usage: { include: true },
    // Tool schemas already provide the strict structured-output boundary.
    // Sending response_format at the same time is redundant and excludes or
    // destabilizes providers that reliably implement tools but not the two
    // output modes together.
    provider: { require_parameters: true },
  };
  if (parallelToolCalls != null) request.parallel_tool_calls = parallelToolCalls === true;
  if (temperature != null) {
    request.temperature = boundedNumber(temperature, 0.1, 0, 2, 'temperature');
  }
  if (sessionId != null) {
    const normalized = String(sessionId).trim();
    if (!normalized || normalized.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
      throw new GlobalChatProviderError('invalid_request', 'Invalid provider session id');
    }
    request.session_id = normalized;
  }
  return request;
}

function nonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function integer(value) {
  const number = nonnegative(value);
  return number == null ? null : Math.round(number);
}

function usageFrom(value) {
  const usage = value && typeof value === 'object' ? value : {};
  const promptDetails = usage.prompt_tokens_details || usage.promptTokensDetails || {};
  const completionDetails = usage.completion_tokens_details || usage.completionTokensDetails || {};
  return {
    inputTokens: integer(usage.prompt_tokens ?? usage.promptTokens) ?? 0,
    cachedInputTokens: integer(promptDetails.cached_tokens ?? promptDetails.cachedTokens) ?? 0,
    outputTokens: integer(usage.completion_tokens ?? usage.completionTokens) ?? 0,
    reasoningTokens: integer(
      completionDetails.reasoning_tokens ?? completionDetails.reasoningTokens,
    ) ?? 0,
    costUsd: nonnegative(usage.cost),
  };
}

function contentDelta(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part.text === 'string') return part.text;
    return '';
  }).join('');
}

function appendToolCall(map, raw) {
  if (!raw || typeof raw !== 'object') return;
  const index = Number.isInteger(raw.index) && raw.index >= 0 ? raw.index : map.size;
  const existing = map.get(index) || {
    id: '',
    type: 'function',
    function: { name: '', arguments: '' },
  };
  if (typeof raw.id === 'string') existing.id += raw.id;
  if (raw.type === 'function') existing.type = 'function';
  if (raw.function && typeof raw.function === 'object') {
    if (typeof raw.function.name === 'string') existing.function.name += raw.function.name;
    if (typeof raw.function.arguments === 'string') {
      existing.function.arguments += raw.function.arguments;
      if (existing.function.arguments.length > MAX_TOOL_ARGUMENT_CHARS) {
        throw new GlobalChatProviderError('response_too_large', 'Tool arguments exceeded the limit', {
          dispatched: true,
        });
      }
    }
  }
  map.set(index, existing);
}

async function* sseData(body) {
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
    throw new GlobalChatProviderError('invalid_response', 'Provider returned no stream', {
      dispatched: true,
    });
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines = [];
  let bytes = 0;

  function* consumeLines(final = false) {
    const lines = buffer.split('\n');
    buffer = final ? '' : lines.pop();
    for (let line of lines) {
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        if (dataLines.length) yield dataLines.join('\n');
        dataLines = [];
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
  }

  for await (const chunk of body) {
    const byteLength = chunk?.byteLength ?? Buffer.byteLength(String(chunk || ''));
    bytes += byteLength;
    if (bytes > MAX_STREAM_BYTES) {
      throw new GlobalChatProviderError('response_too_large', 'Provider stream exceeded the limit', {
        dispatched: true,
      });
    }
    buffer += decoder.decode(chunk, { stream: true });
    yield* consumeLines(false);
  }
  buffer += decoder.decode();
  yield* consumeLines(true);
  if (buffer) {
    let line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length) yield dataLines.join('\n');
}

function providerErrorCode(status) {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 402) return 'billing';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  return 'invalid_request';
}

async function streamChat({
  apiKey,
  baseUrl,
  origin,
  signal,
  onContent,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ...requestInput
}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new GlobalChatProviderError('authentication', 'OpenRouter key is unavailable');
  }
  if (typeof baseUrl !== 'string' || !baseUrl) {
    throw new GlobalChatProviderError('invalid_request', 'OpenRouter base URL is unavailable');
  }
  if (typeof fetchImpl !== 'function') {
    throw new GlobalChatProviderError('invalid_request', 'Fetch implementation is unavailable');
  }
  const body = buildRequest(requestInput);
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), boundedInteger(
    timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 300_000, 'timeoutMs',
  ));
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;
  let response;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',
        ...platformHeaders(origin),
      },
      body: JSON.stringify(body),
      signal: combinedSignal,
    });
  } catch (err) {
    clearTimeout(timer);
    const timedOut = timeoutController.signal.aborted && !signal?.aborted;
    throw new GlobalChatProviderError(
      timedOut ? 'timeout' : (signal?.aborted ? 'cancelled' : 'network'),
      timedOut ? 'Global Chat model timed out' : (signal?.aborted ? 'Global Chat model cancelled' : 'Could not reach Global Chat model'),
      { dispatched: true },
    );
  }

  if (!response.ok) {
    clearTimeout(timer);
    throw new GlobalChatProviderError(
      providerErrorCode(response.status),
      `Global Chat model request failed (HTTP ${response.status})`,
      { status: response.status, dispatched: true },
    );
  }

  const toolCalls = new Map();
  let content = '';
  let finishReason = null;
  let servedModel = null;
  let provider = null;
  let usage = usageFrom(null);
  let generationId = response.headers?.get?.('x-generation-id') || null;

  try {
    for await (const data of sseData(response.body)) {
      if (!data || data === '[DONE]') continue;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        throw new GlobalChatProviderError('invalid_response', 'Provider returned invalid stream data', {
          dispatched: true,
        });
      }
      if (event.error) {
        throw new GlobalChatProviderError('provider_error', 'Provider reported a generation error', {
          dispatched: true,
        });
      }
      generationId ||= typeof event.id === 'string' ? event.id : null;
      servedModel = typeof event.model === 'string' ? event.model : servedModel;
      provider = typeof event.provider === 'string' ? event.provider : provider;
      if (event.usage) usage = usageFrom(event.usage);
      const choice = Array.isArray(event.choices) ? event.choices[0] : null;
      if (!choice) continue;
      const delta = choice.delta || {};
      const fragment = contentDelta(delta.content);
      if (fragment) {
        content += fragment;
        if (content.length > MAX_CONTENT_CHARS) {
          throw new GlobalChatProviderError('response_too_large', 'Provider response exceeded the limit', {
            dispatched: true,
          });
        }
        if (typeof onContent === 'function') await onContent(fragment);
      }
      for (const call of delta.tool_calls || []) appendToolCall(toolCalls, call);
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    const orderedToolCalls = [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => call);
    // A provider/proxy can close an otherwise valid HTTP stream without the
    // terminal choice. Returning the partial tool arguments makes the next
    // layer report a misleading schema error and skips its transient retry.
    // Surface this as a stream failure instead. A length cutoff is equally
    // incomplete for a tool-only protocol and is safe to retry once.
    if (!finishReason || finishReason === 'length') {
      throw new GlobalChatProviderError(
        'stream_error',
        finishReason === 'length'
          ? 'Global Chat model response reached its output limit'
          : 'Global Chat model stream ended before completion',
        { dispatched: true },
      );
    }
    return {
      generationId,
      requestedModel: body.model,
      servedModel: servedModel || body.model,
      provider,
      finishReason,
      content,
      toolCalls: orderedToolCalls,
      assistantMessage: {
        role: 'assistant',
        content: content || null,
        ...(orderedToolCalls.length ? { tool_calls: orderedToolCalls } : {}),
      },
      usage,
    };
  } catch (err) {
    if (err instanceof GlobalChatProviderError) throw err;
    const timedOut = timeoutController.signal.aborted && !signal?.aborted;
    throw new GlobalChatProviderError(
      timedOut ? 'timeout' : (signal?.aborted ? 'cancelled' : 'stream_error'),
      timedOut ? 'Global Chat model timed out' : (signal?.aborted ? 'Global Chat model cancelled' : 'Global Chat model stream failed'),
      { dispatched: true },
    );
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  GlobalChatProviderError,
  buildRequest,
  usageFrom,
  sseData,
  streamChat,
};
