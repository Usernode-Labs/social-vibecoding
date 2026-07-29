import { KeyRound, UserPlus } from "lucide-react"
import { useEffect, useRef, useState, type FormEvent } from "react"
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom"

import { PlatformIcon } from "@/components/platform-icon"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { registerWithActivationCode } from "@/lib/auth-api"

export function Register() {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const usernameInput = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const activationCode = searchParams.get("code")?.trim() || ""

  useEffect(() => {
    if (activationCode) usernameInput.current?.focus()
  }, [activationCode])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)
    const data = new FormData(event.currentTarget)

    try {
      await registerWithActivationCode({
        code: String(data.get("code") || "").trim(),
        username: String(data.get("username") || "").trim(),
        password: String(data.get("password") || ""),
      })
      navigate({ pathname: "/", hash: location.hash }, { replace: true })
    } catch (cause) {
      setError(cause instanceof TypeError ? "Network error" : cause instanceof Error ? cause.message : "Unable to register")
    } finally {
      setPending(false)
    }
  }

  return <div className="flex flex-1 items-center justify-center p-4 sm:p-6"><Card className="w-full max-w-sm"><CardHeader><CardTitle><h1>Create your account</h1></CardTitle><CardDescription>Use the activation code you were given to join Social Vibecoding.</CardDescription></CardHeader><CardContent><form onSubmit={submit}><FieldGroup><Field><FieldLabel htmlFor="code">Activation code</FieldLabel><Input autoCapitalize="characters" autoComplete="off" defaultValue={activationCode} id="code" name="code" placeholder="Enter activation code" required /></Field><Field><FieldLabel htmlFor="username">Username</FieldLabel><Input autoComplete="username" id="username" name="username" placeholder="Choose a username" ref={usernameInput} required /></Field><Field><FieldLabel htmlFor="password">Password</FieldLabel><Input autoComplete="new-password" id="password" name="password" placeholder="Choose a password" required type="password" /><FieldDescription>Your password is submitted only to the existing account service.</FieldDescription></Field>{error ? <Field data-invalid><FieldError>{error}</FieldError></Field> : null}<Button disabled={pending} type="submit"><PlatformIcon data-icon="inline-start" icon={UserPlus} />{pending ? "Creating account…" : "Create account"}</Button></FieldGroup></form><p className="mt-5 text-center text-sm text-muted-foreground">Already have an account? <Link className="underline underline-offset-4 hover:text-foreground" to={{ pathname: "/login", hash: location.hash }}><PlatformIcon className="mr-1 inline-block align-text-bottom" icon={KeyRound} />Log in</Link></p><p className="mt-3 text-center text-sm text-muted-foreground"><Link className="underline underline-offset-4 hover:text-foreground" to="/">Continue without signing in</Link></p></CardContent></Card></div>
}
