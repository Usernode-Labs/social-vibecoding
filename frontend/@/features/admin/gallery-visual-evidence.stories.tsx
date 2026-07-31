import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fireEvent, waitFor, within } from "storybook/test"

import { GalleryVisualEvidence } from "@/features/admin/gallery-visual-evidence"

const png = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const secondPng = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const video = "cccccccccccccccccccccccccccccccc"
const deterministicArtwork = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl2gAAAAASUVORK5CYII="

const meta = {
  title: "Blocks/Admin/Gallery visual evidence",
  component: GalleryVisualEvidence,
  parameters: { layout: "padded" },
} satisfies Meta<typeof GalleryVisualEvidence>

export default meta
type Story = StoryObj<typeof meta>

function loadVisibleMedia(canvasElement: HTMLElement) {
  canvasElement.querySelectorAll("img").forEach((image) => fireEvent.load(image))
  canvasElement.querySelectorAll("video").forEach((recording) => fireEvent.loadedData(recording))
}

export const Complete: Story = {
  args: { visuals: { captures: [{ index: 0, path: "/", viewport: null, before: { png }, after: { png: secondPng } }] } },
  play: async ({ canvasElement }) => {
    loadVisibleMedia(canvasElement)
    await waitFor(() => expect(canvasElement.querySelectorAll('[data-media-readiness="ready"]')).toHaveLength(2))
  },
}

export const CaptureWarnings: Story = {
  args: { visuals: { captures: [{ index: 0, path: "/search", viewport: null, before: { png }, after: { png: secondPng, webm: video }, beforeFellBack: true }, { index: 1, path: "/new-flow", viewport: "mobile", before: null, after: { png: secondPng } }] } },
  play: async ({ canvasElement }) => {
    loadVisibleMedia(canvasElement)
    await waitFor(() => expect(canvasElement.querySelectorAll('[data-media-readiness="ready"]')).toHaveLength(3))
  },
}

export const Loading: Story = {
  args: { visuals: { captures: [{ index: 0, path: "/search", viewport: "mobile", before: { png }, after: { webm: video } }] } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getAllByRole("status")).toHaveLength(2)
    await expect(canvasElement.querySelectorAll('[data-media-readiness="loading"]')).toHaveLength(2)
  },
}

export const ByteFailure: Story = {
  args: { visuals: { captures: [{ index: 0, path: "/search", viewport: "mobile", before: null, after: { png: secondPng } }] } },
  play: async ({ canvasElement }) => {
    const image = within(canvasElement).getByRole("img", { name: "After /search · mobile" })
    fireEvent.error(image)
    await expect(within(canvasElement).getByRole("alert")).toHaveTextContent("After visual didn’t load")
    await expect(within(canvasElement).getByRole("button", { name: "Retry" })).toBeVisible()
  },
}

export const VideoFallback: Story = {
  args: { visuals: { captures: [{ index: 0, path: "/search", viewport: "mobile", before: null, after: { png: secondPng, webm: video } }] } },
  play: async ({ canvasElement }) => {
    const fallbackReady = new Promise<HTMLImageElement>((resolve) => {
      const observer = new MutationObserver(() => {
        const image = canvasElement.querySelector("img")
        if (!image) return
        observer.disconnect()
        image.src = deterministicArtwork
        fireEvent.load(image)
        resolve(image)
      })
      observer.observe(canvasElement, { childList: true, subtree: true })
    })
    fireEvent.error(canvasElement.querySelector("video")!)
    await fallbackReady
    await waitFor(() => expect(canvasElement.querySelector('[data-media-readiness="ready"]')).toBeTruthy())
    await expect(within(canvasElement).getByText("Recording unavailable")).toBeVisible()
  },
}

export const InvalidReference: Story = {
  args: { visuals: { captures: [{ index: 0, path: "/search", viewport: null, before: null, after: { png: "not-a-visual-id" } }] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole("alert")).toHaveTextContent("stored artifact reference is invalid")
    await expect(canvas.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument()
  },
}

export const NoArtifacts: Story = { args: { visuals: null } }
