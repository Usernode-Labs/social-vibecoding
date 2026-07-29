import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core"
import { arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { GripVertical, Search, Vote } from "lucide-react"
import { useEffect, useMemo, useState, type HTMLAttributes } from "react"
import { Link } from "react-router-dom"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PlatformIcon } from "@/components/platform-icon"
import { StatusDot } from "@/components/status-dot"
import type { AppSession } from "@/lib/apps-api"
import type { BoardOrderEntry, DevBoardSnapshot, MergedBoardItem, PmOrder, PmOrderEntry, SharedBoardSession } from "@/lib/dev-board-api"
import type { DevIssue, DevProposal } from "@/lib/dev-forum-api"
import type { GitHubIssue } from "@/lib/github-issues-api"
import { appDevGitHubIssuePath, appDevGovernancePath, appDevProposalPath, appDevSessionPath, appDevSharedSessionPath } from "@/lib/routes"
import { cn } from "@/lib/utils"

type ColumnKey = "issues" | "in-progress" | "in-review" | "done"
type ReorderColumn = "issues" | "review"
type FilterValue = { query: string; priority: string; category: string; assignee: string; needsVote: boolean }

/** These names deliberately match the established `?view=` contract. */
export type DevWorkspaceView = "list" | "kanban" | "pm"

export type DevPmMove = {
  target: PmOrderEntry
  sourceAssignee: string | null
  destinationAssignee: string | null
  sourceOrder: PmOrderEntry[]
  destinationOrder: PmOrderEntry[]
}

type BoardCard = {
  id: string
  title: string
  description: string
  href: string
  kind: "issue" | "session" | "shared-session" | "proposal" | "gov" | "merged"
  order?: BoardOrderEntry
  priority?: string | null
  category?: string | null
  assignee?: string | null
  needsVote?: boolean
  status?: string | null
}

type Columns = Record<ColumnKey, BoardCard[]>

const columnLabels: Record<ColumnKey, string> = {
  issues: "Issues",
  "in-progress": "In progress",
  "in-review": "In review",
  done: "Done",
}

const emptyFilter: FilterValue = { query: "", priority: "all", category: "all", assignee: "all", needsVote: false }

function sessionTitle(session: AppSession | SharedBoardSession) {
  return session.session_title || session.pr_title || "New development session"
}

function propTop(value: { top?: string | null } | null | undefined) {
  return value?.top || null
}

function isIssueInProgress(issue: GitHubIssue) {
  return issue.headless?.status === "generating" || issue.headless?.status === "ready" || Boolean(Number(issue.in_progress?.count || 0) || issue.in_progress?.claims?.length)
}

function applySavedOrder(cards: BoardCard[], saved: BoardOrderEntry[]) {
  if (saved.length === 0 || cards.length < 2) return cards
  const rank = new Map(saved.map((entry, index) => [`${entry.type}:${entry.ref}`, index]))
  const unranked: BoardCard[] = []
  const ranked: Array<{ card: BoardCard; position: number }> = []
  cards.forEach((card) => {
    const position = card.order ? rank.get(`${card.order.type}:${card.order.ref}`) : undefined
    if (position === undefined) unranked.push(card)
    else ranked.push({ card, position })
  })
  return [...unranked, ...ranked.sort((a, b) => a.position - b.position).map(({ card }) => card)]
}

function toIssue(issue: GitHubIssue, slug: string): BoardCard {
  return {
    id: `issue:${issue.number}`,
    title: issue.title,
    description: `GitHub issue #${issue.number}${issue.created_by_username ? ` · ${issue.created_by_username}` : ""}`,
    href: appDevGitHubIssuePath(slug, issue.number),
    kind: "issue",
    order: { type: "issue", ref: issue.number },
    priority: propTop(issue.priority),
    category: propTop(issue.category),
    assignee: propTop(issue.assignee),
    status: isIssueInProgress(issue) ? "In progress" : null,
  }
}

