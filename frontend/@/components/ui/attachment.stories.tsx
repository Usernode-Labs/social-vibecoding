import type { Meta, StoryObj } from "@storybook/react-vite"
import { FileText, Image, RotateCcw, X } from "lucide-react"
import { expect, within } from "storybook/test"

import { PlatformIcon } from "@/components/platform-icon"
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment"

const meta = {
  title: "Elements/Conversation/Attachment",
  component: Attachment,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Attachment>

export default meta
type Story = StoryObj<typeof meta>

function DocumentAttachment({ state = "done" }: { state?: "idle" | "uploading" | "processing" | "error" | "done" }) {
  return (
    <Attachment state={state}>
      <AttachmentMedia><PlatformIcon icon={FileText} /></AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>implementation-notes.md</AttachmentTitle>
        <AttachmentDescription>{state === "error" ? "Upload failed" : state === "uploading" ? "Uploading…" : "12 KB"}</AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        {state === "error" ? <AttachmentAction aria-label="Retry upload"><PlatformIcon icon={RotateCcw} /></AttachmentAction> : null}
        <AttachmentAction aria-label="Remove attachment"><PlatformIcon icon={X} /></AttachmentAction>
      </AttachmentActions>
    </Attachment>
  )
}

export const Complete: Story = { render: () => <DocumentAttachment /> }
export const Uploading: Story = { render: () => <DocumentAttachment state="uploading" /> }
export const Error: Story = { render: () => <DocumentAttachment state="error" /> }
export const Group: Story = {
  render: () => (
    <AttachmentGroup aria-label="Message attachments">
      <DocumentAttachment />
      <Attachment orientation="vertical" size="sm">
        <AttachmentMedia><PlatformIcon icon={Image} /></AttachmentMedia>
        <AttachmentContent><AttachmentTitle>preview.png</AttachmentTitle><AttachmentDescription>84 KB</AttachmentDescription></AttachmentContent>
      </Attachment>
    </AttachmentGroup>
  ),
}

function SizeAttachment({ filename, orientation = "horizontal", size = "default" }: { filename: string; orientation?: "horizontal" | "vertical"; size?: "default" | "sm" | "xs" }) {
  return (
    <Attachment orientation={orientation} size={size}>
      <AttachmentMedia><PlatformIcon icon={FileText} /></AttachmentMedia>
      <AttachmentContent><AttachmentTitle>{filename}</AttachmentTitle></AttachmentContent>
    </Attachment>
  )
}

export const SizeMatrix: Story = {
  render: () => (
    <div className="flex max-w-xl flex-wrap items-start gap-3">
      <SizeAttachment filename="default.md" />
      <SizeAttachment filename="small.md" size="sm" />
      <SizeAttachment filename="compact.md" size="xs" />
      <SizeAttachment filename="vertical-small.md" orientation="vertical" size="sm" />
      <SizeAttachment filename="vertical-compact.md" orientation="vertical" size="xs" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const expectedSizes = [
      ["default.md", "16px"],
      ["small.md", "16px"],
      ["compact.md", "14px"],
      ["vertical-small.md", "24px"],
      ["vertical-compact.md", "14px"],
    ] as const
    for (const [filename, expectedSize] of expectedSizes) {
      const attachment = canvas.getByText(filename).closest('[data-slot="attachment"]')
      const icon = attachment?.querySelector('[data-slot="attachment-media"] > [data-slot="platform-icon"]')
      await expect(icon).not.toBeNull()
      await expect(getComputedStyle(icon!).width).toBe(expectedSize)
      await expect(getComputedStyle(icon!).height).toBe(expectedSize)
    }
  },
}
