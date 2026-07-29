import { readFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { gzipSync } from "node:zlib"

const dist = path.resolve(import.meta.dirname, "../../public/react")
const html = await readFile(path.join(dist, "index.html"), "utf8")
const entryMatch = html.match(/src="\/react\/(assets\/index-[^"]+\.js)"/)

if (!entryMatch) throw new Error("Could not find the React entry asset in public/react/index.html")

const entry = await readFile(path.join(dist, entryMatch[1]))
const bytes = gzipSync(entry).byteLength
const maxBytes = 160 * 1024

if (bytes > maxBytes) {
  throw new Error(`Initial React bundle is ${(bytes / 1024).toFixed(1)} KiB gzip; budget is ${(maxBytes / 1024).toFixed(0)} KiB.`)
}

process.stdout.write(`Initial React bundle: ${(bytes / 1024).toFixed(1)} KiB gzip (budget ${(maxBytes / 1024).toFixed(0)} KiB).\n`)
