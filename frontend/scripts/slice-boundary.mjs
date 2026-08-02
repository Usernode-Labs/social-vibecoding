import { spawnSync } from "node:child_process"

const CHECKPOINT_PREFIX = /^wip\(([a-z0-9][a-z0-9-]*)\):\s+.+/
const PRIVATE_CHECKPOINT_PREFIX = /^wip\(/
const EVENT_ID = /^[0-9a-f]{64}$/

function git(repoRoot, args, options = {}) {
  const run = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    input: options.input,
  })
  if (run.status !== 0) {
    const detail = (run.stderr || run.stdout || `git ${args.join(" ")} failed`).trim()
    throw new Error(detail)
  }
  return options.preserveOutput ? run.stdout : run.stdout.trim()
}

function optionalGit(repoRoot, args) {
  const run = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" })
  return run.status === 0 ? run.stdout.trim() : null
}

function requireCommit(repoRoot, ref, label) {
  try {
    return git(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`])
  } catch {
    throw new Error(`${label} is not a readable commit: ${ref}`)
  }
}

function configuredIdentity(repoRoot) {
  const name = optionalGit(repoRoot, ["config", "--get", "user.name"])
  const email = optionalGit(repoRoot, ["config", "--get", "user.email"])
  if (!name || !email) {
    throw new Error("repository-local git user.name and user.email are required")
  }
  return { name, email }
}

function meaningfulCheckpointBody(message) {
  const lines = message.split("\n").slice(1)
  const trailer = /^(?:Task|Plan-Step|Decision|Evidence|Origin-Buzz-Event|Co-authored-by|Signed-off-by):/
  return lines.some((line) => line.trim() && !trailer.test(line.trim()))
}

function checkpointLog(repoRoot, base, slice, identity) {
  const commits = git(repoRoot, ["rev-list", "--reverse", `${base}..HEAD`])
    .split("\n")
    .filter(Boolean)
  if (!commits.length) throw new Error(`slice ${slice} has no checkpoint commits after ${base}`)

  return commits.map((commit) => {
    const message = git(repoRoot, ["show", "--no-patch", "--format=%B", commit], {
      preserveOutput: true,
    }).replace(/\n+$/, "")
    const subject = message.split("\n", 1)[0]
    const match = subject.match(CHECKPOINT_PREFIX)
    if (!match || match[1] !== slice) {
      throw new Error(`checkpoint ${commit.slice(0, 12)} must start with wip(${slice}):`)
    }
    if (message.includes("\\n\\n")) {
      throw new Error(`checkpoint ${commit.slice(0, 12)} contains literal \\n\\n text; use real message newlines`)
    }
    for (const trailer of [
      `Co-authored-by: ${identity.name} <${identity.email}>`,
      `Signed-off-by: ${identity.name} <${identity.email}>`,
    ]) {
      if (!message.split("\n").includes(trailer)) {
        throw new Error(`checkpoint ${commit.slice(0, 12)} is missing ${trailer}`)
      }
    }
    const trailers = git(repoRoot, ["interpret-trailers", "--parse"], { input: message })
    if (!trailers.split("\n").includes(`Task: ${slice}`)) {
      throw new Error(`checkpoint ${commit.slice(0, 12)} needs final Task: ${slice}`)
    }
    if (!meaningfulCheckpointBody(message)) {
      throw new Error(`checkpoint ${commit.slice(0, 12)} needs a meaningful body`)
    }
    return { commit, message, subject }
  })
}

export function buildSliceCommitMessage({ subject, originEvent, checkpoints, identity, task }) {
  if (!subject?.trim() || subject.includes("\n")) {
    throw new Error("--subject must be one non-empty line")
  }
  if (!EVENT_ID.test(originEvent || "")) {
    throw new Error("--origin-event must be a 64-character lowercase hex event identifier")
  }
  if (!task?.trim() || task.includes("\n")) {
    throw new Error("task must be one non-empty line")
  }

  const checkpointSections = checkpoints.map((checkpoint, index) => [
    `--- checkpoint ${index + 1}: ${checkpoint.commit} ---`,
    checkpoint.message,
    `--- end checkpoint ${index + 1} ---`,
  ].join("\n"))

  return [
    subject.trim(),
    "",
    "Checkpoint log (oldest first; raw messages preserved):",
    "",
    checkpointSections.join("\n\n"),
    "",
    "Exact-commit verification is recorded after finalization in the UI gate timing artifact and the signed Buzz receipt keyed to this immutable commit.",
    "",
    `Task: ${task}`,
    `Origin-Buzz-Event: ${originEvent}`,
    `Co-authored-by: ${identity.name} <${identity.email}>`,
    `Signed-off-by: ${identity.name} <${identity.email}>`,
    "",
  ].join("\n")
}

export function resolvePublishBase(repoRoot, environment = process.env) {
  const explicit = environment.SLICE_PUBLISH_BASE?.trim()
  if (explicit) return requireCommit(repoRoot, explicit, "SLICE_PUBLISH_BASE")

  const upstream = optionalGit(repoRoot, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ])
  if (upstream) return requireCommit(repoRoot, upstream, "upstream")

  const parent = optionalGit(repoRoot, ["rev-parse", "--verify", "HEAD^"])
  return parent || null
}

export function wipCommitsInPublishRange(repoRoot, environment = process.env) {
  const base = resolvePublishBase(repoRoot, environment)
  const range = base ? `${base}..HEAD` : "HEAD"
  const output = git(repoRoot, ["log", "--format=%H%x09%s", range])
  return output.split("\n").filter(Boolean).flatMap((line) => {
    const separator = line.indexOf("\t")
    const commit = separator < 0 ? line : line.slice(0, separator)
    const subject = separator < 0 ? "" : line.slice(separator + 1)
    return PRIVATE_CHECKPOINT_PREFIX.test(subject) ? [{ commit, subject }] : []
  })
}

export function assertPublishableHistory(repoRoot, environment = process.env) {
  const checkpoints = wipCommitsInPublishRange(repoRoot, environment)
  if (checkpoints.length) {
    throw new Error([
      "publish range contains private checkpoint commits:",
      ...checkpoints.map(({ commit, subject }) => `- ${commit.slice(0, 12)} ${subject}`),
      "finalize the slice before running or publishing the boundary gate",
    ].join("\n"))
  }
}

export function finalizeSlice({ repoRoot, base, slice, subject, originEvent, dryRun = false, now = new Date() }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slice || "")) {
    throw new Error("--slice must use lowercase letters, numbers, and hyphens")
  }
  if (git(repoRoot, ["status", "--porcelain=v1"])) {
    throw new Error("slice finalization requires a clean working tree")
  }

  const baseCommit = requireCommit(repoRoot, base, "--base")
  const oldHead = requireCommit(repoRoot, "HEAD", "HEAD")
  if (optionalGit(repoRoot, ["merge-base", "--is-ancestor", baseCommit, oldHead]) === null) {
    throw new Error(`--base ${base} is not an ancestor of HEAD`)
  }
  if (baseCommit === oldHead) throw new Error("--base must precede at least one checkpoint")

  const branchRef = optionalGit(repoRoot, ["symbolic-ref", "--quiet", "HEAD"])
  if (!branchRef) throw new Error("slice finalization requires an attached branch")

  const identity = configuredIdentity(repoRoot)
  const checkpoints = checkpointLog(repoRoot, baseCommit, slice, identity)
  const message = buildSliceCommitMessage({ subject, originEvent, checkpoints, identity, task: slice })
  if (dryRun) {
    return { baseCommit, oldHead, branchRef, checkpoints, message, recoveryRef: null, newCommit: null }
  }

  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
  const recoveryRef = `refs/buzz/slice-recovery/${slice}/${timestamp}-${oldHead.slice(0, 12)}`
  git(repoRoot, ["check-ref-format", recoveryRef])
  git(repoRoot, ["update-ref", recoveryRef, oldHead])

  const tree = git(repoRoot, ["rev-parse", `${oldHead}^{tree}`])
  const newCommit = git(repoRoot, ["commit-tree", tree, "-p", baseCommit], { input: message })
  git(repoRoot, ["update-ref", branchRef, newCommit, oldHead])

  if (git(repoRoot, ["status", "--porcelain=v1"])) {
    throw new Error(`finalized commit ${newCommit} left the working tree dirty; recover from ${recoveryRef}`)
  }
  return { baseCommit, oldHead, branchRef, checkpoints, message, recoveryRef, newCommit }
}

export function parseFinalizeArguments(argv) {
  const values = new Map()
  let dryRun = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--dry-run") {
      dryRun = true
      continue
    }
    if (!["--base", "--slice", "--subject", "--origin-event"].includes(argument)) {
      throw new Error(`unknown finalizer argument: ${argument}`)
    }
    const value = argv[index + 1]
    if (!value) throw new Error(`${argument} requires a value`)
    values.set(argument, value)
    index += 1
  }
  for (const required of ["--base", "--slice", "--subject", "--origin-event"]) {
    if (!values.has(required)) throw new Error(`${required} is required`)
  }
  return {
    base: values.get("--base"),
    slice: values.get("--slice"),
    subject: values.get("--subject"),
    originEvent: values.get("--origin-event"),
    dryRun,
  }
}
