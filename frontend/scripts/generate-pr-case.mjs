import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import zlib from "node:zlib"

import { PNG } from "pngjs"

import { buildReviewerDeck } from "./pr-case-deck.mjs"
import { buildTokenDemo, collectPrCaseEvidence, PR_CASE_BASE_REVISION, PR_CASE_BRANCH_REVISION } from "./pr-case-tools.mjs"

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = path.resolve(frontendRoot, "..")
const outputRoot = path.join(repoRoot, "docs", "pr-case")
const checkOnly = process.argv.includes("--check")
const expectedLegacyEquivalencePaths = [
  "public/index.html",
  "public/css/app.css",
  "public/js/app.js",
  "public/js/home.js",
  "public/js/theme.js",
  "public/js/browse.js",
  "public/usernode-native/v1/native.css",
  "public/usernode-native/v1/native.js",
]

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function imageData(fileName) {
  const buffer = fs.readFileSync(path.join(outputRoot, fileName))
  return `data:image/png;base64,${buffer.toString("base64")}`
}

function receipt(claim) {
  return `<aside class="receipt" aria-label="Receipt ${claim.id}">
    <div class="receipt-id">${claim.id}</div>
    <div class="receipt-body">
      <p>${escapeHtml(claim.statement)}</p>
      <code>${escapeHtml(claim.command)}</code>
    </div>
  </aside>`
}

function frame({ id, eyebrow, title, body, claim, theme = "light" }, index) {
  return `<section class="slide ${theme}" data-slide-id="${id}" data-slide-index="${index}" aria-label="${escapeHtml(title)}">
    <header class="slide-head">
      <span class="eyebrow">${escapeHtml(eyebrow)}</span>
      <span class="slide-number">${String(index).padStart(2, "0")}</span>
    </header>
    <div class="slide-content">
      <h1>${escapeHtml(title)}</h1>
      ${body}
    </div>
    ${receipt(claim)}
    <footer><span>main ${PR_CASE_BASE_REVISION.slice(0, 8)}</span><span>branch ${PR_CASE_BRANCH_REVISION.slice(0, 8)}</span><span>${id}</span></footer>
  </section>`
}

function appendixPage(claims, index, total) {
  return `<section class="slide appendix" data-slide-id="appendix-${index}" aria-label="Reproduce commands ${index} of ${total}">
    <header class="slide-head"><span class="eyebrow">Appendix · reproduce, do not trust</span><span class="slide-number">A${index}</span></header>
    <div class="appendix-grid">
      ${claims.map((claim) => `<article>
        <div class="appendix-title"><strong>${claim.id}</strong><span>${escapeHtml([...new Set(claim.metrics.map((metric) => metric.unit))].join(" · "))}</span></div>
        <p>${escapeHtml(claim.statement)}</p>
        <pre>${escapeHtml(claim.command)}</pre>
        <small>${claim.sources.map(escapeHtml).join(" · ")}</small>
      </article>`).join("")}
    </div>
    <footer><span>base ${PR_CASE_BASE_REVISION}</span><span>branch ${PR_CASE_BRANCH_REVISION}</span></footer>
  </section>`
}

