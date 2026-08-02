# Commit message grammar (draft for docs/commit-grammar.md)

Blessed by Cyrcle_0 (fe-cleanup event 4089afe3, 2026-08-02: "tooling has my blessing"). Design thread: tooling channel, root 404fa98f. Author: lead-claude. Lands via lead-codex under one-writer rule.

## Why this exists

Long-running agent tasks must be readable after the fact from git alone — no message platform required. The task-log reader joins commits to plan steps and recovery checkpoints; this grammar is the contract that makes those joins mechanical instead of heuristic.

## Grammar

Every commit message has three parts, in order:

### 1. Subject — one sentence, at most 72 characters

Imperative mood, states the observable change, no trailing period. This is the line every log tool shows; it must survive alone.

### 2. Body — free prose

What changed and why, constraints honored, evidence gathered. No format constraints. Write for the reviewer who arrives six months late.

### 3. Trailer block — the FINAL paragraph, nothing after it

One `Key: value` per line, no blank lines inside the block. Recognized keys:

| Key | Required | Meaning |
|-----|----------|---------|
| `Task:` | **mandatory** | Slice or task identity. When a recovery checkpoint exists, must equal the `<slice>` segment of `refs/buzz/slice-recovery/<slice>/...` |
| `Plan-Step:` | optional | Anchor into `docs/plan.md` (manager-altitude plan file) |
| `Decision:` | optional, repeatable | A decision point made in this commit, one line each |
| `Evidence:` | optional, repeatable | Path or artifact identifier backing the claim (gate artifact, screenshot, spec) |
| `Origin-Buzz-Event:` | optional | Message-platform event id that authorized or triggered the work |

**Placement is load-bearing.** A trailer written as the first body paragraph is invisible to git's trailer parser (`git log --format=%(trailers)` returns nothing) — this defect was observed in real history on this machine. The block must be the final paragraph, exactly where `git interpret-trailers` expects it.

## Hook — three checks, commit-msg stage

Reject the commit unless all three hold:

1. Subject line is at most 72 characters.
2. `git interpret-trailers --parse` over the message yields at least one trailer, and the trailer block is the final paragraph (no non-trailer text after it).
3. A `Task:` trailer is present and non-empty.

Nothing else is validated — body stays free. Existing history is never rewritten; the hook governs new commits only.

## Plan file

`docs/plan.md` is the manager-altitude plan: numbered steps with stable anchors that `Plan-Step:` trailers reference. The channel canvas remains lead-altitude working state; the plan file is the durable, in-repo view the reader renders against. The reader resolves `Plan-Step` → plan anchor and `Task` → `refs/buzz/slice-recovery/<slice>` checkpoints to produce plan-versus-progress from git alone.
