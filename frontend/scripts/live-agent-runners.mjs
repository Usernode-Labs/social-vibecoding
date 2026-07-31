import { spawn } from "node:child_process"

export const supportedLiveRunners = ["codex", "claude"]

export function buildRunnerInvocation(runner, prompt, options = {}) {
  const writable = options.writable === true
  if (runner === "codex") {
    const args = [
      "exec",
      "--json",
      "--sandbox",
      writable ? "workspace-write" : "read-only",
      "-c",
      "model_reasoning_effort=low",
      prompt,
    ]
    if (options.skipGitCheck) args.splice(1, 0, "--skip-git-repo-check")
    return {
      command: "codex",
      args,
      model: "Codex command-line default",
      permissionProfile: writable ? "native workspace-write sandbox" : "native read-only sandbox",
    }
  }
  if (runner === "claude") {
    const tools = writable ? "Read,Glob,Grep,Bash,Edit" : "Read,Glob,Grep,Bash"
    return {
      command: "claude",
      args: [
        "--print",
        prompt,
        "--output-format", "json",
        "--no-session-persistence",
        "--setting-sources", "project",
        "--strict-mcp-config",
        "--no-chrome",
        "--effort", "low",
        "--model", "fable",
        "--permission-mode", "auto",
        "--tools", tools,
      ],
      model: "Claude Fable",
      permissionProfile: writable
        ? "Claude auto sandbox with read, search, shell, and edit tools"
        : "Claude auto sandbox with read, search, and shell tools",
    }
  }
  throw new Error(`Unsupported live-agent runner: ${runner}`)
}

function parseEmbeddedObject(message) {
  if (typeof message !== "string") return message || null
  try {
    return JSON.parse(message)
  } catch {
    const start = message.indexOf("{")
    const end = message.lastIndexOf("}")
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(message.slice(start, end + 1))
      } catch {
        // Preserve the native response below.
      }
    }
  }
  return { raw: message }
}

export function parseCodexOutput(stdout) {
  const events = (stdout || "").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
  const usage = events.findLast((event) => event.type === "turn.completed")?.usage || null
  const message = events
    .filter((event) => event.type === "item.completed" && event.item?.type === "agent_message")
    .at(-1)?.item?.text || ""
  return { answer: parseEmbeddedObject(message), usage }
}

export function parseClaudeOutput(stdout) {
  let envelope
  try {
    envelope = JSON.parse(stdout)
  } catch {
    return { answer: { raw: stdout || "" }, usage: null }
  }
  if (Array.isArray(envelope)) {
    envelope = envelope.findLast((event) => event?.type === "result") || envelope.at(-1) || {}
  }
  const result = envelope.structured_output ?? envelope.result ?? envelope.content ?? envelope
  const modelUsage = envelope.modelUsage && typeof envelope.modelUsage === "object"
      ? Object.values(envelope.modelUsage).reduce((total, entry) => ({
        input_tokens: total.input_tokens
          + (entry.inputTokens || entry.input_tokens || 0)
          + (entry.cacheCreationInputTokens || entry.cache_creation_input_tokens || 0),
        cached_input_tokens: total.cached_input_tokens + (entry.cacheReadInputTokens || entry.cache_read_input_tokens || 0),
        output_tokens: total.output_tokens + (entry.outputTokens || entry.output_tokens || 0),
      }), { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 })
    : null
  const usage = envelope.usage
    ? {
        input_tokens: (envelope.usage.input_tokens || envelope.usage.inputTokens || 0)
          + (envelope.usage.cache_creation_input_tokens || 0),
        cache_creation_input_tokens: envelope.usage.cache_creation_input_tokens || 0,
        cached_input_tokens: envelope.usage.cache_read_input_tokens || envelope.usage.cached_input_tokens || 0,
        output_tokens: envelope.usage.output_tokens || envelope.usage.outputTokens || 0,
      }
    : modelUsage
  return { answer: parseEmbeddedObject(result), usage }
}

export async function runLiveAgent(runner, id, prompt, cwd, options = {}) {
  const invocation = buildRunnerInvocation(runner, prompt, options)
  const childEnv = { ...process.env }
  for (const key of [
    "CODEX_THREAD_ID",
    "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
    "CLAUDE_CODE_ENTRYPOINT",
  ]) delete childEnv[key]
  const run = await new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs || 180_000)
    child.on("close", (status, signal) => {
      clearTimeout(timer)
      resolve({ status, signal, stdout, stderr })
    })
  })
  const parsed = runner === "codex" ? parseCodexOutput(run.stdout) : parseClaudeOutput(run.stdout)
  return {
    id,
    runner,
    model: invocation.model,
    permissionProfile: invocation.permissionProfile,
    exitCode: run.status,
    signal: run.signal,
    usage: parsed.usage,
    answer: parsed.answer,
    stderr: run.stderr.trim().split("\n").filter(Boolean).slice(-8),
  }
}