function buildHtml(evidence, captureManifest) {
  const claim = Object.fromEntries(evidence.claims.map((item) => [item.id, item]))
  const facts = evidence.facts
  const tokenDemo = buildTokenDemo()
  const beforeLight = imageData("images/home-before-light.png")
  const afterLight = imageData("images/home-after-light.png")
  const beforeDark = imageData("images/home-before-dark.png")
  const afterDark = imageData("images/home-after-dark.png")
  const slides = [
    frame({
      id: "main-partial-centralization", eyebrow: "The pull-request case · 01", title: "Two rewrites. One repository.", claim: claim.R1,
      body: `<div class="hero-grid"><div><p class="lead">Main already centralized platform color, but still compiles interface utilities in the browser.</p><div class="big-stat">${facts.base.tailwindHtmlPages}<span>HTML pages still load the compiler</span></div></div><div class="ladder"><div>Scattered palette</div><div class="active">Central palette</div><div>Generated tokens</div><div>Governed components</div><div>Rendered proof</div></div></div>`,
    }, 1),
    frame({
      id: "token-authority-demo", eyebrow: "Authority · 02", title: "A token edit propagates. A broken ladder does not.", claim: claim.R2, theme: "ink",
      body: `<div class="demo-grid"><article><span class="tag good">accepted edit</span><h2>${escapeHtml(tokenDemo.validEdit)}</h2><pre>${escapeHtml(tokenDemo.propagatedLine)}</pre><div class="swatch"></div></article><article><span class="tag bad">refused edit</span><h2>${escapeHtml(tokenDemo.invalidEdit)}</h2><pre>${escapeHtml(tokenDemo.rejection)}</pre><div class="guard-mark">×</div></article></div><p class="caption">The generator and guard run in a temporary working directory. Canonical files stay untouched. Token source SHA-256: ${tokenDemo.canonicalSha256.slice(0, 16)}…</p>`,
    }, 2),
    frame({
      id: "verification-files", eyebrow: "Verification · 03", title: "The root test inventory stayed intact.", claim: claim.R3,
      body: `<div class="compare"><article><span>pinned main</span><strong>${facts.base.rootNodeTestFiles}</strong><p>root Node test files</p></article><div class="arrow">→</div><article class="accent"><span>integrated branch</span><strong>${facts.branch.rootNodeTestFiles}</strong><p>root Node test files</p></article></div><p class="lead narrow">All ${facts.branch.retainedBaseTestFiles} pinned-main paths remain, zero were removed, and the integration receipt records ${facts.gate.serverTestsPassed} passing root tests.</p>`,
    }, 3),
    frame({
      id: "verification-category", eyebrow: "Verification · 04", title: "Stories and gate stages are different units.", claim: claim.R4, theme: "ink",
      body: `<div class="unit-grid"><article><strong>${facts.branch.storyFiles}</strong><h2>story files</h2><p>isolated presentation states</p></article><article><strong>${facts.gate.stages}</strong><h2>gate stages</h2><p>the complete integration contract</p></article></div><p class="callout">Not “${facts.gate.stages} rendered assertions.” The unit matters because the gate includes tests, builds, budgets, policy, and Storybook.</p>`,
    }, 4),
    frame({
      id: "surface-grammar", eyebrow: "Grammar · 05", title: "The interface has an inventory, not a mood board.", claim: claim.R5,
      body: `<div class="catalog"><div class="catalog-total"><strong>${facts.branch.catalogComponents}</strong><span>catalog components</span></div><div class="tier"><strong>${facts.branch.catalogTiers.element}</strong><span>elements</span></div><div class="tier"><strong>${facts.branch.catalogTiers.block}</strong><span>blocks</span></div><div class="tier"><strong>${facts.branch.catalogTiers.feature}</strong><span>features</span></div></div><div class="flow"><span>tokens.json</span><b>→</b><span>catalog.json</span><b>→</b><span>stories + routes</span><b>→</b><span>gate</span></div>`,
    }, 5),
    frame({
      id: "legacy-interface-loop", eyebrow: "Before generation · 06", title: "Pinned main had no component-isolated story surface.", claim: claim.R6,
      body: `<div class="loop old"><div class="node">HTML + scripts</div><div class="edge">root behavior</div><div class="node">${facts.base.rootNodeTestFiles} test files</div><div class="edge broken">isolated-state gap</div><div class="node ghost">${facts.base.componentStoryFiles} story files</div></div><p class="lead narrow">The root inventory proves behavior coverage. Zero story files means pinned main had no component-isolated Storybook presentation states; this claim does not infer that appearance was never asserted elsewhere.</p>`,
    }, 6),
    frame({
      id: "lean-mechanical-loop", eyebrow: "The live loop · 07", title: "Teach just enough. Check everything mechanical.", claim: claim.R7, theme: "ink",
      body: `<div class="two-halves"><article><span class="tag">before generation</span><h2>Progressively reveal the law</h2><ul><li>Always loaded: ${facts.context.alwaysLoadedBytes} / ${facts.context.alwaysLoadedRatchetBytes} bytes</li><li>Query the catalog instead of bulk-reading it</li><li>Route task-specific guidance on demand</li></ul></article><article><span class="tag">after generation</span><h2>Block what machines can prove</h2><ul><li>Component route: ${facts.context.componentReviewBytes} / ${facts.context.componentReviewRatchetBytes} bytes</li><li>Owner ceiling: ${facts.context.ownerCeilingBytes} bytes</li><li>Tests, lint, policy, builds, rendered evidence</li></ul></article></div><p class="callout">Mechanical checks preserve attention for judgment. The harness is scaffolding, not the building.</p>`,
    }, 7),
    frame({
      id: "harness-integrity", eyebrow: "After generation · 08", title: "One immutable source. Every stage visible.", claim: claim.R8,
      body: `<div class="gate"><strong>${facts.gate.passed}/${facts.gate.stages}</strong><span>gate stages passed</span><div class="gate-track">${Array.from({ length: facts.gate.stages }, (_, index) => `<i style="--i:${index}"></i>`).join("")}</div><p>zero skipped · zero omitted · clean at both boundaries</p></div>`,
    }, 8),
    frame({
      id: "regression-caught", eyebrow: "Scar tissue · 09", title: "The documentation loop caught itself getting fat.", claim: claim.R9, theme: "alert",
      body: `<div class="regression"><div class="regression-stat"><strong>${facts.gate.integrationAlwaysLoadedBytes.toLocaleString("en-US")}</strong><span>always-loaded bytes</span></div><div class="versus">against</div><div class="regression-stat limit"><strong>${facts.gate.integrationAlwaysLoadedRatchetBytes.toLocaleString("en-US")}</strong><span>byte ratchet</span></div></div><p class="lead narrow">Merged guidance broke the context budget. The fix routed ${facts.gate.routedGuidanceBytes.toLocaleString("en-US")} bytes on demand. The ratchet did not move.</p><div class="failure-chain"><span>listener + cache assumptions</span><b>→</b><span>context overflow</span><b>→</b><span>stale routing tests</span><b>→</b><span>clean receipt</span></div>`,
    }, 9),
    frame({
      id: "costs-honestly", eyebrow: "Costs · 10", title: "The system has carrying cost. That is the point.", claim: claim.R10,
      body: `<div class="cost-grid"><article><strong>${facts.branch.checkScripts}</strong><span>check-prefixed script names</span></article><article><strong>${facts.gate.stages}</strong><span>continuous-integration-parity stages</span></article><article><strong>${facts.canonicalTokenSources}</strong><span>canonical token source</span></article></div><p class="lead narrow">More machinery is not free. It is justified only when it converts recurring review arguments into reproducible failures.</p>`,
    }, 10),
    frame({
      id: "review-the-system", eyebrow: "Provenance · 11", title: "Review the decisions, not just the diff.", claim: claim.R11, theme: "ink",
      body: `<div class="provenance"><article><strong>${facts.branch.provenanceCommits}</strong><span>commits with task + origin trailers</span></article><article><strong>${facts.branch.branchOnlyCommits}</strong><span>branch-only commits inspected</span></article><article><strong>${facts.branch.provenanceEvents}</strong><span>distinct origin events</span></article></div><p class="callout">Provenance grammar arrived mid-program. The Storybook ledger will combine valid trailers with owner-approved historical summaries instead of inventing missing history.</p>`,
    }, 11),
    frame({
      id: "compatibility-evidence", eyebrow: "The visible result · 12", title: "Current main is the before. History stays history.", claim: claim.R12,
      body: `<div class="shots"><figure><img src="${beforeLight}" alt="Pinned main Home in light theme"><figcaption>main · light</figcaption></figure><figure><img src="${afterLight}" alt="Integrated React Home in light theme"><figcaption>branch · light</figcaption></figure><figure><img src="${beforeDark}" alt="Pinned main Home in dark theme"><figcaption>main · dark</figcaption></figure><figure><img src="${afterDark}" alt="Integrated React Home in dark theme"><figcaption>branch · dark</figcaption></figure></div><p class="caption">Same deterministic data fixture · ${captureManifest.viewport.width} × ${captureManifest.viewport.height} · service workers blocked · frozen compiler ${captureManifest.tailwindPlaySha256.slice(0, 12)}… Review the pinned revisions, exact probes, capture manifest, and failure receipts before approving.</p>`,
    }, 12),
  ]
  const appendixGroups = [evidence.claims.slice(0, 4), evidence.claims.slice(4, 8), evidence.claims.slice(8, 12)]
  const appendix = appendixGroups.map((group, index) => appendixPage(group, index + 1, appendixGroups.length)).join("\n")

  const legacyHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Usernode pull-request case</title>
<style>
:root{--canvas:#f1f1ef;--paper:#fff;--ink:#181817;--muted:#696963;--line:#d8d8d2;--accent:#a36e00;--accent-soft:#f4dfaa;--dark:#11110f;--dark-paper:#1b1b18;--red:#bf3d31;--red-soft:#f7d8d3;font-family:Arial,"Helvetica Neue",sans-serif;color:var(--ink);background:#d7d7d2}
*{box-sizing:border-box}html,body{margin:0;min-height:100%}body{display:grid;place-items:center;padding:32px}.deck{display:grid;gap:32px}.slide{position:relative;width:1600px;height:900px;overflow:hidden;background:var(--paper);padding:64px 76px 54px;box-shadow:0 24px 70px #0002;display:flex;flex-direction:column}.slide.ink{background:var(--dark);color:#f3f2ed}.slide.alert{background:#fff7f5}.slide-head{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);padding-bottom:18px}.ink .slide-head{border-color:#ffffff22}.eyebrow{text-transform:uppercase;letter-spacing:.18em;font-size:15px;font-weight:700;color:var(--muted)}.ink .eyebrow{color:#aaa99f}.slide-number{font-size:18px;font-variant-numeric:tabular-nums;color:var(--muted)}.slide-content{flex:1;padding-top:48px}.slide h1{font-size:64px;line-height:1.02;letter-spacing:-.045em;max-width:1200px;margin:0 0 38px}.slide h2{font-size:28px;line-height:1.15;margin:20px 0}.lead{font-size:30px;line-height:1.35;color:#3f3f3a;max-width:850px}.ink .lead{color:#d0cfc7}.lead.narrow{font-size:26px;max-width:1050px}.caption{font-size:16px;color:var(--muted);margin:18px 0 0}.ink .caption{color:#aaa99f}.receipt{min-height:112px;border:1px solid var(--line);display:grid;grid-template-columns:92px 1fr;border-radius:18px;overflow:hidden;background:#fafaf8}.ink .receipt{background:#191916;border-color:#ffffff24}.receipt-id{display:grid;place-items:center;font-size:24px;font-weight:800;color:#8a5d00;background:var(--accent-soft)}.receipt-body{padding:16px 22px;min-width:0}.receipt p{font-size:17px;margin:0 0 9px}.receipt code{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px;color:var(--muted)}.ink .receipt code{color:#aaa99f}.slide footer{display:flex;justify-content:space-between;gap:20px;margin-top:18px;font:12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;color:#8c8c85}.hero-grid{display:grid;grid-template-columns:1.2fr .8fr;gap:90px}.big-stat{font-size:150px;font-weight:800;line-height:.9;margin-top:52px;color:#8a5d00}.big-stat span{display:block;font-size:20px;line-height:1.3;color:var(--muted);margin-top:18px}.ladder{display:grid;gap:12px;align-content:center}.ladder div{padding:20px 24px;border:1px solid var(--line);border-radius:14px;font-size:20px;color:var(--muted)}.ladder .active{background:var(--accent-soft);border-color:#b77d08;color:#4a3100;font-weight:700;transform:translateX(-18px)}.demo-grid{display:grid;grid-template-columns:1fr 1fr;gap:26px}.demo-grid article{position:relative;min-height:340px;padding:28px;border:1px solid #ffffff25;border-radius:24px;background:var(--dark-paper);overflow:hidden}.demo-grid pre{font:18px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;color:#d8d7cf;background:#090908;padding:20px;border-radius:14px}.tag{display:inline-block;font-size:13px;text-transform:uppercase;letter-spacing:.13em;border:1px solid currentColor;border-radius:999px;padding:7px 10px;color:#b6b5ad}.tag.good{color:#b8d49b}.tag.bad{color:#efaaa2}.swatch{position:absolute;right:28px;bottom:24px;width:90px;height:90px;border-radius:50%;background:oklch(.32 .08 255);box-shadow:0 0 0 14px #ffffff0b}.guard-mark{position:absolute;right:28px;bottom:5px;font-size:140px;line-height:1;color:#ef776b}.compare{display:grid;grid-template-columns:1fr 90px 1fr;align-items:center;gap:30px;max-width:1100px}.compare article{border:1px solid var(--line);border-radius:24px;padding:36px 40px}.compare article.accent{background:var(--accent-soft);border-color:#c39223}.compare span,.compare p{font-size:18px;color:var(--muted)}.compare strong{display:block;font-size:124px;line-height:1;margin:24px 0 4px}.arrow{font-size:58px;text-align:center;color:#9c9c95}.unit-grid{display:grid;grid-template-columns:1fr 1fr;gap:28px}.unit-grid article{padding:34px;border:1px solid #ffffff25;border-radius:24px;background:var(--dark-paper)}.unit-grid strong{font-size:120px;line-height:1;color:#e5bd62}.unit-grid p{font-size:20px;color:#aaa99f}.callout{font-size:24px;line-height:1.4;border-left:5px solid #bd8615;padding:14px 0 14px 24px;max-width:1180px}.catalog{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:18px}.catalog>div{border:1px solid var(--line);border-radius:20px;padding:30px;display:flex;flex-direction:column;justify-content:end;min-height:240px}.catalog-total{background:var(--accent-soft)}.catalog strong{font-size:82px}.catalog span{font-size:20px;color:var(--muted)}.flow{display:flex;align-items:center;gap:18px;margin-top:34px;font-size:18px}.flow span{padding:14px 18px;border:1px solid var(--line);border-radius:999px}.flow b{color:#a2a29a}.loop{display:flex;align-items:center;gap:16px;margin:80px 0 70px}.node{font-size:24px;font-weight:700;border:1px solid var(--line);border-radius:18px;padding:34px 28px;background:#fafaf8}.node.ghost{border-style:dashed;color:#999}.edge{font-size:15px;color:var(--muted);padding-bottom:36px;position:relative;min-width:150px;text-align:center}.edge:after{content:"→";position:absolute;font-size:44px;left:50%;top:20px;transform:translateX(-50%)}.edge.broken:after{content:"⋯";color:var(--red)}.two-halves{display:grid;grid-template-columns:1fr 1fr;gap:26px}.two-halves article{padding:34px;border:1px solid #ffffff24;border-radius:24px;background:var(--dark-paper)}.two-halves ul{font-size:20px;line-height:1.55;color:#d0cfc7;padding-left:22px}.gate{text-align:center}.gate>strong{font-size:170px;letter-spacing:-.06em;color:#8a5d00}.gate>span{display:block;font-size:24px;color:var(--muted)}.gate-track{display:grid;grid-template-columns:repeat(28,1fr);gap:7px;max-width:1180px;margin:44px auto 24px}.gate-track i{height:24px;border-radius:6px;background:color-mix(in srgb,var(--accent) calc(35% + var(--i)*2%),#eadfc3)}.gate p{font-size:18px;color:var(--muted)}.regression{display:flex;align-items:end;gap:28px}.regression-stat{padding:24px 34px;border-radius:22px;background:var(--red-soft);border:1px solid #df8d83}.regression-stat.limit{background:#fff;border-color:var(--line)}.regression-stat strong{display:block;font-size:104px;line-height:1}.regression-stat span{font-size:18px;color:var(--muted)}.versus{font-size:18px;color:var(--muted);padding-bottom:28px}.failure-chain{display:flex;align-items:center;gap:14px;margin-top:32px}.failure-chain span{padding:12px 16px;border:1px solid #e2b3ac;border-radius:999px;font-size:15px;background:#fff}.failure-chain b{color:#c4776e}.cost-grid,.provenance{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}.cost-grid article,.provenance article{border:1px solid var(--line);border-radius:22px;padding:34px;min-height:260px}.cost-grid strong,.provenance strong{display:block;font-size:108px;line-height:1;color:#8a5d00}.cost-grid span,.provenance span{font-size:20px;color:var(--muted)}.ink .provenance article{border-color:#ffffff25;background:var(--dark-paper)}.ink .provenance span{color:#aaa99f}.shots{display:grid;grid-template-columns:1fr 1fr;gap:12px}.shots figure{position:relative;margin:0;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#eee}.shots img{display:block;width:100%;height:225px;object-fit:cover}.shots figcaption{position:absolute;left:10px;bottom:10px;background:#111d;color:#fff;padding:6px 9px;border-radius:8px;font-size:13px}.appendix{background:#fbfbf8}.appendix-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;flex:1;padding-top:28px}.appendix-grid article{border:1px solid var(--line);border-radius:18px;padding:22px;min-height:270px;overflow:hidden}.appendix-title{display:flex;justify-content:space-between}.appendix-title strong{font-size:24px;color:#8a5d00}.appendix-title span{font-size:13px;color:var(--muted)}.appendix-grid p{font-size:16px;line-height:1.35}.appendix-grid pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;background:#efefe9;padding:12px;border-radius:10px;max-height:100px;overflow:hidden}.appendix-grid small{display:block;color:var(--muted);overflow-wrap:anywhere}
.slide[data-slide-id="compatibility-evidence"] .slide-content{padding-top:22px}.slide[data-slide-id="compatibility-evidence"] h1{font-size:46px;margin-bottom:14px}.slide[data-slide-id="compatibility-evidence"] .shots{grid-template-columns:1fr 1fr;gap:8px 12px}.slide[data-slide-id="compatibility-evidence"] .shots img{height:195px;aspect-ratio:16/9;object-fit:contain}.slide[data-slide-id="compatibility-evidence"] .caption{font-size:13px;margin-top:7px}
@media(max-width:1700px){body{padding:0}.slide{transform-origin:top left}}
@page{size:16.666667in 9.375in;margin:0}@media print{body{display:block;padding:0;background:#fff}.deck{display:block}.slide{box-shadow:none;break-after:page;page-break-after:always}.slide:last-child{break-after:auto}}
</style></head><body><main class="deck">${slides.join("\n")}${appendix}</main>
<script>const slides=[...document.querySelectorAll('.slide')];let current=0;function show(index){current=Math.max(0,Math.min(slides.length-1,index));slides.forEach((slide,i)=>slide.hidden=i!==current);location.hash=slides[current].dataset.slideId}function printMode(){slides.forEach(slide=>slide.hidden=false)}if(!matchMedia('print').matches){const hash=location.hash.slice(1);const found=slides.findIndex(slide=>slide.dataset.slideId===hash);show(found<0?0:found)}addEventListener('keydown',event=>{if(event.key==='ArrowRight'||event.key==='PageDown')show(current+1);if(event.key==='ArrowLeft'||event.key==='PageUp')show(current-1);if(event.key==='Home')show(0);if(event.key==='End')show(slides.length-1)});addEventListener('beforeprint',printMode);addEventListener('afterprint',()=>show(current));</script></body></html>`
  return buildReviewerDeck({
    evidence,
    captureManifest,
    repoRoot,
    imageData,
    escapeHtml,
    baseRevision: PR_CASE_BASE_REVISION,
    branchRevision: PR_CASE_BRANCH_REVISION,
    tokenDemo,
    legacyHtml,
  })
}

function validateEvidence(evidence, captureManifest, html) {
  const errors = []
  const ids = new Set()
  for (const claim of evidence.claims) {
    if (ids.has(claim.id)) errors.push(`duplicate claim id ${claim.id}`)
    ids.add(claim.id)
    for (const field of ["id", "slideId", "statement", "command"]) {
      if (!claim[field]) errors.push(`${claim.id || "claim"} has no ${field}`)
    }
    if (!Array.isArray(claim.metrics) || !claim.metrics.length) errors.push(`${claim.id} has no structured metrics`)
    for (const item of claim.metrics || []) {
      for (const field of ["id", "unit", "revision", "scope"]) if (!item[field]) errors.push(`${claim.id}.${item.id || "metric"} has no ${field}`)
      if (!Object.hasOwn(item, "value")) errors.push(`${claim.id}.${item.id || "metric"} has no value`)
    }
  }
  for (const capture of captureManifest.captures) {
    const fileName = path.join(outputRoot, capture.file)
    if (!fs.existsSync(fileName)) errors.push(`missing capture ${capture.file}`)
    else {
      const bytes = fs.readFileSync(fileName)
      if (sha256(bytes) !== capture.sha256) errors.push(`capture hash drifted: ${capture.file}`)
      const png = PNG.sync.read(bytes)
      if (png.width !== capture.width || png.height !== capture.height) errors.push(`capture dimensions drifted: ${capture.file}`)
    }
    if (capture.rasterBoundary?.maxChannelDelta !== 40 || capture.rasterBoundary?.maxChangedPixelRatio !== 0.001) {
      errors.push(`capture raster boundary is missing or changed: ${capture.file}`)
    }
  }
  const expectedCaptureRoutes = ["/", "/react/", "/", "/react/"]
  if (JSON.stringify(captureManifest.captures.map((capture) => capture.route)) !== JSON.stringify(expectedCaptureRoutes)) {
    errors.push("capture routes must identify legacy / and staged React /react/ for both themes")
  }
  if (captureManifest.revisions.base !== PR_CASE_BASE_REVISION || captureManifest.revisions.branch !== PR_CASE_BRANCH_REVISION) {
    errors.push("capture revisions do not match the case revisions")
  }
  if (JSON.stringify(captureManifest.legacyPathsVerifiedUnchangedBetweenRevisions) !== JSON.stringify(expectedLegacyEquivalencePaths)) {
    errors.push("selected legacy equivalence assertions are missing or reordered")
  }
  const expectedBlockedPrefixes = ["https://cdn.jsdelivr.net/", "https://raw.githubusercontent.com/"]
  if (JSON.stringify(captureManifest.networkPolicy?.blockedExternalPrefixes) !== JSON.stringify(expectedBlockedPrefixes)) {
    errors.push("capture blocked-external policy is missing or changed")
  }
  for (const [field, expected] of Object.entries({
    tailwindBrowserCompiler: "frozen-fixture",
    applicationProgrammingInterface: "deterministic-fixture",
    serviceWorkers: "blocked",
  })) {
    if (captureManifest.networkPolicy?.[field] !== expected) errors.push(`capture network policy has no exact ${field} disposition`)
  }
  for (const field of ["platform", "architecture", "node", "playwright", "chromium"]) {
    if (!captureManifest.runtime?.[field]) errors.push(`capture runtime provenance has no ${field}`)
  }
  for (const capture of captureManifest.captures) if (!capture.bodyFontFamily) errors.push(`capture font provenance is missing: ${capture.file}`)
  if (sha256(JSON.stringify(captureManifest.fixture)) !== captureManifest.fixtureSha256) errors.push("capture fixture hash drifted")
  const frozenFixturePath = path.join(outputRoot, "capture-fixtures", "tailwind-play-2026-08-04.js.gz")
  if (!fs.existsSync(frozenFixturePath)) errors.push("frozen Tailwind fixture is missing")
  else {
    const compressed = fs.readFileSync(frozenFixturePath)
    if (sha256(compressed) !== captureManifest.tailwindPlayGzipSha256) errors.push("compressed Tailwind fixture hash drifted")
    if (sha256(zlib.gunzipSync(compressed)) !== captureManifest.tailwindPlaySha256) errors.push("uncompressed Tailwind fixture hash drifted")
  }
  const forbidden = [/localhost/i, /\/Users\//, /127\.0\.0\.1/, /Lukas/i, /Cyrcle_0/i, /lead-(?:codex|claude)/i]
  for (const pattern of forbidden) if (pattern.test(html)) errors.push(`generated HTML contains forbidden private or local text: ${pattern}`)
  const slideIds = [...html.matchAll(/<section class="slide[^"]*" data-slide-id="([^"]+)"/g)].map((match) => match[1])
  if (new Set(slideIds).size !== slideIds.length) errors.push("generated HTML has duplicate slide identifiers")
  if (slideIds.length !== 34) errors.push(`generated HTML must contain 34 reviewer deck slides, received ${slideIds.length}`)
  for (const stableId of ["token-authority-demo", "lean-mechanical-loop", "regression-caught"]) {
    if (!slideIds.includes(stableId)) errors.push(`generated HTML is missing stable selected slide ${stableId}`)
  }
  const claimIds = [...html.matchAll(/data-claim-id="([^"]+)"/g)].map((match) => match[1])
  if (claimIds.length !== evidence.claims.length || evidence.claims.some((item) => !claimIds.includes(item.id))) {
    errors.push("generated HTML must carry one detail slide for every reproducible claim")
  }
  if (!html.startsWith("<!doctype html>") || !html.includes("data:image/png;base64,")) errors.push("generated HTML is not self-contained")
  if (errors.length) throw new Error(`pull-request case validation failed:\n\n- ${errors.join("\n- ")}`)
}

function writeOrCheck(fileName, content) {
  const filePath = path.join(outputRoot, fileName)
  if (checkOnly) {
    if (!fs.existsSync(filePath) || fs.readFileSync(filePath, "utf8") !== content) {
      throw new Error(`${fileName} is stale; run node frontend/scripts/generate-pr-case.mjs`)
    }
  } else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content)
  }
}

function validateExportManifest() {
  if (!checkOnly) return
  const manifestPath = path.join(outputRoot, "artifact-manifest.json")
  if (!fs.existsSync(manifestPath)) throw new Error("artifact-manifest.json is missing; run node frontend/scripts/export-pr-case.mjs")
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  const artifacts = manifest.artifacts || []
  if (!artifacts.length) throw new Error("artifact manifest has no artifacts")
  const files = new Set()
  for (const artifact of artifacts) {
    if (files.has(artifact.file)) throw new Error(`duplicate export artifact: ${artifact.file}`)
    files.add(artifact.file)
    if (!artifact.kind || !artifact.bytes || !artifact.sha256) throw new Error(`incomplete export artifact record: ${artifact.file}`)
    const artifactPath = path.join(outputRoot, artifact.file)
    if (!artifactPath.startsWith(`${outputRoot}${path.sep}`) || !fs.existsSync(artifactPath)) {
      throw new Error(`export artifact is missing or outside docs/pr-case: ${artifact.file}`)
    }
    const actual = sha256(fs.readFileSync(artifactPath))
    if (actual !== artifact.sha256) throw new Error(`export artifact hash drifted: ${artifact.file}`)
  }
  const requiredKinds = ["self-contained-html", "portable-document", "claim-manifest", "capture-manifest", "sanitized-gate-receipt", "slide-image", "pull-request-image"]
  for (const kind of requiredKinds) if (!artifacts.some((item) => item.kind === kind)) throw new Error(`artifact manifest has no ${kind}`)

  const managedFiles = []
  function collect(relativeDirectory = "") {
    const directory = path.join(outputRoot, relativeDirectory)
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".DS_Store") continue
      const relative = path.join(relativeDirectory, entry.name)
      if (entry.isDirectory()) collect(relative)
      else managedFiles.push(relative.split(path.sep).join("/"))
    }
  }
  collect()
  const envelopeFiles = new Set(["artifact-manifest.json", "artifact-sha256.txt"])
  for (const file of managedFiles) {
    if (!files.has(file) && !envelopeFiles.has(file)) throw new Error(`unmanifested file under docs/pr-case: ${file}`)
  }
  for (const file of files) if (!managedFiles.includes(file)) throw new Error(`manifested file absent from docs/pr-case: ${file}`)

  const checksumPath = path.join(outputRoot, "artifact-sha256.txt")
  const expectedChecksums = [
    ...artifacts.map((item) => `${item.sha256}  ${item.file}`),
    `${sha256(fs.readFileSync(manifestPath))}  artifact-manifest.json`,
  ].sort().join("\n") + "\n"
  if (!fs.existsSync(checksumPath) || fs.readFileSync(checksumPath, "utf8") !== expectedChecksums) {
    throw new Error("artifact-sha256.txt is incomplete or stale")
  }

  const receipt = JSON.parse(fs.readFileSync(path.join(outputRoot, "receipts", "integration.json"), "utf8"))
  const rawArtifactRoot = path.join(frontendRoot, ".artifacts", "ui-gate")
  if (fs.existsSync(rawArtifactRoot)) {
    const available = new Set(fs.readdirSync(rawArtifactRoot)
      .filter((file) => file.endsWith(".json"))
      .map((file) => sha256(fs.readFileSync(path.join(rawArtifactRoot, file)))))
    const receiptHashes = [receipt.artifactSha256, ...receipt.failedExactHeads.map((item) => item.artifactSha256)]
    for (const hash of receiptHashes) if (!available.has(hash)) throw new Error(`sanitized receipt does not resolve to a local raw gate artifact: ${hash}`)
  }
}

const captureManifest = JSON.parse(fs.readFileSync(path.join(outputRoot, "capture-manifest.json"), "utf8"))
const evidence = collectPrCaseEvidence()
const html = buildHtml(evidence, captureManifest)
validateEvidence(evidence, captureManifest, html)
writeOrCheck("claims.json", `${JSON.stringify(evidence, null, 2)}\n`)
writeOrCheck("index.html", html)
validateExportManifest()
console.log(`Pull-request case ${checkOnly ? "is current" : "generated"}: 13 narrative slides, 21 detail slides, ${evidence.claims.length} reproducible claims.`)
