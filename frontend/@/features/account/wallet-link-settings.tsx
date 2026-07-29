import { Clock3, Copy, Link2, LoaderCircle, QrCode, Smartphone } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

import { PlatformIcon } from "@/components/platform-icon"
import { StatusDot } from "@/components/status-dot"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  getNativeBridgeInfo,
  hasNativeCapability,
  sendNativeWalletTransaction,
  type NativeBridgeInfo,
} from "@/lib/native-bridge"
import {
  getWalletLinkStatus,
  startWalletLink,
  type WalletLinkRequest,
} from "@/lib/wallet-settings-api"

type QRCodeOptions = {
  text: string
  width: number
  height: number
  colorDark: string
  colorLight: string
  correctLevel?: number
}

type QRCodeConstructor = {
  new (element: HTMLElement, options: QRCodeOptions): unknown
  CorrectLevel?: { L?: number }
}

export type WalletLinkPhase =
  | { kind: "unlinked" }
  | { kind: "starting" }
  | {
      kind: "awaiting"
      delivery: "native" | "qr"
      request: WalletLinkRequest
      remainingSeconds: number
    }
  | { kind: "linked"; pubkey: string }
  | { kind: "error"; message: string }

function messageFrom(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback
}

function shortAddress(pubkey: string) {
  return pubkey.length > 20 ? `${pubkey.slice(0, 10)}…${pubkey.slice(-6)}` : pubkey
}

function remainingSeconds(expiresAt: string) {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000))
}

