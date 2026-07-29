import {
  Activity,
  BatteryCharging,
  Bug,
  Cpu,
  ExternalLink,
  FileText,
  Fingerprint,
  Gauge,
  LogIn,
  LogOut,
  RotateCcw,
  ShieldCheck,
  Smartphone,
} from "lucide-react"
import { useEffect, useState } from "react"

import { PlatformIcon } from "@/components/platform-icon"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
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
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import {
  getNativeBridgeInfo,
  getNativeSettingsState,
  hasNativeCapability,
  logoutNativeApp,
  openNativeBatterySettings,
  openNativeScreen,
  requestNativePermissions,
  resetNativeZkChallenge,
  setNativeDebugMode,
  setNativeFacematchStrict,
  setNativeIosKeepAlive,
  setNativeNodeSleep,
  type NativeBridgeInfo,
  type NativeSettingsState,
} from "@/lib/native-bridge"

type LoadState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "unsupported"; info: NativeBridgeInfo }
  | { kind: "error"; info: NativeBridgeInfo; message: string }
  | { kind: "ready"; info: NativeBridgeInfo; settings: NativeSettingsState }

type BusyAction =
  | "permissions"
  | "battery"
  | "sleep"
  | "facematch"
  | "debug"
  | "keepalive"
  | "zk"
  | "logout"
  | "screen"

function messageFrom(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback
}

async function openNativeSettingsScreen(
  info: NativeBridgeInfo,
  screen: "settings" | "benchmark" | "httpLogs" | "terms"
) {
  const opened = await openNativeScreen(info, screen)
  if (!opened) throw new Error("Usernode could not open that native screen.")
}

function StatusBadge({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <Badge className="shrink-0" variant={ok ? "secondary" : "outline"}>
      {children}
    </Badge>
  )
}

function SettingsToggle({
  checked,
  description,
  disabled,
  icon,
  label,
  onCheckedChange,
}: {
  checked: boolean
  description: string
  disabled: boolean
  icon: typeof Smartphone
  label: string
  onCheckedChange: (checked: boolean) => void
}) {
  const id = `native-${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`
  return (
    <Field data-disabled={disabled} orientation="responsive">
      <FieldContent>
        <FieldLabel htmlFor={id}>
          <PlatformIcon icon={icon} />
          {label}
        </FieldLabel>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <Switch
        checked={checked}
        disabled={disabled}
        id={id}
        onCheckedChange={onCheckedChange}
      />
    </Field>
  )
}