function toProposal(proposal: DevProposal, slug: string): BoardCard {
  const title = proposal.pr_title || proposal.pr_title_fallback || `Proposal #${proposal.pr_number || proposal.id}`
  return {
    id: `proposal:${proposal.id}`,
    title,
    description: `Proposal #${proposal.pr_number || proposal.id}${proposal.username ? ` · ${proposal.username}` : ""}`,
    href: appDevProposalPath(slug, proposal.id),
    kind: "proposal",
    order: { type: "proposal", ref: proposal.id },
    priority: propTop(proposal.priority),
    category: propTop(proposal.category),
    assignee: propTop(proposal.assignee),
    needsVote: proposal.status === "promoted" && !proposal.my_vote,
    status: proposal.status === "merging" ? "Merging" : "In vote",
  }
}

function toGovernance(item: DevIssue, slug: string): BoardCard {
  return {
    id: `gov:${item.id}`,
    title: item.title,
    description: `Governance · ${item.kind.replaceAll("_", " ")}`,
    href: appDevGovernancePath(slug, item.id),
    kind: "gov",
    order: { type: "gov", ref: item.id },
    priority: propTop(item.priority),
    category: propTop(item.category),
    assignee: propTop(item.assignee),
    needsVote: !item.my_vote,
    status: "In vote",
  }
}

function toOwnSession(session: AppSession, slug: string): BoardCard {
  return {
    id: `session:${session.id}`,
    title: sessionTitle(session),
    description: session.branch_name || "Your Dev session",
    href: appDevSessionPath(slug, session.id),
    kind: "session",
    status: session.warm ? "Working" : session.status === "paused" ? "Paused" : "Active",
  }
}

function toSharedSession(session: SharedBoardSession, slug: string): BoardCard {
  return {
    id: `shared-session:${session.id}`,
    title: sessionTitle(session),
    description: `Shared by ${session.username || "a collaborator"}`,
    href: appDevSharedSessionPath(slug, session.id),
    kind: "shared-session",
    status: session.busy ? "Working" : session.status === "paused" ? "Paused" : "Shared",
  }
}

function toMerged(item: MergedBoardItem, slug: string): BoardCard {
  const title = item.pr_title || item.title || `Completed change #${item.pr_number || item.id}`
  return {
    id: `merged:${item.row_type || "pr"}:${item.id}`,
    title,
    description: item.row_type === "close_issue" ? "Applied governance change" : `Merged${item.username ? ` · ${item.username}` : ""}`,
    href: item.row_type === "close_issue"
      ? appDevGovernancePath(slug, item.id)
      : appDevProposalPath(slug, item.id),
    kind: "merged",
    status: "Done",
  }
}

function buildColumns(snapshot: DevBoardSnapshot, slug: string): Columns {
  const linkedIssues = new Set(snapshot.proposals.flatMap((proposal) => proposal.linked_issues || []).map(Number).filter(Number.isFinite))
  const issueCards = snapshot.issues.filter((issue) => !linkedIssues.has(issue.number)).map((issue) => toIssue(issue, slug))
  const ownSessions = snapshot.sessions.filter((session) => ["active", "paused"].includes(session.status)).map((session) => toOwnSession(session, slug))
  const sharedSessions = snapshot.sharedSessions.map((session) => toSharedSession(session, slug))
  const inProgressIssues = issueCards.filter((card) => card.status === "In progress")
  const openIssues = issueCards.filter((card) => card.status !== "In progress")
  const review = [...snapshot.proposals.map((item) => toProposal(item, slug)), ...snapshot.governance.map((item) => toGovernance(item, slug))]
  return {
    issues: applySavedOrder(openIssues, snapshot.order.issues),
    "in-progress": [...ownSessions, ...inProgressIssues, ...sharedSessions],
    "in-review": applySavedOrder(review, snapshot.order.review),
    done: snapshot.merged.map((item) => toMerged(item, slug)),
  }
}

function matchesFilter(card: BoardCard, filter: FilterValue) {
  const query = filter.query.trim().toLowerCase()
  if (query && !`${card.title} ${card.description}`.toLowerCase().includes(query)) return false
  if (filter.priority !== "all" && card.priority !== filter.priority) return false
  if (filter.category !== "all" && card.category !== filter.category) return false
  if (filter.assignee === "unassigned") {
    if (card.kind === "gov" || card.assignee) return false
  } else if (filter.assignee !== "all" && card.assignee !== filter.assignee) return false
  return !filter.needsVote || card.needsVote === true
}