function remainingLabel(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`
}

function WalletLinkQr({ payload }: { payload: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState(true)

  useEffect(() => {
    const container = containerRef.current
    const QRCode = (window as Window & { QRCode?: QRCodeConstructor }).QRCode
    if (!container || typeof QRCode !== "function") {
      setAvailable(false)
      return
    }
    container.replaceChildren()
    new QRCode(container, {
      text: payload,
      width: 180,
      height: 180,
      colorDark: "#1a1a1a",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel?.L,
    })
    const image = container.querySelector("img")
    if (image) image.alt = "Wallet link QR code"
    setAvailable(true)
    return () => container.replaceChildren()
  }, [payload])

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        aria-label="Wallet link QR code"
        className="min-h-52 min-w-52 rounded-lg bg-white p-3 [&_canvas]:size-45 [&_img]:size-45"
        data-testid="wallet-link-qr"
        ref={containerRef}
        role="img"
      />
      {!available ? (
        <p className="max-w-sm text-center text-sm text-muted-foreground">
          The QR renderer is unavailable. Copy the request below and open it with Usernode.
        </p>
      ) : null}
    </div>
  )
}

export function WalletLinkSettingsView({
  phase,
  readOnly = false,
  onCancel,
  onCopy,
  onRetry,
  onStart,
}: {
  phase: WalletLinkPhase
  readOnly?: boolean
  onCancel?: () => void
  onCopy?: () => void
  onRetry?: () => void
  onStart?: () => void
}) {
  const linked = phase.kind === "linked"
  return (
    <Card data-testid="wallet-link-settings">
      <CardHeader>
        <CardTitle>Usernode wallet</CardTitle>
        <CardDescription>
          Link your on-chain identity to this Social Vibecoding account.
        </CardDescription>
        <CardAction>
          <Badge variant={linked ? "secondary" : "outline"}>
            {linked ? "Linked" : "Not linked"}
          </Badge>
        </CardAction>
      </CardHeader>

      {phase.kind === "unlinked" ? (
        <>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Linking enables wallet sign-in and lets the native app prove account ownership without exposing your key.
            </p>
          </CardContent>
          <CardFooter>
            <Button disabled={readOnly} onClick={onStart} type="button">
              <PlatformIcon data-icon="inline-start" icon={Link2} />
              Link Usernode wallet
            </Button>
          </CardFooter>
        </>
      ) : null}

      {phase.kind === "starting" ? (
        <CardContent className="flex items-center gap-3 text-sm text-muted-foreground" role="status">
          <PlatformIcon className="animate-spin" icon={LoaderCircle} />
          Preparing a one-time wallet link request…
        </CardContent>
      ) : null}

      {phase.kind === "awaiting" ? (
        <>
          <CardContent className="flex flex-col gap-4">
            {phase.delivery === "qr" ? (
              <>
                <WalletLinkQr payload={JSON.stringify(phase.request.qr)} />
                <div className="text-center">
                  <p className="font-medium">Scan with the Usernode mobile app</p>
                  <p className="text-sm text-muted-foreground">
                    The one-unit transaction contains only the single-use link token.
                  </p>
                </div>
              </>
            ) : (
              <Alert>
                <PlatformIcon icon={Smartphone} />
                <AlertTitle>Confirm in Usernode</AlertTitle>
                <AlertDescription>
                  Approve the native transaction sheet. This page will recognize the linked wallet automatically.
                </AlertDescription>
              </Alert>
            )}
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
              <PlatformIcon icon={Clock3} />
              Expires in {remainingLabel(phase.remainingSeconds)}
            </div>
          </CardContent>
          <CardFooter className="flex flex-wrap gap-2">
            {phase.delivery === "qr" ? (
              <Button onClick={onCopy} type="button" variant="outline">
                <PlatformIcon data-icon="inline-start" icon={Copy} />
                Copy link request
              </Button>
            ) : null}
            <Button onClick={onCancel} type="button" variant="ghost">Cancel</Button>
          </CardFooter>
        </>
      ) : null}

      {phase.kind === "linked" ? (
        <CardContent>
          <div className="flex items-center gap-3 rounded-lg border bg-muted/40 p-3">
            <div className="min-w-0">
              <StatusDot className="font-medium" label="Wallet linked" role="positive" subject="Wallet" />
              <p className="truncate font-mono text-sm text-muted-foreground" title={phase.pubkey}>
                {shortAddress(phase.pubkey)}
              </p>
            </div>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            Unlinking stays intentionally unavailable here because it would remove your native sign-in recovery path without an on-chain unlink.
          </p>
        </CardContent>
      ) : null}

      {phase.kind === "error" ? (
        <>
          <CardContent>
            <Alert variant="destructive">
              <PlatformIcon icon={QrCode} />
              <AlertTitle>Could not link wallet</AlertTitle>
              <AlertDescription>{phase.message}</AlertDescription>
            </Alert>
          </CardContent>
          <CardFooter>
            <Button disabled={readOnly} onClick={onRetry} type="button" variant="outline">Try again</Button>
          </CardFooter>
        </>
      ) : null}
    </Card>
  )
}

export function WalletLinkSettings({
  enabled,
  linkedPubkey,
  onLinked,
  readOnly = false,
}: {
  enabled: boolean
  linkedPubkey: string | null
  onLinked?: (pubkey: string) => void
  readOnly?: boolean
}) {
  const [phase, setPhase] = useState<WalletLinkPhase>(
    linkedPubkey ? { kind: "linked", pubkey: linkedPubkey } : { kind: "unlinked" }
  )
  const bridgeInfoRef = useRef<NativeBridgeInfo | null>(null)
  const [copyNotice, setCopyNotice] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void getNativeBridgeInfo().then((info) => {
      if (active) bridgeInfoRef.current = info
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (linkedPubkey) setPhase({ kind: "linked", pubkey: linkedPubkey })
  }, [linkedPubkey])

  const complete = useCallback((pubkey: string) => {
    setPhase({ kind: "linked", pubkey })
    onLinked?.(pubkey)
  }, [onLinked])

  const awaitingRequest = phase.kind === "awaiting" ? phase.request : null

  useEffect(() => {
    if (!awaitingRequest) return
    const expiresAt = awaitingRequest.expiresAt
    const controller = new AbortController()
    let checking = false

    const check = async () => {
      if (checking) return
      checking = true
      try {
        const status = await getWalletLinkStatus(controller.signal)
        if (status.linked && status.pubkey) complete(status.pubkey)
      } catch {
        // Linking remains valid for ten minutes. A transient status request
        // must not discard the QR/native confirmation state; the next poll
        // can still observe the completed on-chain link.
      } finally {
        checking = false
      }
    }

    void check()
    const pollTimer = window.setInterval(() => void check(), 2000)
    const countdownTimer = window.setInterval(() => {
      const seconds = remainingSeconds(expiresAt)
      if (seconds <= 0) {
        setPhase({ kind: "error", message: "The wallet link request expired. Start a new request." })
        return
      }
      setPhase((current) => current.kind === "awaiting"
        ? { ...current, remainingSeconds: seconds }
        : current)
    }, 1000)

    return () => {
      controller.abort()
      window.clearInterval(pollTimer)
      window.clearInterval(countdownTimer)
    }
  }, [awaitingRequest, complete])

  if (!enabled) return null

  const start = async () => {
    if (readOnly) return
    setCopyNotice(null)
    setPhase({ kind: "starting" })
    try {
      const request = await startWalletLink()
      const activeBridgeInfo = bridgeInfoRef.current ?? await getNativeBridgeInfo()
      bridgeInfoRef.current = activeBridgeInfo
      const delivery = hasNativeCapability(activeBridgeInfo, "sendTransaction") ? "native" : "qr"
      setPhase({
        kind: "awaiting",
        delivery,
        request,
        remainingSeconds: remainingSeconds(request.expiresAt),
      })
      if (delivery === "native") {
        await sendNativeWalletTransaction(activeBridgeInfo, request.qr)
      }
    } catch (cause) {
      setPhase({ kind: "error", message: messageFrom(cause, "Could not start wallet linking.") })
    }
  }

  const copy = async () => {
    if (phase.kind !== "awaiting") return
    try {
      await navigator.clipboard.writeText(JSON.stringify(phase.request.qr))
      setCopyNotice("Wallet link request copied.")
    } catch {
      setCopyNotice("Could not copy automatically. Scan the QR code instead.")
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <WalletLinkSettingsView
        onCancel={() => setPhase({ kind: "unlinked" })}
        onCopy={() => void copy()}
        onRetry={() => void start()}
        onStart={() => void start()}
        phase={phase}
        readOnly={readOnly}
      />
      {copyNotice ? <p className="px-1 text-sm text-muted-foreground" role="status">{copyNotice}</p> : null}
    </div>
  )
}
