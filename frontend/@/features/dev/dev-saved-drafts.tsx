import { Pencil, SendHorizontal, Trash2 } from "lucide-react"

import { PlatformIcon } from "@/components/platform-icon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import type { SavedDevDraft } from "@/lib/dev-session-draft"

type DevSavedDraftsViewProps = {
  busy?: boolean
  drafts: SavedDevDraft[]
  onDelete: (id: string) => void
  onEdit: (id: string) => void
  onSend: (id: string) => void
  streaming?: boolean
}

export function DevSavedDraftsView({
  busy = false,
  drafts,
  onDelete,
  onEdit,
  onSend,
  streaming = false,
}: DevSavedDraftsViewProps) {
  if (!drafts.length) return null

  return (
    <section aria-labelledby="saved-dev-drafts-heading" className="overflow-hidden rounded-xl border bg-container" data-surface="container">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium" id="saved-dev-drafts-heading">Saved drafts</h3>
          <Badge variant="secondary">{drafts.length}</Badge>
        </div>
        {streaming ? <span className="text-sm text-muted-foreground sm:text-xs">Sending unlocks when Builder finishes</span> : null}
      </header>
      <ul className="divide-y">
        {drafts.map((draft) => (
          <li className="flex min-w-0 items-center gap-3 px-3 py-2" key={draft.id}>
            <p className="min-w-0 flex-1 truncate text-sm" title={draft.text}>{draft.text}</p>
            <ButtonGroup aria-label={`Actions for saved draft: ${draft.text}`}>
              <Button
                aria-label={`Send saved draft: ${draft.text}`}
                disabled={busy || streaming}
                onClick={() => onSend(draft.id)}
                size="icon-sm"
                title={streaming ? "Builder is still working" : "Send this draft now"}
                type="button"
                variant="outline"
              >
                <PlatformIcon data-icon icon={SendHorizontal} />
              </Button>
              <Button
                aria-label={`Edit saved draft: ${draft.text}`}
                disabled={busy}
                onClick={() => onEdit(draft.id)}
                size="icon-sm"
                title="Move this draft into the composer"
                type="button"
                variant="outline"
              >
                <PlatformIcon data-icon icon={Pencil} />
              </Button>
              <Button
                aria-label={`Delete saved draft: ${draft.text}`}
                disabled={busy}
                onClick={() => onDelete(draft.id)}
                size="icon-sm"
                title="Delete this draft"
                type="button"
                variant="outline"
              >
                <PlatformIcon data-icon icon={Trash2} />
              </Button>
            </ButtonGroup>
          </li>
        ))}
      </ul>
    </section>
  )
}