function filterOptions(columns: Columns) {
  const cards = Object.values(columns).flat()
  const values = (field: "priority" | "category" | "assignee") => [...new Set(cards.map((card) => card[field]).filter((value): value is string => Boolean(value)))].sort()
  return { priority: values("priority"), category: values("category"), assignee: values("assignee") }
}

type DevBoardProps = {
  slug: string
  snapshot: DevBoardSnapshot
  canReorder: boolean
  loadingMore?: boolean
  mergedError?: string | null
  mode?: DevWorkspaceView
  onLoadMore?: () => void
  onPersistOrder: (column: ReorderColumn, order: BoardOrderEntry[]) => Promise<void>
  onPersistPmMove: (move: DevPmMove) => Promise<void>
}

export function DevBoard({ slug, snapshot, canReorder, loadingMore = false, mergedError, mode = "kanban", onLoadMore, onPersistOrder, onPersistPmMove }: DevBoardProps) {
  const [filter, setFilter] = useState<FilterValue>(emptyFilter)
  const [activeColumn, setActiveColumn] = useState<ColumnKey>("issues")
  const baseColumns = useMemo(() => buildColumns(snapshot, slug), [slug, snapshot])
  const [columns, setColumns] = useState<Columns>(baseColumns)
  const [saving, setSaving] = useState<ReorderColumn | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => setColumns(baseColumns), [baseColumns])
  const options = useMemo(() => filterOptions(baseColumns), [baseColumns])
  const filteredColumns = useMemo(() => Object.fromEntries(Object.entries(columns).map(([key, cards]) => [key, cards.filter((card) => matchesFilter(card, filter))])) as Columns, [columns, filter])
  const hasFilters = Boolean(filter.query || filter.priority !== "all" || filter.category !== "all" || filter.assignee !== "all" || filter.needsVote)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))

  const commitReorder = async (column: ReorderColumn, nextCards: BoardCard[], previous = columns) => {
    const order = nextCards.map((card) => card.order).filter((entry): entry is BoardOrderEntry => Boolean(entry))
    const columnKey: ColumnKey = column === "issues" ? "issues" : "in-review"
    setColumns((current) => ({ ...current, [columnKey]: nextCards }))
    setSaving(column)
    setNotice(null)
    try {
      await onPersistOrder(column, order)
    } catch (cause) {
      setColumns(previous)
      setNotice(cause instanceof Error ? cause.message : "The order could not be saved. The previous order was restored.")
    } finally {
      setSaving(null)
    }
  }

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id || hasFilters) return
    const findColumn = (id: string) => (Object.keys(columns) as ColumnKey[]).find((column) => columns[column].some((card) => card.id === id))
    const source = findColumn(String(active.id))
    const target = findColumn(String(over.id))
    if (!source || !target || source !== target) {
      setNotice("This lifecycle is server-owned. Cards can be reordered within Issues and In review, but cannot move between stages.")
      return
    }
    const persistedColumn: ReorderColumn | null = source === "issues" ? "issues" : source === "in-review" ? "review" : null
    if (!persistedColumn || !canReorder) return
    const from = columns[source].findIndex((card) => card.id === active.id)
    const to = columns[source].findIndex((card) => card.id === over.id)
    if (from < 0 || to < 0 || from === to) return
    await commitReorder(persistedColumn, arrayMove(columns[source], from, to))
  }
  const boardView = mode === "kanban"
  const pmView = mode === "pm"
  const workspaceTitle = boardView ? "Development board" : pmView ? "Tasks by person" : "Development work"
  const workspaceDescription = boardView
    ? "Track work from issue through review. Drag to reorder shared Issues and In review work."
    : pmView
      ? "Open issues and proposals grouped by their leading community assignee. Collaborators can drag to cast or withdraw their own assignee vote and save each person’s order."
      : "A linear activity feed from open work through review and completed changes."

  return <section className="flex flex-col gap-4" aria-labelledby="dev-board-heading" data-testid="dev-board">
    <header className="flex flex-col gap-1"><h3 className="text-lg font-medium" id="dev-board-heading">{workspaceTitle}</h3><p className="text-base text-muted-foreground text-pretty sm:text-sm">{workspaceDescription}</p></header>
    {mode !== "list" ? <div className="flex flex-col gap-2" aria-label="Board filters">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1"><PlatformIcon className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground" icon={Search} /><Input aria-label="Filter board cards" className="pl-8" name="board-filter" onChange={(event) => setFilter((current) => ({ ...current, query: event.target.value }))} placeholder="Filter by title, author, or number" value={filter.query} /></div>
        <Button aria-pressed={filter.needsVote} onClick={() => setFilter((current) => ({ ...current, needsVote: !current.needsVote }))} type="button" variant={filter.needsVote ? "secondary" : "outline"}><PlatformIcon data-icon="inline-start" icon={Vote} />Needs vote</Button>
        {hasFilters ? <Button onClick={() => setFilter(emptyFilter)} type="button" variant="ghost">Clear filters</Button> : null}
      </div>
      {options.priority.length || options.category.length || options.assignee.length ? <div className="flex flex-wrap gap-2">
        <BoardSelect label="Priority" onValueChange={(priority) => setFilter((current) => ({ ...current, priority }))} options={options.priority} value={filter.priority} />
        <BoardSelect label="Category" onValueChange={(category) => setFilter((current) => ({ ...current, category }))} options={options.category} value={filter.category} />
        <BoardSelect includeUnassigned label="Assignee" onValueChange={(assignee) => setFilter((current) => ({ ...current, assignee }))} options={options.assignee} value={filter.assignee} />
      </div> : null}
    </div> : null}
    {notice ? <p className="text-base text-muted-foreground sm:text-sm" role="status">{notice}</p> : null}
    {boardView ? <Tabs onValueChange={(value) => setActiveColumn(value as ColumnKey)} value={activeColumn}>
      <TabsList aria-label="Development board columns" className="w-full max-sm:grid max-sm:grid-cols-4 sm:hidden" variant="line">
        {(Object.keys(columnLabels) as ColumnKey[]).map((key) => <TabsTrigger key={key} value={key}><span className="truncate">{columnLabels[key]}</span><span className="tabular-nums text-muted-foreground">{filteredColumns[key].length}</span></TabsTrigger>)}
      </TabsList>
      <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd} sensors={sensors}><div className="overflow-x-auto pb-2"><div className="grid min-w-[70rem] items-start gap-4 sm:min-w-0 sm:grid-cols-2 xl:grid-cols-4">
        {(Object.keys(columnLabels) as ColumnKey[]).map((column) => <BoardColumn active={activeColumn === column} cards={filteredColumns[column]} column={column} disabled={!canReorder || hasFilters || saving !== null} key={column} />)}
      </div></div></DndContext>
    </Tabs> : null}
    {mode === "list" ? <DevListView columns={columns} /> : null}
    {pmView ? <DevPmView canReorder={canReorder && !hasFilters && saving === null} columns={filteredColumns} onPersistMove={onPersistPmMove} pmOrder={snapshot.pmOrder} setNotice={setNotice} /> : null}
    {mode !== "pm" && (snapshot.mergedHasMore || mergedError) ? <div className="flex flex-wrap items-center gap-3">
      {snapshot.mergedHasMore ? <p className="text-base text-muted-foreground sm:text-sm">Showing the newest {snapshot.merged.length} of {snapshot.mergedTotal} completed changes.</p> : null}
      {snapshot.mergedHasMore && onLoadMore ? <Button disabled={loadingMore} onClick={onLoadMore} size="sm" type="button" variant="outline">{loadingMore ? "Loading…" : "Load older completed work"}</Button> : null}
      {mergedError ? <p className="text-sm text-destructive" role="alert">{mergedError}</p> : null}
    </div> : null}
  </section>
}

