import { CheckCircle2, CircleAlert, Eye, ShieldCheck, Trophy } from "lucide-react"
import { useEffect, useState } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { PlatformIcon } from "@/components/platform-icon"
import { readBrowserPreference, writeBrowserPreference } from "@/lib/browser-preferences"
import { getNativeProfileInfo } from "@/lib/native-bridge"
import { getProfileChallengeHistory, getProfileRanking, type ProfileChallengeHistoryItem, type ProfileRanking } from "@/lib/profile-api"

type ProfileState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string }
  | { kind: "ready"; ranking: ProfileRanking; seasonName?: string; history: HistoryState }

type HistoryState =
  | { kind: "loading" }
  | { kind: "ready"; items: ProfileChallengeHistoryItem[] }
  | { kind: "error"; message: string }

// A local display preference only—never a credential, wallet token, or
// allocation value. The old key is read once so existing users keep their
// chosen reveal state after this name was clarified for security tooling.
const REVEAL_KEY = "sv:profile-allocation-revealed"
const LEGACY_REVEAL_KEY = "sv:profile_tokens_revealed"

export function Profile() {
  const [state, setState] = useState<ProfileState>({ kind: "loading" })
  const [tokensRevealed, setTokensRevealed] = useState(() => readBrowserPreference(REVEAL_KEY) === "1" || readBrowserPreference(LEGACY_REVEAL_KEY) === "1")

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    void (async () => {
      const info = await getNativeProfileInfo()
      if (cancelled) return
      if (info?.participantId == null) {
        setState({ kind: "unavailable" })
        return
      }
      try {
        const { ranking, seasonName } = await getProfileRanking(info.participantId, controller.signal)
        if (cancelled) return
        setState({ kind: "ready", ranking, seasonName, history: { kind: "loading" } })
        try {
          const items = await getProfileChallengeHistory(info.participantId, controller.signal)
          if (!cancelled) setState({ kind: "ready", ranking, seasonName, history: { kind: "ready", items } })
        } catch (historyCause) {
          if (cancelled || (historyCause instanceof DOMException && historyCause.name === "AbortError")) return
          setState({ kind: "ready", ranking, seasonName, history: { kind: "error", message: historyCause instanceof Error ? historyCause.message : "Unable to load completed challenges" } })
        }
      } catch (cause) {
        if (cancelled || (cause instanceof DOMException && cause.name === "AbortError")) return
        setState({ kind: "error", message: cause instanceof Error ? cause.message : "Unable to load your profile" })
      }
    })()
    return () => { cancelled = true; controller.abort() }
  }, [])

  const revealTokens = () => {
    writeBrowserPreference(REVEAL_KEY, "1")
    setTokensRevealed(true)
  }

  return <main className="isolate mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6" data-testid="profile">
    <header className="space-y-2"><h2 className="text-balance text-3xl font-semibold tracking-tight">Profile</h2><p className="text-base text-muted-foreground text-pretty">Your Usernode points, rank, and token allocation.</p></header>
    {state.kind === "loading" ? <div className="space-y-3"><Skeleton className="h-40 w-full" /><Skeleton className="h-32 w-full" /></div> : null}
    {state.kind === "unavailable" ? <Alert><PlatformIcon icon={ShieldCheck} /><AlertTitle>Profile unavailable</AlertTitle><AlertDescription>Open Usernode and finish registration to see your points and rank here.</AlertDescription></Alert> : null}
    {state.kind === "error" ? <Alert variant="destructive"><AlertTitle>Profile unavailable</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
    {state.kind === "ready" ? <ProfileDetails history={state.history} ranking={state.ranking} seasonName={state.seasonName} tokensRevealed={tokensRevealed} onReveal={revealTokens} /> : null}
  </main>
}

