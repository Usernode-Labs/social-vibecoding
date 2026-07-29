import { readFileSync } from "node:fs"

import { expect, test } from "@playwright/test"

import "../public/app-shortcut-contract.js"
import {
  appShortcutNativeLabel,
  createAppShortcutNativeEnvelope,
  createAppShortcutRequest,
  isAppShortcutNativeEnvelopeV1,
  isAppShortcutRequestV1,
} from "../@/lib/app-shortcut-contract"
import {
  appOpenPath,
  appShortcutTarget,
  reactAppOpenPath,
  safeAppInnerPath,
} from "../@/lib/routes"

const recipeBot = {
  id: "immutable-recipebot-id",
  slug: "recipe bot",
  name: "RecipeBot",
  icon_url: "/app-icons/0123456789abcdef0123456789abcdef",
}

type JsonSchema = Record<string, unknown> & {
  $defs?: Record<string, JsonSchema>
}

function schemaValid(schema: JsonSchema, value: unknown, root = schema): boolean {
  if (typeof schema.$ref === "string") {
    const segments = schema.$ref.replace(/^#\//, "").split("/")
    let resolved: unknown = root
    for (const segment of segments) resolved = (resolved as Record<string, unknown>)[segment]
    return schemaValid(resolved as JsonSchema, value, root)
  }
  if ("const" in schema && value !== schema.const) return false
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.filter((option) => schemaValid(option as JsonSchema, value, root)).length === 1
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const record = value as Record<string, unknown>
    const required = Array.isArray(schema.required) ? schema.required as string[] : []
    if (required.some((key) => !(key in record))) return false
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>
    if (schema.additionalProperties === false && Object.keys(record).some((key) => !(key in properties))) return false
    return Object.entries(properties).every(([key, property]) => !(key in record) || schemaValid(property, record[key], root))
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return false
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return false
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) return false
  }
  if (schema.type === "integer") {
    if (!Number.isInteger(value)) return false
    if (typeof schema.minimum === "number" && (value as number) < schema.minimum) return false
    if (typeof schema.maximum === "number" && (value as number) > schema.maximum) return false
  }
  if (schema.type === "null" && value !== null) return false
  if (schema.type === "boolean" && typeof value !== "boolean") return false
  return true
}

function setFixturePath(target: Record<string, unknown>, path: string, value: unknown, remove: boolean) {
  const segments = path.split(".")
  let owner = target
  for (const segment of segments.slice(0, -1)) owner = owner[segment] as Record<string, unknown>
  if (remove) delete owner[segments.at(-1)!]
  else owner[segments.at(-1)!] = value
}

test("pins one canonical React host route with an optional safe inner path", () => {
  expect(appOpenPath(recipeBot.slug)).toBe("/apps/recipe%20bot/open")
  expect(reactAppOpenPath(recipeBot.slug)).toBe("/react/apps/recipe%20bot/open")
  expect(appShortcutTarget("https://social.example/", recipeBot.slug))
    .toBe("https://social.example/react/apps/recipe%20bot/open")

  const target = new URL(appShortcutTarget(
    "https://social.example/ignored/base",
    recipeBot.slug,
    "/recipes?query=tomato&sort=recent"
  ))
  expect(target.pathname).toBe("/react/apps/recipe%20bot/open")
  expect(target.searchParams.get("path")).toBe("/recipes?query=tomato&sort=recent")
})

test("rejects an unsafe inner path or shortcut origin", () => {
  expect(safeAppInnerPath("/recipes/tomato")).toBe("/recipes/tomato")
  for (const unsafe of [
    "//attacker.example",
    "/recipes with spaces",
    "/recipes\\escape",
    `/${"a".repeat(513)}`,
  ]) {
    expect(safeAppInnerPath(unsafe)).toBeNull()
    expect(() => appShortcutTarget("https://social.example", recipeBot.slug, unsafe))
      .toThrow("unsafe inner path")
  }

  expect(() => appShortcutTarget("javascript:alert(1)", recipeBot.slug))
    .toThrow("HTTP(S) origin")
  expect(() => appShortcutTarget("https://user:pass@social.example", recipeBot.slug))
    .toThrow("without credentials")
})

