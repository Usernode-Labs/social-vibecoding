import {
  isAppShortcutRequestV1,
  type AppShortcutRequestV1,
} from "@/lib/app-shortcut-contract"

type NativeChannel = { postMessage: (message: string) => void }

export type NativeProfileInfo = { participantId?: number | null }
export type NativeBridgeInfo = { version: number; capabilities: string[] }
export type NativeHomeScreenShortcutSupport = {
  mechanism: "pinned-shortcut" | "widget"
  widgetInstalled?: boolean
}
export type NativeHomeScreenShortcutResult = {
  added: true
  mechanism?: "pinned-shortcut" | "widget"
}
export type NativeNodeStatus = {
  status?: "synced" | "syncing" | "connecting" | "offline" | string
  localBestHeight?: number | null
  networkBestHeight?: number | null
  connectedPeers?: number | null
  totalPeers?: number | null
}
export type NativeWalletState = {
  address?: string | null
  balance?: string | null
  tokenAmount?: number | null
  tokenSymbol?: string | null
  lastUpdatedMs?: number | null
}
export type NativeSignature = {
  publicKey: string
  signature: string
}
export type NativeTransactionRequest = {
  to: string
  amount: number | string
  memo: string
  confirmTitle?: string
  confirmSubtitle?: string
}
export type NativeSettingsState = {
  buildInfo: {
    appVersion: string | null
    buildNumber: string | null
    nodeVersion: string | null
    commitHash: string | null
    branch: string | null
  }
  nodeSleepEnabled: boolean
  debugMode: boolean
  facematchStrict: boolean
  termsAccepted: boolean | null
  authStatus: string | null
  permissions: {
    platform: "android" | "ios" | string | null
    exactAlarmGranted: boolean
    batteryOptDisabled: boolean | null
    deviceManufacturer: string | null
    iosKeepAliveActive: boolean | null
  }
}

type NativeProfileClient = {
  isNative?: boolean
  getProfileInfo?: () => Promise<NativeProfileInfo | null>
  getBridgeInfo?: () => Promise<NativeBridgeInfo>
  getNodeStatus?: () => Promise<NativeNodeStatus | null>
  getWalletState?: () => Promise<NativeWalletState | null>
  getHomeScreenShortcutSupport?: () => Promise<unknown>
  addHomeScreenShortcut?: (request: AppShortcutRequestV1) => Promise<unknown>
  openExternal?: (url: string) => Promise<boolean>
  openNativeScreen?: (screen: "settings" | "profile" | "benchmark" | "httpLogs" | "terms") => Promise<boolean>
  getSettingsState?: () => Promise<unknown>
  setNodeSleepEnabled?: (enabled: boolean) => Promise<unknown>
  setDebugMode?: (enabled: boolean) => Promise<unknown>
  setFacematchStrict?: (enabled: boolean) => Promise<unknown>
  setIosKeepAlive?: (enabled: boolean) => Promise<unknown>
  requestPermissions?: () => Promise<unknown>
  resetZkChallenge?: () => Promise<boolean>
  openBatterySettings?: () => Promise<boolean>
  logout?: () => Promise<boolean>
}

type NativeWalletGlobals = Window & {
  getNodeAddress?: () => Promise<unknown>
  signMessage?: (message: string) => Promise<unknown>
  sendTransaction?: (
    destinationPubkey: string,
    amount: number | string,
    memo: string,
    options?: {
      confirmTitle?: string
      confirmSubtitle?: string
      waitForInclusion?: boolean
    }
  ) => Promise<unknown>
}

function nativeChannel(): NativeChannel | null {
  const candidate = (window as Window & { Usernode?: NativeChannel }).Usernode
  return candidate && typeof candidate.postMessage === "function" ? candidate : null
}

export function syncNativeTitle(title: string) {
  document.title = title
  try {
    nativeChannel()?.postMessage(JSON.stringify({ method: "titleChanged", value: title }))
  } catch {
    // Desktop has no native channel. Title sync is a Flutter fast path only.
  }
}

export async function getNativeProfileInfo(): Promise<NativeProfileInfo | null> {
  const client = (window as Window & { usernode?: NativeProfileClient }).usernode
  if (typeof client?.getProfileInfo !== "function") return null
  try {
    return await client.getProfileInfo()
  } catch {
    // Old mobile builds and desktop both deliberately resolve to the unavailable state.
    return null
  }
}

