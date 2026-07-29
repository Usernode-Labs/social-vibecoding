export type NodeStatusSnapshot = {
  status?: string
  peers?: number | null
  bestTipHeight?: number | null
  peerBestTipHeight?: number | null
  hasBeenSynced?: boolean
  hasFullUtxoDb?: boolean | null
  error?: string | null
  at?: number | null
}

export type ExplorerStatusSnapshot = {
  status?: string
  host?: string | null
  chainId?: string | null
  latencyMs?: number | null
  error?: string | null
  hasBeenOk?: boolean
  at?: number | null
}

export type NodeStatusSnapshotFull = {
  server?: {
    name?: string
    mode?: string
    version?: string
    uptimeMs?: number | null
    explorerHost?: string | null
  }
  node?: NodeStatusSnapshot | null
  explorer?: ExplorerStatusSnapshot | null
  services?: Record<string, unknown>
  at?: number | null
}

export async function getNodeStatusSnapshot(signal?: AbortSignal): Promise<NodeStatusSnapshotFull> {
  const response = await fetch("/api/node-status/full", { credentials: "same-origin", cache: "no-store", signal })
  if (!response.ok) throw new Error(`Request failed (${response.status})`)
  return response.json() as Promise<NodeStatusSnapshotFull>
}
