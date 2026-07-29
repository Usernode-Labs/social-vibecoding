import { cn } from "@/lib/utils"
import {
  serializeAppIdentity,
  type AppIdentityInput,
  type AppIdentityPayloadV1,
} from "@/lib/app-identity-contract"

const identitySizes = {
  sm: "size-8 text-sm",
  md: "size-12 text-lg",
  lg: "size-16 text-xl",
} as const

export type AppIdentityProps = {
  app: AppIdentityInput
  size?: keyof typeof identitySizes
  decorative?: boolean
}

export function AppIdentity({ app, decorative = true, size = "md" }: AppIdentityProps) {
  const sizeClass = identitySizes[size]
  const options = { origin: globalThis.location?.origin ?? "http://usernode.invalid" }
  let identity: AppIdentityPayloadV1
  try {
    identity = serializeAppIdentity(app, options)
  } catch {
    // Artwork is untrusted API data. An invalid/private URL must neither
    // render nor take down the app catalog; the governed monogram is the
    // fail-closed presentation.
    identity = serializeAppIdentity({ ...app, icon_url: null }, options)
  }
  const identityData = {
    "data-appearance-hash": identity.appearance_hash,
    "data-identity-contract-version": identity.contract_version,
    "data-identity-hash": identity.identity_hash,
  }
  if (identity.artwork_ref) {
    return (
      <img
        alt={decorative ? "" : identity.display_name}
        className={cn("shrink-0 rounded-md object-cover", sizeClass)}
        src={identity.artwork_ref}
        {...identityData}
      />
    )
  }

  return (
    <div
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : identity.display_name}
      className={cn("app-identity flex shrink-0 items-center justify-center rounded-md border font-semibold", sizeClass)}
      data-identity-slot={identity.slot}
      role={decorative ? undefined : "img"}
      {...identityData}
    >
      {identity.monogram}
    </div>
  )
}