export function NativeAppSettings({ readOnly = false }: { readOnly?: boolean }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" })
  const [busy, setBusy] = useState<BusyAction | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [zkOpen, setZkOpen] = useState(false)
  const [logoutOpen, setLogoutOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setState({ kind: "loading" })
      const info = await getNativeBridgeInfo()
      if (cancelled) return
      if (!info) {
        setState({ kind: "unavailable" })
        return
      }
      if (!hasNativeCapability(info, "getSettingsState")) {
        setState({ kind: "unsupported", info })
        return
      }
      try {
        const settings = await getNativeSettingsState(info)
        if (!cancelled) {
          setState(settings
            ? { kind: "ready", info, settings }
            : { kind: "error", info, message: "Usernode did not return a settings snapshot." })
        }
      } catch (cause) {
        if (!cancelled) {
          setState({ kind: "error", info, message: messageFrom(cause, "Could not load Usernode app settings.") })
        }
      }
    })()
    return () => { cancelled = true }
  }, [])

  const update = async (
    action: BusyAction,
    task: (info: NativeBridgeInfo) => Promise<NativeSettingsState>
  ) => {
    if (state.kind !== "ready" || readOnly || busy) return
    setBusy(action)
    setActionError(null)
    try {
      const settings = await task(state.info)
      setState({ kind: "ready", info: state.info, settings })
    } catch (cause) {
      setActionError(messageFrom(cause, "Could not update Usernode settings."))
    } finally {
      setBusy(null)
    }
  }

  const act = async (
    action: BusyAction,
    task: (info: NativeBridgeInfo) => Promise<void>,
    close?: () => void
  ) => {
    if (state.kind !== "ready" || readOnly || busy) return
    setBusy(action)
    setActionError(null)
    try {
      await task(state.info)
      close?.()
    } catch (cause) {
      setActionError(messageFrom(cause, "Usernode could not complete the action."))
    } finally {
      setBusy(null)
    }
  }

  if (state.kind === "loading") {
    return (
      <Card data-testid="native-app-settings-loading">
        <CardHeader>
          <CardTitle>Usernode app</CardTitle>
          <CardDescription>Loading protected device settings.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (state.kind === "unavailable") {
    return (
      <Alert data-testid="settings-unavailable">
        <PlatformIcon icon={Smartphone} />
        <AlertTitle>Native controls need Usernode</AlertTitle>
        <AlertDescription>
          This browser does not expose the Usernode bridge, so native permissions, wallet controls and Usernode-app logout remain unavailable. Web settings and Social Vibecoding logout still work here.
        </AlertDescription>
      </Alert>
    )
  }

  if (state.kind === "unsupported" || state.kind === "error") {
    const canOpen = hasNativeCapability(state.info, "openNativeScreen")
    return (
      <Alert data-testid={state.kind === "unsupported" ? "settings-unsupported" : "settings-native-error"}>
        <PlatformIcon icon={ShieldCheck} />
        <AlertTitle>{state.kind === "unsupported" ? "Update Usernode to manage device settings here" : "Could not load Usernode app settings"}</AlertTitle>
        <AlertDescription>
          {state.kind === "unsupported"
            ? `This Usernode build reports bridge version ${state.info.version}, but does not advertise the settings controls used by this page.`
            : state.message}
          {canOpen ? (
            <Button
              className="mt-3"
              disabled={readOnly || busy === "screen"}
              onClick={() => {
                setBusy("screen")
                setActionError(null)
                void openNativeSettingsScreen(state.info, "settings")
                  .catch((cause) => setActionError(messageFrom(cause, "Could not open Usernode settings.")))
                  .finally(() => setBusy(null))
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              <PlatformIcon data-icon="inline-start" icon={ExternalLink} />
              Open native settings
            </Button>
          ) : null}
        </AlertDescription>
      </Alert>
    )
  }

  const { info, settings } = state
  const permissions = settings.permissions
  const android = permissions.platform === "android"
  const ios = permissions.platform === "ios"
  const buildParts = [
    settings.buildInfo.appVersion
      ? `App ${settings.buildInfo.appVersion}${settings.buildInfo.buildNumber ? ` (${settings.buildInfo.buildNumber})` : ""}`
      : null,
    settings.buildInfo.nodeVersion ? `Node ${settings.buildInfo.nodeVersion}` : null,
    settings.buildInfo.commitHash,
  ].filter(Boolean)

  return (
    <section aria-label="Usernode app settings" className="flex flex-col gap-6" data-testid="native-app-settings">
      <Card>
        <CardHeader>
          <div className="flex items-start gap-2">
            <PlatformIcon icon={Smartphone} />
            <div>
              <CardTitle>Usernode app · device permissions</CardTitle>
              <CardDescription>Block production needs the app to wake your device at exact slot times.</CardDescription>
            </div>
          </div>
          <CardAction>
            <Badge variant="outline">{permissions.platform || "Device"}</Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4 text-sm">
            <span>{android ? "Exact alarms" : "Alarm permissions"}</span>
            <StatusBadge ok={permissions.exactAlarmGranted}>
              {permissions.exactAlarmGranted ? "Granted" : "Not granted"}
            </StatusBadge>
          </div>
          {!permissions.exactAlarmGranted && hasNativeCapability(info, "requestPermissions") ? (
            <Button
              disabled={readOnly || busy !== null}
              onClick={() => void update("permissions", (current) => requestNativePermissions(current))}
              size="sm"
              type="button"
              variant="outline"
            >
              <PlatformIcon data-icon="inline-start" icon={ShieldCheck} />
              {busy === "permissions" ? "Waiting for permission…" : "Request permissions"}
            </Button>
          ) : null}
          {android ? (
            <>
              <div className="flex items-center justify-between gap-4 text-sm">
                <span>Battery optimization</span>
                <StatusBadge ok={permissions.batteryOptDisabled === true}>
                  {permissions.batteryOptDisabled === true ? "Unrestricted" : "Restricted"}
                </StatusBadge>
              </div>
              {permissions.batteryOptDisabled !== true && hasNativeCapability(info, "openBatterySettings") ? (
                <Button
                  disabled={readOnly || busy !== null}
                  onClick={() => void act("battery", (current) => openNativeBatterySettings(current))}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <PlatformIcon data-icon="inline-start" icon={BatteryCharging} />
                  Open battery settings
                </Button>
              ) : null}
              {permissions.deviceManufacturer ? (
                <p className="text-sm text-muted-foreground">Device: {permissions.deviceManufacturer}</p>
              ) : null}
            </>
          ) : null}
          {ios && hasNativeCapability(info, "setIosKeepAlive") ? (
            <SettingsToggle
              checked={permissions.iosKeepAliveActive === true}
              description="Keep the app awake while it remains in the foreground."
              disabled={readOnly || busy !== null}
              icon={BatteryCharging}
              label="Keep-alive mode"
              onCheckedChange={(enabled) => void update("keepalive", (current) => setNativeIosKeepAlive(current, enabled))}
            />
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Node, privacy and identity</CardTitle>
          <CardDescription>Protected preferences for the embedded node and ZK passport flow.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <SettingsToggle
              checked={settings.nodeSleepEnabled}
              description="Pause the node after inactivity and wake it on your next interaction."
              disabled={readOnly || busy !== null || !hasNativeCapability(info, "setNodeSleepEnabled")}
              icon={Cpu}
              label="Node sleep on inactivity"
              onCheckedChange={(enabled) => void update("sleep", (current) => setNativeNodeSleep(current, enabled))}
            />
            <SettingsToggle
              checked={settings.facematchStrict}
              description="Require strict face matching during the ZK passport identity flow."
              disabled={readOnly || busy !== null || !hasNativeCapability(info, "setFacematchStrict")}
              icon={Fingerprint}
              label="Strict facematch"
              onCheckedChange={(enabled) => void update("facematch", (current) => setNativeFacematchStrict(current, enabled))}
            />
          </FieldGroup>
        </CardContent>
        {hasNativeCapability(info, "resetZkChallenge") ? (
          <CardFooter>
            <Button disabled={readOnly || busy !== null} onClick={() => setZkOpen(true)} type="button" variant="destructive">
              <PlatformIcon data-icon="inline-start" icon={RotateCcw} />
              Restart ZK challenge
            </Button>
          </CardFooter>
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Diagnostics</CardTitle>
          <CardDescription>Debugging tools for the app and its embedded node.</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingsToggle
            checked={settings.debugMode}
            description="Enable additional app diagnostics and logging."
            disabled={readOnly || busy !== null || !hasNativeCapability(info, "setDebugMode")}
            icon={Bug}
            label="Debug mode"
            onCheckedChange={(enabled) => void update("debug", (current) => setNativeDebugMode(current, enabled))}
          />
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          {hasNativeCapability(info, "openNativeScreen") ? (
            <>
              <Button disabled={readOnly || busy !== null} onClick={() => void act("screen", (current) => openNativeSettingsScreen(current, "benchmark"))} size="sm" type="button" variant="outline">
                <PlatformIcon data-icon="inline-start" icon={Gauge} />
                Device benchmark
              </Button>
              <Button disabled={readOnly || busy !== null} onClick={() => void act("screen", (current) => openNativeSettingsScreen(current, "httpLogs"))} size="sm" type="button" variant="outline">
                <PlatformIcon data-icon="inline-start" icon={Activity} />
                HTTP debug logs
              </Button>
            </>
          ) : null}
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>About, legal and help</CardTitle>
          <CardDescription>Build identity and practical information for operating a Usernode device.</CardDescription>
        </CardHeader>
        {buildParts.length ? (
          <CardContent>
            <p className="font-mono text-sm text-muted-foreground">{buildParts.join(" · ")}</p>
          </CardContent>
        ) : null}
        <CardContent>
          <Accordion>
            <AccordionItem value="about">
              <AccordionTrigger>About Usernode</AccordionTrigger>
              <AccordionContent className="text-muted-foreground">
                Your device verifies, executes and contributes compute directly to a peer-to-peer network. Testnet validates block production, consensus behaviour and network reliability before broader community coordination tools build on that foundation.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="production">
              <AccordionTrigger>What is block production?</AccordionTrigger>
              <AccordionContent className="text-muted-foreground">
                VRF selection assigns upcoming slots. The app schedules device wake-ups, monitors the node at slot time and records whether each block was produced successfully.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="reliability">
              <AccordionTrigger>Platform and reliability</AccordionTrigger>
              <AccordionContent className="text-muted-foreground">
                {android
                  ? "Android uses exact alarms to wake the device during slot windows. Battery restrictions can reduce reliability."
                  : "iOS combines background tasks with optional foreground keep-alive. The operating system ultimately controls background execution."}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </CardContent>
        {hasNativeCapability(info, "openNativeScreen") ? (
          <CardFooter>
            <Button disabled={readOnly || busy !== null} onClick={() => void act("screen", (current) => openNativeSettingsScreen(current, "terms"))} size="sm" type="button" variant="outline">
              <PlatformIcon data-icon="inline-start" icon={FileText} />
              {settings.termsAccepted === false ? "Review terms · not yet accepted" : "Terms"}
            </Button>
          </CardFooter>
        ) : null}
      </Card>

      <Card data-testid="settings-native-account">
        <CardHeader>
          <CardTitle>Usernode app account</CardTitle>
          <CardDescription>
            {settings.authStatus === "authenticated"
              ? "End the native app account session. You will need to sign in again to keep earning points."
              : "You are browsing as a guest. Sign in to create your wallet and start earning points."}
          </CardDescription>
          <CardAction>
            <Badge variant="outline">{settings.authStatus || "Unknown"}</Badge>
          </CardAction>
        </CardHeader>
        <CardFooter>
          {settings.authStatus === "authenticated" && hasNativeCapability(info, "logout") ? (
            <Button disabled={readOnly || busy !== null} onClick={() => setLogoutOpen(true)} type="button" variant="destructive">
              <PlatformIcon data-icon="inline-start" icon={LogOut} />
              Log out of Usernode app
            </Button>
          ) : hasNativeCapability(info, "openNativeScreen") ? (
            <Button disabled={readOnly || busy !== null} onClick={() => void act("screen", (current) => openNativeSettingsScreen(current, "settings"))} type="button">
              <PlatformIcon data-icon="inline-start" icon={LogIn} />
              Log in to Usernode app
            </Button>
          ) : null}
        </CardFooter>
      </Card>

      {actionError ? (
        <Alert data-testid="native-settings-action-error" variant="destructive">
          <AlertTitle>Usernode action failed</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      <AlertDialog onOpenChange={(open) => { if (!busy) setZkOpen(open) }} open={zkOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restart the ZK challenge?</AlertDialogTitle>
            <AlertDialogDescription>Your in-progress identity registration will be discarded.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "zk"}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy === "zk"}
              onClick={() => void act("zk", (current) => resetNativeZkChallenge(current), () => setZkOpen(false))}
              type="button"
              variant="destructive"
            >
              {busy === "zk" ? "Restarting…" : "Restart"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog onOpenChange={(open) => { if (!busy) setLogoutOpen(open) }} open={logoutOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Log out of the Usernode app?</AlertDialogTitle>
            <AlertDialogDescription>You will need to sign in again to keep earning points.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "logout"}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy === "logout"}
              onClick={() => void act("logout", (current) => logoutNativeApp(current), () => setLogoutOpen(false))}
              type="button"
              variant="destructive"
            >
              {busy === "logout" ? "Logging out…" : "Log out of Usernode app"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
