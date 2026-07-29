import {
  Bot,
  EyeOff,
  KeyRound,
  Languages,
  LogOut,
  RefreshCw,
  ShieldAlert,
} from "lucide-react"
import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"

import { PlatformIcon } from "@/components/platform-icon"
import { ThemeSwitcher } from "@/components/theme-switcher"
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
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { logoutCurrentSession } from "@/lib/auth-api"
import { isAdminPreviewEnabled, setAdminPreviewEnabled } from "@/lib/admin-preview"
import { isProductionReadOnlyReview, productionWriteAppSlug } from "@/lib/runtime-mode"
import {
  getWebSettings,
  removeAnthropicApiKey,
  saveAnthropicApiKey,
  updateAiProgressEstimate,
  updateWebLocale,
  type WebSettings,
} from "@/lib/settings-api"
import { AgentFilesSettings } from "@/features/account/agent-files-settings"
import { AiPermissionsSettings } from "@/features/account/ai-permissions-settings"
import { AiSpendSummary } from "@/features/account/ai-spend-summary"
import { DeveloperPreferencesSettings } from "@/features/account/developer-preferences-settings"
import { NativeAppSettings } from "@/features/account/native-app-settings"
import { PasswordSettings } from "@/features/account/password-settings"
import { WalletLinkSettings } from "@/features/account/wallet-link-settings"

type WebSettingsState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; settings: WebSettings }

const localeOptions = [
  { value: "auto", label: "Auto — use device language" },
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "id", label: "Bahasa Indonesia" },
  { value: "pt-BR", label: "Português (Brasil)" },
  { value: "it", label: "Italiano" },
  { value: "nl", label: "Nederlands" },
  { value: "pl", label: "Polski" },
  { value: "tr", label: "Türkçe" },
  { value: "ru", label: "Русский" },
  { value: "uk", label: "Українська" },
  { value: "ar", label: "العربية" },
  { value: "hi", label: "हिन्दी" },
  { value: "vi", label: "Tiếng Việt" },
  { value: "th", label: "ไทย" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "zh-CN", label: "中文（简体）" },
  { value: "zh-TW", label: "中文（繁體）" },
]

function messageFrom(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback
}

