import { SearchX } from "lucide-react"

import { ActionLink } from "@/components/action-link"
import { PlatformIcon } from "@/components/platform-icon"
import { TopBar } from "@/components/top-bar"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty"

export function NotFound() {
  return <><TopBar title="Page not found" /><div className="isolate flex w-full flex-1 px-4 py-4 sm:px-6" data-testid="not-found"><Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={SearchX} /></EmptyMedia><EmptyDescription>This page doesn’t exist.</EmptyDescription></EmptyHeader><EmptyContent><ActionLink to="/" variant="default">Go to Home</ActionLink></EmptyContent></Empty></div></>
}
