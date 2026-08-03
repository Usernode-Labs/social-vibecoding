import type { Meta, StoryObj } from "@storybook/react-vite"
import { TriangleAlert } from "lucide-react"
import { expect } from "storybook/test"

import { PlatformIcon } from "@/components/platform-icon"
import { ShellAttentionProvider } from "@/components/platform-menu-trigger"
import { TopBar } from "@/components/top-bar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { SidebarProvider } from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { HostedAppStage } from "@/features/apps/hosted-app-stage"
import { cn } from "@/lib/utils"

type MatrixState = "error" | "loading" | "ready" | "staged"

function StageContent({ state }: { state: MatrixState }) {
  if (state === "loading") return <Skeleton aria-label="Loading app" className="min-h-64 flex-1" role="status" />
  if (state === "error") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <Alert className="max-w-md" variant="destructive">
          <PlatformIcon icon={TriangleAlert} />
          <AlertTitle>App unavailable</AlertTitle>
          <AlertDescription>Check your connection and try again.</AlertDescription>
        </Alert>
      </div>
    )
  }
  return (
    <div className="flex min-h-64 flex-1 items-center justify-center bg-background text-sm text-muted-foreground">
      Child application canvas
    </div>
  )
}

function StageCase({
  dark = false,
  mobile,
  state,
}: {
  dark?: boolean
  mobile: boolean
  state: MatrixState
}) {
  return (
    <section
      aria-label={dark ? "Dark theme" : "Light theme"}
      className={cn("h-136 overflow-hidden", dark && "dark", mobile ? "w-full" : "min-w-0 flex-1")}
      data-theme-case={dark ? "dark" : "light"}
    >
      <SidebarProvider className="h-full min-h-0">
        <div className="flex min-h-0 flex-1 flex-col bg-paper text-foreground" data-surface="paper">
          <ShellAttentionProvider count={0}>
            <HostedAppStage
              header={<TopBar action={<Button size="sm" type="button" variant="outline">Improve</Button>} title="RecipeBot" />}
              staged={state === "staged"}
              state={state === "staged" ? "ready" : state}
            >
              <StageContent state={state} />
            </HostedAppStage>
          </ShellAttentionProvider>
        </div>
      </SidebarProvider>
    </section>
  )
}

function StageMatrix({ mobile, state }: { mobile: boolean; state: MatrixState }) {
  return (
    <div className={cn("flex min-h-screen gap-4 bg-muted p-4", mobile ? "flex-col" : "flex-row")}>
      <StageCase mobile={mobile} state={state} />
      <StageCase dark mobile={mobile} state={state} />
    </div>
  )
}

async function assertStageContract(canvasElement: HTMLElement, mobile: boolean, staged: boolean) {
  const cases = canvasElement.querySelectorAll<HTMLElement>("[data-theme-case]")
  await expect(cases).toHaveLength(2)
  for (const themeCase of cases) {
    const paper = themeCase.querySelector<HTMLElement>('[data-surface="paper"]')
    const stage = themeCase.querySelector<HTMLElement>('[data-slot="hosted-app-stage"]')
    const header = themeCase.querySelector<HTMLElement>('[data-slot="top-bar"]')
    const card = themeCase.querySelector<HTMLElement>('[data-slot="app-stage-card"]')
    await expect(paper).toBeTruthy()
    await expect(stage).toBeTruthy()
    await expect(header).toBeTruthy()
    await expect(card).toBeTruthy()
    await expect(themeCase.querySelectorAll('[data-surface="paper"]')).toHaveLength(1)
    await expect(stage).toHaveAttribute("data-surface", "print")
    await expect(paper!.contains(header!)).toBe(true)
    await expect(paper!.contains(card!)).toBe(true)
    const paperBackground = getComputedStyle(paper!).backgroundColor
    const unpainted = document.createElement("div")
    themeCase.append(unpainted)
    const unpaintedBackground = getComputedStyle(unpainted).backgroundColor
    unpainted.remove()
    await expect(getComputedStyle(stage!).backgroundColor).toBe(unpaintedBackground)
    await expect(getComputedStyle(header!).backgroundColor).toBe(unpaintedBackground)
    const cardStyle = getComputedStyle(card!)
    await expect(paperBackground).not.toBe(cardStyle.backgroundColor)
    await expect(Number.parseFloat(cardStyle.borderTopLeftRadius)).toBeGreaterThan(0)
    await expect(Number.parseFloat(cardStyle.borderTopRightRadius)).toBeGreaterThan(0)
    if (mobile) {
      await expect(Number.parseFloat(cardStyle.borderBottomLeftRadius)).toBe(0)
      await expect(Number.parseFloat(cardStyle.borderBottomRightRadius)).toBe(0)
    } else {
      await expect(Number.parseFloat(cardStyle.borderBottomLeftRadius)).toBeGreaterThan(0)
      await expect(Number.parseFloat(cardStyle.borderBottomRightRadius)).toBeGreaterThan(0)
    }
    if (staged) {
      const status = themeCase.querySelector<HTMLElement>('[data-slot="app-stage-boundary"]')
      const label = themeCase.querySelector<HTMLElement>('[data-slot="app-stage-status"]')
      await expect(status).toHaveAttribute("data-status-tone", "info")
      await expect(label).toBeVisible()
      await expect(getComputedStyle(status!).backgroundColor).not.toBe(paperBackground)
    }
  }
}

const meta = {
  title: "Blocks/Apps/Hosted app stage",
  component: HostedAppStage,
  parameters: { layout: "fullscreen" },
  args: {
    children: <StageContent state="ready" />,
    header: <TopBar title="RecipeBot" />,
    state: "ready",
  },
} satisfies Meta<typeof HostedAppStage>

export default meta
type Story = StoryObj<typeof meta>

function desktop(state: MatrixState): Story {
  return {
    render: () => <StageMatrix mobile={false} state={state} />,
    play: async ({ canvasElement }) => assertStageContract(canvasElement, false, state === "staged"),
  }
}

function mobile(state: MatrixState): Story {
  return {
    parameters: { viewport: { defaultViewport: "mobile1" } },
    render: () => <StageMatrix mobile state={state} />,
    play: async ({ canvasElement }) => assertStageContract(canvasElement, true, state === "staged"),
  }
}

export const ReadyDesktop: Story = desktop("ready")
export const LoadingDesktop: Story = desktop("loading")
export const ErrorDesktop: Story = desktop("error")
export const StagedDesktop: Story = desktop("staged")
export const ReadyMobile: Story = mobile("ready")
export const LoadingMobile: Story = mobile("loading")
export const ErrorMobile: Story = mobile("error")
export const StagedMobile: Story = mobile("staged")
