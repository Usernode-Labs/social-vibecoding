import type { Meta, StoryObj } from "@storybook/react-vite"

import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"

const meta = {
  title: "Elements/Primitives/Sheet",
  component: Sheet,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Sheet>

export default meta
type Story = StoryObj<typeof meta>

function Example({ open = false, side = "right" }: { open?: boolean; side?: "top" | "right" | "bottom" | "left" }) {
  return (
    <Sheet defaultOpen={open}>
      <SheetTrigger render={<Button variant="outline" />}>Open details</SheetTrigger>
      <SheetContent side={side}>
        <SheetHeader><SheetTitle>App details</SheetTitle><SheetDescription>Review visibility and collaboration settings.</SheetDescription></SheetHeader>
        <div className="px-6 text-sm">Only app managers can change these controls.</div>
        <SheetFooter><Button>Save changes</Button></SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

export const Trigger: Story = { render: () => <Example /> }
export const RightOpen: Story = { render: () => <Example open /> }
export const BottomOpen: Story = { render: () => <Example open side="bottom" /> }
