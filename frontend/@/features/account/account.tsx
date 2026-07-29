import { ArrowRight, RadioTower, RefreshCw, UserRound } from "lucide-react"
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"

import { PlatformIcon } from "@/components/platform-icon"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { NativeDeviceSummary, type NativeDeviceSummaryState } from "@/features/account/native-device-summary"
import { getNativeBridgeInfo, getNativeNodeStatus, getNativeWalletState, openNativeScreen, subscribeNativeNodeStatus } from "@/lib/native-bridge"

export function Account() {
  const [device, setDevice] = useState<NativeDeviceSummaryState>({ kind: "loading" })
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    let unsubscribe: () => void = () => {}
    void (async () => {
      const info = await getNativeBridgeInfo()
      if (cancelled) return
      if (!info) {
        setDevice({ kind: "unavailable" })
        return
      }
      if (!info.capabilities.includes("getNodeStatus") && !info.capabilities.includes("getWalletState")) {
        setDevice({ kind: "unsupported", info })
        return
      }
      const [node, wallet] = await Promise.all([getNativeNodeStatus(info), getNativeWalletState(info)])
      if (cancelled) return
      setDevice({ kind: "ready", info, node, wallet })
      unsubscribe = subscribeNativeNodeStatus((nextNode) => {
        if (!cancelled) setDevice((current) => current.kind === "ready" ? { ...current, node: nextNode } : current)
      })
    })()
    return () => { cancelled = true; unsubscribe() }
  }, [refreshKey])

  const openSettings = () => {
    if (device.kind === "ready") void openNativeScreen(device.info, "settings")
  }

  return <main className="isolate mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6" data-testid="account">
    <header className="flex flex-wrap items-start justify-between gap-4"><div className="space-y-2"><h2 className="text-balance text-3xl font-semibold tracking-tight">Account</h2><p className="max-w-[56ch] text-base text-muted-foreground text-pretty">Your Usernode profile, device, and wallet status.</p></div><Button onClick={() => setRefreshKey((value) => value + 1)} size="sm" type="button" variant="outline"><PlatformIcon data-icon="inline-start" icon={RefreshCw} />Refresh</Button></header>
    <Card><CardHeader><div className="flex items-start gap-2"><PlatformIcon icon={UserRound} /><div><CardTitle>Profile and rewards</CardTitle><CardDescription>Points, rank, allocation, and completed challenge history are available in Usernode.</CardDescription></div></div></CardHeader><CardContent className="text-base text-muted-foreground sm:text-sm">This profile requires the native bridge to identify your participant record. It never derives or creates a participant identifier in the web shell.</CardContent><CardFooter><Button render={<Link to="/account/profile" />} size="sm" variant="outline">View profile<PlatformIcon data-icon="inline-end" icon={ArrowRight} /></Button></CardFooter></Card>
    <NativeDeviceSummary onOpenNativeSettings={openSettings} state={device} />
    <Card>
      <CardHeader>
        <div className="flex items-start gap-2"><PlatformIcon icon={RadioTower} /><div><CardTitle>Platform service status</CardTitle><CardDescription>A public, read-only snapshot of the server, node sidecar, and explorer.</CardDescription></div></div>
      </CardHeader>
      <CardContent className="text-base text-muted-foreground sm:text-sm">This is separate from your device and wallet. It never reads a bridge capability or exposes an operator action.</CardContent>
      <CardFooter><Button render={<Link to="/node-status" />} size="sm" variant="outline">View node status<PlatformIcon data-icon="inline-end" icon={ArrowRight} /></Button></CardFooter>
    </Card>
  </main>
}
