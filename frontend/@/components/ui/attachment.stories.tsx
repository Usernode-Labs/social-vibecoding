import type { Meta, StoryObj } from "@storybook/react-vite"
import { FileText, Image, RotateCcw, X } from "lucide-react"

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