function nativeClient(): NativeProfileClient | null {
  return (window as Window & { usernode?: NativeProfileClient }).usernode || null
}

/**
 * Capability discovery is deliberately the only gateway to v2/v3 native
 * chrome. Old app builds and desktop resolve to no bridge rather than trying
 * an unsupported bridge method.
 */
export async function getNativeBridgeInfo(): Promise<NativeBridgeInfo | null> {
  const client = nativeClient()
  // The bundled bridge exists in normal browsers too, but intentionally
  // reports empty capabilities there. Avoid presenting that as an outdated
  // mobile app; it is the ordinary desktop/QR mode.
  if (client?.isNative === false) return null
  if (typeof client?.getBridgeInfo !== "function") return null
  try {
    const info = await client.getBridgeInfo()
    if (!info || !Array.isArray(info.capabilities)) return null
    return { version: Number.isFinite(info.version) ? info.version : 0, capabilities: info.capabilities.filter((capability): capability is string => typeof capability === "string") }
  } catch {
    return null
  }
}

export function hasNativeCapability(info: NativeBridgeInfo | null, capability: string) {
  return info?.capabilities.includes(capability) === true
}

export async function getNativeHomeScreenShortcutSupport(
  info: NativeBridgeInfo | null
): Promise<NativeHomeScreenShortcutSupport | null> {
  const client = nativeClient()
  if (
    !hasNativeCapability(info, "getHomeScreenShortcutSupport")
    || !hasNativeCapability(info, "addHomeScreenShortcut")
    || typeof client?.getHomeScreenShortcutSupport !== "function"
  ) return null
  try {
    const value = await client.getHomeScreenShortcutSupport()
    if (!value || typeof value !== "object") return null
    const row = value as Record<string, unknown>
    if (row.mechanism !== "pinned-shortcut" && row.mechanism !== "widget") return null
    return {
      mechanism: row.mechanism,
      ...(typeof row.widgetInstalled === "boolean" ? { widgetInstalled: row.widgetInstalled } : {}),
    }
  } catch {
    return null
  }
}

/**
 * Sends the versioned web-owned shortcut request through the existing native
 * capability. Current native builds consume name/url/icon_url; Flutter must
 * explicitly adopt contract_version and identity before host evidence may
 * claim cross-platform identity/cache parity.
 */
export async function addNativeHomeScreenShortcut(
  info: NativeBridgeInfo | null,
  request: AppShortcutRequestV1
): Promise<NativeHomeScreenShortcutResult> {
  const client = nativeClient()
  if (!hasNativeCapability(info, "addHomeScreenShortcut") || typeof client?.addHomeScreenShortcut !== "function") {
    throw new Error("Home-screen shortcuts are not available in this Usernode build.")
  }
  if (!isAppShortcutRequestV1(request)) {
    throw new Error("The app shortcut request does not satisfy the web-owned v1 contract.")
  }
  const value = await client.addHomeScreenShortcut(request)
  if (!value || typeof value !== "object" || (value as Record<string, unknown>).added !== true) {
    throw new Error("Usernode did not add the app shortcut.")
  }
  const mechanism = (value as Record<string, unknown>).mechanism
  if (mechanism !== undefined && mechanism !== "pinned-shortcut" && mechanism !== "widget") {
    throw new Error("Usernode returned an unsupported shortcut mechanism.")
  }
  return {
    added: true,
    ...(mechanism ? { mechanism } : {}),
  }
}

export async function openNativeExternalUrl(info: NativeBridgeInfo | null, url: string) {
  const client = nativeClient()
  if (!hasNativeCapability(info, "openExternal") || typeof client?.openExternal !== "function") return false
  try {
    const parsed = new URL(url, window.location.href)
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password
    ) return false
    return await client.openExternal(parsed.toString()) === true
  } catch {
    return false
  }
}

function nativeWalletGlobals() {
  return window as NativeWalletGlobals
}

export async function getNativeWalletAddress(info: NativeBridgeInfo | null) {
  const globals = nativeWalletGlobals()
  if (!hasNativeCapability(info, "getNodeAddress") || typeof globals.getNodeAddress !== "function") {
    throw new Error("Wallet address access is not available in this Usernode build.")
  }
  const value = await globals.getNodeAddress()
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Usernode returned an invalid wallet address.")
  }
  return value.trim()
}

