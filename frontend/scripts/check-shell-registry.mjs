import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const frontendRoot = process.cwd()
const committed = path.join(frontendRoot, "public", "r")
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "usernode-shell-registry-"))
const generated = path.join(temporaryRoot, "r")

function filesIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name)
    return entry.isDirectory() ? filesIn(filePath) : [filePath]
  })
}

try {
  execFileSync("npx", ["shadcn", "build", "--output", generated], {
    cwd: frontendRoot,
    stdio: "pipe",
  })
  const expectedFiles = filesIn(generated).map((file) => path.relative(generated, file)).sort()
  const actualFiles = fs.existsSync(committed)
    ? filesIn(committed).map((file) => path.relative(committed, file)).sort()
    : []
  if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) {
    throw new Error("public/r file set is stale; run npm run build:registry")
  }
  for (const relative of expectedFiles) {
    const expected = fs.readFileSync(path.join(generated, relative), "utf8")
    const actual = fs.readFileSync(path.join(committed, relative), "utf8")
    if (expected !== actual) throw new Error(`public/r/${relative} is stale; run npm run build:registry`)
  }
  for (const relative of expectedFiles.filter((file) => file !== "registry.json")) {
    execFileSync("npx", ["shadcn", "add", `./public/r/${relative}`, "--dry-run"], {
      cwd: frontendRoot,
      stdio: "pipe",
    })
  }
  console.log(`Shell registry check passed: ${expectedFiles.length - 1} CLI-installable owned components are current.`)
} catch (error) {
  console.error(`Shell registry check failed:\n\n- ${error.message}`)
  process.exitCode = 1
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
}
