import { KeyRound, LockKeyhole, ShieldCheck } from "lucide-react"
import { useEffect, useState, type FormEvent } from "react"

import { PlatformIcon } from "@/components/platform-icon"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  getNativeBridgeInfo,
  hasNativeCapability,
  signNativeMessage,
  type NativeBridgeInfo,
} from "@/lib/native-bridge"
import { changeWebPassword } from "@/lib/settings-api"
import { changePasswordWithWallet, requestWalletChallenge } from "@/lib/wallet-settings-api"

type PasswordMode = "password" | "wallet"

function messageFrom(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback
}

export function PasswordSettings({
  readOnly = false,
  walletPubkey,
}: {
  readOnly?: boolean
  walletPubkey: string | null
}) {
  const [bridgeInfo, setBridgeInfo] = useState<NativeBridgeInfo | null>(null)
  const [mode, setMode] = useState<PasswordMode>("password")
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void getNativeBridgeInfo().then(setBridgeInfo)
  }, [])

  const walletAvailable = Boolean(walletPubkey) && hasNativeCapability(bridgeInfo, "signMessage")
  const activeMode: PasswordMode = mode === "wallet" && walletAvailable ? "wallet" : "password"

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (readOnly || busy) return
    setError(null)
    setNotice(null)
    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters.")
      return
    }
    if (newPassword !== confirmPassword) {
      setError("New passwords do not match.")
      return
    }

    setBusy(true)
    try {
      if (activeMode === "wallet") {
        if (!walletPubkey || !walletAvailable) {
          throw new Error("Wallet signing is not available in this Usernode app.")
        }
        const challenge = await requestWalletChallenge(walletPubkey)
        const signature = await signNativeMessage(bridgeInfo, challenge)
        await changePasswordWithWallet({
          publicKey: signature.publicKey,
          challenge,
          signature: signature.signature,
          newPassword,
        })
      } else {
        if (!currentPassword) {
          setError("Enter your current password.")
          return
        }
        await changeWebPassword(currentPassword, newPassword)
      }
      setCurrentPassword("")
      setNewPassword("")
      setConfirmPassword("")
      setNotice("Password changed.")
    } catch (cause) {
      const message = messageFrom(cause, "Could not change password")
      setError(/denied/i.test(message) ? "Signature request was denied." : message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <Card data-testid="settings-password">
        <CardHeader>
          <CardTitle>Change password</CardTitle>
          <CardDescription>
            Update the password used for Social Vibecoding web login.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {walletAvailable ? (
            <Tabs
              onValueChange={(value) => {
                setMode(value as PasswordMode)
                setError(null)
                setNotice(null)
              }}
              value={mode}
            >
              <TabsList aria-label="Password verification method">
                <TabsTrigger value="password">
                  <PlatformIcon data-icon="inline-start" icon={LockKeyhole} />
                  Current password
                </TabsTrigger>
                <TabsTrigger value="wallet">
                  <PlatformIcon data-icon="inline-start" icon={ShieldCheck} />
                  Linked wallet
                </TabsTrigger>
              </TabsList>
            </Tabs>
          ) : null}

          {activeMode === "wallet" ? (
            <Alert>
              <PlatformIcon icon={ShieldCheck} />
              <AlertTitle>Verify with your linked wallet</AlertTitle>
              <AlertDescription>
                Usernode will ask you to sign a fresh, single-use challenge. Your private key never leaves the native app.
              </AlertDescription>
            </Alert>
          ) : null}

          <FieldGroup>
            {activeMode === "password" ? (
              <Field>
                <FieldLabel htmlFor="settings-current-password">Current password</FieldLabel>
                <Input
                  autoComplete="current-password"
                  disabled={readOnly || busy}
                  id="settings-current-password"
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  required
                  type="password"
                  value={currentPassword}
                />
              </Field>
            ) : null}
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor="settings-new-password">New password</FieldLabel>
              <Input
                aria-invalid={Boolean(error)}
                autoComplete="new-password"
                disabled={readOnly || busy}
                id="settings-new-password"
                minLength={8}
                onChange={(event) => {
                  setNewPassword(event.target.value)
                  setError(null)
                  setNotice(null)
                }}
                required
                type="password"
                value={newPassword}
              />
              <FieldDescription>At least 8 characters.</FieldDescription>
            </Field>
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor="settings-confirm-password">Confirm new password</FieldLabel>
              <Input
                aria-invalid={Boolean(error)}
                autoComplete="new-password"
                disabled={readOnly || busy}
                id="settings-confirm-password"
                minLength={8}
                onChange={(event) => {
                  setConfirmPassword(event.target.value)
                  setError(null)
                  setNotice(null)
                }}
                required
                type="password"
                value={confirmPassword}
              />
              {error ? <FieldError>{error}</FieldError> : null}
              {notice ? <p className="text-sm text-muted-foreground" role="status">{notice}</p> : null}
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter>
          <Button
            disabled={readOnly || busy || !newPassword || !confirmPassword || (activeMode === "password" && !currentPassword)}
            type="submit"
          >
            <PlatformIcon data-icon="inline-start" icon={activeMode === "wallet" ? ShieldCheck : KeyRound} />
            {busy
              ? activeMode === "wallet" ? "Verifying wallet…" : "Changing password…"
              : activeMode === "wallet" ? "Sign and change password" : "Change password"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  )
}
