import fs from "node:fs"
import path from "node:path"

const frontendRoot = process.cwd()
const sourcePath = path.join(frontendRoot, "design-system", "tokens.json")
const outputPath = path.join(frontendRoot, "src", "generated", "design-tokens.css")

function readTokens() {
  return JSON.parse(fs.readFileSync(sourcePath, "utf8"))
}

function referenceTarget(value, label, mode) {
  const match = /^\{semantic\.(light|dark)\.([a-z0-9-]+)\}$/.exec(value)
  if (!match) throw new Error(`${label} must reference a semantic color in the same mode`)
  if (match[1] !== mode) throw new Error(`${label} cannot reference semantic.${match[1]} from semantic.${mode}`)
  return match[2]
}

function colorToCss(token, label, mode) {
  if (token?.$type !== "color" && !token?.$value) {
    throw new Error(`${label} must be a DTCG color token`)
  }
  const value = token.$value
  if (typeof value === "string") return `var(--${referenceTarget(value, label, mode)})`
  if (value?.colorSpace !== "oklch" || !Array.isArray(value.components) || value.components.length !== 3) {
    throw new Error(`${label} must use an oklch DTCG color value`)
  }
  const [lightness, chroma, hue] = value.components
  const alpha = value.alpha === undefined ? "" : ` / ${Math.round(value.alpha * 100)}%`
  return `oklch(${lightness} ${chroma} ${hue}${alpha})`
}

function renderBlock(selector, tokens) {
  const lines = Object.entries(tokens)
    .filter(([key]) => !key.startsWith("$"))
    .map(([name, token]) => `  --${name}: ${colorToCss(token, `semantic.${selector}.${name}`, selector)};`)
  return `${selector === "light" ? ":root" : ".dark"} {\n${lines.join("\n")}\n}`
}

const identitySlots = Array.from({ length: 8 }, (_, index) => index + 1)
const statusRoles = ["positive", "info", "warning", "negative"]
const semanticRoles = [...statusRoles, "attention"]

function semanticToken(tokens, name, label, seen = new Set()) {
  const token = tokens[name]
  if (!token) throw new Error(`${label}.${name} is required`)
  if (seen.has(name)) throw new Error(`${label}.${name} has a circular semantic reference`)
  if (typeof token.$value === "string") {
    const target = referenceTarget(token.$value, `${label}.${name}`, label.split(".")[1])
    return semanticToken(tokens, target, label, new Set([...seen, name]))
  }
  return token
}

function oklchToLinearSrgb({ components }) {
  const [lightness, chroma, hue] = components
  const radians = hue * Math.PI / 180
  const a = chroma * Math.cos(radians)
  const b = chroma * Math.sin(radians)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((channel) => Math.max(0, Math.min(1, channel)))
}

function linearToSrgb(channel) {
  return channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055
}