function WorkCard({ card }: { card: BoardCard }) {
  const metadata = [card.priority, card.category, card.assignee ? `@${card.assignee}` : null].filter((value): value is string => Boolean(value))
  const session = card.kind === "session" || card.kind === "shared-session"
  const action = session ? "Open session" : "View details"
  return <Card className="gap-0 py-0">
    <CardHeader className="gap-2 p-4 pb-3">
      <div className="flex items-start justify-between gap-3"><div className="min-w-0"><CardTitle className="line-clamp-2 text-base font-medium">{card.title}</CardTitle><CardDescription className="mt-1 line-clamp-2 text-base leading-6 sm:text-sm sm:leading-5">{card.description}</CardDescription></div>{card.status ? <Badge className="shrink-0" variant={card.status === "Working" ? "secondary" : "outline"}>{card.status}</Badge> : null}</div>
    </CardHeader>
    {metadata.length || card.needsVote ? <CardContent className="flex flex-wrap gap-2 px-4 pb-3">{metadata.map((value) => <Badge key={value} variant="secondary">{value}</Badge>)}{card.needsVote ? <StatusDot label="Needs vote" role="attention" subject={card.title} /> : null}</CardContent> : null}
    <CardFooter className="border-t p-3"><Button className="w-full" render={<Link aria-label={session ? `Open ${card.title}` : `View ${card.title}`} to={card.href} />} size="sm" variant="outline">{action}</Button></CardFooter>
  </Card>
}

