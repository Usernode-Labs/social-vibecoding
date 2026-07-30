import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"

import { ShellAttentionProvider } from "@/components/platform-menu-trigger"
import { SidebarProvider } from "@/components/ui/sidebar"
import { NotFound } from "@/features/platform/not-found"

const meta = {
  title: "Features/Platform/Not found",
  component: NotFound,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <SidebarProvider>
        <ShellAttentionProvider count={0}>
          <div className="flex min-h-96 flex-col"><Story /></div>
        </ShellAttentionProvider>
      </SidebarProvider>
    ),
  ],
} satisfies Meta<typeof NotFound>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole("heading", { level: 1, name: "Page not found" })).toBeTruthy()
    await expect(canvas.getByText("This page doesn’t exist.")).toBeTruthy()
    await expect(canvas.getByRole("link", { name: "Go to Home" })).toHaveAttribute("href", "/")
  },
}

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
}
