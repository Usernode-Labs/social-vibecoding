import type { Meta, StoryObj } from "@storybook/react-vite"
import { Archive } from "lucide-react"

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
          <AlertDialogMedia><PlatformIcon icon={Archive} size="lg" /></AlertDialogMedia>
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
export const Open: Story = { render: () => <Dialog open /> }
export const CompactOpen: Story = { render: () => <Dialog compact open /> }
