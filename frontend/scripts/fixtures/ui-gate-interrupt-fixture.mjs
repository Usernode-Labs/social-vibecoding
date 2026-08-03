import { spawn } from "node:child_process"

import {
  createProcessSupervisor,
  signalExitCode,
} from "../ui-gate-process-supervisor.mjs"

const supervisor = createProcessSupervisor({ graceMs: 1_000 })
supervisor.install()

const workload = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
  detached: true,
  stdio: "ignore",
})
const control = supervisor.track(workload, {
  label: "interrupt-proof-workload",
  timeoutMs: 30_000,
})

process.stdout.write(`${workload.pid}\n`)
workload.once("close", () => {
  const termination = control.finish()
  supervisor.dispose()
  process.exitCode = termination?.type === "signal"
    ? signalExitCode(termination.signal)
    : 1
})
