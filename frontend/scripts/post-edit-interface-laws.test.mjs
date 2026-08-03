import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  governedFilesFromHookInput,
  reviewHookInput,
  runHook,
} from "./post-edit-interface-laws.mjs"

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = path.resolve(frontendRoot, "..")
const themeSwitcher = path.join(frontendRoot, "@", "components", "theme-switcher.tsx")
const acceptedWarningFixture = path.join(frontendRoot, "@", "features", "account", "settings.tsx")

test("Codex apply_patch input selects governed files and ignores stories", () => {
  const files = governedFilesFromHookInput({
    cwd: repoRoot,
    tool_name: "apply_patch",
    tool_input: {
      command: "*** Begin Patch\n*** Update File: frontend/@/components/theme-switcher.tsx\n*** Update File: frontend/@/components/theme-switcher.stories.tsx\n*** End Patch",
    },
  })
  assert.deepEqual(files, [themeSwitcher])
})

test("Claude Edit and Write input selects an absolute governed file", () => {
  assert.deepEqual(governedFilesFromHookInput({
    cwd: repoRoot,
    tool_name: "Edit",
    tool_input: { file_path: themeSwitcher },
  }), [themeSwitcher])
})

test("non-governed edits produce no hook response", () => {
  assert.equal(reviewHookInput({
    cwd: repoRoot,
    tool_name: "Write",
    tool_input: { file_path: path.join(repoRoot, "README.md") },
  }), null)
})

test("per-edit response injects warning-first context for the editing agent", () => {
  const response = reviewHookInput({
    cwd: repoRoot,
    tool_name: "Edit",
    tool_input: { file_path: acceptedWarningFixture },
  })
  assert.equal(response?.hookSpecificOutput?.hookEventName, "PostToolUse")
  assert.match(response?.hookSpecificOutput?.additionalContext || "", /Interface law per-edit scan checked 1 governed file/)
  assert.match(response?.hookSpecificOutput?.additionalContext || "", /Accepted warning/)
})

test("malformed hook input stays warning-first instead of blocking the completed edit", () => {
  const response = runHook("{")
  assert.match(response?.hookSpecificOutput?.additionalContext || "", /failed without blocking/)
})
