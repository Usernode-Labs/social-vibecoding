import { ArrowLeft, KeyRound, Link2, LoaderCircle, ShieldCheck, UserPlus, WalletCards } from "lucide-react"
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"

import { PlatformIcon } from "@/components/platform-icon"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  checkWalletAuthentication,
  linkWalletDuringLogin,
  loginWithWallet,
  registerWithWallet,
  resetPasswordWithWallet,
  type WalletAuthCheck,
  type WalletLinkRequest,
} from "@/lib/auth-api"
import {
  getNativeBridgeInfo,
  getNativeWalletAddress,
  hasNativeCapability,
  sendNativeWalletTransaction,
  signNativeMessage,
  type NativeBridgeInfo,
} from "@/lib/native-bridge"
import { getWalletLinkStatus } from "@/lib/wallet-settings-api"

export type WalletAccessScreen =
  | "checking"
  | "sign-in"
  | "options"
  | "link"
  | "register"
  | "recovery"
  | "linking"
  | "ineligible"

export type WalletAccessViewProps = {
  busy?: boolean
  error?: string | null
  linked?: boolean
  linkNotice?: string | null
  onAccountSubmit?: (kind: "link" | "register", username: string, password: string) => void
  onBack?: () => void
  onContinue?: () => void
  onPasswordFallback?: () => void
  onRecoverySubmit?: (newPassword: string) => void
  onSelect?: (screen: WalletAccessScreen) => void
  onSignIn?: () => void
  pubkey?: string
  screen: WalletAccessScreen
}

function shortAddress(address?: string) {
  if (!address) return ""
  return address.length > 22 ? `${address.slice(0, 10)}…${address.slice(-8)}` : address
}

function AccountForm({
  busy,
  error,
  kind,
  onBack,
  onSubmit,
}: {
  busy: boolean
  error?: string | null
  kind: "link" | "register"
  onBack?: () => void
  onSubmit?: WalletAccessViewProps["onAccountSubmit"]
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    onSubmit?.(kind, String(data.get("username") || "").trim(), String(data.get("password") || ""))
  }
  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`wallet-${kind}-username`}>Username</FieldLabel>
          <Input autoComplete="username" disabled={busy} id={`wallet-${kind}-username`} name="username" required />
        </Field>
        <Field data-invalid={Boolean(error)}>
          <FieldLabel htmlFor={`wallet-${kind}-password`}>Password</FieldLabel>
          <Input
            autoComplete={kind === "register" ? "new-password" : "current-password"}
            disabled={busy}
            id={`wallet-${kind}-password`}
            minLength={kind === "register" ? 8 : undefined}
            name="password"
            required
            type="password"
          />
          {kind === "register" ? <FieldDescription>At least 8 characters.</FieldDescription> : null}
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
        <Button disabled={busy} type="submit">
          <PlatformIcon data-icon="inline-start" icon={kind === "register" ? UserPlus : Link2} />
          {busy ? "Preparing wallet link…" : kind === "register" ? "Create and link account" : "Log in and link wallet"}
        </Button>
        <Button disabled={busy} onClick={onBack} type="button" variant="ghost">
          <PlatformIcon data-icon="inline-start" icon={ArrowLeft} />
          Back
        </Button>
      </FieldGroup>
    </form>
  )
}

function RecoveryForm({
  busy,
  error,
  onBack,
  onSubmit,
}: {
  busy: boolean
  error?: string | null
  onBack?: () => void
  onSubmit?: WalletAccessViewProps["onRecoverySubmit"]
}) {
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [localError, setLocalError] = useState<string | null>(null)
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (password.length < 8) return setLocalError("Password must be at least 8 characters.")
    if (password !== confirm) return setLocalError("Passwords do not match.")
    setLocalError(null)
    onSubmit?.(password)
  }
  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Alert>
          <PlatformIcon icon={ShieldCheck} />
          <AlertTitle>Prove account ownership</AlertTitle>
          <AlertDescription>Usernode will ask you to sign a fresh challenge before the password changes.</AlertDescription>
        </Alert>
        <Field>
          <FieldLabel htmlFor="wallet-recovery-password">New password</FieldLabel>
          <Input
            autoComplete="new-password"
            disabled={busy}
            id="wallet-recovery-password"
            minLength={8}
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
        </Field>
        <Field data-invalid={Boolean(localError || error)}>
          <FieldLabel htmlFor="wallet-recovery-confirm">Confirm new password</FieldLabel>
          <Input
            autoComplete="new-password"
            disabled={busy}
            id="wallet-recovery-confirm"
            minLength={8}
            onChange={(event) => setConfirm(event.target.value)}
            required
            type="password"
            value={confirm}
          />
          {localError || error ? <FieldError>{localError || error}</FieldError> : null}
        </Field>
        <Button disabled={busy} type="submit">
          <PlatformIcon data-icon="inline-start" icon={ShieldCheck} />
          {busy ? "Verifying wallet…" : "Sign and reset password"}
        </Button>
        <Button disabled={busy} onClick={onBack} type="button" variant="ghost">
          <PlatformIcon data-icon="inline-start" icon={ArrowLeft} />
          Back
        </Button>
      </FieldGroup>
    </form>
  )
}

