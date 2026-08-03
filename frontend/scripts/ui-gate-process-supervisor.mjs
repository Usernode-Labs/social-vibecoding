const SIGNAL_EXIT_CODES = {
  SIGINT: 130,
  SIGTERM: 143,
}

export function hasUnboundedTestTimeout(command) {
  return /--test-timeout(?:=|\s+)0(?:\s|$)/.test(command)
}

export function signalProcessTree(
  child,
  signal,
  { platform = process.platform, kill = process.kill } = {},
) {
  if (!Number.isInteger(child?.pid) || child.pid <= 0) return false
  try {
    if (platform === "win32") child.kill(signal)
    else kill(-child.pid, signal)
    return true
  } catch (cause) {
    if (cause?.code === "ESRCH") return false
    throw cause
  }
}

export function signalExitCode(signal) {
  return SIGNAL_EXIT_CODES[signal] || 1
}

export function createProcessSupervisor({
  graceMs,
  signalSource = process,
  platform = process.platform,
  kill = process.kill,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!Number.isInteger(graceMs) || graceMs < 1) {
    throw new Error("UI gate termination grace must be a positive integer")
  }

  const active = new Map()
  const handlers = new Map()
  let interruptedSignal = null

  function send(entry, signal) {
    try {
      return signalProcessTree(entry.child, signal, { platform, kill })
    } catch (cause) {
      entry.signalError = cause instanceof Error ? cause.message : String(cause)
      return false
    }
  }

  function terminate(entry, reason) {
    if (entry.reason) return
    entry.reason = reason
    entry.onTerminate?.(reason)
    send(entry, "SIGTERM")
    entry.forceTimer = setTimer(() => send(entry, "SIGKILL"), graceMs)
  }

  function track(child, { label, timeoutMs, onTerminate } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error(`UI gate stage ${label || "unknown"} needs a positive timeout`)
    }
    const entry = {
      child,
      label: label || "unknown",
      onTerminate,
      reason: null,
      signalError: null,
      forceTimer: null,
      deadlineTimer: null,
    }
    active.set(child, entry)
    entry.deadlineTimer = setTimer(() => terminate(entry, {
      type: "timeout",
      timeoutMs,
      label: entry.label,
    }), timeoutMs)
    if (interruptedSignal) terminate(entry, { type: "signal", signal: interruptedSignal })

    return {
      finish() {
        clearTimer(entry.deadlineTimer)
        if (entry.forceTimer) clearTimer(entry.forceTimer)
        active.delete(child)
        return entry.reason
          ? { ...entry.reason, ...(entry.signalError ? { signalError: entry.signalError } : {}) }
          : null
      },
    }
  }

  function interrupt(signal) {
    if (interruptedSignal) {
      for (const entry of active.values()) send(entry, "SIGKILL")
      return
    }
    interruptedSignal = signal
    for (const entry of active.values()) terminate(entry, { type: "signal", signal })
  }

  function install() {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => interrupt(signal)
      handlers.set(signal, handler)
      signalSource.on(signal, handler)
    }
  }

  function dispose({ terminateActive = false } = {}) {
    if (terminateActive) {
      for (const entry of active.values()) terminate(entry, { type: "runner-finalize" })
    }
    for (const [signal, handler] of handlers) signalSource.off(signal, handler)
    handlers.clear()
  }

  return {
    track,
    interrupt,
    install,
    dispose,
    get interruptedSignal() { return interruptedSignal },
    get activeCount() { return active.size },
  }
}