function DevListView({ columns }: { columns: Columns }) {
  return <div className="flex flex-col gap-6" data-testid="dev-list">
    {(Object.keys(columnLabels) as ColumnKey[]).map((column) => <section aria-labelledby={`dev-list-${column}`} className="flex flex-col gap-3" key={column}>
      <header className="flex items-center justify-between gap-3"><h4 className="text-base font-medium" id={`dev-list-${column}`}>{columnLabels[column]}</h4><Badge variant="outline"><span className="tabular-nums">{columns[column].length}</span></Badge></header>
      {columns[column].length ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{columns[column].map((card) => <WorkCard card={card} key={card.id} />)}</div> : <Empty className="min-h-28 border bg-muted/20"><EmptyHeader><EmptyTitle>Nothing here yet</EmptyTitle><EmptyDescription>{column === "issues" ? "New work will appear here." : "No work is currently in this stage."}</EmptyDescription></EmptyHeader></Empty>}
    </section>)}
  </div>
}

type PmGroup = { id: string; name: string | null; cards: BoardCard[] }

function initialFor(name: string) {
  return name.trim().slice(0, 1).toUpperCase() || "?"
}

function groupPmCards(columns: Columns, pmOrder: PmOrder) {
  // PM deliberately excludes sessions, governance, and completed work: these
  // are not assignable tasks in the established product model.
  const tasks = [...columns.issues, ...columns["in-progress"], ...columns["in-review"]]
    .filter((card) => card.kind === "issue" || card.kind === "proposal")
  const byAssignee = new Map<string, PmGroup>()
  const unassigned: BoardCard[] = []
  tasks.forEach((card) => {
    const name = card.assignee?.trim()
    if (!name) {
      unassigned.push(card)
      return
    }
    const key = name.toLocaleLowerCase()
    const group = byAssignee.get(key) || { id: `pm:${key}`, name, cards: [] }
    group.cards.push(card)
    byAssignee.set(key, group)
  })
  const groups = [...byAssignee.entries()]
    .map(([key, group]) => ({ ...group, cards: applySavedOrder(group.cards, pmOrder[key] || []) }))
    .sort((left, right) => right.cards.length - left.cards.length || (left.name || "").localeCompare(right.name || ""))
  return [...groups, { id: "pm:unassigned", name: null, cards: unassigned }]
}

function orderEntries(cards: BoardCard[]) {
  const entries: PmOrderEntry[] = []
  for (const card of cards) {
    const entry = card.order
    if (entry && (entry.type === "issue" || entry.type === "proposal")) {
      entries.push({ type: entry.type, ref: entry.ref })
    }
  }
  return entries
}

