const usdFormatter = new Intl.NumberFormat(undefined, {
  currency: "USD",
  style: "currency",
})

const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER)

export function formatUsd(cents?: number | null) {
  const safeCents = Number.isSafeInteger(cents) && Number(cents) >= 0 ? Number(cents) : 0
  return usdFormatter.format(safeCents / 100)
}

export function formatUsdInput(cents?: number | null) {
  if (cents == null) return ""
  const safeCents = Number.isSafeInteger(cents) && cents >= 0 ? cents : 0
  return `${Math.floor(safeCents / 100)}.${String(safeCents % 100).padStart(2, "0")}`
}

export function parseUsdInput(value: string) {
  const match = value.trim().match(/^(?:(\d+)(?:\.(\d{0,2}))?|\.(\d{1,2}))$/)
  if (!match) return null

  const dollars = BigInt(match[1] ?? 0)
  const decimal = (match[2] ?? match[3] ?? "").padEnd(2, "0")
  const cents = dollars * 100n + BigInt(decimal || 0)

  return cents <= MAX_SAFE_CENTS ? Number(cents) : null
}
