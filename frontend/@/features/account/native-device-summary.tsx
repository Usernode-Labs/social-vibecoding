import { Cpu, ExternalLink, ShieldCheck, Smartphone, Wallet } from "lucide-react"

import { PlatformIcon } from "@/components/platform-icon"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import type { NativeBridgeInfo, NativeNodeStatus, NativeWalletState } from "@/lib/native-bridge"

export type NativeDeviceSummaryState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "unsupported"; info: NativeBridgeInfo }
  | { kind: "ready"; info: NativeBridgeInfo; node: NativeNodeStatus | null; wallet: NativeWalletState | null }

function statusLabel(status?: string | null) {
  if (!status) return "Checking"
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function shortAddress(address?: string | null) {
  if (!address) return "Address unavailable"
  return address.length > 18 ? `${address.slice(0, 10)}…${address.slice(-6)}` : address
}

function formatBalance(wallet: NativeWalletState | null) {
  if (!wallet || wallet.tokenAmount == null || !Number.isFinite(wallet.tokenAmount)) return "Balance unavailable"
  const symbol = wallet.tokenSymbol || "UT"
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(wallet.tokenAmount)} ${symbol}`
}

function NodeDetails({ node }: { node: NativeNodeStatus | null }) {
  if (!node) return <p className="text-base text-muted-foreground sm:text-sm">Node status is not available from this Usernode build.</p>
  const tips = node.localBestHeight == null ? "Height unavailable" : node.networkBestHeight == null ? `${node.localBestHeight.toLocaleString()} local` : `${node.localBestHeight.toLocaleString()} / ${node.networkBestHeight.toLocaleString()}`
  const peers = node.connectedPeers == null ? "Peers unavailable" : node.totalPeers == null ? `${node.connectedPeers} connected` : `${node.connectedPeers} of ${node.totalPeers} peers`
  return <dl className="grid gap-3 text-base sm:grid-cols-2 sm:text-sm">
    <div><dt className="text-muted-foreground">Sync status</dt><dd className="mt-1 font-medium">{statusLabel(node.status)}</dd></div>
    <div><dt className="text-muted-foreground">Chain height</dt><dd className="mt-1 font-medium tabular-nums">{tips}</dd></div>
    <div><dt className="text-muted-foreground">Network</dt><dd className="mt-1 font-medium">{peers}</dd></div>
  </dl>
}

export function NativeDeviceSummary({ state, onOpenNativeSettings }: { state: NativeDeviceSummaryState; onOpenNativeSettings?: () => void }) {
  if (state.kind === "loading") return <Card data-testid="native-device-summary"><CardHeader><CardTitle>Device and wallet</CardTitle><CardDescription>Loading Usernode capabilities.</CardDescription></CardHeader><CardContent className="space-y-3"><Skeleton className="h-18 w-full" /><Skeleton className="h-18 w-full" /></CardContent></Card>

  if (state.kind === "unavailable") return <Alert data-testid="native-device-unavailable"><PlatformIcon icon={Smartphone} /><AlertTitle>Open in Usernode to see your device</AlertTitle><AlertDescription>This browser does not expose the Usernode bridge. Your wallet, node, and device settings stay private to the Usernode app.</AlertDescription></Alert>

  if (state.kind === "unsupported") return <Alert data-testid="native-device-unsupported"><PlatformIcon icon={ShieldCheck} /><AlertTitle>Update Usernode to see device status</AlertTitle><AlertDescription>This Usernode build reports bridge version {state.info.version}, but does not provide the device and wallet capabilities used by this screen.</AlertDescription></Alert>

  const node = state.node
  const wallet = state.wallet
  const canOpenSettings = state.info.capabilities.includes("openNativeScreen") && onOpenNativeSettings
  return <section aria-label="Usernode device and wallet" className="grid gap-4 lg:grid-cols-2" data-testid="native-device-summary">
    <Card>
      <CardHeader>
        <div className="flex items-start gap-2"><PlatformIcon icon={Cpu} /><div><CardTitle>Node</CardTitle><CardDescription>Current status from your Usernode device.</CardDescription></div></div>
      </CardHeader>
      <CardContent><NodeDetails node={node} /></CardContent>
    </Card>
    <Card>
      <CardHeader>
        <div className="flex items-start gap-2"><PlatformIcon icon={Wallet} /><div><CardTitle>Wallet</CardTitle><CardDescription>Your address and balance remain native-controlled.</CardDescription></div></div>
      </CardHeader>
      <CardContent className="space-y-3"><dl className="grid gap-3 text-base sm:text-sm"><div><dt className="text-muted-foreground">Balance</dt><dd className="mt-1 font-medium tabular-nums">{formatBalance(wallet)}</dd></div><div><dt className="text-muted-foreground">Address</dt><dd className="mt-1 font-mono text-sm">{shortAddress(wallet?.address)}</dd></div></dl>{wallet?.lastUpdatedMs ? <p className="text-base text-muted-foreground sm:text-sm">Updated {new Date(wallet.lastUpdatedMs).toLocaleTimeString()}.</p> : null}</CardContent>
      {canOpenSettings ? <CardFooter><Button onClick={onOpenNativeSettings} size="sm" type="button" variant="outline"><PlatformIcon data-icon="inline-start" icon={ExternalLink} />Open Usernode settings</Button></CardFooter> : null}
    </Card>
  </section>
}
