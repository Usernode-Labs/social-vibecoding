# Reading a shots agent timeout

The owner-only before/after run trace records `agentActivity` while the
shots agent works, including before the turn exits. Its `budgetMs` records the *effective*
configured agent budget. The default is 480,000 ms (8 minutes); an
environment override can change it. The run's default recovery window is 1,440,000 ms (24 minutes).

Before model exploration, `auth_bootstrap` records one fixed-shape event for
each persona and revision. `responseStatus`, `sessionCookieInstalled`, and
`sessionCookiePresent` show whether the private preview accepted its
app-scoped identity and the shots agent's browser retained the resulting
session.
The trace never contains the identity token, cookie, URL, or page content.
An HTTP preview that issues a Secure session cookie needs the explicit
private-context exchange; otherwise the shots agent sees a sign-in screen.

For a timeout, look at the last `events` and the three pending lists:

| Trace field | What it measures | A long pending item suggests |
| --- | --- | --- |
| `pendingProviderRequests` | Time inside the Codex/OpenRouter request adapter, with 15-second progress marks | `await_headers`: provider or network wait; `await_first_byte`: model has sent headers but no output yet; `streaming`: output started but has not finished. Compare byte and chunk counts between marks to see whether the stream is still advancing. |
| `pendingBrowserCalls` | Actual Playwright MCP call time, with 15-second progress marks | Browser navigation, page loading, action, or snapshot is taking time. The tool name and base/head side identify the operation. |
| `pendingDocumentRequests` | In-flight HTTP document loads through the shots origin proxy | The preview app may be slow to serve the page. This is available for HTTP document requests; HTTPS CONNECT is opaque to the proxy. |

Completed `provider_request_end`, `browser_call_end`, and `document_response`
events report durations and outcomes. Provider events also mark response headers
and first byte separately. A sequence of short successful browser calls followed
by a long `provider_request_pending` points to model time. A long
`browser_call_pending` with an unfinished document request points to page or
browser time. If neither boundary has a pending call while the turn remains
active, inspect the last model tool event and runner phase: the gap is in the
agent process between calls, and the trace alone cannot prove what it was
thinking. Compare those events with `agent_deadline` and `worker_stop_requested`
to distinguish the platform's timeout from an external interruption.

`routeHint` reports whether a browser navigation matches an accepted intent
start or a declared check, with only an ordinal for its route. Browser result
shape counts headings, buttons, links, image blocks, and response size. These
fields help spot repeated navigation or a blank/error page without retaining
URLs, page text, prompts, model output, credentials, or screenshots in the
diagnostic trace. The shots themselves remain the place for human review.

These counters diagnose the *next* run. They do not retroactively explain an
older timeout, and longer budgets do not by themselves repair a stuck model,
browser, or preview app.

## When the shots agent's process dies

A turn that ends without the runner's exit marker was killed, or vanished
with its container. The worker then records why, from fixed values, and the
run keeps it: the failed dispatch in `agentDispatches` carries `exitCode`
(`-1` for no marker) and `exitCause`, and the failure's `detail` repeats
them. The admin shots-runs export has them as `agent_exit_code` and
`agent_exit_cause`.

| `exitCause` | What the worker saw |
| --- | --- |
| `oom_killed` | The worker container was killed for running out of memory during this turn |
| `container_gone` | The worker container stopped or disappeared |
| `turn_process_gone` | The container kept running, but the turn's processes were gone with no exit marker |
| `probe_unobservable` | The worker could not be asked whether the turn was still running |

For `oom_killed`, `container_gone` and `turn_process_gone` the run
dispatches the agent once more, with the budget that is left (at least a
minute), so `agentDispatches` then has two entries; the second one's outcome
is the run's. The admin connector's `list_recent_shots` reports the last
failed dispatch of a failed run as `agentExit` (`code`, `exitCode`,
`exitCause`).

`workerMemory` summarises the worker's memory, which the shots proxy samples
every 5 seconds (`worker/shots-memory.js`):
- `limitMb` and `peakUsedMb`: the memory limit and the most the worker used.
- `lastUsedMb`: the last sample, the nearest to a sudden death.
- `oomKillsDuringTurn`: how many processes the kernel killed for memory since the first sample.
- `peakRssMb`: the most the browsers, the agent, the browser tool servers (`mcp`), the proxy and everything else each held.

A last sample near the limit, or kills during the turn, says that memory ran
out. The export has these as the `worker_memory_*` and `worker_oom_kills`
columns. `peakRssMb` adds up each process's resident memory, so memory that
processes share (Chromium's above all) is counted once per process. Its sum
can be several times the container's own figure: compare the classes with
each other, and use `peakUsedMb` for how close the worker came to its limit.

The shots agent works in the proposal's own worker, and a merge retires that
worker and its volume. A run holds the worker while it runs
(`worker.holdWorker`), so a merge in the middle of a run is carried out when
the run ends (`worker.retireWorker`), not under the agent. Before that, a
merge mid-run showed up as `container_gone` about 30 seconds after the merge,
when Kubernetes' grace period for the deleted pod ran out. The 2026-10-02
export had five such deaths. Withdrawing, pausing or moving a proposal back
still stops its worker at once: shots of a change that is no longer up for a
vote are not needed.

`agentActivity.egressBlocked` counts the destinations the shots proxy refused,
by reason and kind of host: for example `private_address:pair_host` (the pair's own
host on another port or scheme, such as a browser trying `https://` first),
`dns:other` or `private_address:loopback`. The export's
`egress_blocked_json` has the same counts. The trace never names a
destination.
