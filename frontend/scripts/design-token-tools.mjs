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
  return `${[
    "/* Generated from design-system/tokens.json. Do not edit directly. */",
    `:root {\n  --font-sans-authority: ${font.map((part) => part.includes(" ") ? `'${part}'` : part).join(", ")};\n  --radius: ${radius.value}${radius.unit};\n}`,
    renderBlock("light", light),
    renderBlock("dark", dark),
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
