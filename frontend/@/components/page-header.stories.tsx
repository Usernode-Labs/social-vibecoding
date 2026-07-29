import type { ReactNode } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, within } from "storybook/test"

import { PageHeader } from "@/components/page-header"
import { Button, buttonVariants } from "@/components/ui/button"

function EvidenceFrame({
  children,
  label,
  mobile = false,
  theme,
}: {
  children: ReactNode
  label: string
  mobile?: boolean
  theme: "light" | "dark"
}) {
  return (
    <section
      aria-label={label}
      className={`${theme === "dark" ? "dark" : ""} ${
        mobile ? "w-80" : "w-full max-w-4xl"
      } max-w-full overflow-hidden rounded-2xl border bg-background p-6 text-foreground`}
      role="region"
    >
      {children}
    </section>
  )
}

const meta = {
  title: "Shell/Page header",
  component: PageHeader,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="grid justify-items-start gap-8">
        <EvidenceFrame label="Light desktop" theme="light">
          <Story />
        </EvidenceFrame>
        <EvidenceFrame label="Dark desktop" theme="dark">
          <Story />
        </EvidenceFrame>
        <EvidenceFrame label="Light mobile" mobile theme="light">
          <Story />
        </EvidenceFrame>
        <EvidenceFrame label="Dark mobile" mobile theme="dark">
          <Story />
        </EvidenceFrame>
      </div>
    ),
  ],
} satisfies Meta<typeof PageHeader>

export default meta
type Story = StoryObj<typeof meta>

const createDapp = fn()

export const WithDescription: Story = {
  args: {
    title: "Work",
    description: "Review sessions and proposals across the dApps you build.",
  },
  play: async ({ canvasElement }) => {
    const regions = within(canvasElement).getAllByRole("region")
    for (const region of regions) {
      const canvas = within(region)
      await expect(canvas.getAllByRole("heading", { level: 1 })).toHaveLength(1)
      await expect(
        canvas.getByText(
          "Review sessions and proposals across the dApps you build."
        )
      ).toBeVisible()
    }
  },
}

export const WithAction: Story = {
  args: {
    title: "dApps",
    action: (
      <Button onClick={createDapp} type="button">
        Create dApp
      </Button>
    ),
  },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", {
      name: "Light desktop",
    })
    const action = within(region).getByRole("button", { name: "Create dApp" })
    await userEvent.click(action)
    await expect(createDapp).toHaveBeenCalled()
  },
}

export const Compact: Story = {
  args: {
    title: "Node details",
    compact: true,
  },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", {
      name: "Light desktop",
    })
    await expect(region.querySelector("[data-compact='true']")).toBeTruthy()
    await expect(
      within(region).getAllByRole("heading", { level: 1 })
    ).toHaveLength(1)
  },
}

export const LongTitle: Story = {
  args: {
    title: "Members and visibility for Collaborative Sketchbook",
  },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", {
      name: "Light mobile",
    })
    const heading = within(region).getByRole("heading", {
      level: 1,
      name: "Members and visibility for Collaborative Sketchbook",
    })
    await expect(heading.scrollWidth).toBeLessThanOrEqual(heading.clientWidth)
    await expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth)
  },
}

export const Narrow: Story = {
  args: {
    title: "App settings",
    description: "Choose who can open and improve this dApp.",
    action: (
      <a
        className={buttonVariants({ variant: "default" })}
        href="/react/apps/game-corner/settings/access"
      >
        Manage access
      </a>
    ),
  },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", {
      name: "Light mobile",
    })
    const canvas = within(region)
    const heading = canvas.getByRole("heading", {
      level: 1,
      name: "App settings",
    })
    const action = canvas.getByRole("link", { name: "Manage access" })
    await expect(action).toHaveAttribute(
      "href",
      "/react/apps/game-corner/settings/access"
    )
    await expect(action.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      heading.getBoundingClientRect().bottom
    )
    await expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth)
  },
}

export const NoDescription: Story = {
  args: {
    title: "Activity",
  },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", {
      name: "Light desktop",
    })
    const header = region.querySelector("[data-slot='page-header']")
    await expect(header).toHaveAttribute("aria-labelledby")
    await expect(header).not.toHaveAttribute("aria-describedby")
    await expect(
      within(region).getAllByRole("heading", { level: 1 })
    ).toHaveLength(1)
  },
}
