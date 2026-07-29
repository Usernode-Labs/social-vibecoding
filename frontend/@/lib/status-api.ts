export type OperationalNodeStatus = {
  status?: string | null
  peers?: number | null
  bestTipHeight?: number | null
  peerBestTipHeight?: number | null
  hasBeenSynced?: boolean
  hasFullUtxoDb?: boolean | null
  error?: string | null
  at?: string | number | null
}

export type OperationalSummary = {
  apps?: number
  prodRunning?: number
  prodMissing?: number
  stagingRunning?: number
  stagingCap?: number
  workersRunning?: number
  workersInFlight?: number
  workersWarmIdle?: number
  workersOrphaned?: number
  stuckSessions?: number
  sessionsGlobalUsed?: number
  sessionsGlobalCap?: number
  activeTurns?: number
}

export type OperationalApp = {
  name?: string
  slug?: string
  dbStatus?: string
  openSessions?: number
  openIssues?: number
  prod?: { state?: string; uptimeSeconds?: number } | null
  sessions?: Array<{
    id?: number
    username?: string
    branchName?: string
    ageSeconds?: number
    staging?: { state?: string } | null
  }>
}

export type OperationalWorker = {
  state?: string
  workerMode?: string
  orphan?: boolean
  sessionId?: number
  appSlug?: string
  username?: string
  uptimeSeconds?: number
}

export type StuckSession = {
  id?: number
  appSlug?: string
  username?: string
  branchName?: string
  ageSeconds?: number
}

export type OperationalStatus = {
  version?: string
  now?: string
  deployProgress?: { deploying?: boolean; sha?: string; startedAt?: string } | null
  node?: OperationalNodeStatus | null
  summary?: OperationalSummary
  apps?: OperationalApp[]
  workers?: OperationalWorker[]
  stuckSessions?: StuckSession[]
  driftContainers?: Array<{ kind?: string; expected?: string }>
  /** Server-only visibility indicator. React deliberately does not render its extra fields. */
  isAdmin?: boolean
}

/** Public, cached platform snapshot. The server performs redaction before responding. */
export async function getOperationalStatus(signal?: AbortSignal): Promise<OperationalStatus> {
  const response = await fetch("/api/status", { credentials: "same-origin", cache: "no-store", signal })
  if (!response.ok) throw new Error(`Request failed (${response.status})`)
  return response.json() as Promise<OperationalStatus>
}
