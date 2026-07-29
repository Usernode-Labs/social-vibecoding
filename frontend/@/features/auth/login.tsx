import { ArrowLeft, KeyRound, LogIn, WalletCards } from "lucide-react"
import { useCallback, useState, type FormEvent } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"

import { PlatformIcon } from "@/components/platform-icon"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { WalletAccess } from "@/features/auth/wallet-access"
import { loginWithPassword } from "@/lib/auth-api"

type LoginMode = "wallet" | "password" | "recovery"

export function Login() {
  const navigate = useNavigate()
  const location = useLocation()
  const [mode, setMode] = useState<LoginMode>("wallet")
  const [walletDetected, setWalletDetected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const authenticated = useCallback(() => {
    navigate({ pathname: "/", hash: location.hash }, { replace: true })
  }, [location.hash, navigate])
  const showPassword = useCallback(() => setMode("password"), [])
  const walletReady = useCallback(() => setWalletDetected(true), [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)
    const data = new FormData(event.currentTarget)
    try {
      await loginWithPassword({
        username: String(data.get("username") || ""),
        password: String(data.get("password") || ""),
      })
      authenticated()
    } catch (cause) {
      setError(cause instanceof TypeError ? "Network error" : cause instanceof Error ? cause.message : "Unable to log in")
    } finally {
      setPending(false)
    }
  }

  if (mode === "wallet") {
    return (
      <div className="flex flex-1 items-center justify-center p-4 sm:p-6">
        <WalletAccess onAuthenticated={authenticated} onDetected={walletReady} onUnavailable={showPassword} />
      </div>
    )
  }

  if (mode === "recovery") {
    return (
      <div className="flex flex-1 items-center justify-center p-4 sm:p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle><h1>Reset your password</h1></CardTitle>
            <CardDescription>Social Vibecoding accounts do not store an email address.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Alert>
              <PlatformIcon icon={KeyRound} />
              <AlertTitle>Ask a platform administrator</AlertTitle>
              <AlertDescription>
                Ask an administrator for a temporary password. After signing in, choose your own password in Settings.
              </AlertDescription>
            </Alert>
            {walletDetected ? (
              <Button onClick={() => setMode("wallet")} type="button" variant="outline">
                <PlatformIcon data-icon="inline-start" icon={WalletCards} />
                Reset with Usernode wallet
              </Button>
            ) : null}
            <Button onClick={() => setMode("password")} type="button" variant="ghost">
              <PlatformIcon data-icon="inline-start" icon={ArrowLeft} />
              Back to login
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex flex-1 items-center justify-center p-4 sm:p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle><h1>Welcome back</h1></CardTitle>
          <CardDescription>Log in to Social Vibecoding.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="username">Username</FieldLabel>
                <Input autoComplete="username" id="username" name="username" required />
              </Field>
              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input autoComplete="current-password" id="password" name="password" required type="password" />
              </Field>
              {error ? <Field data-invalid><FieldError>{error}</FieldError></Field> : null}
              <Button disabled={pending} type="submit">
                <PlatformIcon data-icon="inline-start" icon={LogIn} />
                {pending ? "Logging in…" : "Log in"}
              </Button>
              {walletDetected ? (
                <Button onClick={() => setMode("wallet")} type="button" variant="outline">
                  <PlatformIcon data-icon="inline-start" icon={WalletCards} />
                  Use Usernode wallet
                </Button>
              ) : null}
            </FieldGroup>
          </form>
          <p className="mt-3 text-center text-sm">
            <Button className="h-auto p-0 text-muted-foreground" onClick={() => setMode("recovery")} type="button" variant="link">
              Forgot password?
            </Button>
          </p>
          <p className="mt-5 text-center text-sm text-muted-foreground">
            Have an activation code?{" "}
            <Link className="underline underline-offset-4 hover:text-foreground" to={{ pathname: "/register", hash: location.hash }}>
              Register
            </Link>
          </p>
          <p className="mt-3 text-center text-sm text-muted-foreground">
            <Link className="underline underline-offset-4 hover:text-foreground" to="/">Continue without signing in</Link>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
