(function appShortcutContractBootstrap(root, factory) {
  var runtime = factory()
  if (typeof module === "object" && module.exports) module.exports = runtime
  if (root) root.UsernodeAppShortcutContract = runtime
})(typeof globalThis !== "undefined" ? globalThis : this, function createAppShortcutContract() {
  "use strict"

  var APP_IDENTITY_CONTRACT = "usernode.app-identity"
  var APP_IDENTITY_CONTRACT_VERSION = 1
  var APP_IDENTITY_HASH_ALGORITHM = "fnv1a64"
  var APP_SHORTCUT_CONTRACT = "usernode.app-shortcut"
  var APP_SHORTCUT_CONTRACT_VERSION = 1
  var APP_SHORTCUT_ROUTE_CONTRACT = "usernode.react-app-open.v1"
  var APP_SHORTCUT_METHOD = "addHomeScreenShortcut"
  var APP_SHORTCUT_ROUTE_PREFIX = "/react/apps/"
  var IDENTITY_NAMESPACE = "usernode:app-identity:v1:"
  var APPEARANCE_NAMESPACE = "usernode:app-identity-appearance:v1:"
  var IDENTITY_SLOT_COUNT = 8
  var MAX_NATIVE_SHORTCUT_LABEL_CODE_UNITS = 48
  var MAX_DATA_IMAGE_BYTES = 2 * 1024 * 1024
  var APP_ICON_PATH = /^\/app-icons\/[0-9a-f]{32}$/
  var HASH = /^fnv1a64:[0-9a-f]{16}$/
  var DATA_IMAGE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/

  function assertObject(value, message) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message)
    return value
  }

  function normalizeOrigin(origin) {
    var url = new URL(String(origin))
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      throw new Error("App shortcut origin must be an HTTP(S) origin without credentials")
    }
    return url.origin
  }

  function safeInnerPath(value) {
    if (value === null || value === undefined) return null
    if (typeof value !== "string" || value.length > 512 || !value.startsWith("/") || value.startsWith("//")) {
      throw new Error("App shortcut received an unsafe inner path")
    }
    for (var index = 0; index < value.length; index += 1) {
      var character = value[index]
      var code = value.charCodeAt(index)
      if (/[\s\\`'"<>]/.test(character) || code < 32 || code === 127) {
        throw new Error("App shortcut received an unsafe inner path")
      }
    }
    return value
  }

  function normalizeIdentityPart(value) {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return ""
      return String(value)
    }
    return typeof value === "string" ? value.trim() : ""
  }

  function identityKey(app) {
    assertObject(app, "AppIdentity requires an app object")
    var id = normalizeIdentityPart(app.id)
    if (id) return "id:" + id
    var slug = normalizeIdentityPart(app.slug)
    if (slug) return "slug:" + slug
    throw new Error("AppIdentity requires a non-empty app id or legacy slug")
  }

  function legacySlotIdentity(app) {
    assertObject(app, "AppIdentity requires an app object")
    var id = normalizeIdentityPart(app.id)
    if (id) return id
    var slug = normalizeIdentityPart(app.slug)
    if (slug) return slug
    throw new Error("AppIdentity requires a non-empty app id or legacy slug")
  }

  function fnv1a32(value) {
    var hash = 0x811c9dc5
    var bytes = new TextEncoder().encode(value)
    for (var index = 0; index < bytes.length; index += 1) {
      hash ^= bytes[index]
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash
  }

  function fnv1a64(value) {
    var hash = BigInt("0xcbf29ce484222325")
    var prime = BigInt("0x100000001b3")
    var mask = BigInt("0xffffffffffffffff")
    var bytes = new TextEncoder().encode(value)
    for (var index = 0; index < bytes.length; index += 1) {
      hash ^= BigInt(bytes[index])
      hash = (hash * prime) & mask
    }
    return hash
  }

  function serializedHash(hash) {
    return APP_IDENTITY_HASH_ALGORITHM + ":" + hash.toString(16).padStart(16, "0")
  }

  function monogram(name) {
    var value = String(name || "").trim()
    if (!value) return "?"
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
      var iterator = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)[Symbol.iterator]()
      var first = iterator.next().value
      if (first && first.segment) return first.segment.toLocaleUpperCase()
    }
    return Array.from(value)[0].toLocaleUpperCase()
  }

  function graphemes(value) {
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
      return Array.from(
        new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value),
        function (part) { return part.segment }
      )
    }
    return null
  }

  function nativeShortcutLabel(name) {
    var value = String(name || "").trim()
    if (!value) throw new Error("App shortcut requires a non-empty display name")
    if (value.length <= MAX_NATIVE_SHORTCUT_LABEL_CODE_UNITS) return value
    var label = ""
    var segments = graphemes(value)
    // Without a platform grapheme segmenter there is no safe boundary at
    // which to truncate a long label. Prefer the stable fallback to emitting
    // half of an emoji, combining sequence, or conjunct.
    if (!segments) return "App"
    for (var index = 0; index < segments.length; index += 1) {
      if (label.length + segments[index].length > MAX_NATIVE_SHORTCUT_LABEL_CODE_UNITS) break
      label += segments[index]
    }
    // A deliberately pathological single grapheme can exceed the native
    // platform limit. Use a stable readable label rather than splitting it.
    return label || "App"
  }

  function validateDataImage(value) {
    var match = DATA_IMAGE.exec(value)
    if (!match || match[2].length % 4 === 1) {
      throw new Error("App shortcut data artwork must be a valid base64 PNG, JPEG, or WebP image")
    }
    var padding = match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0
    var decodedBytes = Math.floor(match[2].length * 3 / 4) - padding
    if (decodedBytes <= 0 || decodedBytes > MAX_DATA_IMAGE_BYTES) {
      throw new Error("App shortcut data artwork must contain 1 byte to 2 MiB")
    }
    return value
  }

  function normalizeArtwork(value, origin) {
    if (value === null || value === undefined || String(value).trim() === "") {
      return { ref: null, url: null }
    }
    var artwork = String(value).trim()
    if (artwork.startsWith("data:")) {
      var dataImage = validateDataImage(artwork)
      return { ref: dataImage, url: dataImage }
    }
    var baseOrigin = normalizeOrigin(origin)
    var url = new URL(artwork, baseOrigin)
    if (url.origin !== baseOrigin || url.username || url.password || url.search || url.hash || !APP_ICON_PATH.test(url.pathname)) {
      throw new Error("App shortcut artwork must be a same-origin content-addressed /app-icons URL")
    }
    return { ref: url.pathname, url: url.href }
  }

  function identityHash(app) {
    return serializedHash(fnv1a64(IDENTITY_NAMESPACE + identityKey(app)))
  }

  function identitySlot(app) {
    // Palette assignment predates the portable identity contract. Keep its
    // exact FNV-1a 32/raw-id mapping so adopting stronger identity/cache
    // hashes does not recolor every existing app.
    return fnv1a32(IDENTITY_NAMESPACE + legacySlotIdentity(app)) % IDENTITY_SLOT_COUNT + 1
  }

  function serializeIdentity(app, options) {
    var key = identityKey(app)
    var displayName = String(app.name || "").trim()
    if (!displayName) throw new Error("AppIdentity requires a non-empty display name")
    var origin = options && options.origin ? options.origin : "http://usernode.invalid"
    var artwork = normalizeArtwork(app.icon_url, origin)
    var stableHash = identityHash(app)
    var glyph = monogram(displayName)
    var appearanceSource = JSON.stringify([
      APP_IDENTITY_CONTRACT_VERSION,
      stableHash,
      displayName,
      glyph,
      artwork.ref,
    ])
    return {
      contract: APP_IDENTITY_CONTRACT,
      contract_version: APP_IDENTITY_CONTRACT_VERSION,
      hash_algorithm: APP_IDENTITY_HASH_ALGORITHM,
      identity_key: key,
      identity_hash: stableHash,
      appearance_hash: serializedHash(fnv1a64(APPEARANCE_NAMESPACE + appearanceSource)),
      slot: identitySlot(app),
      display_name: displayName,
      monogram: glyph,
      artwork_ref: artwork.ref,
    }
  }

  function shortcutTarget(origin, slug, innerPath) {
    var baseOrigin = normalizeOrigin(origin)
    var normalizedSlug = normalizeIdentityPart(slug)
    if (!normalizedSlug) throw new Error("App shortcut requires a non-empty slug")
    var path = APP_SHORTCUT_ROUTE_PREFIX + encodeURIComponent(normalizedSlug) + "/open"
    var safePath = safeInnerPath(innerPath)
    if (safePath !== null) path += "?" + new URLSearchParams({ path: safePath }).toString()
    return new URL(path, baseOrigin).href
  }

  function createShortcutArgs(app, options) {
    options = assertObject(options, "App shortcut options are required")
    var origin = normalizeOrigin(options.origin)
    var identity = serializeIdentity(app, { origin: origin })
    var artwork = normalizeArtwork(app.icon_url, origin)
    return {
      contract: APP_SHORTCUT_CONTRACT,
      contract_version: APP_SHORTCUT_CONTRACT_VERSION,
      route_contract: APP_SHORTCUT_ROUTE_CONTRACT,
      name: nativeShortcutLabel(identity.display_name),
      url: shortcutTarget(origin, app.slug, options.innerPath),
      icon_url: artwork.url,
      identity: identity,
      silent: options.silent === true,
    }
  }

  function createNativeEnvelope(id, args) {
    if (typeof id !== "string" || !/^\d+-[0-9a-f]+$/.test(id)) {
      throw new Error("Native bridge request id must match the hosted bridge timestamp-random format")
    }
    if (!validateArgs(args)) throw new Error("Native bridge shortcut args do not satisfy v1")
    return { method: APP_SHORTCUT_METHOD, id: id, args: args }
  }

  function exactKeys(value, expected) {
    var keys = Object.keys(value).sort()
    var wanted = expected.slice().sort()
    return keys.length === wanted.length && keys.every(function (key, index) { return key === wanted[index] })
  }

  function validArtworkRef(value) {
    if (value === null) return true
    if (typeof value !== "string") return false
    if (APP_ICON_PATH.test(value)) return true
    try {
      validateDataImage(value)
      return true
    } catch (_) {
      return false
    }
  }

  function validArtworkUrl(value, targetUrl) {
    if (value === null) return true
    if (typeof value !== "string") return false
    if (value.startsWith("data:")) return validArtworkRef(value)
    try {
      var url = new URL(value)
      var target = new URL(targetUrl)
      return url.origin === target.origin && !url.username && !url.password && !url.search && !url.hash && APP_ICON_PATH.test(url.pathname)
    } catch (_) {
      return false
    }
  }

  function validateIdentity(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    if (!exactKeys(value, [
      "contract", "contract_version", "hash_algorithm", "identity_key",
      "identity_hash", "appearance_hash", "slot", "display_name", "monogram", "artwork_ref",
    ])) return false
    if (value.contract !== APP_IDENTITY_CONTRACT
      || value.contract_version !== APP_IDENTITY_CONTRACT_VERSION
      || value.hash_algorithm !== APP_IDENTITY_HASH_ALGORITHM
      || typeof value.identity_key !== "string"
      || !/^(?:id|slug):.+$/.test(value.identity_key)
      || !HASH.test(value.identity_hash)
      || !HASH.test(value.appearance_hash)
      || !Number.isInteger(value.slot)
      || value.slot < 1
      || value.slot > IDENTITY_SLOT_COUNT
      || typeof value.display_name !== "string"
      || value.display_name.length === 0
      || value.display_name !== value.display_name.trim()
      || typeof value.monogram !== "string"
      || value.monogram.length === 0
      || !validArtworkRef(value.artwork_ref)) return false

    var separator = value.identity_key.indexOf(":")
    var rawIdentity = value.identity_key.slice(separator + 1)
    var expectedIdentityHash = serializedHash(fnv1a64(IDENTITY_NAMESPACE + value.identity_key))
    var expectedSlot = fnv1a32(IDENTITY_NAMESPACE + rawIdentity) % IDENTITY_SLOT_COUNT + 1
    var expectedMonogram = monogram(value.display_name)
    var appearanceSource = JSON.stringify([
      APP_IDENTITY_CONTRACT_VERSION,
      expectedIdentityHash,
      value.display_name,
      expectedMonogram,
      value.artwork_ref,
    ])
    var expectedAppearanceHash =
      serializedHash(fnv1a64(APPEARANCE_NAMESPACE + appearanceSource))
    return value.identity_hash === expectedIdentityHash
      && value.slot === expectedSlot
      && value.monogram === expectedMonogram
      && value.appearance_hash === expectedAppearanceHash
  }

  function artworkCorrelates(artworkRef, artworkUrl, targetUrl) {
    if (artworkRef === null || artworkUrl === null) {
      return artworkRef === null && artworkUrl === null
    }
    if (typeof artworkRef !== "string" || typeof artworkUrl !== "string") return false
    if (artworkRef.startsWith("data:")) return artworkUrl === artworkRef
    try {
      var icon = new URL(artworkUrl)
      var target = new URL(targetUrl)
      return icon.origin === target.origin
        && !icon.username
        && !icon.password
        && !icon.search
        && !icon.hash
        && icon.pathname === artworkRef
        && APP_ICON_PATH.test(icon.pathname)
    } catch (_) {
      return false
    }
  }

  function validateArgs(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    if (!exactKeys(value, [
      "contract", "contract_version", "route_contract", "name", "url",
      "icon_url", "identity", "silent",
    ])) return false
    if (value.contract !== APP_SHORTCUT_CONTRACT
      || value.contract_version !== APP_SHORTCUT_CONTRACT_VERSION
      || value.route_contract !== APP_SHORTCUT_ROUTE_CONTRACT
      || typeof value.name !== "string"
      || value.name.length === 0
      || value.name.length > MAX_NATIVE_SHORTCUT_LABEL_CODE_UNITS
      || typeof value.url !== "string"
      || typeof value.silent !== "boolean"
      || !validateIdentity(value.identity)
      || !validArtworkUrl(value.icon_url, value.url)
      || value.name !== nativeShortcutLabel(value.identity.display_name)
      || !artworkCorrelates(value.identity.artwork_ref, value.icon_url, value.url)) return false
    try {
      var target = new URL(value.url)
      if ((target.protocol !== "http:" && target.protocol !== "https:")
        || target.username
        || target.password
        || !new RegExp("^/react/apps/[^/]+/open$").test(target.pathname)
        || target.hash) return false
      if (target.search) {
        if (target.searchParams.size !== 1 || !target.searchParams.has("path")) return false
        try {
          safeInnerPath(target.searchParams.get("path"))
        } catch (_) {
          return false
        }
      }
      return true
    } catch (_) {
      return false
    }
  }

  function validateEnvelope(value) {
    return Boolean(value
      && typeof value === "object"
      && !Array.isArray(value)
      && exactKeys(value, ["method", "id", "args"])
      && value.method === APP_SHORTCUT_METHOD
      && typeof value.id === "string"
      && /^\d+-[0-9a-f]+$/.test(value.id)
      && validateArgs(value.args))
  }

  return Object.freeze({
    APP_IDENTITY_CONTRACT: APP_IDENTITY_CONTRACT,
    APP_IDENTITY_CONTRACT_VERSION: APP_IDENTITY_CONTRACT_VERSION,
    APP_IDENTITY_HASH_ALGORITHM: APP_IDENTITY_HASH_ALGORITHM,
    APP_SHORTCUT_CONTRACT: APP_SHORTCUT_CONTRACT,
    APP_SHORTCUT_CONTRACT_VERSION: APP_SHORTCUT_CONTRACT_VERSION,
    APP_SHORTCUT_ROUTE_CONTRACT: APP_SHORTCUT_ROUTE_CONTRACT,
    APP_SHORTCUT_METHOD: APP_SHORTCUT_METHOD,
    APP_SHORTCUT_ROUTE_PREFIX: APP_SHORTCUT_ROUTE_PREFIX,
    MAX_NATIVE_SHORTCUT_LABEL_CODE_UNITS: MAX_NATIVE_SHORTCUT_LABEL_CODE_UNITS,
    identityKey: identityKey,
    identityHash: identityHash,
    identitySlot: identitySlot,
    monogram: monogram,
    nativeShortcutLabel: nativeShortcutLabel,
    normalizeArtwork: normalizeArtwork,
    serializeIdentity: serializeIdentity,
    shortcutTarget: shortcutTarget,
    createShortcutArgs: createShortcutArgs,
    createNativeEnvelope: createNativeEnvelope,
    validateIdentity: validateIdentity,
    validateArgs: validateArgs,
    validateEnvelope: validateEnvelope,
  })
})