function ProfileDetails({ ranking, seasonName, history, tokensRevealed, onReveal }: { ranking: ProfileRanking; seasonName?: string; history: HistoryState; tokensRevealed: boolean; onReveal: () => void }) {
  const points = Number(ranking.total_points || 0)
  const rankLine = ranking.rank ? `Rank #${ranking.rank}${ranking.total_participants ? ` of ${ranking.total_participants}` : ""}` : "Rank unavailable"
  const title = ranking.season_name || seasonName
  return <>
    <Card><CardHeader className="items-center text-center"><PlatformIcon className="text-muted-foreground" icon={Trophy} size="lg" /><CardTitle className="text-4xl tabular-nums">{points.toLocaleString()}</CardTitle><CardDescription>points</CardDescription></CardHeader><CardContent className="text-center text-sm text-muted-foreground">{rankLine}{title ? ` · ${title}` : ""}</CardContent></Card>
    <Card><CardHeader><CardTitle>Token allocation</CardTitle><CardDescription>Allocations are provisional and subject to the program terms.</CardDescription></CardHeader><CardContent>{ranking.terms_accepted === false ? <Alert><AlertTitle>Token allocation withheld</AlertTitle><AlertDescription>Review and accept the terms in Usernode to see your allocation.</AlertDescription></Alert> : <div className="flex flex-wrap items-center justify-between gap-3"><strong aria-hidden={!tokensRevealed} className={tokensRevealed ? "text-2xl tabular-nums" : "select-none text-2xl blur-md"}>{Number(ranking.total_tokens || 0).toLocaleString()}</strong>{!tokensRevealed ? <Button onClick={onReveal} type="button" variant="outline"><PlatformIcon data-icon="inline-start" icon={Eye} />Reveal</Button> : null}</div>}</CardContent></Card>
    <ChallengeHistory history={history} />
  </>
}

function pointsText(item: ProfileChallengeHistoryItem) {
  if (item.progress.earned_points !== undefined) return `${item.progress.earned_points.toLocaleString()} points`
  return "Points not reported"
}

function ChallengeHistory({ history }: { history: HistoryState }) {
  const [season, setSeason] = useState<number | "all">("all")
  const seasons = history.kind === "ready" ? [...new Map(history.items.map((item) => [item.seasonId, item.seasonName || `Season ${item.seasonId}`])).entries()] : []
  const items = history.kind === "ready" ? history.items.filter((item) => season === "all" || item.seasonId === season) : []

  return <section aria-labelledby="completed-challenges-heading" className="space-y-3">
    <div className="flex flex-wrap items-end justify-between gap-3"><div className="space-y-1"><h3 className="text-xl font-semibold" id="completed-challenges-heading">Completed challenges</h3><p className="text-sm text-muted-foreground">Your earned challenge records are retained across available seasons.</p></div>{seasons.length > 1 ? <div aria-label="Challenge history season" className="flex flex-wrap gap-1"><Button aria-pressed={season === "all"} onClick={() => setSeason("all")} size="sm" type="button" variant={season === "all" ? "default" : "outline"}>All seasons</Button>{seasons.map(([id, name]) => <Button aria-pressed={season === id} key={id} onClick={() => setSeason(id)} size="sm" type="button" variant={season === id ? "default" : "outline"}>{name}</Button>)}</div> : null}</div>
    {history.kind === "loading" ? <div className="space-y-2" data-testid="profile-challenge-history-loading"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div> : null}
    {history.kind === "error" ? <Alert data-testid="profile-challenge-history-error" variant="destructive"><PlatformIcon icon={CircleAlert} /><AlertTitle>Completed challenges unavailable</AlertTitle><AlertDescription>{history.message}</AlertDescription></Alert> : null}
    {history.kind === "ready" && items.length === 0 ? <Alert data-testid="profile-challenge-history-empty"><AlertTitle>No completed challenges yet</AlertTitle><AlertDescription>Completed challenge rewards will appear here once they are reported.</AlertDescription></Alert> : null}
    {history.kind === "ready" && items.length > 0 ? <div className="space-y-2" data-testid="profile-challenge-history">{items.map((item) => <Card key={`${item.seasonId}-${item.challenge.event_id || "season"}-${item.challenge.id}`}><CardHeader className="gap-2"><div className="flex flex-wrap items-center gap-2"><span className="text-sm text-muted-foreground">{item.seasonName || `Season ${item.seasonId}`}</span><span className="inline-flex items-center gap-1 text-sm font-medium"><PlatformIcon className="text-primary" icon={CheckCircle2} size="xs" />Completed</span></div><CardTitle className="text-base sm:text-sm">{item.challenge.goal || item.challenge.task || "Challenge"}</CardTitle>{item.challenge.task && item.challenge.task !== item.challenge.goal ? <CardDescription>{item.challenge.task}</CardDescription> : null}</CardHeader><CardContent className="text-sm text-muted-foreground">{pointsText(item)}</CardContent></Card>)}</div> : null}
  </section>
}