export function Settings() {
  const navigate = useNavigate()
  const [webState, setWebState] = useState<WebSettingsState>({ kind: "loading" })
  const [refreshKey, setRefreshKey] = useState(0)
  const [preferenceError, setPreferenceError] = useState<string | null>(null)
  const [savingPreference, setSavingPreference] = useState<"locale" | "progress" | null>(null)
  const [apiKey, setApiKey] = useState("")
  const [apiKeyBusy, setApiKeyBusy] = useState<"save" | "remove" | null>(null)
  const [apiKeyError, setApiKeyError] = useState<string | null>(null)
  const [apiKeyNotice, setApiKeyNotice] = useState<string | null>(null)
  const [removeKeyOpen, setRemoveKeyOpen] = useState(false)
  const [logoutOpen, setLogoutOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)
  const [adminPreview, setAdminPreview] = useState(() => isAdminPreviewEnabled())
  const preferencesReadOnly = isProductionReadOnlyReview || Boolean(productionWriteAppSlug)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    setWebState({ kind: "loading" })
    setPreferenceError(null)

    void getWebSettings(controller.signal).then((settings) => {
      if (!cancelled) setWebState({ kind: "ready", settings })
    }).catch((cause) => {
      if (!cancelled && !controller.signal.aborted) {
        setWebState({ kind: "error", message: messageFrom(cause, "Could not load web settings") })
      }
    })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [refreshKey])

  const saveLocale = async (value: string | null) => {
    if (webState.kind !== "ready" || preferencesReadOnly) return
    setSavingPreference("locale")
    setPreferenceError(null)
    try {
      const locale = await updateWebLocale(value === "auto" ? null : value)
      setWebState({ kind: "ready", settings: { ...webState.settings, locale } })
    } catch (cause) {
      setPreferenceError(messageFrom(cause, "Could not save language"))
    } finally {
      setSavingPreference(null)
    }
  }

  const saveProgressEstimate = async (enabled: boolean) => {
    if (webState.kind !== "ready" || preferencesReadOnly) return
    setSavingPreference("progress")
    setPreferenceError(null)
    try {
      const aiProgressEstimate = await updateAiProgressEstimate(enabled)
      setWebState({ kind: "ready", settings: { ...webState.settings, aiProgressEstimate } })
    } catch (cause) {
      setPreferenceError(messageFrom(cause, "Could not save AI progress estimate"))
    } finally {
      setSavingPreference(null)
    }
  }

  const saveApiKey = async () => {
    const key = apiKey.trim()
    if (webState.kind !== "ready" || preferencesReadOnly || !key || apiKeyBusy) return
    setApiKeyBusy("save")
    setApiKeyError(null)
    setApiKeyNotice("Verifying the key with Anthropic…")
    try {
      const keyLast4 = await saveAnthropicApiKey(key)
      setWebState({
        kind: "ready",
        settings: { ...webState.settings, hasApiKey: true, keyLast4 },
      })
      setApiKey("")
      setApiKeyNotice("Saved. Eligible coding work can now use your Anthropic account.")
    } catch (cause) {
      setApiKeyNotice(null)
      setApiKeyError(messageFrom(cause, "Could not save API key"))
    } finally {
      setApiKeyBusy(null)
    }
  }

  const removeApiKey = async () => {
    if (webState.kind !== "ready" || preferencesReadOnly || apiKeyBusy) return
    setApiKeyBusy("remove")
    setApiKeyError(null)
    setApiKeyNotice(null)
    try {
      await removeAnthropicApiKey()
      setWebState({
        kind: "ready",
        settings: { ...webState.settings, hasApiKey: false, keyLast4: null },
      })
      setRemoveKeyOpen(false)
      setApiKeyNotice("Removed. Coding work now uses the shared platform budget.")
    } catch (cause) {
      setApiKeyError(messageFrom(cause, "Could not remove API key"))
    } finally {
      setApiKeyBusy(null)
    }
  }

  const logout = async () => {
    if (loggingOut) return
    setLoggingOut(true)
    setLogoutError(null)
    try {
      await logoutCurrentSession()
      navigate("/login", { replace: true })
    } catch (cause) {
      setLogoutError(messageFrom(cause, "Could not log out"))
    } finally {
      setLoggingOut(false)
    }
  }

  const changeAdminPreview = (enabled: boolean) => {
    setAdminPreview(enabled)
    setAdminPreviewEnabled(enabled)
    window.location.reload()
  }

  return (
    <main
      className="isolate mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6"
      data-testid="settings"
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h2 className="text-balance text-3xl font-semibold tracking-tight">Settings</h2>
          <p className="max-w-[60ch] text-base text-muted-foreground text-pretty">
            Manage Social Vibecoding preferences here. Usernode device controls remain protected by the native bridge.
          </p>
        </div>
        <Button onClick={() => setRefreshKey((value) => value + 1)} size="sm" type="button" variant="outline">
          <PlatformIcon data-icon="inline-start" icon={RefreshCw} />
          Refresh
        </Button>
      </header>

      {isProductionReadOnlyReview ? (
        <Alert data-testid="settings-production-review">
          <PlatformIcon icon={ShieldAlert} />
          <AlertTitle>Production review mode</AlertTitle>
          <AlertDescription>Personal preferences and native settings are read-only in this local review.</AlertDescription>
        </Alert>
      ) : null}
      {productionWriteAppSlug ? (
        <Alert data-testid="settings-app-write-scope">
          <PlatformIcon icon={ShieldAlert} />
          <AlertTitle>App-scoped production review</AlertTitle>
          <AlertDescription>
            This local session permits writes only for {productionWriteAppSlug}. Personal preferences are visible but remain read-only.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card data-testid="settings-appearance">
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>
            Use the same neutral interface in light or dark. This preference is saved in this browser.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Field>
            <FieldLabel>Color mode</FieldLabel>
            <ThemeSwitcher />
            <FieldDescription>Your choice also follows this WebView when it is opened inside Usernode.</FieldDescription>
          </Field>
        </CardContent>
      </Card>

      {webState.kind === "loading" ? (
        <Card data-testid="settings-web-loading">
          <CardHeader>
            <CardTitle>Loading web preferences</CardTitle>
            <CardDescription>Reading your Social Vibecoding account settings.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </CardContent>
        </Card>
      ) : null}
      {webState.kind === "error" ? (
        <Alert data-testid="settings-web-error" variant="destructive">
          <AlertTitle>Could not load web preferences</AlertTitle>
          <AlertDescription>{webState.message}</AlertDescription>
        </Alert>
      ) : null}
      {webState.kind === "ready" ? (
        <>
          <Card data-testid="settings-preferences">
            <CardHeader>
              <CardTitle>Platform preferences</CardTitle>
              <CardDescription>These preferences follow your Social Vibecoding account across devices.</CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="settings-locale">
                    <PlatformIcon icon={Languages} />
                    Language
                  </FieldLabel>
                  <Select
                    disabled={preferencesReadOnly || savingPreference !== null}
                    items={localeOptions}
                    onValueChange={(value) => void saveLocale(value)}
                    value={webState.settings.locale || "auto"}
                  >
                    <SelectTrigger className="w-full" id="settings-locale">
                      <SelectValue placeholder="Choose language" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {localeOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>Hosted apps use this as their default language unless they offer an override.</FieldDescription>
                </Field>
                <Field data-disabled={preferencesReadOnly || savingPreference !== null} orientation="horizontal">
                  <FieldContent>
                    <FieldLabel htmlFor="settings-ai-progress">
                      <PlatformIcon icon={Bot} />
                      AI progress estimate
                    </FieldLabel>
                    <FieldDescription>
                      Show an occasional, clearly labelled AI estimate while a coding agent is working. The estimate can be wrong and adds a small cost.
                    </FieldDescription>
                  </FieldContent>
                  <Switch
                    checked={webState.settings.aiProgressEstimate}
                    disabled={preferencesReadOnly || savingPreference !== null}
                    id="settings-ai-progress"
                    onCheckedChange={(checked) => void saveProgressEstimate(checked)}
                  />
                </Field>
              </FieldGroup>
            </CardContent>
          </Card>

          {webState.settings.isAdmin ? (
            <Card data-testid="settings-admin-preview">
              <CardHeader>
                <CardTitle>Admin preview</CardTitle>
                <CardDescription>
                  Hide administrator-only React UI to inspect the platform as a regular user.
                </CardDescription>
                <CardAction>
                  <Badge variant="outline">
                    {webState.settings.canAdminWrite ? "Administrator" : "View-only administrator"}
                  </Badge>
                </CardAction>
              </CardHeader>
              <CardContent>
                <Field orientation="responsive">
                  <FieldContent>
                    <FieldLabel htmlFor="settings-admin-preview">
                      <PlatformIcon icon={EyeOff} />
                      View as non-admin
                    </FieldLabel>
                    <FieldDescription>
                      This changes only client-side presentation. Server permissions remain intact, and the page reloads so every route sees the same mask.
                    </FieldDescription>
                  </FieldContent>
                  <Switch
                    checked={adminPreview}
                    id="settings-admin-preview"
                    onCheckedChange={changeAdminPreview}
                  />
                </Field>
              </CardContent>
            </Card>
          ) : null}

          <DeveloperPreferencesSettings />

          <Card data-testid="settings-ai-billing">
            <CardHeader>
              <CardTitle>AI billing</CardTitle>
              <CardDescription>
                {webState.settings.hasApiKey
                  ? "Your own Anthropic API key is active for eligible coding work."
                  : "Coding work currently uses the shared platform budget."}
              </CardDescription>
              <CardAction>
                <Badge variant={webState.settings.hasApiKey ? "secondary" : "outline"}>
                  {webState.settings.hasApiKey ? "BYOK active" : "Shared budget"}
                </Badge>
              </CardAction>
            </CardHeader>
            {webState.settings.hasApiKey && webState.settings.keyLast4 ? (
              <CardContent className="flex items-center gap-2 text-muted-foreground">
                <PlatformIcon icon={KeyRound} />
                <span>Saved key ending in {webState.settings.keyLast4}</span>
              </CardContent>
            ) : null}
            <CardContent>
              <Field data-invalid={Boolean(apiKeyError)}>
                <FieldLabel htmlFor="settings-api-key">Anthropic API key</FieldLabel>
                <Input
                  autoComplete="off"
                  disabled={preferencesReadOnly || apiKeyBusy !== null}
                  id="settings-api-key"
                  onChange={(event) => {
                    setApiKey(event.target.value)
                    setApiKeyError(null)
                    setApiKeyNotice(null)
                  }}
                  placeholder={webState.settings.hasApiKey ? "Paste a new key to replace it" : "sk-ant-…"}
                  spellCheck={false}
                  type="password"
                  value={apiKey}
                />
                <FieldDescription>
                  The server verifies the key before encrypting it. The full key is never returned after saving.
                </FieldDescription>
                {apiKeyError ? <FieldError>{apiKeyError}</FieldError> : null}
                {apiKeyNotice ? <p className="text-sm text-muted-foreground" role="status">{apiKeyNotice}</p> : null}
              </Field>
            </CardContent>
            <CardFooter className="flex flex-wrap gap-2">
              <Button
                disabled={preferencesReadOnly || apiKeyBusy !== null || !apiKey.trim()}
                onClick={() => void saveApiKey()}
                type="button"
              >
                <PlatformIcon data-icon="inline-start" icon={KeyRound} />
                {apiKeyBusy === "save" ? "Verifying…" : webState.settings.hasApiKey ? "Replace key" : "Save key"}
              </Button>
              {webState.settings.hasApiKey ? (
                <Button
                  disabled={preferencesReadOnly || apiKeyBusy !== null}
                  onClick={() => setRemoveKeyOpen(true)}
                  type="button"
                  variant="destructive"
                >
                  Remove key
                </Button>
              ) : null}
            </CardFooter>
          </Card>

          <AiSpendSummary enabled={webState.settings.hasApiKey} />

          <AiPermissionsSettings
            hasApiKey={webState.settings.hasApiKey}
            readOnly={preferencesReadOnly}
          />

          <AgentFilesSettings readOnly={preferencesReadOnly} />

          <WalletLinkSettings
            enabled={webState.settings.walletLinkEnabled}
            linkedPubkey={webState.settings.usernodePubkey}
            onLinked={(usernodePubkey) => setWebState({
              kind: "ready",
              settings: { ...webState.settings, usernodePubkey },
            })}
            readOnly={preferencesReadOnly}
          />

          <PasswordSettings
            readOnly={preferencesReadOnly}
            walletPubkey={webState.settings.usernodePubkey}
          />
        </>
      ) : null}

      {preferenceError ? (
        <Alert data-testid="settings-preference-error" variant="destructive">
          <AlertTitle>Could not save preference</AlertTitle>
          <AlertDescription>{preferenceError}</AlertDescription>
        </Alert>
      ) : null}

      <NativeAppSettings readOnly={isProductionReadOnlyReview} />

      <Card data-testid="settings-web-session">
        <CardHeader>
          <div className="flex items-start gap-2">
            <PlatformIcon icon={LogOut} />
            <div>
              <CardTitle>Social Vibecoding session</CardTitle>
              <CardDescription>End this website session and clear cached API data from this browser or WebView.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardFooter>
          <Button onClick={() => setLogoutOpen(true)} type="button" variant="destructive">
            <PlatformIcon data-icon="inline-start" icon={LogOut} />
            Log out
          </Button>
        </CardFooter>
      </Card>
      {logoutError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not log out</AlertTitle>
          <AlertDescription>{logoutError}</AlertDescription>
        </Alert>
      ) : null}

      <AlertDialog onOpenChange={(open) => { if (!loggingOut) setLogoutOpen(open) }} open={logoutOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Log out of Social Vibecoding?</AlertDialogTitle>
            <AlertDialogDescription>
              This ends the web platform session. Your native Usernode wallet and device settings remain in the Usernode app.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={loggingOut}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={loggingOut}
              onClick={() => void logout()}
              type="button"
              variant="destructive"
            >
              {loggingOut ? "Logging out…" : "Log out"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog onOpenChange={(open) => { if (!apiKeyBusy) setRemoveKeyOpen(open) }} open={removeKeyOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove your Anthropic API key?</AlertDialogTitle>
            <AlertDialogDescription>
              Future coding work will fall back to the shared platform budget. The saved encrypted key cannot be recovered after removal.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={apiKeyBusy === "remove"}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={apiKeyBusy === "remove"}
              onClick={() => void removeApiKey()}
              type="button"
              variant="destructive"
            >
              {apiKeyBusy === "remove" ? "Removing…" : "Remove key"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  )
}
