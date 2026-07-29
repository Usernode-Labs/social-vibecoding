import type { Meta, StoryObj } from "@storybook/react-vite"

import { TopicAttributeControls } from "@/features/dev/topic-attribute-controls"

const attributes = {
  priority: {
    field: "priority" as const,
    options: [{ value: "high", count: 3, mine: true }],
    myValue: "high",
  },
  category: {
    field: "category" as const,
    options: [{ value: "ux", count: 2 }],
    myValue: null,
    categories: [
      { value: "bug", label: "Bug", custom: false },
      { value: "ux", label: "UX", custom: true },
    ],
  },
  assignee: {
    field: "assignee" as const,
    options: [{ value: "sam", count: 2 }],
    myValue: null,
  },
}

const meta = {
  title: "Dev/Topic attribute controls",
  component: TopicAttributeControls,
  parameters: { layout: "padded" },
} satisfies Meta<typeof TopicAttributeControls>

export default meta
type Story = StoryObj<typeof meta>

export const Loaded: Story = {
  args: { attributes, onChange: async () => true },
}

export const SavingCategory: Story = {
  args: { attributes, onChange: async () => true, pendingField: "category" },
}

export const PartialAvailability: Story = {
  args: { attributes: { priority: attributes.priority, category: null, assignee: null }, onChange: async () => false },
}

export const ReadOnly: Story = {
  args: { attributes, disabled: true, onChange: async () => false },
}