export async function signNativeMessage(info: NativeBridgeInfo | null, message: string): Promise<NativeSignature> {
  const globals = nativeWalletGlobals()
  if (!hasNativeCapability(info, "signMessage") || typeof globals.signMessage !== "function") {
    throw new Error("Wallet signing is not available in this Usernode build.")
  }
  const value = await globals.signMessage(message)
  if (!value || typeof value !== "object") {
    throw new Error("Usernode returned an invalid signature.")
  }
  const row = value as Record<string, unknown>
  const publicKey = typeof row.publicKey === "string" && row.publicKey.trim()
    ? row.publicKey.trim()
    : typeof row.pubkey === "string" && row.pubkey.trim()
      ? row.pubkey.trim()
      : await getNativeWalletAddress(info)
  if (typeof row.signature !== "string" || !row.signature.trim()) {
    throw new Error("Usernode returned an invalid signature.")
  }
  return { publicKey, signature: row.signature.trim() }
}

export async function sendNativeWalletTransaction(
  info: NativeBridgeInfo | null,
  request: NativeTransactionRequest
) {
  const globals = nativeWalletGlobals()
  if (!hasNativeCapability(info, "sendTransaction") || typeof globals.sendTransaction !== "function") {
    throw new Error("Wallet transactions are not available in this Usernode build.")
  }
  const value = await globals.sendTransaction(request.to, request.amount, request.memo, {
    confirmTitle: request.confirmTitle,
    confirmSubtitle: request.confirmSubtitle,
    waitForInclusion: false,
  })
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>
    if (typeof row.error === "string" && row.error.trim()) throw new Error(row.error)
    if (row.queued === false) throw new Error("Usernode did not queue the wallet transaction.")
  }
  return value
}

export async function getNativeNodeStatus(info: NativeBridgeInfo | null): Promise<NativeNodeStatus | null> {
  const client = nativeClient()
  if (!hasNativeCapability(info, "getNodeStatus") || typeof client?.getNodeStatus !== "function") return null
  try {
    return await client.getNodeStatus()
  } catch {
    return null
  }
}

export async function getNativeWalletState(info: NativeBridgeInfo | null): Promise<NativeWalletState | null> {
  const client = nativeClient()
  if (!hasNativeCapability(info, "getWalletState") || typeof client?.getWalletState !== "function") return null
  try {
    return await client.getWalletState()
  } catch {
    return null
  }
}

/** The native app emits an initial event and subsequent meaningful status changes. */
export function subscribeNativeNodeStatus(listener: (status: NativeNodeStatus) => void) {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail
    if (detail && typeof detail === "object") listener(detail as NativeNodeStatus)
  }
  window.addEventListener("usernode:node-status", handler)
  return () => window.removeEventListener("usernode:node-status", handler)
}

/**
 * An explicit, allowlisted native escape hatch. This does not replace native
 * settings or bypass its trusted-origin check; it only asks Flutter to push
 * one of the bridge contract's permitted routes.
 */
export async function openNativeScreen(info: NativeBridgeInfo | null, screen: "settings" | "profile" | "benchmark" | "httpLogs" | "terms") {
  const client = nativeClient()
  if (!hasNativeCapability(info, "openNativeScreen") || typeof client?.openNativeScreen !== "function") return false
  try {
    return await client.openNativeScreen(screen)
  } catch {
    return false
  }
}

function nullableText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function nullableBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null
}

function normalizeNativeSettings(value: unknown): NativeSettingsState | null {
  if (!value || typeof value !== "object") return null
  const row = value as Record<string, unknown>
  const build = row.buildInfo && typeof row.buildInfo === "object"
    ? row.buildInfo as Record<string, unknown>
    : {}
  const permissions = row.permissions && typeof row.permissions === "object"
    ? row.permissions as Record<string, unknown>
    : {}
  return {
    buildInfo: {
      appVersion: nullableText(build.appVersion),
      buildNumber: nullableText(build.buildNumber),
      nodeVersion: nullableText(build.nodeVersion),
      commitHash: nullableText(build.commitHash),
      branch: nullableText(build.branch),
    },
    nodeSleepEnabled: row.nodeSleepEnabled !== false,
    debugMode: row.debugMode === true,
    facematchStrict: row.facematchStrict !== false,
    termsAccepted: nullableBoolean(row.termsAccepted),
    authStatus: nullableText(row.authStatus),
    permissions: {
      platform: nullableText(permissions.platform),
      exactAlarmGranted: permissions.exactAlarmGranted === true,
      batteryOptDisabled: nullableBoolean(permissions.batteryOptDisabled),
      deviceManufacturer: nullableText(permissions.deviceManufacturer),
      iosKeepAliveActive: nullableBoolean(permissions.iosKeepAliveActive),
    },
  }
}

