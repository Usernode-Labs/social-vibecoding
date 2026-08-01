const ENVIRONMENT_SIGNATURES = [
  { reason: "address-in-use", pattern: /EADDRINUSE|address already in use/i },
  { reason: "bind-denied", pattern: /listen (?:EACCES|EPERM)|operation not permitted.*(?:listen|bind)/i },
  { reason: "web-server-timeout", pattern: /Timed out waiting \d+ms from config\.webServer/i },
  { reason: "browser-launch", pattern: /browserType\.launch|Executable doesn't exist|Failed to launch browser/i },
]

export function classifyGateFailure({ gate, stdout = "", stderr = "", override = "" }) {
  if (override.trim()) {
    return { class: override.trim(), reason: "operator-override", source: "operator" }
  }

  const output = `${stdout}\n${stderr}`
  const environment = ENVIRONMENT_SIGNATURES.find(({ pattern }) => pattern.test(output))
  if (environment) {
    return { class: "environment", reason: environment.reason, source: "output-signature" }
  }

  const kind = gate.kind || "check"
  if (kind === "test") return { class: "test", reason: "test-command-exit", source: "stage-kind" }
  if (kind === "build") return { class: "build", reason: "build-command-exit", source: "stage-kind" }
  return { class: "check", reason: "check-command-exit", source: "stage-kind" }
}
