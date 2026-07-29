import type { Meta, StoryObj } from "@storybook/react-vite"

import { GalleryVisualEvidence } from "@/features/admin/gallery-visual-evidence"

const png = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const secondPng = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const video = "cccccccccccccccccccccccccccccccc"

const meta = {
  title: "Admin/Gallery visual evidence",
  component: GalleryVisualEvidence,
  parameters: { layout: "padded" },
} satisfies Meta<typeof GalleryVisualEvidence>

export default meta
type Story = StoryObj<typeof meta>

export const Complete: Story = { args: { visuals: { captures: [{ index: 0, path: "/", viewport: null, before: { png }, after: { png: secondPng } }] } } }

export const CaptureWarnings: Story = { args: { visuals: { captures: [{ index: 0, path: "/search", viewport: null, before: { png }, after: { png: secondPng, webm: video }, beforeFellBack: true }, { index: 1, path: "/new-flow", viewport: "mobile", before: null, after: { png: secondPng } }] } } }

export const NoArtifacts: Story = { args: { visuals: null } }
