import { BellRing, TerminalSquare } from "lucide-react"
import { useEffect, useState } from "react"

import { PlatformIcon } from "@/components/platform-icon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import {
  DEV_ALERT_TEST_DELAY_MS,
  devAlertsEnabled,
  getDevConsoleMode,
  prepareDevAlerts,
  requestDevAlertPermission,
  setDevAlertsEnabled,
  setDevConsoleMode,
  testDevAlert,
} from "@/lib/browser-preferences"

export function DeveloperPreferencesSettings() {
  const [consoleAlwaysVisible, setConsoleAlwaysVisible] = useState(() => getDevConsoleMode() === "always")
  const [alertsEnabled, setAlertsEnabledState] = useState(devAlertsEnabled)
  const [testRemaining, setTestRemaining] = useState<number | null>(null)
  const [testSent, setTestSent] = useState(false)

  useEffect(() => {
    if (testRemaining === null || testRemaining <= 0) return
    const timer = window.setInterval(() => {
      setTestRemaining((remaining) => remaining === null ? null : Math.max(0, remaining - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [testRemaining])

  useEffect(() => {
    if (testRemaining !== 0) return
    setTestSent(true)
    setTestRemaining(null)
  }, [testRemaining])

  const changeConsoleMode = (enabled: boolean) => {
    setConsoleAlwaysVisible(enabled)
    setDevConsoleMode(enabled ? "always" : "errors-only")
  }

  const changeAlerts = (enabled: boolean) => {
    setAlertsEnabledState(enabled)
    setDevAlertsEnabled(enabled)
    setTestSent(false)
    if (enabled) {
      prepareDevAlerts()
      requestDevAlertPermission()
    }
  }

  const sendTest = () => {
    setTestSent(false)
    const delay = testDevAlert()
    setTestRemaining(Math.ceil(delay / 1000))
  }

  return (
    <Card data-testid="settings-developer-preferences">
      <CardHeader>
        <CardTitle>Developer experience</CardTitle>
        <CardDescription>Browser and WebView preferences for app diagnostics and completed coding work.</CardDescription>
        <CardAction><Badge variant="outline">This device</Badge></CardAction>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field orientation="responsive">
            <FieldContent>
              <FieldLabel htmlFor="settings-dev-console">
                <PlatformIcon icon={TerminalSquare} />
                Always show developer console
              </FieldLabel>
              <FieldDescription>
                Pin the console icon whenever a child app or staging preview is visible. Otherwise it appears after that app reports an error.
              </FieldDescription>
            </FieldContent>
            <Switch
              checked={consoleAlwaysVisible}
              id="settings-dev-console"
              onCheckedChange={changeConsoleMode}
            />
          </Field>
          <Field orientation="responsive">
            <FieldContent>
              <FieldLabel htmlFor="settings-dev-alerts">
                <PlatformIcon icon={BellRing} />
                Dev-chat sound and alerts
              </FieldLabel>
              <FieldDescription>
                Play a soft chime while this page is visible, or show a browser notification when a completed Dev turn arrives in the background.
              </FieldDescription>
            </FieldContent>
            <Switch
              checked={alertsEnabled}
              id="settings-dev-alerts"
              onCheckedChange={changeAlerts}
            />
          </Field>
        </FieldGroup>
      </CardContent>
      <CardFooter className="flex flex-wrap items-center gap-3">
        <Button disabled={!alertsEnabled || testRemaining !== null} onClick={sendTest} type="button" variant="outline">
          <PlatformIcon data-icon="inline-start" icon={BellRing} />
          {testRemaining === null ? "Send a test alert" : `Alert in ${testRemaining}s`}
        </Button>
        <p aria-live="polite" className="text-sm text-muted-foreground">
          {testRemaining !== null
            ? "Stay here for the chime, or background the app for a notification."
            : testSent
              ? "Test sent. Check your sound or browser notifications."
              : `The test waits ${DEV_ALERT_TEST_DELAY_MS / 1000} seconds so you can switch context.`}
        </p>
      </CardFooter>
    </Card>
  )
}
