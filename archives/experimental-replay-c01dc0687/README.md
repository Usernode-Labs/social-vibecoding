# Offline experimental replay archive

Producing revision: `c01dc0687f0075a0591a3b7540ad4765e7d176e0`.
This directory is self-contained. Copy it anywhere, then run with Node.js:

```sh
node replay.cjs --verify
node replay.cjs preview-flow < exported-traces.jsonl
node replay.cjs cli-preview-handoff < exported-traces.jsonl
node replay.cjs proposal-review < exported-traces.jsonl
```

No checkout, npm install, database, credentials or network is needed. Verified on
Node `v24.19.0`. The runner checks artifact and individual source SHA-256 hashes
before loading the archived reducers and their frozen dependencies.

- Preview reducer versions 1–10, CLI versions 1–3, review versions 1–2.
  The final versions snapshot the accepted producing revision too.
- Exact replay dependency bytes, including CLI v2's enabling conditions/actions,
  schemas, encryption module, Zod `3.25.76` CommonJS closure and license. The
  original package/lock files record dependency provenance; no dependency install
  is needed. Node's `crypto`/`util` are the only permitted builtin dependencies.
- Nine original historical golden assertions exported while all five producing
  suites passed (134 tests, no skips). Full original test sources are archived.
  These are test traces, not recovered production or external-store exports.
- 139 additional current-version test traces exported before pruning, for
  independent replay of the producing revision.
- Five **synthetic version witnesses** for preview v2/v5/v6/v7 and review v1,
  clearly labeled in `goldens.jsonl`. They prove executable dependency closure,
  not historical behavioral coverage that never existed.
- Original partial-work/staging sources and helper tests remain provenance
  snapshots. Their PostgreSQL/Kubernetes integration tests are **not** runnable
  in this offline archive; replay cannot create or delete external resources.
  The lazy Kubernetes recipe selector is unreachable during replay and unavailable.

`sources.json.gz` stores exact file bytes as base64 keyed by original path.
`manifest.json` records every source hash and executable artifact hash.
`goldens.jsonl` contains input states/actions/facts, versions and expected outputs.
Current reducers, action receipt retries and supported work execute in the live
runtime; it never imports this archive. Unsupported stores must be inventoried,
exported and reconciled before replacement. Archive replay does not drain work.
