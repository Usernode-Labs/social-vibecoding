import { ArrowRight, RadioTower, UserRound } from "lucide-react"
import { useEffect, useState } from "react"

import { ActionLink } from "@/components/action-link"
import { PlatformIcon } from "@/components/platform-icon"
import { TopBar } from "@/components/top-bar"
import { Button } from "@/components/ui/button"
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
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

  return <div className="isolate flex w-full flex-1 flex-col" data-testid="account">
    <TopBar action={<Button onClick={() => setRefreshKey((value) => value + 1)} size="sm" type="button" variant="outline">Refresh</Button>} title="Account" /><div className="flex w-full flex-1 flex-col gap-6 px-4 py-4 antialiased sm:px-6">
    <Card><CardHeader><div className="flex items-start gap-2"><PlatformIcon icon={UserRound} /><div><CardTitle>Profile and rewards</CardTitle><CardDescription>Points, rank, allocation, and completed challenge history are available in Usernode.</CardDescription></div></div></CardHeader><CardFooter><ActionLink size="sm" to="/account/profile" variant="outline">View profile<PlatformIcon data-icon="inline-end" icon={ArrowRight} /></ActionLink></CardFooter></Card>
    <NativeDeviceSummary onOpenNativeSettings={openSettings} state={device} />
    <Card>
      <CardHeader>
        <div className="flex items-start gap-2"><PlatformIcon icon={RadioTower} /><div><CardTitle>Platform service status</CardTitle><CardDescription>A public, read-only snapshot of the server, node sidecar, and explorer.</CardDescription></div></div>
      </CardHeader>
      <CardFooter><ActionLink size="sm" to="/node-status" variant="outline">View node status<PlatformIcon data-icon="inline-end" icon={ArrowRight} /></ActionLink></CardFooter>
    </Card>
  </div></div>
}
