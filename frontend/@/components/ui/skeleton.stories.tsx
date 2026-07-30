import type { Meta, StoryObj } from "@storybook/react-vite"

import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

const meta = {
  title: "Elements/Primitives/Skeleton",
  component: Skeleton,
  parameters: { layout: "centered" },
  args: { className: "h-5 w-40" },
} satisfies Meta<typeof Skeleton>

export default meta
type Story = StoryObj<typeof meta>

export const Line: Story = {}
export const CardLoading: Story = {
  render: () => (
    <Card className="w-80" role="status">
      <span className="sr-only">Loading app details</span>
      <CardHeader><Skeleton className="h-6 w-36" /><Skeleton className="h-4 w-56" /></CardHeader>
      <CardContent className="flex flex-col gap-3"><Skeleton className="h-20 w-full" /><Skeleton className="h-9 w-28" /></CardContent>
    </Card>
  ),
}