export function WalletAccessView({
  busy = false,
  error,
  linked = false,
  linkNotice,
  onAccountSubmit,
  onBack,
  onContinue,
  onPasswordFallback,
  onRecoverySubmit,
  onSelect,
  onSignIn,
  pubkey,
  screen,
}: WalletAccessViewProps) {
  const title = screen === "recovery"
    ? "Reset your password"
    : screen === "register"
      ? "Create your account"
      : screen === "link"
        ? "Link an existing account"
        : "Continue with Usernode"
  return (
    <Card className="w-full max-w-sm" data-testid="wallet-access">
      <CardHeader>
        <div className="mb-1 flex size-10 items-center justify-center rounded-md border bg-muted">
          <PlatformIcon icon={WalletCards} size="lg" />
        </div>
        <CardTitle><h2>{title}</h2></CardTitle>
        <CardDescription>
          {pubkey ? `Wallet ${shortAddress(pubkey)}` : "Use the wallet secured by the native Usernode app."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {screen === "checking" ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <PlatformIcon className="animate-spin" icon={LoaderCircle} />
            Checking your wallet…
          </div>
        ) : null}
        {screen === "sign-in" ? (
          <div className="grid gap-3">
            <Alert>
              <PlatformIcon icon={ShieldCheck} />
              <AlertTitle>Wallet linked</AlertTitle>
              <AlertDescription>Approve one signature request to enter your existing account.</AlertDescription>
            </Alert>
            {error ? <FieldError>{error}</FieldError> : null}
            <Button disabled={busy} onClick={onSignIn} type="button">
              <PlatformIcon data-icon="inline-start" icon={KeyRound} />
              {busy ? "Verifying identity…" : "Sign in with wallet"}
            </Button>
            <Button disabled={busy} onClick={() => onSelect?.("recovery")} type="button" variant="outline">
              Reset password with wallet
            </Button>
          </div>
        ) : null}
        {screen === "options" ? (
          <div className="grid gap-3">
            <Alert>
              <PlatformIcon icon={WalletCards} />
              <AlertTitle>Wallet not linked yet</AlertTitle>
              <AlertDescription>Create an account for this genesis wallet or link an account you already use.</AlertDescription>
            </Alert>
            <Button onClick={() => onSelect?.("register")} type="button">
              <PlatformIcon data-icon="inline-start" icon={UserPlus} />
              Create account
            </Button>
            <Button onClick={() => onSelect?.("link")} type="button" variant="outline">
              <PlatformIcon data-icon="inline-start" icon={Link2} />
              Link existing account
            </Button>
          </div>
        ) : null}
        {screen === "link" || screen === "register" ? (
          <AccountForm busy={busy} error={error} kind={screen} onBack={onBack} onSubmit={onAccountSubmit} />
        ) : null}
        {screen === "recovery" ? (
          <RecoveryForm busy={busy} error={error} onBack={onBack} onSubmit={onRecoverySubmit} />
        ) : null}
        {screen === "linking" ? (
          <div className="grid gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <PlatformIcon className={error ? undefined : "animate-spin"} icon={error ? Link2 : LoaderCircle} />
              {error || linkNotice || "Waiting for the wallet-link transaction…"}
            </div>
            {error ? <Button onClick={onContinue}>Continue to apps</Button> : null}
          </div>
        ) : null}
        {screen === "ineligible" ? (
          <Alert>
            <PlatformIcon icon={WalletCards} />
            <AlertTitle>{linked ? "Wallet recovery is available" : "Wallet authentication unavailable"}</AlertTitle>
            <AlertDescription>
              {linked
                ? "This linked wallet can reset your password, but wallet sign-in remains limited to genesis participants."
                : "Only genesis participants can create or link an account through the native wallet."}
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
      {screen !== "checking" && screen !== "link" && screen !== "register" && screen !== "recovery" && screen !== "linking" ? (
        <CardFooter className="flex-col items-stretch gap-2">
          {screen === "ineligible" && linked ? (
            <Button onClick={() => onSelect?.("recovery")} type="button" variant="outline">Reset password with wallet</Button>
          ) : null}
          <Button onClick={onPasswordFallback} type="button" variant="ghost">Use username and password</Button>
        </CardFooter>
      ) : null}
    </Card>
  )
}

function errorMessage(cause: unknown, fallback: string) {
  const message = cause instanceof Error && cause.message ? cause.message : fallback
  return /denied/i.test(message) ? "The wallet request was denied." : message
}

async function waitForWalletLink() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const status = await getWalletLinkStatus()
      if (status.linked) return true
    } catch {
      // The legacy flow treats transient poll failures as inconclusive. The
      // on-chain link request remains live, so retry until its bounded window.
    }
    await new Promise((resolve) => window.setTimeout(resolve, 3000))
  }
  return false
}

