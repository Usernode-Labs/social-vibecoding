import { Flag, Tags, UserRound, X } from "lucide-react"
import { useState } from "react"

import { PlatformIcon } from "@/components/platform-icon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { TopicAttributeField, TopicAttributeOptions } from "@/lib/github-issues-api"

const PRIORITIES = [
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
]

type TopicAttributeControlsProps = {
  attributes: Partial<Record<TopicAttributeField, TopicAttributeOptions | null>>
  disabled?: boolean
  onChange: (field: TopicAttributeField, value: string | null) => Promise<boolean>
  pendingField?: TopicAttributeField | null
}

function tally(attribute: TopicAttributeOptions | null | undefined) {
  const top = attribute?.options[0]
  if (!top) return null
  return `${top.value} · ${top.count}`
}

function choices(field: TopicAttributeField, attribute: TopicAttributeOptions | null | undefined) {
  if (field === "priority") return PRIORITIES
  if (field === "category") {
    const categories = attribute?.categories || []
    return categories.map((category) => ({ label: category.label, value: category.value }))
  }
  return (attribute?.options || []).map((option) => ({ label: `@${option.value}`, value: option.value }))
}

/**
 * One inspectable contract for the platform-local topic signals shared by
 * issues and proposals. Each field is a personal, reversible vote; the
 * community-leading value remains server-derived and is never mutated here.
 */
export function TopicAttributeControls({ attributes, disabled = false, onChange, pendingField = null }: TopicAttributeControlsProps) {
  const [assigneeDraft, setAssigneeDraft] = useState("")
  const [categoryDraft, setCategoryDraft] = useState("")

  const renderField = (field: TopicAttributeField, label: string, description: string, icon: typeof Flag) => {
    const attribute = attributes[field]
    const pending = pendingField === field
    const options = choices(field, attribute)
    const draft = field === "assignee" ? assigneeDraft : categoryDraft
    const setDraft = field === "assignee" ? setAssigneeDraft : setCategoryDraft
    const custom = field !== "priority"
    const submitCustom = async () => {
      const value = draft.trim().replace(/\s+/g, " ")
      if (!value) return
      if (await onChange(field, value)) setDraft("")
    }

    return <Field className="min-w-0" key={field}>
      <div className="flex flex-wrap items-center gap-2">
        <FieldLabel className="flex items-center gap-2" htmlFor={`topic-attribute-${field}`}><PlatformIcon icon={icon} size="sm" />{label}</FieldLabel>
        {tally(attribute) ? <Badge className="max-w-full truncate" variant="outline">Community: {tally(attribute)}</Badge> : null}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select disabled={disabled || pending || attribute === null || attribute === undefined || options.length === 0} onValueChange={(value) => { if (value) void onChange(field, value) }} value={attribute?.myValue || null}>
          <SelectTrigger aria-label={`My ${label.toLowerCase()}`} className="w-full sm:w-52" id={`topic-attribute-${field}`} size="sm">
            <SelectValue placeholder={attribute === undefined || attribute === null ? "Loading…" : options.length ? `Choose ${label.toLowerCase()}` : "No suggestions yet"} />
          </SelectTrigger>
          <SelectContent>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
        </Select>
        {attribute?.myValue ? <Button disabled={disabled || pending} onClick={() => void onChange(field, null)} size="sm" type="button" variant="ghost"><PlatformIcon data-icon="inline-start" icon={X} />Clear my {label.toLowerCase()}</Button> : null}
      </div>
      {custom ? <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); void submitCustom() }}>
        <Input aria-label={field === "assignee" ? "Suggest assignee" : "Suggest category"} disabled={disabled || pending} maxLength={field === "assignee" ? 64 : 32} onChange={(event) => setDraft(event.target.value)} placeholder={field === "assignee" ? "Type a collaborator name" : "Type a category"} value={draft} />
        <Button disabled={disabled || pending || !draft.trim()} size="sm" type="submit">Suggest</Button>
      </form> : null}
      <FieldDescription>{description}{pending ? " Saving your vote…" : ""}</FieldDescription>
    </Field>
  }

  return <section aria-labelledby="topic-attribute-heading" className="flex flex-col gap-3">
    <div><h3 className="text-sm font-medium" id="topic-attribute-heading">Community signals</h3><p className="text-sm text-muted-foreground">Community suggestions, not assignments.</p></div>
    <FieldGroup className="grid gap-5 lg:grid-cols-3">
      {renderField("priority", "Priority", "Signal how urgently the community should consider this issue.", Flag)}
      {renderField("category", "Category", "Choose an app category or suggest a short new one.", Tags)}
      {renderField("assignee", "Assigned person", "Suggest who could take this work; the leading vote is shown to everyone.", UserRound)}
    </FieldGroup>
  </section>
}
