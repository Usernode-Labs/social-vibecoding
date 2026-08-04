import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { chromium } from "playwright"

import { PR_CASE_BASE_REVISION, PR_CASE_BRANCH_REVISION } from "./pr-case-tools.mjs"

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = path.resolve(frontendRoot, "..")
const outputRoot = path.join(repoRoot, "docs", "pr-case")
const slideRoot = path.join(outputRoot, "slides")
const imageRoot = path.join(outputRoot, "images")
const htmlPath = path.join(outputRoot, "index.html")
const pdfPath = path.join(outputRoot, "pr-case.pdf")

function sha256(fileName) {
  return crypto.createHash("sha256").update(fs.readFileSync(fileName)).digest("hex")
}

function artifact(fileName, kind, extra = {}) {
  const filePath = path.join(outputRoot, fileName)
  return { file: fileName, kind, bytes: fs.statSync(filePath).size, sha256: sha256(filePath), ...extra }
}

function imageData(fileName) {
  return `data:image/png;base64,${fs.readFileSync(path.join(outputRoot, fileName)).toString("base64")}`
}

fs.mkdirSync(slideRoot, { recursive: true })
fs.mkdirSync(imageRoot, { recursive: true })

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" })
  await page.addStyleTag({ content: "body{padding:0!important;display:block!important}.deck{gap:0!important}.deck-stage{position:static!important;display:block!important}.deck-frame{width:1600px!important;height:900px!important}.slide{box-shadow:none!important}.deck-hud,.lb{display:none!important}" })
  await page.evaluate(() => document.fonts.ready)
  const slideIds = await page.locator(".slide").evaluateAll((slides) => slides.map((slide) => slide.dataset.slideId))
  const layoutFailures = await page.locator(".slide").evaluateAll((slides) => {
    document.querySelectorAll(".deck-frame").forEach((frame) => { frame.style.display = "block"; frame.style.transform = "none" })
    slides.forEach((slide) => { slide.hidden = false })
    return slides.flatMap((slide) => {
      const bounds = slide.getBoundingClientRect()
      const content = slide.querySelector(":scope > .slide-content")?.getBoundingClientRect()
      const receipt = slide.querySelector(":scope > .receipt")?.getBoundingClientRect()
      const footer = slide.querySelector(":scope > footer")?.getBoundingClientRect()
      const contentOverlapsReceipt = content && receipt && content.bottom > receipt.top + 0.5
      const footerOverflows = footer && footer.bottom - bounds.top > slide.clientHeight + 0.5
      const visualOverflow = slide.scrollWidth > slide.clientWidth + 0.5 || slide.scrollHeight > slide.clientHeight + 0.5
      return contentOverlapsReceipt || footerOverflows || visualOverflow
        ? [{
            id: slide.dataset.slideId,
            contentBottom: content && content.bottom - bounds.top,
            receiptTop: receipt && receipt.top - bounds.top,
            footerBottom: footer && footer.bottom - bounds.top,
          }]
        : []
    })
  })
  if (layoutFailures.length) throw new Error(`slide layout overflow:\n${JSON.stringify(layoutFailures, null, 2)}`)
  const slideArtifacts = []
  for (const [index, id] of slideIds.entries()) {
    await page.evaluate((slideId) => {
      const slides = [...document.querySelectorAll(".slide")]
      slides.forEach((slide) => { slide.hidden = false })
      document.querySelectorAll(".deck-frame").forEach((frame) => {
        const ownsSlide = frame.querySelector(".slide")?.dataset.slideId === slideId
        frame.style.display = ownsSlide ? "block" : "none"
        frame.style.transform = "none"
      })
    }, id)
    const fileName = `slides/${String(index + 1).padStart(2, "0")}-${id}.png`
    await page.locator(`[data-slide-id="${id}"]`).screenshot({ path: path.join(outputRoot, fileName) })
    slideArtifacts.push(artifact(fileName, "slide-image", { slideId: id, width: 1600, height: 900 }))
  }

  await page.evaluate(() => {
    document.querySelectorAll(".slide").forEach((slide) => { slide.hidden = false })
    document.querySelectorAll(".deck-frame").forEach((frame) => { frame.style.display = "block"; frame.style.transform = "none" })
  })
  await page.emulateMedia({ media: "print" })
  await page.pdf({
    path: pdfPath,
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: false,
  })
  const pdfSource = fs.readFileSync(pdfPath).toString("latin1")
  const dateMatches = pdfSource.match(/D:\d{14}\+00'00'/g) || []
  if (dateMatches.length !== 2) throw new Error(`expected two PDF date fields, found ${dateMatches.length}`)
  fs.writeFileSync(pdfPath, Buffer.from(pdfSource.replaceAll(/D:\d{14}\+00'00'/g, "D:20260804000000+00'00'"), "latin1"))
  const pdfInfo = execFileSync("pdfinfo", [pdfPath], { encoding: "utf8" })
  const actualPdfPages = Number(/^Pages:\s+(\d+)$/m.exec(pdfInfo)?.[1])
  const pageSize = /^Page size:\s+([\d.]+) x ([\d.]+) pts$/m.exec(pdfInfo)
  const pdfAspect = pageSize ? Number(pageSize[1]) / Number(pageSize[2]) : null
  if (actualPdfPages !== slideIds.length || !pdfAspect || Math.abs(pdfAspect - 16 / 9) > 0.001) {
    throw new Error(`PDF inspection failed: pages=${actualPdfPages}, aspect=${pdfAspect}`)
  }

  const expectedSlideFiles = new Set(slideArtifacts.map((item) => path.basename(item.file)))
  for (const fileName of fs.readdirSync(slideRoot)) {
    if (fileName.endsWith(".png") && !expectedSlideFiles.has(fileName)) fs.unlinkSync(path.join(slideRoot, fileName))
  }

  const selected = {
    "token-authority-demo": "images/pr-case-token-authority.png",
    "lean-mechanical-loop": "images/pr-case-live-loop.png",
    "regression-caught": "images/pr-case-regression.png",
  }
  const selectedArtifacts = []
  for (const [slideId, destination] of Object.entries(selected)) {
    const source = slideArtifacts.find((item) => item.slideId === slideId)
    if (!source) throw new Error(`selected slide is missing: ${slideId}`)
    fs.copyFileSync(path.join(outputRoot, source.file), path.join(outputRoot, destination))
    selectedArtifacts.push(artifact(destination, "pull-request-image", { slideId, width: 1600, height: 900 }))
  }
  const staleCompatibilityImage = path.join(imageRoot, "pr-case-compatibility.png")
  if (fs.existsSync(staleCompatibilityImage)) fs.unlinkSync(staleCompatibilityImage)

  const comparisonPage = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })
  for (const theme of ["light", "dark"]) {
    const before = imageData(`images/home-before-${theme}.png`)
    const after = imageData(`images/home-after-${theme}.png`)
    await comparisonPage.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box}html,body{margin:0;width:1600px;height:900px;overflow:hidden}body{font-family:Arial,"Helvetica Neue",sans-serif;background:${theme === "dark" ? "#11110f" : "#fff"};color:${theme === "dark" ? "#f3f2ed" : "#181817"};padding:58px 64px 48px}header{display:flex;justify-content:space-between;align-items:end;border-bottom:1px solid ${theme === "dark" ? "#ffffff24" : "#d8d8d2"};padding-bottom:20px;margin-bottom:34px}h1{font-size:46px;line-height:1;margin:0;letter-spacing:-.035em}header span{font:14px ui-monospace,SFMono-Regular,Menlo,monospace;color:#888881}.pair{display:grid;grid-template-columns:1fr 1fr;gap:22px}figure{margin:0;border:1px solid ${theme === "dark" ? "#ffffff24" : "#d8d8d2"};border-radius:18px;overflow:hidden;background:#e9e9e5}img{display:block;width:100%;aspect-ratio:16/9;object-fit:contain}figcaption{font-size:18px;font-weight:700;padding:16px 20px;background:${theme === "dark" ? "#1b1b18" : "#fafaf8"}}footer{display:flex;justify-content:space-between;margin-top:24px;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;color:#888881}
    </style></head><body><header><h1>Home · ${theme} theme</h1><span>pinned comparison</span></header><main class="pair"><figure><img src="${before}" alt="Pinned main Home"><figcaption>main · ${PR_CASE_BASE_REVISION.slice(0, 12)}</figcaption></figure><figure><img src="${after}" alt="Integrated React Home"><figcaption>branch · ${PR_CASE_BRANCH_REVISION.slice(0, 12)}</figcaption></figure></main><footer><span>same fixture · 1280 × 720 sources</span><span>service workers blocked</span></footer></body></html>`, { waitUntil: "load" })
    await comparisonPage.evaluate(() => document.fonts.ready)
    const destination = `images/pr-case-compatibility-${theme}.png`
    await comparisonPage.screenshot({ path: path.join(outputRoot, destination), fullPage: false })
    selectedArtifacts.push(artifact(destination, "pull-request-image", { comparisonTheme: theme, width: 1600, height: 900 }))
  }
  await comparisonPage.close()

  const captureManifest = JSON.parse(fs.readFileSync(path.join(outputRoot, "capture-manifest.json"), "utf8"))
  const captureArtifacts = captureManifest.captures.map((capture) => artifact(capture.file, "capture-image", {
    width: capture.width,
    height: capture.height,
  }))

  const manifest = {
    schemaVersion: 1,
    revisions: { base: PR_CASE_BASE_REVISION, branch: PR_CASE_BRANCH_REVISION },
    viewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
    artifacts: [
      artifact("index.html", "self-contained-html"),
      artifact("README.md", "artifact-documentation"),
      artifact("claims.json", "claim-manifest"),
      artifact("capture-manifest.json", "capture-manifest"),
      artifact("capture-fixtures/README.md", "capture-fixture-documentation"),
      artifact("capture-fixtures/tailwind-play-2026-08-04.js.gz", "capture-fixture"),
      artifact("receipts/integration.json", "sanitized-gate-receipt"),
      artifact("pr-case.pdf", "portable-document", { pages: actualPdfPages, aspectRatio: pdfAspect }),
      ...captureArtifacts,
      ...slideArtifacts,
      ...selectedArtifacts,
    ],
  }
  const manifestPath = path.join(outputRoot, "artifact-manifest.json")
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const checksums = [
    ...manifest.artifacts.map((item) => `${item.sha256}  ${item.file}`),
    `${sha256(manifestPath)}  artifact-manifest.json`,
  ]
    .sort()
    .join("\n")
  fs.writeFileSync(path.join(outputRoot, "artifact-sha256.txt"), `${checksums}\n`)
  console.log(`Exported ${slideIds.length} slide images, ${selectedArtifacts.length} pull-request images, and a ${slideIds.length}-page PDF.`)
} finally {
  await browser.close()
}