async function nativeSettingsMutation(
  info: NativeBridgeInfo | null,
  capability: string,
  call: ((client: NativeProfileClient) => Promise<unknown>) | undefined
) {
  const client = nativeClient()
  if (!client || !hasNativeCapability(info, capability) || !call) {
    throw new Error(`${capability} is not available in this Usernode build.`)
  }
  const state = normalizeNativeSettings(await call(client))
  if (!state) throw new Error("Usernode returned an invalid settings snapshot.")
  return state
}

export async function getNativeSettingsState(info: NativeBridgeInfo | null) {
  const client = nativeClient()
  if (!hasNativeCapability(info, "getSettingsState") || typeof client?.getSettingsState !== "function") return null
  return normalizeNativeSettings(await client.getSettingsState())
}

export function setNativeNodeSleep(info: NativeBridgeInfo | null, enabled: boolean) {
  const client = nativeClient()
  return nativeSettingsMutation(
    info,
    "setNodeSleepEnabled",
    typeof client?.setNodeSleepEnabled === "function"
      ? (current) => current.setNodeSleepEnabled!(enabled)
      : undefined
  )
}

export function setNativeDebugMode(info: NativeBridgeInfo | null, enabled: boolean) {
  const client = nativeClient()
  return nativeSettingsMutation(
    info,
    "setDebugMode",
    typeof client?.setDebugMode === "function"
      ? (current) => current.setDebugMode!(enabled)
      : undefined
  )
}

export function setNativeFacematchStrict(info: NativeBridgeInfo | null, enabled: boolean) {
  const client = nativeClient()
  return nativeSettingsMutation(
    info,
    "setFacematchStrict",
    typeof client?.setFacematchStrict === "function"
      ? (current) => current.setFacematchStrict!(enabled)
      : undefined
  )
}

export function setNativeIosKeepAlive(info: NativeBridgeInfo | null, enabled: boolean) {
  const client = nativeClient()
  return nativeSettingsMutation(
    info,
    "setIosKeepAlive",
    typeof client?.setIosKeepAlive === "function"
      ? (current) => current.setIosKeepAlive!(enabled)
      : undefined
  )
}

export function requestNativePermissions(info: NativeBridgeInfo | null) {
  const client = nativeClient()
  return nativeSettingsMutation(
    info,
    "requestPermissions",
    typeof client?.requestPermissions === "function"
      ? (current) => current.requestPermissions!()
      : undefined
  )
}

async function nativeBooleanAction(
  info: NativeBridgeInfo | null,
  capability: string,
  call: ((client: NativeProfileClient) => Promise<boolean>) | undefined
) {
  const client = nativeClient()
  if (!client || !hasNativeCapability(info, capability) || !call) {
    throw new Error(`${capability} is not available in this Usernode build.`)
  }
  const result = await call(client)
  if (result !== true) throw new Error("Usernode did not complete the action.")
}

export function resetNativeZkChallenge(info: NativeBridgeInfo | null) {
  const client = nativeClient()
  return nativeBooleanAction(
    info,
    "resetZkChallenge",
    typeof client?.resetZkChallenge === "function"
      ? (current) => current.resetZkChallenge!()
      : undefined
  )
}

export function openNativeBatterySettings(info: NativeBridgeInfo | null) {
  const client = nativeClient()
  return nativeBooleanAction(
    info,
    "openBatterySettings",
    typeof client?.openBatterySettings === "function"
      ? (current) => current.openBatterySettings!()
      : undefined
  )
}

export function logoutNativeApp(info: NativeBridgeInfo | null) {
  const client = nativeClient()
  return nativeBooleanAction(
    info,
    "logout",
    typeof client?.logout === "function"
      ? (current) => current.logout!()
      : undefined
  )
}
