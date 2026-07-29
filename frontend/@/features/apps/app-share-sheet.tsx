import { Copy, ExternalLink } from "lucide-react"
import { useRef, useState } from "react"

import { PlatformIcon } from "@/components/platform-icon"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from "@/components/ui/sheet"
import { resolveDevHost } from "@/lib/dev-host"
import { cn } from "@/lib/utils"

type CopyState =
  | { kind: "idle" }
  | { kind: "copied" }
  | { kind: "error"; message: string }

async function copyText(value: string, input: HTMLInputElement | null) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }

  if (!input) throw new Error("This browser did not expose a copy action.")
  input.focus()
  input.select()
  if (!document.execCommand("copy")) {
    throw new Error("This browser did not allow copying the link.")
  }
}

/**
 * App sharing is an owned presentation pattern over the app's canonical bare
 * URL. It neither creates a token nor changes visibility; the child app keeps
 * responsibility for deciding whether an external visitor must sign in.
 */
export function AppShareSheet({
  appName,
  className,
  defaultOpen = false,
  url,
}: {
  appName: string
  className?: string
  defaultOpen?: boolean
  url: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [copyState, setCopyState] = useState<CopyState>({ kind: "idle" })
  const shareUrl = resolveDevHost(url)

  const copy = async () => {
    setCopyState({ kind: "idle" })
    try {
      await copyText(shareUrl, inputRef.current)
      setCopyState({ kind: "copied" })
    } catch (cause) {
      setCopyState({
        kind: "error",
        message: cause instanceof Error ? cause.message : "The app link could not be copied.",
      })
    }
  }

  return (
    <Sheet
      defaultOpen={defaultOpen}
      onOpenChange={(open) => {
        if (!open) setCopyState({ kind: "idle" })
      }}
    >
      <SheetTrigger
        render={
          <Button
            aria-label={`Share ${appName}`}
            className={cn(className)}
            type="button"
            variant="outline"
          />
        }
      >
        Share
      </SheetTrigger>
      <SheetContent className="w-[calc(100%-1rem)] sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Share {appName}</SheetTitle>
          <SheetDescription>
            Anyone with this link can open the app outside Usernode. Some visitors may need to sign in.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4">
          <Field>
            <FieldLabel htmlFor="app-share-url">App link</FieldLabel>
            <Input
              className="font-mono"
              id="app-share-url"
              readOnly
              ref={inputRef}
              value={shareUrl}
            />
          </Field>
          {copyState.kind === "copied" ? (
            <Alert role="status">
              <PlatformIcon icon={Copy} />
              <AlertTitle>Link copied</AlertTitle>
              <AlertDescription>The app link is ready to paste.</AlertDescription>
            </Alert>
          ) : null}
          {copyState.kind === "error" ? (
            <Alert variant="destructive">
              <AlertTitle>Link was not copied</AlertTitle>
              <AlertDescription>{copyState.message}</AlertDescription>
            </Alert>
          ) : null}
        </div>
        <SheetFooter>
          <Button onClick={() => void copy()} type="button">
            {copyState.kind === "copied" ? "Copied" : "Copy link"}
          </Button>
          <Button
            render={<a href={shareUrl} rel="noreferrer" target="_blank" />}
            variant="outline"
          >
            <PlatformIcon data-icon="inline-start" icon={ExternalLink} />
            Open in new tab
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