test("serializes a frozen identity and appearance cache key into the request", () => {
  const request = createAppShortcutRequest(recipeBot, { origin: "https://social.example/base" })

  expect(request).toEqual({
    contract: "usernode.app-shortcut",
    contract_version: 1,
    route_contract: "usernode.react-app-open.v1",
    name: "RecipeBot",
    url: "https://social.example/react/apps/recipe%20bot/open",
    icon_url: "https://social.example/app-icons/0123456789abcdef0123456789abcdef",
    identity: {
      contract: "usernode.app-identity",
      contract_version: 1,
      hash_algorithm: "fnv1a64",
      identity_key: "id:immutable-recipebot-id",
      identity_hash: "fnv1a64:1131aa589733488c",
      appearance_hash: "fnv1a64:14615e0a0b637166",
      slot: 8,
      display_name: "RecipeBot",
      monogram: "R",
      artwork_ref: "/app-icons/0123456789abcdef0123456789abcdef",
    },
    silent: false,
  })
  expect(isAppShortcutRequestV1(request)).toBe(true)
  expect(isAppShortcutRequestV1({ ...request, contract_version: 2 })).toBe(false)
})

test("derives a grapheme-safe native label while preserving the full display name", () => {
  const fullName = `${"A".repeat(43)}👩‍🍳X Recipe collection`
  const request = createAppShortcutRequest(
    { ...recipeBot, name: fullName },
    { origin: "https://social.example" }
  )

  expect(request.identity.display_name).toBe(fullName)
  expect(request.name).toBe(`${"A".repeat(43)}👩‍🍳`)
  expect(request.name.length).toBe(48)
  expect(request.name).toBe(appShortcutNativeLabel(fullName))
  expect(request.name).toContain("\u200d")
  expect(isAppShortcutRequestV1(request)).toBe(true)
  expect(isAppShortcutRequestV1({ ...request, name: `${"A".repeat(43)}👩` })).toBe(false)
})

test("uses a readable fallback rather than splitting a grapheme without Intl.Segmenter", () => {
  const descriptor = Object.getOwnPropertyDescriptor(Intl, "Segmenter")
  Object.defineProperty(Intl, "Segmenter", { configurable: true, value: undefined })
  try {
    expect(appShortcutNativeLabel(`${"A".repeat(48)}👩‍🍳`)).toBe("App")
  } finally {
    if (descriptor) Object.defineProperty(Intl, "Segmenter", descriptor)
  }
})

test("serializes numeric app ids inside the exact hosted-bridge envelope and silent policy", () => {
  const args = createAppShortcutRequest(
    { ...recipeBot, id: 900001 },
    { origin: "https://social.example", silent: true }
  )
  const envelope = createAppShortcutNativeEnvelope("1785340000000-a1b2c3", args)

  expect(envelope).toEqual({
    method: "addHomeScreenShortcut",
    id: "1785340000000-a1b2c3",
    args,
  })
  expect(args.identity.identity_key).toBe("id:900001")
  expect(args.silent).toBe(true)
  expect(isAppShortcutNativeEnvelopeV1(envelope)).toBe(true)
  expect(isAppShortcutNativeEnvelopeV1({ ...envelope, id: 42 })).toBe(false)
  expect(isAppShortcutNativeEnvelopeV1({ ...envelope, id: "42" })).toBe(false)
  expect(isAppShortcutNativeEnvelopeV1({ ...envelope, id: undefined })).toBe(false)
  expect(isAppShortcutNativeEnvelopeV1({ ...envelope, method: "unknown" })).toBe(false)
  expect(() => createAppShortcutNativeEnvelope("invalid", args)).toThrow("timestamp-random format")
})

test("accepts validated image data artwork and rejects arbitrary or private artwork URLs", () => {
  const imageData = createAppShortcutRequest(
    { ...recipeBot, icon_url: "data:image/png;base64,AA==" },
    { origin: "https://social.example" }
  )
  expect(imageData.icon_url).toBe("data:image/png;base64,AA==")

  expect(() => createAppShortcutRequest(
    { ...recipeBot, icon_url: "javascript:alert(1)" },
    { origin: "https://social.example" }
  )).toThrow("same-origin content-addressed")

  for (const icon_url of [
    "https://cdn.example/app-icons/0123456789abcdef0123456789abcdef",
    "https://127.0.0.1/app-icons/0123456789abcdef0123456789abcdef",
    "https://user:pass@social.example/app-icons/0123456789abcdef0123456789abcdef",
    "https://social.example/app-icons/0123456789abcdef0123456789abcdef?revision=2",
    "/uploads/arbitrary.png",
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "data:image/png;base64,!",
  ]) {
    expect(() => createAppShortcutRequest(
      { ...recipeBot, icon_url },
      { origin: "https://social.example" }
    ), icon_url).toThrow()
  }
})