function DevPmView({
  canReorder,
  columns,
  onPersistMove,
  pmOrder,
  setNotice,
}: {
  canReorder: boolean
  columns: Columns
  onPersistMove: (move: DevPmMove) => Promise<void>
  pmOrder: PmOrder
  setNotice: (notice: string | null) => void
}) {
  const initialGroups = useMemo(() => groupPmCards(columns, pmOrder), [columns, pmOrder])
  const [groups, setGroups] = useState(initialGroups)
  const [saving, setSaving] = useState(false)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))

  useEffect(() => setGroups(initialGroups), [initialGroups])

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    if (!over || saving || !canReorder) return
    const sourceIndex = groups.findIndex((group) => group.cards.some((card) => card.id === active.id))
    const destinationIndex = groups.findIndex((group) => group.id === over.id || group.cards.some((card) => card.id === over.id))
    if (sourceIndex < 0 || destinationIndex < 0) return
    const source = groups[sourceIndex]
    const destination = groups[destinationIndex]
    const cardIndex = source.cards.findIndex((card) => card.id === active.id)
    if (cardIndex < 0) return
    const destinationCardIndex = destination.cards.findIndex((card) => card.id === over.id)
    const nextGroups = groups.map((group) => ({ ...group, cards: [...group.cards] }))

    if (sourceIndex === destinationIndex) {
      const targetIndex = destinationCardIndex < 0 ? source.cards.length - 1 : destinationCardIndex
      if (cardIndex === targetIndex) return
      nextGroups[sourceIndex].cards = arrayMove(source.cards, cardIndex, targetIndex)
    } else {
      const [card] = nextGroups[sourceIndex].cards.splice(cardIndex, 1)
      const targetIndex = destinationCardIndex < 0 ? nextGroups[destinationIndex].cards.length : destinationCardIndex
      nextGroups[destinationIndex].cards.splice(targetIndex, 0, card)
    }

    const target = source.cards[cardIndex].order
    if (!target || (target.type !== "issue" && target.type !== "proposal")) return
    const pmTarget: PmOrderEntry = { type: target.type, ref: target.ref }
    const previous = groups
    setGroups(nextGroups)
    setSaving(true)
    setNotice(null)
    try {
      await onPersistMove({
        target: pmTarget,
        sourceAssignee: source.name,
        destinationAssignee: destination.name,
        sourceOrder: orderEntries(nextGroups[sourceIndex].cards),
        destinationOrder: orderEntries(nextGroups[destinationIndex].cards),
      })
    } catch (cause) {
      setGroups(previous)
      setNotice(cause instanceof Error ? cause.message : "The PM board change could not be saved. Server order was restored.")
    } finally {
      setSaving(false)
    }
  }

  const hasTasks = groups.some((group) => group.cards.length)
  return <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd} sensors={sensors}>
    <div className="flex flex-col gap-6" data-testid="dev-pm">
      {!hasTasks ? <Empty className="min-h-40 border bg-muted/20"><EmptyHeader><EmptyTitle>No open assigned work</EmptyTitle><EmptyDescription>Issues and proposals will appear here when they are available.</EmptyDescription></EmptyHeader></Empty> : null}
      {groups.map((group) => <PmLane canReorder={canReorder && !saving} group={group} key={group.id} />)}
    </div>
  </DndContext>
}

function PmLane({ canReorder, group }: { canReorder: boolean; group: PmGroup }) {
  const droppable = useDroppable({ id: group.id, disabled: !canReorder })
  const headingId = group.name ? `dev-${group.id}` : "dev-pm-unassigned"
  if (!group.cards.length && !canReorder) return null
  return <section aria-labelledby={headingId} className="flex flex-col gap-3" data-testid={group.name ? `dev-pm-lane-${group.name.toLocaleLowerCase()}` : "dev-pm-lane-unassigned"} ref={droppable.setNodeRef}>
    <header className="flex items-center gap-2">
      {group.name ? <Avatar className="size-8"><AvatarFallback>{initialFor(group.name)}</AvatarFallback></Avatar> : null}
      <h4 className="text-base font-medium" id={headingId}>{group.name ? `@${group.name}` : "Unassigned"}</h4>
      <Badge variant="outline"><span className="tabular-nums">{group.cards.length}</span></Badge>
    </header>
    <div className={cn("grid min-h-20 gap-3 rounded-xl border border-dashed p-3 md:grid-cols-2 xl:grid-cols-3", droppable.isOver && "border-ring bg-accent/30")}>
      <SortableContext items={group.cards.map((card) => card.id)} strategy={rectSortingStrategy}>
        {group.cards.map((card) => <BoardCardView card={card} draggable={canReorder} key={card.id} />)}
      </SortableContext>
      {!group.cards.length ? <p className="self-center text-sm text-muted-foreground">Drop a task here to withdraw your assignee vote.</p> : null}
    </div>
  </section>
}

