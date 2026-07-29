type KudosResponse = {
  ok?: boolean
  remaining?: number
  limit?: number
}

async function responseError(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: unknown } | null
  return typeof payload?.error === "string" && payload.error.trim()
    ? payload.error
    : `Request failed (${response.status})`
}

function validatedResponse(payload: KudosResponse) {
  if (payload.ok !== true) throw new Error("The server did not confirm the kudos update.")
  return {
    remaining: typeof payload.remaining === "number" ? payload.remaining : null,
    limit: typeof payload.limit === "number" ? payload.limit : null,
  }
}

/**
 * The existing proposal-recognition contract. Eligibility, collaborator
 * access, self-kudos prevention, duplicate handling, weekly quota and live
 * broadcasts stay entirely server-owned.
 */
export async function giveProposalKudos(sessionId: number) {
  const response = await fetch(`/api/sessions/${encodeURIComponent(String(sessionId))}/kudos`, {
    credentials: "same-origin",
    method: "POST",
  })
  if (!response.ok) throw new Error(await responseError(response))
  return validatedResponse(await response.json() as KudosResponse)
}

/** Only a direct kudos from the current viewer can be retracted. */
export async function retractProposalKudos(sessionId: number) {
  const response = await fetch(`/api/sessions/${encodeURIComponent(String(sessionId))}/kudos`, {
    credentials: "same-origin",
    method: "DELETE",
  })
  if (!response.ok) throw new Error(await responseError(response))
  return validatedResponse(await response.json() as KudosResponse)
}
