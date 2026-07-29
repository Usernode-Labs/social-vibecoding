import { Eye, GitPullRequest, LockKeyhole, UsersRound } from "lucide-react"
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"

import { PlatformIcon } from "@/components/platform-icon"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { AppVisibility } from "@/lib/apps-api"

export type AppVisibilitySelection = {
  collabVisibility: AppVisibility
  viewVisibility: AppVisibility
}

export type AppVisibilityProposalState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "ready"; existing: boolean; proposalHref: string; prNumber: number | null }
  | { kind: "error"; message: string }

type AppVisibilitySettingsProps = {
  appName: string
  canManage: boolean
  current: AppVisibilitySelection
  disabled?: boolean
  onPropose: (selection: AppVisibilitySelection) => void
  proposal: AppVisibilityProposalState
  selfHosted: boolean
}

function visibilitySummary(selection: AppVisibilitySelection) {
  if (selection.collabVisibility === "public") {
    return "Anyone on the platform can build and open this app."
  }
  return selection.viewVisibility === "private"
    ? "Only accepted collaborators can build or open this app."
    : "Only accepted collaborators can build; everyone can open the app."
}

/**
 * The visibility editor deliberately models a proposed target rather than a
 * mutable switch. The current server policy remains visually authoritative
 * until the resulting manifest PR passes governance and deploy reconciliation.
 */
export function AppVisibilitySettings({
  appName,
  canManage,
  current,
  disabled = false,
  onPropose,
  proposal,
  selfHosted,
}: AppVisibilitySettingsProps) {
  const [draft, setDraft] = useState<AppVisibilitySelection>(current)
  const [confirmOpen, setConfirmOpen] = useState(false)

  useEffect(() => {
    setDraft({
      collabVisibility: current.collabVisibility,
      viewVisibility: current.viewVisibility,
    })
  }, [current.collabVisibility, current.viewVisibility])

  const changed =
    draft.collabVisibility !== current.collabVisibility ||
    draft.viewVisibility !== current.viewVisibility
  const submitting = proposal.kind === "submitting"
  const controlsDisabled = disabled || submitting || !canManage || selfHosted

  const selectCollaboration = (values: string[]) => {
    const collabVisibility = values[0] as AppVisibility | undefined
    if (!collabVisibility) return
    setDraft((selection) => ({
      collabVisibility,
      viewVisibility: collabVisibility === "public" ? "public" : selection.viewVisibility,
    }))
  }

  const selectViewing = (values: string[]) => {
    const viewVisibility = values[0] as AppVisibility | undefined
    if (!viewVisibility || draft.collabVisibility === "public") return
    setDraft((selection) => ({ ...selection, viewVisibility }))
  }

  return (
    <Card data-testid="app-visibility-settings">
      <CardHeader>
        <CardTitle>Visibility</CardTitle>
        <CardDescription>
          Choose who can build and who can open {appName}. Changes enter the normal proposal, vote, merge, and deployment lifecycle.
        </CardDescription>
        <CardAction>
          <Badge variant="outline">
            {current.collabVisibility === "public" ? "Open collaboration" : "Private collaboration"}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Alert>
            <PlatformIcon icon={Eye} />
            <AlertTitle>Current access</AlertTitle>
            <AlertDescription>{visibilitySummary(current)}</AlertDescription>
          </Alert>
          <Field data-disabled={controlsDisabled}>
            <FieldContent>
              <FieldLabel>Who can build?</FieldLabel>
              <FieldDescription>
                Public collaboration also requires public viewing. Private collaboration enables invitations and a private viewing option.
              </FieldDescription>
            </FieldContent>
            <ToggleGroup
              aria-label="Who can build"
              disabled={controlsDisabled}
              onValueChange={selectCollaboration}
              spacing={0}
              value={[draft.collabVisibility]}
              variant="outline"
            >
              <ToggleGroupItem value="public">
                <PlatformIcon data-icon="inline-start" icon={UsersRound} />
                Anyone
              </ToggleGroupItem>
              <ToggleGroupItem value="private">
                <PlatformIcon data-icon="inline-start" icon={LockKeyhole} />
                Collaborators
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <Field data-disabled={controlsDisabled || draft.collabVisibility === "public"}>
            <FieldContent>
              <FieldLabel>Who can open the app?</FieldLabel>
              <FieldDescription>
                Viewing can be private only while collaboration is private.
              </FieldDescription>
            </FieldContent>
            <ToggleGroup
              aria-label="Who can open the app"
              disabled={controlsDisabled || draft.collabVisibility === "public"}
              onValueChange={selectViewing}
              spacing={0}
              value={[draft.viewVisibility]}
              variant="outline"
            >
              <ToggleGroupItem value="public">
                <PlatformIcon data-icon="inline-start" icon={Eye} />
                Everyone
              </ToggleGroupItem>
              <ToggleGroupItem value="private">
                <PlatformIcon data-icon="inline-start" icon={LockKeyhole} />
                Collaborators
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>
          {changed ? (
            <Alert>
              <PlatformIcon icon={GitPullRequest} />
              <AlertTitle>Proposed access</AlertTitle>
              <AlertDescription>{visibilitySummary(draft)}</AlertDescription>
            </Alert>
          ) : null}
          {!canManage ? (
            <p className="text-sm text-muted-foreground">
              Only the app creator or an administrator can propose a visibility change.
            </p>
          ) : null}
          {selfHosted ? (
            <p className="text-sm text-muted-foreground">
              This self-hosted platform app does not manage visibility through a manifest proposal.
            </p>
          ) : null}
          {proposal.kind === "error" ? (
            <Alert variant="destructive">
              <AlertTitle>Visibility proposal was not created</AlertTitle>
              <AlertDescription>{proposal.message}</AlertDescription>
            </Alert>
          ) : null}
          {proposal.kind === "ready" ? (
            <Alert>
              <PlatformIcon icon={GitPullRequest} />
              <AlertTitle>{proposal.existing ? "Visibility proposal already open" : "Visibility proposal created"}</AlertTitle>
              <AlertDescription>
                {proposal.prNumber ? `PR #${proposal.prNumber} is ready for the group’s vote. ` : ""}
                The current access policy stays in place until the proposal passes and deploys.
              </AlertDescription>
            </Alert>
          ) : null}
        </FieldGroup>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button
          disabled={controlsDisabled || !changed}
          onClick={() => setConfirmOpen(true)}
          type="button"
        >
          <PlatformIcon data-icon="inline-start" icon={GitPullRequest} />
          {submitting ? "Opening proposal…" : "Propose visibility change"}
        </Button>
        {changed ? (
          <Button disabled={submitting} onClick={() => setDraft(current)} type="button" variant="outline">
            Reset
          </Button>
        ) : null}
        {proposal.kind === "ready" ? (
          <Button render={<Link to={proposal.proposalHref} />} variant="outline">
            Open proposal
          </Button>
        ) : null}
      </CardFooter>

      <AlertDialog onOpenChange={(open) => { if (!submitting) setConfirmOpen(open) }} open={confirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Open a visibility proposal?</AlertDialogTitle>
            <AlertDialogDescription>
              This creates a GitHub-backed manifest proposal. {visibilitySummary(draft)} The change applies only after the group approves it, it merges, and the app redeploys.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={submitting || !changed || disabled}
              onClick={() => {
                setConfirmOpen(false)
                onPropose(draft)
              }}
              type="button"
            >
              Open proposal
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