function BoardSelect({ includeUnassigned = false, label, onValueChange, options, value }: { includeUnassigned?: boolean; label: string; onValueChange: (value: string) => void; options: string[]; value: string }) {
  return <Select onValueChange={(nextValue) => { if (nextValue) onValueChange(nextValue) }} value={value}><SelectTrigger aria-label={`Filter by ${label.toLowerCase()}`} size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="all">All {label.toLowerCase()}</SelectItem>{includeUnassigned ? <SelectItem value="unassigned">Unassigned</SelectItem> : null}{options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectGroup></SelectContent></Select>
}

function BoardColumn({ active, cards, column, disabled }: { active: boolean; cards: BoardCard[]; column: ColumnKey; disabled: boolean }) {
  const reorderable = (column === "issues" || column === "in-review") && !disabled
  return <section aria-label={`${columnLabels[column]} column`} className={cn("min-w-0 max-sm:hidden", active && "max-sm:flex")}>
    <div className="self-start overflow-hidden rounded-xl border bg-muted/30">
      <div className="flex items-center justify-between border-b px-3 py-2.5"><h4 className="text-base font-medium sm:text-sm">{columnLabels[column]}</h4><Badge variant="outline"><span className="tabular-nums">{cards.length}</span></Badge></div>
      <div className="flex flex-col gap-2 p-2.5">
        {cards.length === 0 ? <Empty className="min-h-24 border-0 bg-transparent p-3"><EmptyHeader><EmptyTitle>Nothing here yet</EmptyTitle><EmptyDescription>{column === "issues" ? "New work will appear here." : "No matching work in this stage."}</EmptyDescription></EmptyHeader></Empty> : <SortableContext items={cards.map((card) => card.id)} strategy={verticalListSortingStrategy}>{cards.map((card) => <BoardCardView card={card} draggable={reorderable} key={card.id} />)}</SortableContext>}
      </div>
    </div>
  </section>
}

function BoardCardView({ card, draggable }: { card: BoardCard; draggable: boolean }) {
  const sortable = useSortable({ id: card.id, disabled: !draggable })
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }
  // The whole surface is the pointer drag target. The explicit handle stays
  // focusable for keyboard drag, but requiring a tiny hidden affordance made
  // the board feel inert in normal desktop use.
  const pointerListeners = sortable.listeners ? {
    onMouseDown: sortable.listeners.onMouseDown as HTMLAttributes<HTMLDivElement>["onMouseDown"],
    onPointerDown: sortable.listeners.onPointerDown as HTMLAttributes<HTMLDivElement>["onPointerDown"],
    onTouchStart: sortable.listeners.onTouchStart as HTMLAttributes<HTMLDivElement>["onTouchStart"],
  } : undefined
  return <div ref={sortable.setNodeRef} style={style} className={cn("relative min-w-0", sortable.isDragging && "z-10 opacity-60")}><Card className={cn("min-w-0 gap-2 bg-background py-0 [--card-spacing:--spacing(3)]", draggable && "cursor-grab active:cursor-grabbing")} {...pointerListeners}>
    <Link aria-label={card.kind === "session" ? `Open ${card.title}` : `View ${card.title}`} className="block rounded-xl p-3 outline-none focus-visible:ring-3 focus-visible:ring-ring/50" to={card.href}>
      <CardTitle className="min-w-0 pr-7 line-clamp-2 text-base font-medium sm:text-sm">{card.title}</CardTitle>
      <CardDescription className="mt-2 line-clamp-2 text-base leading-6 sm:text-sm sm:leading-5">{card.description}</CardDescription>
      {card.status || card.needsVote ? <div className="mt-3 flex flex-wrap items-center gap-2">{card.status ? <Badge variant={card.status === "Working" ? "secondary" : "outline"}>{card.status}</Badge> : null}{card.needsVote ? <StatusDot label="Needs vote" role="attention" subject={card.title} /> : null}</div> : null}
    </Link>{draggable ? <Button aria-label={`Reorder ${card.title}`} className="absolute top-2 right-2 text-muted-foreground hover:text-foreground" ref={sortable.setActivatorNodeRef} size="icon-xs" type="button" variant="ghost" {...sortable.attributes} {...sortable.listeners}><PlatformIcon icon={GripVertical} /></Button> : null}
  </Card></div>
}
