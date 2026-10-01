# Migration simplification checkpoint

1 October 2026. Acceptance requires both demonstrated guarantees and removal of
replaced ownership/machinery. Another opt-in path alone is not migration progress.
Keep current protections until their replacement is proved. No production cutover
or deletion is authorized by this inventory.

| Temporary item | Intended replacement | Removal gate |
| --- | --- | --- |
| `native-preview-prepare`, `native-preview-template-prepare`, `native-preview-kpack-prepare` and their checkpoint branches | One complete recoverable native Kubernetes preparation contract | Prove actual clone → Build → runtime → separate activation/recovery; inventory and drain/finish retained old work. Do not reinterpret queued payloads. |
| Layered experiment admission flags (`nativePreviewAttempts`, worker/clone/build/runtime flags) | One bounded caller's supported admission policy | Complete-path proof and explicit caller cutover; confirm no caller or retained work depends on old flags. Keep admission and recovery ownership separate. |
| Frozen experimental reducer versions | Supported decision contract versions for retained traces/work | Audit real persisted versions and promised trace retention. Preserve replay where required; archive development-only history in Git/fixtures, not automatically in production runtime forever. |
| Long-held PostgreSQL staging/retention/lifecycle session locks (`advisory-locks.js`, `build-retention-guard.js`) and process-local queue (`staging.js`) | Proven attempt isolation, externally fenced database retirement, conditional activation and one durable execution owner | Complete-path/caller proof under interruption/overlap. Keep locks while any shared-resource/legacy writer needs them; partial resource isolation alone does not replace them. |
| Synchronous `staging.js` + `preview-flow/native.js` / `candidate-native.js` plus durable `preview-flow/work.js` | One preparation/publication owner for the selected caller | Cut over one real caller and remove its old dispatch/recovery path together; explicitly exclude other callers until their own cutovers. |
| `preview-flow/cleanup.start` and `build-retention` recovery timers plus durable `work.census` / `scripts/preview-preparation-worker.js` and `execution/service.js` | One discoverable, fair recovery owner per admitted contract | Inventory admitted work/resource locators and consumers; demonstrate worker restart/recovery before removing the selected owner's old timer. Do not orphan retained work. |
| C5 indefinite clone retention after Deployment submission (replaced in C6) | Existing clone ownership/retired-role/NOLOGIN/forced-drop fence | C6 proves connections, delayed Pods, lost replies/restarts and successor protection. Runtime creation obligations and retired roles remain discoverable; database release is not creator closure. |
| Role/runtime/Build tombstones and retained artifacts | Explicitly proven retention/compaction policy | No current expiry/removal gate. Elapsed time or absence is insufficient; preserve required identities and recovery ownership. |
| Injected Build/clone phases in C5 runtime proof | Complete actual preparation evidence | Next checkpoint after C6; remove reliance on injected evidence for the chosen real path, not the focused regression fixtures. |

Next sequence: finish C6 safe release → prove one complete real preparation path →
cut over one bounded caller and remove its duplicate ownership. Do not expand to
additional workflows before this replacement is demonstrated. Track the mechanisms
actually removed, retained compatibility obligations, and remaining guarantees.

Version review at C6: `reducer.js` uses v9 for live decisions and v1–v8 only for
historical replay. Explicit historical fixtures cover v1 (`preview-flow.test.js`),
v3/v4 (`preview-candidate.test.js`) and v8 (`recoverable-preview-runtime.test.js`).
v2/v5/v6/v7 have no separately named replay fixtures. None of these older versions
is a distinct live reducer selected by a caller. Canonical main at the recorded
revision lacks this experimental directory, and this session has not deployed it;
that is repository evidence, not an inventory of every retained deployment/trace.
Keep existing replay support during C6. Before cutover, inventory persisted
`preview_flow_decisions.reducer_version` and retained exported traces/work, then
choose supported versions and archive unsupported development-only versions with
their fixtures in Git. Do not infer safe removal from missing test coverage. C6
changes no reducer policy/action schema, so it adds no frozen reducer version.

Current `native-preview-kubernetes-prepare` and `native-preview-retire` remain the
selected experiment's preparation/recovery owners. Complete-path proof should
replace older preparation kinds for one caller; creator obligations must keep a
recovery owner until a separate closure/compaction contract is proved. B2/C2 reuse
is retained; further workflow expansion waits for the caller replacement above.
