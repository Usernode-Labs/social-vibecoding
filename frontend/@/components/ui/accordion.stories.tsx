import type { Meta, StoryObj } from "@storybook/react-vite"

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"

const meta = {
  title: "Elements/Primitives/Accordion",
  component: Accordion,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="w-screen max-w-xl px-4"><Story /></div>],
} satisfies Meta<typeof Accordion>

export default meta
type Story = StoryObj<typeof meta>

export const Closed: Story = {
  render: () => (
    <Accordion>
      <AccordionItem value="details">
        <AccordionTrigger>How does this work?</AccordionTrigger>
        <AccordionContent>The details remain available without leaving the current screen.</AccordionContent>
      </AccordionItem>
    </Accordion>
  ),
}

export const Open: Story = {
  render: () => (
    <Accordion defaultValue={["details"]}>
      <AccordionItem value="details">
        <AccordionTrigger>How does this work?</AccordionTrigger>
        <AccordionContent>The details remain available without leaving the current screen.</AccordionContent>
      </AccordionItem>
      <AccordionItem value="privacy">
        <AccordionTrigger>Who can see it?</AccordionTrigger>
        <AccordionContent>Visibility follows the current app collaboration settings.</AccordionContent>
      </AccordionItem>
    </Accordion>
  ),
}