function srgbToLinear(channel) {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

function tokenSrgb(token) {
  return oklchToLinearSrgb(token.$value).map(linearToSrgb)
}

function tokenAlpha(token) {
  return token.$value.alpha ?? 1
}

function compositeToken(token, backdrop) {
  const alpha = tokenAlpha(token)
  const source = tokenSrgb(token)
  return source.map((channel, index) => channel * alpha + backdrop[index] * (1 - alpha))
}

function relativeLuminance(color) {
  const [red, green, blue] = color.map(srgbToLinear)
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrastRatio(left, right) {
  const rightColor = tokenSrgb(right)
  const leftColor = compositeToken(left, rightColor)
  const [high, low] = [relativeLuminance(leftColor), relativeLuminance(rightColor)].sort((a, b) => b - a)
  return (high + 0.05) / (low + 0.05)
}

function assertContrast(left, right, minimum, label) {
  const ratio = contrastRatio(left, right)
  if (ratio < minimum) throw new Error(`${label} contrast ${ratio.toFixed(2)}:1 is below ${minimum}:1`)
}

function lightness(token, label) {
  const value = token?.$value
  if (value?.colorSpace !== "oklch" || !Array.isArray(value.components)) {
    throw new Error(`${label} must use an oklch DTCG color value`)
  }
  return value.components[0]
}

function assertLightnessStep(lower, upper, minimum, label) {
  const step = lightness(upper.token, upper.label) - lightness(lower.token, lower.label)
  if (step + Number.EPSILON < minimum) {
    throw new Error(`${label} lightness step ${step.toFixed(3)} is below ${minimum.toFixed(3)}`)
  }
}

function assertAlias(tokens, name, target, mode) {
  const expected = `{semantic.${mode}.${target}}`
  if (tokens[name]?.$value !== expected) {
    throw new Error(`semantic.${mode}.${name} must alias semantic.${mode}.${target}`)
  }
}

function assertContainerSystem(tokens, mode, paper) {
  const label = `semantic.${mode}`
  const container = semanticToken(tokens, "container", label)
  const alpha = tokenAlpha(container)
  if (alpha < 0.04 || alpha > 0.08) {
    throw new Error(`${label}.container alpha ${alpha.toFixed(2)} must stay between 0.04 and 0.08`)
  }

  const stack = [tokenSrgb(paper)]
  for (let depth = 1; depth <= 3; depth += 1) {
    stack.push(compositeToken(container, stack.at(-1)))
  }
  const luminances = stack.map(relativeLuminance)
  for (let depth = 1; depth < luminances.length; depth += 1) {
    const movesInExpectedDirection = mode === "light"
      ? luminances[depth] < luminances[depth - 1]
      : luminances[depth] > luminances[depth - 1]
    if (!movesInExpectedDirection) {
      throw new Error(`${label}.container must ${mode === "light" ? "darken" : "lighten"} its immediate context at depth ${depth}`)
    }
  }

  const foregroundRoles = ["fg-primary", "fg-secondary", "fg-tertiary"]
  const foregroundAlphas = foregroundRoles.map((name) => tokenAlpha(semanticToken(tokens, name, label)))
  if (!(foregroundAlphas[0] > foregroundAlphas[1] && foregroundAlphas[1] > foregroundAlphas[2])) {
    throw new Error(`${label} foreground alpha must descend primary to secondary to tertiary`)
  }
  for (const role of [...foregroundRoles, "destructive"]) {
    const foreground = semanticToken(tokens, role, label)
    for (let depth = 0; depth < stack.length; depth += 1) {
      const foregroundColor = compositeToken(foreground, stack[depth])
      const ratio = (() => {
        const [high, low] = [relativeLuminance(foregroundColor), relativeLuminance(stack[depth])].sort((a, b) => b - a)
        return (high + 0.05) / (low + 0.05)
      })()
      if (ratio < 4.5) {
        throw new Error(`${label}.${role}/Container depth ${depth} contrast ${ratio.toFixed(2)}:1 is below 4.5:1`)
      }
    }
  }
}

function validateSurfaceFoundation(tokens, mode) {
  const label = `semantic.${mode}`
  const background = { label: `${label}.background`, token: semanticToken(tokens, "background", label) }
  const stage = { label: `${label}.stage`, token: semanticToken(tokens, "stage", label) }
  const paper = { label: `${label}.paper`, token: semanticToken(tokens, "paper", label) }
  const mutedForeground = semanticToken(tokens, "muted-foreground", label)

  assertAlias(tokens, "foreground", "fg-primary", mode)
  assertAlias(tokens, "muted-foreground", "fg-secondary", mode)
  assertAlias(tokens, "card", "paper", mode)
  assertLightnessStep(background, paper, 0.02, `${label} Canvas to Paper`)
  assertLightnessStep(background, stage, 0.02, `${label} shell Canvas to hosted Canvas`)
  assertLightnessStep(stage, paper, 0.02, `${label} hosted Canvas to Paper`)
  assertContainerSystem(tokens, mode, paper.token)
  assertContrast(mutedForeground, background.token, 4.5, `${label}.muted-foreground/Canvas`)
  assertContrast(semanticToken(tokens, "destructive", label), background.token, 4.5, `${label}.destructive text/Canvas`)
  assertContrast(semanticToken(tokens, "destructive", label), paper.token, 4.5, `${label}.destructive text/Paper`)
}

function validateSemanticFoundation(tokens, mode) {
  const label = `semantic.${mode}`
  assertContrast(
    semanticToken(tokens, "destructive-foreground", label),
    semanticToken(tokens, "destructive", label),
    4.5,
    `${label}.destructive foreground/background`
  )
  for (const slot of identitySlots) {
    const surface = semanticToken(tokens, `identity-${slot}-surface`, label)
    const foreground = semanticToken(tokens, `identity-${slot}-foreground`, label)
    const border = semanticToken(tokens, `identity-${slot}-border`, label)
    assertContrast(foreground, surface, 4.5, `${label}.identity-${slot} foreground/surface`)
    assertContrast(border, semanticToken(tokens, "card", label), 3, `${label}.identity-${slot} border/card`)
    assertContrast(semanticToken(tokens, "ring", label), surface, 3, `${label}.identity-${slot} focus ring/surface`)
  }
  for (const role of semanticRoles) {
    const surface = semanticToken(tokens, `${role === "attention" ? "attention" : `status-${role}`}-surface`, label)
    const foreground = semanticToken(tokens, `${role === "attention" ? "attention" : `status-${role}`}-foreground`, label)
    const border = semanticToken(tokens, `${role === "attention" ? "attention" : `status-${role}`}-border`, label)
    assertContrast(foreground, surface, 4.5, `${label}.${role} foreground/surface`)
    assertContrast(border, semanticToken(tokens, "card", label), 3, `${label}.${role} border/card`)
    assertContrast(semanticToken(tokens, "ring", label), surface, 3, `${label}.${role} focus ring/surface`)
  }
}

function renderSemanticComponentAliases() {
  const identityRules = identitySlots.map((slot) => `
.app-identity[data-identity-slot="${slot}"] {
  --app-identity-surface: var(--identity-${slot}-surface);
  --app-identity-foreground: var(--identity-${slot}-foreground);
  --app-identity-border: var(--identity-${slot}-border);
}`).join("\n")
  const statusRules = semanticRoles.map((role) => {
    const prefix = role === "attention" ? "attention" : `status-${role}`
    return `
.status-dot[data-status-role="${role}"] {
  --status-dot-surface: var(--${prefix}-surface);
  --status-dot-foreground: var(--${prefix}-foreground);
  --status-dot-border: var(--${prefix}-border);
}`
  }).join("\n")
  const statusSurfaceRules = statusRoles.map((role) => `
.status-surface[data-status-tone="${role}"] {
  --status-surface: var(--status-${role}-surface);
  --status-surface-foreground: var(--status-${role}-foreground);
  --status-surface-border: var(--status-${role}-border);
}`).join("\n")
  const neutralRule = `
.status-dot[data-status-role="neutral"] {
  --status-dot-surface: var(--muted);
  --status-dot-foreground: var(--muted-foreground);
  --status-dot-border: var(--border);
}`
  return `
.app-identity {
  background-color: var(--app-identity-surface);
  border-color: var(--app-identity-border);
  color: var(--app-identity-foreground);
}
${identityRules}

.status-dot {
  background-color: var(--status-dot-surface);
  border-color: var(--status-dot-border);
  color: var(--status-dot-foreground);
}
${statusRules}${neutralRule}

.status-surface {
  background-color: var(--status-surface);
  border-color: var(--status-surface-border);
  color: var(--status-surface-foreground);
}
${statusSurfaceRules}`
}

function renderForcedColorsOverrides() {
  return `@media (forced-colors: active) {
  .app-identity {
    background-color: Canvas;
    border-color: CanvasText;
    color: CanvasText;
  }

  .status-dot {
    background-color: CanvasText;
    border-color: Canvas;
    color: CanvasText;
    outline: 1px solid CanvasText;
    outline-offset: 1px;
  }

  .status-surface {
    background-color: Canvas;
    border-color: CanvasText;
    color: CanvasText;
  }
}`
}

export function renderDesignTokens() {
  const tokens = readTokens()
  if (tokens.$schema !== "https://www.designtokens.org/schemas/2025.10/format.json") {
    throw new Error("tokens.json must use the DTCG 2025.10 schema")
  }
  const radius = tokens.foundation?.radius?.base?.$value
  const font = tokens.foundation?.font?.sans?.$value
  if (radius?.unit !== "rem" || typeof radius.value !== "number") {
    throw new Error("foundation.radius.base must be a rem dimension")
  }
  if (!Array.isArray(font) || font.length === 0) {
    throw new Error("foundation.font.sans must be a fontFamily token")
  }
  const light = tokens.semantic?.light
  const dark = tokens.semantic?.dark
  const lightNames = Object.keys(light || {}).filter((key) => !key.startsWith("$")).sort()
  const darkNames = Object.keys(dark || {}).filter((key) => !key.startsWith("$")).sort()
  if (JSON.stringify(lightNames) !== JSON.stringify(darkNames)) {
    throw new Error("light and dark semantic color modes must expose the same token names")
  }
  validateSemanticFoundation(light, "light")
  validateSemanticFoundation(dark, "dark")
  validateSurfaceFoundation(light, "light")
  validateSurfaceFoundation(dark, "dark")
  return `${[
    "/* Generated from design-system/tokens.json. Do not edit directly. */",
    `:root {\n  --font-sans-authority: ${font.map((part) => part.includes(" ") ? `'${part}'` : part).join(", ")};\n  --radius: ${radius.value}${radius.unit};\n}`,
    renderBlock("light", light),
    renderBlock("dark", dark),
    renderSemanticComponentAliases(),
    renderForcedColorsOverrides(),
  ].join("\n\n")}\n`
}

export function writeDesignTokens() {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, renderDesignTokens())
}

export function checkDesignTokens() {
  const expected = renderDesignTokens()
  const actual = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : ""
  if (actual !== expected) {
    throw new Error("src/generated/design-tokens.css is stale. Run npm run build:tokens.")
  }
}