export function WalletAccess({
  onAuthenticated,
  onDetected,
  onUnavailable,
}: {
  onAuthenticated: () => void
  onDetected?: () => void
  onUnavailable: () => void
}) {
  const bridgeInfo = useRef<NativeBridgeInfo | null>(null)
  const [check, setCheck] = useState<WalletAuthCheck | null>(null)
  const [pubkey, setPubkey] = useState("")
  const [screen, setScreen] = useState<WalletAccessScreen>("checking")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [linkNotice, setLinkNotice] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void (async () => {
      const info = await getNativeBridgeInfo()
      if (!active) return
      if (!hasNativeCapability(info, "getNodeAddress") || !hasNativeCapability(info, "signMessage")) {
        onUnavailable()
        return
      }
      try {
        const address = await getNativeWalletAddress(info)
        const result = await checkWalletAuthentication(address)
        if (!active) return
        bridgeInfo.current = info
        setPubkey(address)
        setCheck(result)
        onDetected?.()
        setScreen(result.status === "linked" && result.isGenesis
          ? "sign-in"
          : result.status === "not_linked" && result.isGenesis
            ? "options"
            : "ineligible")
      } catch {
        if (active) onUnavailable()
      }
    })()
    return () => { active = false }
  }, [onDetected, onUnavailable])

  const select = (next: WalletAccessScreen) => {
    setError(null)
    setScreen(next)
  }
  const back = () => select(check?.status === "linked" && check.isGenesis
    ? "sign-in"
    : check?.status === "not_linked" && check.isGenesis
      ? "options"
      : "ineligible")

  const signIn = async () => {
    if (!bridgeInfo.current || !check || !pubkey) return
    setBusy(true)
    setError(null)
    try {
      const challenge = check.challenge || (await checkWalletAuthentication(pubkey)).challenge
      if (!challenge) throw new Error("The server did not issue a wallet challenge.")
      const signature = await signNativeMessage(bridgeInfo.current, challenge)
      await loginWithWallet({ pubkey, publicKey: signature.publicKey, challenge, signature: signature.signature })
      onAuthenticated()
    } catch (cause) {
      setError(errorMessage(cause, "Unable to sign in with the wallet."))
    } finally {
      setBusy(false)
    }
  }

  const recover = async (newPassword: string) => {
    if (!bridgeInfo.current || !pubkey) return
    setBusy(true)
    setError(null)
    try {
      const latest = await checkWalletAuthentication(pubkey)
      if (!latest.challenge) throw new Error("The server did not issue a wallet challenge.")
      const signature = await signNativeMessage(bridgeInfo.current, latest.challenge)
      await resetPasswordWithWallet({
        pubkey,
        publicKey: signature.publicKey,
        challenge: latest.challenge,
        signature: signature.signature,
        newPassword,
      })
      onAuthenticated()
    } catch (cause) {
      setError(errorMessage(cause, "Unable to reset the password."))
    } finally {
      setBusy(false)
    }
  }

  const submitAccount = async (kind: "link" | "register", username: string, password: string) => {
    if (!bridgeInfo.current || !pubkey) return
    setBusy(true)
    setError(null)
    try {
      const walletLink: WalletLinkRequest | null = kind === "register"
        ? await registerWithWallet({ username, password, pubkey })
        : await linkWalletDuringLogin({ username, password, pubkey })
      if (!walletLink) {
        onAuthenticated()
        return
      }
      setScreen("linking")
      setLinkNotice("Approve the wallet-link transaction in Usernode.")
      await sendNativeWalletTransaction(bridgeInfo.current, {
        ...walletLink,
        confirmTitle: "Link Wallet",
        confirmSubtitle: "Link your Usernode wallet to your Social Vibecoding account.",
      })
      setLinkNotice("Transaction sent. Waiting for confirmation…")
      const linked = await waitForWalletLink()
      if (!linked) throw new Error("The transaction was sent, but the wallet link is still pending.")
      onAuthenticated()
    } catch (cause) {
      setError(errorMessage(cause, "Unable to link this wallet."))
      setScreen((current) => current === "linking" ? "linking" : kind)
    } finally {
      setBusy(false)
    }
  }

  const passwordFallback = useCallback(() => onUnavailable(), [onUnavailable])

  return (
    <WalletAccessView
      busy={busy}
      error={error}
      linked={check?.status === "linked"}
      linkNotice={linkNotice}
      onAccountSubmit={(kind, username, password) => void submitAccount(kind, username, password)}
      onBack={back}
      onContinue={onAuthenticated}
      onPasswordFallback={passwordFallback}
      onRecoverySubmit={(password) => void recover(password)}
      onSelect={select}
      onSignIn={() => void signIn()}
      pubkey={pubkey}
      screen={screen}
    />
  )
}
