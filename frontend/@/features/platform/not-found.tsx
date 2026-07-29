import { ArrowLeft, SearchX } from "lucide-react"
import { Link } from "react-router-dom"

import { Button } from "@/components/ui/button"
import { PlatformIcon } from "@/components/platform-icon"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

export function NotFound() {
  return <div className="isolate mx-auto flex w-full max-w-3xl flex-1 px-4 py-8 sm:px-6" data-testid="not-found"><Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={SearchX} /></EmptyMedia><EmptyTitle><h1>Page not found</h1></EmptyTitle><EmptyDescription>This page doesn’t exist.</EmptyDescription></EmptyHeader><EmptyContent><Button render={<Link to="/" />}><PlatformIcon data-icon="inline-start" icon={ArrowLeft} />Back to apps</Button></EmptyContent></Empty></div>
}
