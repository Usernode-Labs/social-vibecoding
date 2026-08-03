import fs from "node:fs"
import path from "node:path"

const frontendRoot = process.cwd()
const sourcePath = path.join(frontendRoot, "design-system", "tokens.json")
const outputPath = path.join(frontendRoot, "src", "generated", "design-tokens.css")

function readTokens() {
  return JSON.parse(fs.readFileSync(sourcePath, "utf8"))
}

function colorToCss(token, label) {
  if (token?.$type !== "color" && !token?.$value) {
    throw new Error(`${label} must be a DTCG color token`)
  }
  const value = token.$value
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
    .map(([name, token]) => `  --${name}: ${colorToCss(token, `semantic.${selector}.${name}`)};`)
  return `${selector === "light" ? ":root" : ".dark"} {\n${lines.join("\n")}\n}`
}

const identitySlots = Array.from({ length: 8 }, (_, index) => index + 1)
const statusRoles = ["positive", "info", "warning", "negative"]
const semanticRoles = [...statusRoles, "attention"]

function semanticToken(tokens, name, label) {
  const token = tokens[name]
  if (!token) throw new Error(`${label}.${name} is required`)
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

function relativeLuminance(token) {
  const [red, green, blue] = oklchToLinearSrgb(token.$value)
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrastRatio(left, right) {
  const [high, low] = [relativeLuminance(left), relativeLuminance(right)].sort((a, b) => b - a)
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

function validateSurfaceFoundation(tokens, mode) {
  const label = `semantic.${mode}`
  const background = { label: `${label}.background`, token: semanticToken(tokens, "background", label) }
  const stage = { label: `${label}.stage`, token: semanticToken(tokens, "stage", label) }
  const card = { label: `${label}.card`, token: semanticToken(tokens, "card", label) }
  const recess = { label: `${label}.recess`, token: semanticToken(tokens, "recess", label) }
  const mutedForeground = semanticToken(tokens, "muted-foreground", label)

  assertLightnessStep(background, card, 0.02, `${label} Canvas to Paper`)
  assertLightnessStep(background, stage, 0.02, `${label} shell Canvas to hosted Canvas`)
  assertLightnessStep(stage, card, 0.02, `${label} hosted Canvas to Paper`)
  assertLightnessStep(recess, card, 0.02, `${label} Recess to Paper`)
  assertContrast(semanticToken(tokens, "foreground", label), recess.token, 4.5, `${label}.foreground/Recess`)
  assertContrast(mutedForeground, background.token, 4.5, `${label}.muted-foreground/Canvas`)
  assertContrast(mutedForeground, recess.token, 4.5, `${label}.muted-foreground/Recess`)
  assertContrast(semanticToken(tokens, "destructive", label), background.token, 4.5, `${label}.destructive text/Canvas`)
  assertContrast(semanticToken(tokens, "destructive", label), card.token, 4.5, `${label}.destructive text/Paper`)
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
