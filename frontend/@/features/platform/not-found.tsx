import { SearchX } from "lucide-react"
import { Link } from "react-router-dom"

import { PlatformIcon } from "@/components/platform-icon"
import { TopBar } from "@/components/top-bar"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty"

export function NotFound() {
  return <><TopBar title="Page not found" /><div className="isolate flex w-full flex-1 px-4 py-4 sm:px-6" data-testid="not-found"><Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={SearchX} /></EmptyMedia><EmptyDescription>This page doesn’t exist.</EmptyDescription></EmptyHeader><EmptyContent><Button render={<Link to="/" />}>Go to Home</Button></EmptyContent></Empty></div></>
}
