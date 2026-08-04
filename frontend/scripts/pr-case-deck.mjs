import { execFileSync } from "node:child_process"

function gitMatches(repoRoot, revision, pattern, paths, distinct = false) {
  const output = execFileSync("git", ["grep", "-ohE", pattern, revision, "--", ...paths], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim()
  const matches = output ? output.split("\n") : []
  return distinct ? new Set(matches).size : matches.length
}

function stableId(title, seen) {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "slide"
  const count = (seen.get(base) || 0) + 1
  seen.set(base, count)
  return count === 1 ? base : `${base}-${count}`
}

export function buildReviewerDeck({
  evidence,
  captureManifest,
  repoRoot,
  imageData,
  escapeHtml,
  baseRevision,
  branchRevision,
  tokenDemo,
  legacyHtml,
}) {
  if (!legacyHtml.startsWith("<!doctype html>")) throw new Error("legacy reviewer case no longer resolves")
  const claim = Object.fromEntries(evidence.claims.map((item) => [item.id, item]))
  const metric = Object.fromEntries(evidence.claims.map((item) => [
    item.id,
    Object.fromEntries(item.metrics.map((entry) => [entry.id, entry.value])),
  ]))
  const baseShort = baseRevision.slice(0, 8)
  const branchShort = branchRevision.slice(0, 8)
  const sourcePaths = ["public/*", "src/*"]
  const darkPattern = "dark:[a-z0-9-]+"
  const rawPattern = "(text|bg|border)-(zinc|violet|slate|gray|red|green|amber|blue|emerald|rose)-[0-9]+"
  const measurements = {
    darkPairs: gitMatches(repoRoot, baseRevision, darkPattern, sourcePaths),
    darkFiles: Number(execFileSync("git", ["grep", "-lE", "dark:", baseRevision, "--", ...sourcePaths], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim().split("\n").filter(Boolean).length),
    rawColorOccurrences: gitMatches(repoRoot, baseRevision, rawPattern, sourcePaths),
    rawColorDistinct: gitMatches(repoRoot, baseRevision, rawPattern, sourcePaths, true),
  }
  if (!measurements.darkPairs || !measurements.rawColorOccurrences) {
    throw new Error(`reviewer deck measurements did not resolve: ${JSON.stringify(measurements)}`)
  }

  const darkCommand = `git grep -oE '${darkPattern}' ${baseShort} -- 'public/*' 'src/*' | wc -l`
  const rawCommand = `git grep -oE '${rawPattern}' ${baseShort} -- 'public/*' 'src/*' | wc -l`
  const demo = {
    acceptedEdit: tokenDemo.validEdit,
    acceptedOutput: tokenDemo.propagatedLine,
    refusedEdit: tokenDemo.invalidEdit,
    refusedError: tokenDemo.rejection,
  }

  const footer = (tag) => `<div class="nv-foot"><span>main ${baseShort}</span><span>branch ${branchShort}</span><span>${escapeHtml(tag)}</span></div>`
  const bullets = (items) => `<ul class="nv-points">${items.map(([tone, text]) => `<li class="${tone}">${text}</li>`).join("")}</ul>`
  const narrative = (index, kicker, title, stat, items, refs) => {
    const statHtml = stat ? `<div class="nv-stat ${stat[2] || ""}">${stat[0]}<span class="nv-stat-label">${stat[1]}</span></div>` : ""
    const reference = refs.length ? `<div class="nv-refs">receipts: ${refs.join(" · ")} — press ↓ for the detail slides</div>` : ""
    return `<section class="slide nv-slide" data-slide-id="nv-${index + 1}" aria-label="${escapeHtml(title)}"><div class="nv-kicker"><span>${kicker}</span><span>${String(index + 1).padStart(2, "0")}</span></div><div class="nv-body"><h1 class="nv-h1">${title}</h1>${statHtml}${bullets(items)}</div>${reference}${footer(`nv-${index + 1}`)}</section>`
  }
  const claimIds = { R7: "lean-mechanical-loop", R9: "regression-caught" }
  const claimSlide = (id, view) => {
    const slideId = claimIds[id] || `claim-${id}`
    const statHtml = view.stat ? `<div class="nv-stat ${view.stat[2] || ""}">${view.stat[0]}<span class="nv-stat-label">${view.stat[1]}</span></div>` : ""
    return `<section class="slide nv-slide cl-slide" data-slide-id="${slideId}" data-claim-id="${id}" aria-label="Receipt ${id}"><div class="nv-kicker"><span>Receipt · ${id}</span><span>detail</span></div><div class="nv-body"><h1 class="nv-h1 cl-h1">${view.title}</h1>${statHtml}${bullets(view.items)}<code class="cmd-code">${escapeHtml(claim[id].command)}</code></div><div class="nv-refs">${escapeHtml(claim[id].statement)} — re-derived by the command above; a mismatch fails check:design-system</div>${footer(slideId)}</section>`
  }
  const demoSlide = () => `<section class="slide nv-slide demo-slide" data-slide-id="token-authority-demo"><div class="nv-kicker"><span>The demo, live values</span><span>detail</span></div><div class="nv-body"><div class="demo-panels"><div class="demo-panel ok"><div class="demo-tag ok">accepted edit</div><code class="demo-line">${escapeHtml(demo.acceptedEdit)}</code><code class="demo-line out">${escapeHtml(demo.acceptedOutput)}</code><div class="demo-note">propagates to the entire application</div></div><div class="demo-panel no"><div class="demo-tag no">refused edit</div><code class="demo-line">${escapeHtml(demo.refusedEdit)}</code><code class="demo-line err">${escapeHtml(demo.refusedError)}</code><div class="demo-note">the guard explains itself — no silent failure</div></div></div></div><div class="nv-refs">values extracted from the checksummed case at build time — run R2 to re-derive both</div>${footer("token-authority-demo")}</section>`
  const image = (file, alt) => [imageData(`images/${file}`), alt]
  const shotSlide = (title, caption, shots, id) => `<section class="slide nv-slide dd-slide" data-slide-id="${id}" aria-label="${escapeHtml(title)}"><div class="nv-kicker"><span>${title}</span><span>detail</span></div><p class="dd-caption">${caption}</p><div class="dd-imgs ${shots.length > 1 ? "dd-grid-2" : "dd-grid-1"}">${shots.map(([source, alt]) => `<figure class="dd-fig"><img class="dd-shot" src="${source}" alt="${escapeHtml(alt)}"><figcaption>${escapeHtml(alt)}</figcaption></figure>`).join("")}</div><div class="nv-refs">click any image for full screen · Esc closes · ↑ returns</div></section>`
  const commandSlide = (title, caption, rows, id) => `<section class="slide nv-slide cmds-slide" data-slide-id="${id}" aria-label="${escapeHtml(title)}"><div class="nv-kicker"><span>${title}</span><span>detail</span></div><p class="dd-caption">${caption}</p><div class="cmd-list">${rows.map(([label, value, command]) => `<div class="cmd-row"><div class="cmd-label">${label}${value ? ` = <b>${value}</b>` : ""}</div><code class="cmd-code">${escapeHtml(command)}</code></div>`).join("")}</div><div class="nv-refs">run from the repository root · ↑ returns</div></section>`

  const yes = (text) => ["yes", text]
  const no = (text) => ["no", text]
  const plain = (text) => ["", text]
  const views = {
    R1: { title: "Main already did the easy half.", stat: [metric.R1.centralPaletteFiles, "CSS file holds the whole palette"], items: [yes("Centralizing color was done — credit where due"), no(`${metric.R1.browserCompilerHtmlPages} pages still compile their styling in the browser, on every load`)] },
    R2: { title: "The guard says no — and says why.", stat: [metric.R2.guardedInvalidMutations, "classes of broken edit refused"], items: [yes("A valid token edit propagates to the whole application"), no("An inverted Canvas-to-Paper ladder is refused with a plain-language error"), plain("Runs in a temporary directory — canonical files stay untouched")] },
    R3: { title: "Every test main had is still here.", stat: [metric.R3.rootTestsPassed.toLocaleString("en-US"), "root tests pass"], items: [yes(`${metric.R3.retainedBaseRootNodeTestFiles} files kept, ${metric.R3.removedBaseRootNodeTestFiles} removed`), yes(`${metric.R3.branchRootNodeTestFiles - metric.R3.retainedBaseRootNodeTestFiles} new files added on top`)] },
    R4: { title: "Component states are on record now.", stat: [metric.R4.storybookStoryFiles, "story files render real states"], items: [yes(`Backed by a ${metric.R4.gateStages}-stage receipt-grade gate`), plain("Before this branch, the number was zero")] },
    R5: { title: "The inventory is queryable.", stat: [metric.R5.catalogComponents, "catalogued components"], items: [plain(`${metric.R5.elementTierComponents} element · ${metric.R5.blockTierComponents} block · rest feature — ${metric.R5.catalogTiers} explicit tiers`), plain("Agents query the catalog; nobody bulk-reads a source directory")] },
    R6: { title: "Coverage that could not see.", stat: [metric.R6.baseComponentStoryFiles, "component states on record", "bad"], items: [yes(`${metric.R6.baseRootNodeTestFiles} behavior test files — kept and credited`), no("Not one of them renders a pixel")] },
    R7: { title: "Guidance stays small by law.", stat: [metric.R7.alwaysLoadedBytes.toLocaleString("en-US"), "bytes always loaded"], items: [plain(`Held under a ${metric.R7.alwaysLoadedRatchetBytes.toLocaleString("en-US")}-byte ratchet that only tightens`), plain(`Full component review: ${metric.R7.componentReviewBytes.toLocaleString("en-US")} bytes under a ${metric.R7.componentReviewRatchetBytes.toLocaleString("en-US")} ratchet`), no("The 100,000-byte ceiling is non-waivable — owner decision")] },
    R8: { title: "One clean revision. Zero excuses.", stat: [`${metric.R8.passedGateStages}/${metric.R8.totalGateStages}`, "gate stages passed"], items: [yes(`${metric.R8.skippedGateStages} skipped, ${metric.R8.omittedGateStages} omitted`), plain("Start revision = end revision, working tree clean at both ends")] },
    R9: { title: "The loop caught itself.", stat: [metric.R9.preservedFailedArtifacts, "failures preserved as evidence"], items: [no(`Guidance grew to ${metric.R9.regressedAlwaysLoadedBytes.toLocaleString("en-US")} bytes against a ${metric.R9.alwaysLoadedRatchetBytes.toLocaleString("en-US")} ratchet — the gate refused`), yes(`The fix routed ${metric.R9.routedGuidanceBytes.toLocaleString("en-US")} bytes on demand. The ratchet did not move`)] },
    R10: { title: "The price tag, itemized.", stat: [metric.R10.checkPrefixedScriptNames, "check scripts to maintain"], items: [no(`Plus a ${metric.R10.gateStages}-stage gate to keep green on every slice`), yes(`In exchange: ${metric.R10.canonicalTokenSources} token source rules them all`)] },
    R11: { title: "Decisions have receipts.", stat: [metric.R11.provenanceCommits, `of ${metric.R11.branchOnlyCommits} commits carry provenance`], items: [plain(`Each points at one of ${metric.R11.distinctOriginEvents} recorded decisions`), plain("The grammar arrived mid-program — earlier history is summarized, never backfilled")] },
    R12: { title: "Same route. Same data. Both themes.", stat: [metric.R12.captureImages, "pinned captures"], items: [plain(`${metric.R12.captureWidth}×${metric.R12.captureHeight}, one deterministic fixture, ${metric.R12.captureThemes} themes`), plain("Main and branch, side by side — the comparison is repeatable, not curated")] },
  }

  const stories = [
    ["The case", "Two rewrites in one branch.", null, [plain("<b>Product:</b> vanilla HTML and scripts → React with a governed design system"), plain("<b>Harness:</b> nothing pushed back → machines enforce the rules"), plain("The second rewrite is what keeps the first one true"), plain("Every claim in this deck carries a command you can run yourself")], [], []],
    ["Why now", "What is coming needs a frontend that can hold.", null, [plain("A re-brand is ahead"), plain("The interface needs consistent control across every surface"), plain("Agents build user interface here daily"), no("On main, each of those means hand-editing pages that carry their own copy of the truth")], [], []],
    ["Before", "Main is ungoverned — not ugly.", [metric.R6.baseComponentStoryFiles, "component states on record"], [yes(`Credit where due: the palette is already centralized in ${metric.R1.centralPaletteFiles} CSS file`), no(`${metric.R1.browserCompilerHtmlPages} pages still compile their styling in the browser at page load`), no(`${metric.R6.baseRootNodeTestFiles} test files — all behavior, none can see pixels`), plain("The design system is copy-the-nearest-example. Drift is not that loop failing — drift is its output")], ["R1"], [["claim", "R1"]]],
    ["The bill", "What consistency costs on main — today.", [measurements.darkPairs.toLocaleString("en-US"), "hand-paired dark: variants", "bad"], [no(`${measurements.rawColorOccurrences.toLocaleString("en-US")} raw color classes across the product — ${measurements.rawColorDistinct} distinct values, every one a hand-made decision`), no(`Dark mode is maintained by hand in ${measurements.darkFiles} files — every light change needs its dark twin`), no("A re-brand means finding and editing all of them, and hoping nothing was missed"), plain("Measured live at the pinned base every time this deck builds — press ↓ for the commands")], [], [["commands", "Measure it yourself", "Each figure on the previous slide, re-derived by one command at the pinned main revision.", [["Hand-paired dark: variants", measurements.darkPairs.toLocaleString("en-US"), darkCommand], ["Raw color-class occurrences", measurements.rawColorOccurrences.toLocaleString("en-US"), rawCommand], ["Distinct raw color classes", measurements.rawColorDistinct, rawCommand.replace("-oE", "-ohE").replace("| wc -l", "| sort -u | wc -l")]]]]],
    ["Now", "Appearance has one source of truth.", [1, "file: tokens.json"], [yes("A valid edit propagates to the entire application"), yes(`An invalid edit is refused — ${metric.R2.guardedInvalidMutations} classes of broken edit, each with a plain-language error`), plain("A re-brand stops being archaeology and becomes an edit plus a review")], ["R2"], [["claim", "R2"], ["demo"]]],
    ["Kept + gained", "Appearance is testable now — and nothing was lost.", [metric.R3.rootTestsPassed.toLocaleString("en-US"), "root tests pass"], [yes(`All ${metric.R3.retainedBaseRootNodeTestFiles} of main’s test files kept, ${metric.R3.branchRootNodeTestFiles - metric.R3.retainedBaseRootNodeTestFiles} added`), yes(`${metric.R4.storybookStoryFiles} story files render real component states`), yes(`A ${metric.R4.gateStages}-stage gate must pass at one clean revision before anything ships`)], ["R3", "R4"], [["claim", "R3"], ["claim", "R4"]]],
    ["Structure", "A surface grammar, not a pile of screens.", null, [plain("<b>Canvas</b> holds the page · one <b>Paper</b> holds the work · <b>Containers</b> group · one <b>Overlay</b> floats"), plain(`${metric.R5.catalogComponents} catalogued components across ${metric.R5.catalogTiers} tiers — queryable, not memorized`), plain("Humans and agents compose from a vocabulary instead of inventing layouts")], ["R5"], [["claim", "R5"], ["shots", "The grammar in the product — light", "Home route at the pinned branch head.", [image("home-after-light.png", "Branch home route, light theme")]], ["shots", "The grammar in the product — dark", "Same tokens re-resolved — no hand-paired dark variants anywhere.", [image("home-after-dark.png", "Branch home route, dark theme")]]]],
    ["Old harness", "The harness that was there before.", null, [plain("<b>Guidance</b> was the neighboring code — copy the nearest example and adjust"), plain(`<b>Verification</b> was ${metric.R6.baseRootNodeTestFiles} behavior test files — kept and credited, but none can see pixels`), plain("<b>Feedback</b> was save, reload, eyeball"), no("Drift was not that loop failing. Drift was its output")], ["R6"], [["claim", "R6"]]],
    ["The loop", "Lean guidance in, mechanical proof out.", [`${metric.R8.passedGateStages}/${metric.R8.totalGateStages}`, "gate stages, zero skipped"], [plain(`<b>Before generation:</b> a ${metric.R7.alwaysLoadedBytes.toLocaleString("en-US")}-byte law always loaded; the catalog is queried, never bulk-read`), plain("<b>After generation:</b> a per-edit check that teaches, a gate that blocks"), yes(`It caught itself: guidance grew to ${metric.R9.regressedAlwaysLoadedBytes.toLocaleString("en-US")} bytes against a ${metric.R9.alwaysLoadedRatchetBytes.toLocaleString("en-US")}-byte ratchet — refused, ${metric.R9.preservedFailedArtifacts} failures preserved`)], ["R7", "R8", "R9"], [["claim", "R7"], ["claim", "R8"], ["claim", "R9"]]],
    ["Honest cost", "This is not free. That is the point.", null, [no(`${metric.R10.checkPrefixedScriptNames} check scripts and a ${metric.R10.gateStages}-stage gate are maintained infrastructure`), yes("The trade: recurring review arguments become reproducible failures"), plain("A command that exits 1 ends a debate that comments never could")], ["R10"], [["claim", "R10"]]],
    ["How to review", "Review the constraint system, not 50,000 lines.", null, [plain("Check the laws, the tokens, the guards — then spot-check that violations actually fail"), plain(`${metric.R11.provenanceCommits} of ${metric.R11.branchOnlyCommits} commits carry provenance to ${metric.R11.distinctOriginEvents} recorded decisions`), plain(`See it with your eyes: ${metric.R12.captureImages} pinned captures — same route, same data, both themes`)], ["R11", "R12"], [["claim", "R11"], ["claim", "R12"], ["shots", "Before and after — light", "Left: pinned main. Right: integrated branch. Same route, same fixture.", [image("home-before-light.png", "Main home route, light"), image("home-after-light.png", "Branch home route, light")]], ["shots", "Before and after — dark", "Main dark mode is hand-paired variants; branch dark is the same tokens re-resolved.", [image("home-before-dark.png", "Main home route, dark"), image("home-after-dark.png", "Branch home route, dark")]]]],
    ["Verify it", "Three independent answers, all yours to run.", null, [yes(`<b>The machine:</b> a ${metric.R8.totalGateStages}-stage gate at one clean, immutable revision`), yes(`<b>The suite:</b> ${metric.R3.rootTestsPassed.toLocaleString("en-US")} root tests, including every one main had`), yes("<b>The reader:</b> twelve R-commands re-derive every number in this deck against committed claims"), plain("If any of the three disagrees with a slide, the slide is wrong — that is the contract")], [], []],
    ["Go deeper", "Everything deeper lives in Storybook.", null, [plain("Foundation pages, decision ledger, component index — generated into Storybook"), plain("Same loop as the code: generated from source, citation-checked, never hand-typed"), plain("Run <code>cd frontend &amp;&amp; npm run storybook</code>"), plain("Press ↓ for all twelve reproduce commands")], [], [["commands", "Twelve probes, one command", "Swap the probe identifier — R1 through R12 — and each run re-derives its claim against committed claims.json.", [["The template", "", claim.R1.command.replace("--probe R1", "--probe R{1..12}")], ["Probe index", "", ["R1", "R2", "R3", "R4", "R5", "R6"].map((id) => `${id} ${views[id].title}`).join(" · ")], ["", "", ["R7", "R8", "R9", "R10", "R11", "R12"].map((id) => `${id} ${views[id].title}`).join(" · ")]]]]],
  ]

  const seenIds = new Map()
  const childCounts = []
  const placedClaims = new Set()
  const frames = []
  for (const [index, [kicker, title, stat, items, refs, children]] of stories.entries()) {
    frames.push(`<div class="deck-frame" data-frame="${index}">${narrative(index, kicker, title, stat, items, refs)}</div>`)
    for (const [childIndex, child] of children.entries()) {
      let rendered
      if (child[0] === "claim") {
        placedClaims.add(child[1])
        rendered = claimSlide(child[1], views[child[1]])
      } else if (child[0] === "demo") {
        rendered = demoSlide()
      } else if (child[0] === "commands") {
        rendered = commandSlide(child[1], child[2], child[3], stableId(child[1], seenIds))
      } else {
        rendered = shotSlide(child[1], child[2], child[3], stableId(child[1], seenIds))
      }
      frames.push(`<div class="deck-frame" data-frame="${index}.${childIndex + 1}">${rendered}</div>`)
    }
    childCounts.push(children.length)
  }
  const missingClaims = evidence.claims.map((item) => item.id).filter((id) => !placedClaims.has(id))
  if (missingClaims.length) throw new Error(`reviewer deck has claims without detail slides: ${missingClaims.join(", ")}`)

  const css = `:root{--canvas:#0a0a0a;--sheet:#141414;--recess:#1e1e1e;--line:rgba(255,255,255,.09);--ink:#f4f4f4;--dim:#9e9e9e;--faint:#6b6b6b;--emerald:#34d399;--rose:#f43f5e;--amber:#f59e0b;--sky:#0ea5e9}*{box-sizing:border-box;margin:0;padding:0}html,body{height:100%;background:var(--canvas)}body{overflow:hidden;font:16px/1.6 ui-sans-serif,-apple-system,"Segoe UI",sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased}.deck-stage{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}.deck-frame{display:none;transform-origin:center center}.deck-frame.on{display:block}.slide{width:1600px;height:900px;background:var(--sheet);border-radius:24px;padding:64px 88px 44px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 30px 90px #000a}.nv-kicker{display:flex;justify-content:space-between;font:600 15px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em;text-transform:uppercase;color:var(--faint);border-bottom:1px solid var(--line);padding-bottom:18px}.nv-body{flex:1;display:flex;flex-direction:column;justify-content:center;gap:26px;max-width:1240px;min-height:0}.nv-h1{font-size:58px;line-height:1.08;letter-spacing:-.03em;font-weight:640;max-width:22ch}.cl-h1{font-size:48px}.nv-stat{font-size:96px;font-weight:640;letter-spacing:-.04em;line-height:1;font-variant-numeric:tabular-nums;color:var(--emerald);display:flex;align-items:baseline;gap:18px}.nv-stat.bad{color:var(--rose)}.nv-stat-label{font-size:20px;font-weight:400;letter-spacing:0;color:var(--dim)}.nv-points{list-style:none;display:flex;flex-direction:column;gap:16px}.nv-points li{color:var(--dim);font-size:23px;line-height:1.5;padding-left:26px;position:relative;max-width:48ch}.nv-points li:before{content:"";position:absolute;left:2px;top:14px;width:6px;height:6px;border-radius:99px;background:var(--faint)}.nv-points li.yes:before{background:var(--emerald)}.nv-points li.no:before{background:var(--rose)}.nv-points li b{color:var(--ink);font-weight:600}.nv-points li code,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.nv-points li code{font-size:19px;color:var(--emerald);background:rgba(52,211,153,.09);padding:1px 7px;border-radius:6px}.nv-refs{font:14px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--amber);margin-top:10px}.nv-foot{display:flex;justify-content:space-between;margin-top:14px;font:12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--faint)}.demo-panels{display:grid;grid-template-columns:1fr 1fr;gap:28px}.demo-panel{border-radius:16px;padding:28px;display:flex;flex-direction:column;gap:14px;background:var(--recess)}.demo-panel.ok{border:1px solid rgba(52,211,153,.35)}.demo-panel.no{border:1px solid rgba(244,63,94,.35)}.demo-tag{font:600 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase}.demo-tag.ok{color:var(--emerald)}.demo-tag.no{color:var(--rose)}.demo-line{font:17px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink);background:#0f0f0f;border-radius:10px;padding:12px 16px;white-space:pre-wrap;word-break:break-word;display:block}.demo-line.out{color:var(--emerald)}.demo-line.err{color:var(--rose)}.demo-note{font-size:17px;color:var(--dim)}.dd-caption{font-size:20px;color:var(--dim);margin:18px 0 12px;max-width:1100px}.dd-imgs{flex:1;display:grid;gap:24px;min-height:0}.dd-grid-1{grid-template-columns:1fr}.dd-grid-2{grid-template-columns:1fr 1fr}.dd-fig{margin:0;display:flex;flex-direction:column;min-height:0}.dd-shot{flex:1;min-height:0;object-fit:contain;width:100%;border:1px solid var(--line);border-radius:12px;background:#0f0f0f;cursor:zoom-in}.dd-fig figcaption{font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--faint);padding-top:8px}.cmd-list{flex:1;display:flex;flex-direction:column;gap:18px;justify-content:center;overflow:auto;min-height:0;margin-top:12px}.cmd-row{display:flex;flex-direction:column;gap:6px}.cmd-label{font-size:18px;color:var(--dim);max-width:100ch}.cmd-label b{color:var(--rose);font-variant-numeric:tabular-nums}.cmd-code{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--emerald);background:rgba(52,211,153,.07);border:1px solid rgba(52,211,153,.18);border-radius:10px;padding:10px 14px;white-space:pre-wrap;word-break:break-all;display:block}.deck-hud{position:fixed;left:0;right:0;bottom:14px;display:flex;justify-content:center;gap:18px;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim);z-index:5;pointer-events:none}.deck-hud b{color:var(--ink);font-weight:600}.deck-hud .dd-hint{color:var(--amber)}.lb{position:fixed;inset:0;background:#000d;display:none;align-items:center;justify-content:center;z-index:50;cursor:zoom-out}.lb.on{display:flex}.lb img{max-width:96vw;max-height:96vh;object-fit:contain;box-shadow:0 0 120px #000}@page{size:16.666667in 9.375in;margin:0}@media print{html,body{height:auto;overflow:visible;background:#fff}body{display:block}.deck-stage{position:static;display:block;inset:auto}.deck-frame{display:block!important;transform:none!important}.slide{box-shadow:none;border-radius:0;break-after:page;page-break-after:always}.deck-frame:last-child .slide{break-after:auto;page-break-after:auto}.deck-hud,.lb{display:none!important}}`
  const script = `const CHILDREN=${JSON.stringify(childCounts)};const N=CHILDREN.length;let p=0,d=0;const frames={};document.querySelectorAll('.deck-frame').forEach(f=>frames[f.dataset.frame]=f);function fit(frame){const s=Math.min((innerWidth-48)/1600,(innerHeight-70)/900);frame.style.transform='scale('+s+')';frame.style.width='1600px';frame.style.height='900px';frame.style.flex='0 0 auto'}function key(){return d?p+'.'+d:String(p)}function show(){document.querySelectorAll('.deck-frame.on').forEach(f=>f.classList.remove('on'));const f=frames[key()];f.classList.add('on');fit(f);document.getElementById('pos').textContent=d?(p+1)+'.'+d+' / '+N:(p+1)+' / '+N;document.getElementById('ddh').hidden=!(d===0&&CHILDREN[p]>0);const h=d?'#'+(p+1)+'.'+d:'#'+(p+1);if(location.hash!==h)history.replaceState(null,'',h)}function go(np,nd){p=Math.max(0,Math.min(N-1,np));d=Math.max(0,Math.min(CHILDREN[p],nd));show()}addEventListener('keydown',e=>{const lb=document.getElementById('lb');if(e.key==='Escape'&&lb.classList.contains('on'))return lb.classList.remove('on');if(e.key==='ArrowRight'||e.key==='PageDown')go(p+1,0);else if(e.key==='ArrowLeft'||e.key==='PageUp')go(p-1,0);else if(e.key==='ArrowDown'&&d<CHILDREN[p])go(p,d+1);else if(e.key==='ArrowUp'&&d>0)go(p,d-1)});addEventListener('resize',()=>fit(frames[key()]));function fromHash(){const m=location.hash.match(/^#(\\d+)(?:\\.(\\d+))?$/);if(m)go(parseInt(m[1])-1,m[2]?parseInt(m[2]):0);else show()}addEventListener('hashchange',fromHash);document.addEventListener('click',e=>{const lb=document.getElementById('lb');if(e.target.closest('.lb'))return lb.classList.remove('on');const img=e.target.closest('.deck-frame.on img');if(img){document.getElementById('lbimg').src=img.src;lb.classList.add('on')}});fromHash();`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Two rewrites in one branch — reviewer deck</title><style>${css}</style></head><body><div class="deck-stage">${frames.join("")}</div><div class="deck-hud"><span><b id="pos"></b></span><span>←/→ slides</span><span id="ddh" class="dd-hint" hidden>↓ details</span><span>click screenshots for full screen</span></div><div class="lb" id="lb"><img id="lbimg" alt=""></div><script>${script}</script></body></html>`
}
