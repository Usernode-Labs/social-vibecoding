import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { once } from "node:events"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

import {
  createProcessSupervisor,
  hasUnboundedTestTimeout,
  signalExitCode,
  signalProcessTree,
} from "./ui-gate-process-supervisor.mjs"

function timerHarness() {
  const timers = new Map()
  let nextId = 1
  return {
    timers,
    setTimer(callback, delay) {
      const id = nextId
      nextId += 1
      timers.set(id, { callback, delay })
      return id
    },
    clearTimer(id) { timers.delete(id) },
  }
}

test("signals the complete POSIX process group and falls back on Windows", () => {
  const sent = []
  assert.equal(signalProcessTree({ pid: 42 }, "SIGTERM", {
    platform: "darwin",
    kill: (pid, signal) => sent.push([pid, signal]),
  }), true)
  const childSignals = []
  assert.equal(signalProcessTree({ pid: 43, kill: (signal) => childSignals.push(signal) }, "SIGKILL", {
    platform: "win32",
  }), true)
  assert.deepEqual(sent, [[-42, "SIGTERM"]])
  assert.deepEqual(childSignals, ["SIGKILL"])
  assert.equal(signalExitCode("SIGINT"), 130)
  assert.equal(signalExitCode("SIGTERM"), 143)
})

test("detects both forms of an unbounded Node test timeout", () => {
  assert.equal(hasUnboundedTestTimeout("node --test --test-timeout=0 example.test.mjs"), true)
  assert.equal(hasUnboundedTestTimeout("node --test --test-timeout 0 example.test.mjs"), true)
  assert.equal(hasUnboundedTestTimeout("node --test --test-timeout=30000 example.test.mjs"), false)
})

test("bounds a stage with TERM then KILL and clears supervision on close", () => {
  const timer = timerHarness()
  const sent = []
  const terminations = []
  const supervisor = createProcessSupervisor({
    graceMs: 5_000,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    platform: "darwin",
    kill: (pid, signal) => sent.push([pid, signal]),
  })
  const control = supervisor.track({ pid: 51 }, {
    label: "browser-matrix",
    timeoutMs: 20_000,
    onTerminate: (reason) => terminations.push(reason),
  })
  assert.equal(supervisor.activeCount, 1)
  const deadline = [...timer.timers.values()].find(({ delay }) => delay === 20_000)
  deadline.callback()
  assert.deepEqual(sent, [[-51, "SIGTERM"]])
  assert.deepEqual(terminations, [{ type: "timeout", timeoutMs: 20_000, label: "browser-matrix" }])
  const force = [...timer.timers.values()].find(({ delay }) => delay === 5_000)
  force.callback()
  assert.deepEqual(sent.at(-1), [-51, "SIGKILL"])
  assert.deepEqual(control.finish(), { type: "timeout", timeoutMs: 20_000, label: "browser-matrix" })
  assert.equal(supervisor.activeCount, 0)
  assert.equal(timer.timers.size, 0)
})

test("one interrupt stops every active stage and a repeated signal escalates", () => {
  const timer = timerHarness()
  const source = new EventEmitter()
  const sent = []
  const supervisor = createProcessSupervisor({
    graceMs: 5_000,
    signalSource: source,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    platform: "linux",
    kill: (pid, signal) => sent.push([pid, signal]),
  })
  const first = supervisor.track({ pid: 61 }, { label: "first", timeoutMs: 20_000 })
  const second = supervisor.track({ pid: 62 }, { label: "second", timeoutMs: 20_000 })
  supervisor.install()
  source.emit("SIGINT")
  assert.deepEqual(sent, [[-61, "SIGTERM"], [-62, "SIGTERM"]])
  source.emit("SIGINT")
  assert.deepEqual(sent.slice(-2), [[-61, "SIGKILL"], [-62, "SIGKILL"]])
  assert.deepEqual(first.finish(), { type: "signal", signal: "SIGINT" })
  assert.deepEqual(second.finish(), { type: "signal", signal: "SIGINT" })
  supervisor.dispose()
  assert.equal(source.listenerCount("SIGINT"), 0)
  assert.equal(source.listenerCount("SIGTERM"), 0)
})

test("runner finalization cannot abandon an active process group", () => {
  const timer = timerHarness()
  const sent = []
  const supervisor = createProcessSupervisor({
    graceMs: 5_000,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    platform: "darwin",
    kill: (pid, signal) => sent.push([pid, signal]),
  })
  const control = supervisor.track({ pid: 71 }, { label: "orphan-risk", timeoutMs: 20_000 })
  supervisor.dispose({ terminateActive: true })
  assert.deepEqual(sent, [[-71, "SIGTERM"]])
  assert.deepEqual(control.finish(), { type: "runner-finalize" })
})

test("a stage tracked after an interrupt is stopped immediately", () => {
  const timer = timerHarness()
  const sent = []
  const supervisor = createProcessSupervisor({
    graceMs: 5_000,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    platform: "darwin",
    kill: (pid, signal) => sent.push([pid, signal]),
  })
  supervisor.interrupt("SIGTERM")
  const control = supervisor.track({ pid: 81 }, { label: "late-stage", timeoutMs: 20_000 })
  assert.deepEqual(sent, [[-81, "SIGTERM"]])
  assert.deepEqual(control.finish(), { type: "signal", signal: "SIGTERM" })
})

test("a real operating-system interrupt tears down the owned process group", {
  skip: process.platform === "win32" ? "POSIX process-group proof" : false,
  timeout: 10_000,
}, async () => {
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/ui-gate-interrupt-fixture.mjs")
  const helper = spawn(process.execPath, [fixture], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  let workloadPid = null
  try {
    const workloadLine = await new Promise((resolve, reject) => {
      let output = ""
      helper.stdout.setEncoding("utf8")
      helper.stdout.on("data", (chunk) => {
        output += chunk
        const newline = output.indexOf("\n")
        if (newline !== -1) resolve(output.slice(0, newline))
      })
      helper.once("error", reject)
      helper.once("exit", (code) => reject(new Error(`interrupt fixture exited before readiness with ${code}`)))
    })
    workloadPid = Number(workloadLine)
    assert.equal(Number.isInteger(workloadPid), true)
    process.kill(helper.pid, "SIGINT")
    const [exitCode, signal] = await once(helper, "exit")
    assert.equal(exitCode, 130)
    assert.equal(signal, null)
    assert.throws(() => process.kill(workloadPid, 0), { code: "ESRCH" })
  } finally {
    if (helper.exitCode === null && helper.signalCode === null) helper.kill("SIGKILL")
    if (Number.isInteger(workloadPid)) {
      try { process.kill(-workloadPid, "SIGKILL") } catch (cause) {
        if (cause?.code !== "ESRCH") throw cause
      }
    }
  }
})