test("keeps the packaged portable schema aligned with the runtime contract", async ({ request }) => {
  const schema = JSON.parse(
    readFileSync(new URL("../public/contracts/app-shortcut.v1.schema.json", import.meta.url), "utf8")
  ) as {
    $id: string
    required: string[]
    properties: Record<string, { const?: unknown; $ref?: string }>
    $defs: {
      appShortcutArgsV1: { required: string[]; properties: Record<string, { const?: unknown; $ref?: string }> }
      appIdentityV1: { required: string[]; properties: Record<string, { const?: unknown }> }
    }
  }

  expect(schema.$id).toContain("app-shortcut.v1.schema.json")
  expect(schema.required).toEqual(["method", "id", "args"])
  expect(schema.properties.method.const).toBe("addHomeScreenShortcut")
  expect(schema.properties.args.$ref).toBe("#/$defs/appShortcutArgsV1")
  expect(schema.$defs.appShortcutArgsV1.required).toEqual([
    "contract",
    "contract_version",
    "route_contract",
    "name",
    "url",
    "icon_url",
    "identity",
    "silent",
  ])
  expect(schema.$defs.appShortcutArgsV1.properties.contract.const).toBe("usernode.app-shortcut")
  expect(schema.$defs.appShortcutArgsV1.properties.route_contract.const).toBe("usernode.react-app-open.v1")
  expect(schema.$defs.appShortcutArgsV1.properties.identity.$ref).toBe("#/$defs/appIdentityV1")
  expect(schema.$defs.appIdentityV1.required).toContain("appearance_hash")
  expect(schema.$defs.appIdentityV1.properties.hash_algorithm.const).toBe("fnv1a64")

  const packaged = await request.get("/react/contracts/app-shortcut.v1.schema.json")
  expect(packaged.ok()).toBe(true)
  const packagedSchema = await packaged.json()
  expect(packagedSchema).toMatchObject({
    $id: schema.$id,
    properties: {
      method: { const: "addHomeScreenShortcut" },
      args: { $ref: "#/$defs/appShortcutArgsV1" },
    },
  })
})

test("loads the portable runtime from the canonical base on nested history routes", async ({ page }) => {
  await page.route("**/api/apps/recipebot", (route) => route.fulfill({ json: { app: recipeBot } }))
  await page.route("**/api/auth/me", (route) => route.fulfill({
    json: { user: { id: 7, username: "ava", canAdminWrite: false } },
  }))

  await page.goto("/react/apps/recipebot/open")
  expect(await page.evaluate(() => typeof globalThis.UsernodeAppShortcutContract?.createShortcutArgs))
    .toBe("function")
  const source = await page.locator('script[src$="/app-shortcut-contract.js"]').getAttribute("src")
  expect(source).toBe("/react/app-shortcut-contract.js")
})

test("keeps runtime and packaged schema aligned across shared adversarial fixtures", () => {
  const schema = JSON.parse(
    readFileSync(new URL("../public/contracts/app-shortcut.v1.schema.json", import.meta.url), "utf8")
  ) as JsonSchema
  const fixtures = JSON.parse(
    readFileSync(new URL("../public/contracts/app-shortcut.v1.fixtures.json", import.meta.url), "utf8")
  ) as {
    cases: Array<{
      name: string
      path?: string
      value?: unknown
      remove?: boolean
      expected_valid: boolean
      expected_schema_valid?: boolean
    }>
  }
  const baseline = createAppShortcutNativeEnvelope(
    "1785340000000-a1b2c3",
    createAppShortcutRequest(
      { ...recipeBot, id: 900001 },
      { origin: "https://social.example" }
    )
  )

  for (const fixture of fixtures.cases) {
    const candidate = structuredClone(baseline) as unknown as Record<string, unknown>
    if (fixture.path) setFixturePath(candidate, fixture.path, fixture.value, fixture.remove === true)
    expect(schemaValid(schema, candidate), `${fixture.name}: schema`)
      .toBe(fixture.expected_schema_valid ?? fixture.expected_valid)
    expect(isAppShortcutNativeEnvelopeV1(candidate), `${fixture.name}: runtime`).toBe(fixture.expected_valid)
  }
})
