import assert from "node:assert/strict"
import test from "node:test"

import {
  buildRunnerInvocation,
  parseClaudeOutput,
  parseCodexOutput,
  supportedLiveRunners,
} from "./live-agent-runners.mjs"

test("matched runner set exposes Claude and Codex without sharing native flags", () => {
  assert.deepEqual(supportedLiveRunners, ["codex", "claude"])
  const codex = buildRunnerInvocation("codex", "task")
  const claude = buildRunnerInvocation("claude", "task")
  assert.equal(codex.command, "codex")
  assert.ok(codex.args.includes("--sandbox"))
  assert.equal(claude.command, "claude")
  assert.ok(claude.args.includes("--permission-mode"))
  assert.ok(!claude.args.includes("--sandbox"))
})

test("Codex JSON event stream yields final structured answer and usage", () => {
  const parsed = parseCodexOutput([
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{\"decision\":\"reuse\"}" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 3 } }),
  ].join("\n"))
  assert.deepEqual(parsed.answer, { decision: "reuse" })
  assert.equal(parsed.usage.input_tokens, 12)
})

test("Claude JSON envelope yields final structured answer and normalized usage", () => {
  const parsed = parseClaudeOutput(JSON.stringify({
    result: "{\"decision\":\"reuse\"}",
    usage: { input_tokens: 14, cache_read_input_tokens: 5, output_tokens: 4 },
  }))
  assert.deepEqual(parsed.answer, { decision: "reuse" })
  assert.deepEqual(parsed.usage, {
    input_tokens: 14,
    cache_creation_input_tokens: 0,
    cached_input_tokens: 5,
    output_tokens: 4,
  })
})

test("Claude event-array envelope selects the terminal result", () => {
  const parsed = parseClaudeOutput(JSON.stringify([
    { type: "system", subtype: "init" },
    {
      type: "result",
      result: "{\"runner\":\"claude\",\"ok\":true}",
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 60,
        cache_read_input_tokens: 0,
        output_tokens: 8,
      },
    },
  ]))
  assert.deepEqual(parsed.answer, { runner: "claude", ok: true })
  assert.equal(parsed.usage.cache_creation_input_tokens, 60)
  assert.equal(parsed.usage.input_tokens, 62)
})
