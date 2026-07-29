import type { AppIdentityInput, AppIdentityPayloadV1 } from "@/lib/app-identity-contract"

export const APP_SHORTCUT_CONTRACT = "usernode.app-shortcut" as const
export const APP_SHORTCUT_CONTRACT_VERSION = 1 as const
export const APP_SHORTCUT_ROUTE_CONTRACT = "usernode.react-app-open.v1" as const
export const MAX_NATIVE_SHORTCUT_LABEL_CODE_UNITS = 48 as const

export type AppShortcutRequestV1 = {
  contract: typeof APP_SHORTCUT_CONTRACT
  contract_version: typeof APP_SHORTCUT_CONTRACT_VERSION
  route_contract: typeof APP_SHORTCUT_ROUTE_CONTRACT
  name: string
  url: string
  icon_url: string | null
  identity: AppIdentityPayloadV1
  silent: boolean
}

export type AppShortcutRequestOptions = {
  origin: string | URL
  innerPath?: string | null
  silent?: boolean
}

export type AppShortcutNativeEnvelopeV1 = {
  method: "addHomeScreenShortcut"
  id: string
  args: AppShortcutRequestV1
}

type ShortcutRuntime = {
  createShortcutArgs: (app: AppIdentityInput, options: AppShortcutRequestOptions) => AppShortcutRequestV1
  createNativeEnvelope: (id: string, args: AppShortcutRequestV1) => AppShortcutNativeEnvelopeV1
  nativeShortcutLabel: (name: string) => string
  validateArgs: (value: unknown) => boolean
  validateEnvelope: (value: unknown) => boolean
}

function runtime() {
  const contract = globalThis.UsernodeAppShortcutContract as (ShortcutRuntime | undefined)
  if (!contract) throw new Error("The portable app shortcut contract runtime was not loaded")
  return contract
}

/**
 * One versioned request for every new Android shortcut and iOS widget item.
 * Existing native builds consume name/url/icon_url. A native follow-up must
 * persist `identity.appearance_hash` and regenerate cached artwork when it
 * changes; until that lands, this metadata is additive evidence, not proof of
 * native identity adoption.
 */
export function createAppShortcutRequest(
  app: AppIdentityInput,
  options: AppShortcutRequestOptions
): AppShortcutRequestV1 {
  return runtime().createShortcutArgs(app, options)
}

export function appShortcutNativeLabel(displayName: string) {
  return runtime().nativeShortcutLabel(displayName)
}

export function isAppShortcutRequestV1(value: unknown): value is AppShortcutRequestV1 {
  return runtime().validateArgs(value)
}

export function createAppShortcutNativeEnvelope(
  id: string,
  args: AppShortcutRequestV1
): AppShortcutNativeEnvelopeV1 {
  return runtime().createNativeEnvelope(id, args)
}

export function isAppShortcutNativeEnvelopeV1(value: unknown): value is AppShortcutNativeEnvelopeV1 {
  return runtime().validateEnvelope(value)
}
