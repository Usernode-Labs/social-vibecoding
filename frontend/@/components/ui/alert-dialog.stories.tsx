import type { Meta, StoryObj } from "@storybook/react-vite"
import { Archive } from "lucide-react"
import { expect, within } from "storybook/test"

import { PlatformIcon } from "@/components/platform-icon"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"

const meta = {
  title: "Elements/Primitives/Alert dialog",
  component: AlertDialog,
  parameters: { layout: "centered" },
} satisfies Meta<typeof AlertDialog>

export default meta
type Story = StoryObj<typeof meta>

function Dialog({ open = false, compact = false }: { open?: boolean; compact?: boolean }) {
  return (
    <AlertDialog defaultOpen={open}>
      <AlertDialogTrigger render={<Button variant="destructive" />}>Archive session</AlertDialogTrigger>
      <AlertDialogContent size={compact ? "sm" : "default"}>
        <AlertDialogHeader>
          <AlertDialogMedia><PlatformIcon icon={Archive} /></AlertDialogMedia>
          <AlertDialogTitle>Archive this session?</AlertDialogTitle>
          <AlertDialogDescription>This stops its worker and frees the session slot. You can restore it for a limited time.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive">Archive session</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export const Trigger: Story = { render: () => <Dialog /> }
export const Open: Story = {
  render: () => <Dialog open />,
  play: async ({ canvasElement }) => {
    const dialog = await within(canvasElement.ownerDocument.body).findByRole("alertdialog")
    const icon = dialog.querySelector('[data-slot="alert-dialog-media"] > [data-slot="platform-icon"]')
    await expect(icon).not.toBeNull()
    await expect(getComputedStyle(icon!).width).toBe("32px")
    await expect(getComputedStyle(icon!).height).toBe("32px")
  },
}
export const CompactOpen: Story = { render: () => <Dialog compact open /> }
