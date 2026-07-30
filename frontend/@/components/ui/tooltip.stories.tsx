import type { Meta, StoryObj } from "@storybook/react-vite"
import { Bell } from "lucide-react"

import { PlatformIcon } from "@/components/platform-icon"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

const meta = {
  title: "Elements/Primitives/Tooltip",
  component: Tooltip,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Tooltip>

export default meta
type Story = StoryObj<typeof meta>

function Example({ open = false, side = "top" }: { open?: boolean; side?: "top" | "right" | "bottom" | "left" }) {
  return (
    <TooltipProvider>
      <Tooltip defaultOpen={open}>
        <TooltipTrigger render={<Button aria-label="Open activity" size="icon" variant="outline" />}><PlatformIcon icon={Bell} /></TooltipTrigger>
        <TooltipContent side={side}>Activity</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export const Trigger: Story = { render: () => <Example /> }
export const Open: Story = { render: () => <Example open /> }
export const RightOpen: Story = { render: () => <Example open side="right" /> }
