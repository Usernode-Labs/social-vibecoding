/** Stable manual intents across a lost HTTP reply (including a page reload). */
const pending = new Map<string, string>();
export async function postPreviewRequest(
  sessionId: number | string,
  kind: 'ensure-staging' | 'recheck' | 'deploy-staging',
  send: (path: string, options: RequestInit) => Promise<Response> = fetch,
): Promise<Response> {
  const key = `native-preview-intent:${sessionId}:${kind}`;
  let requestId: string | null = pending.get(key) || null;
  try { requestId ||= sessionStorage.getItem(key); } catch { /* Storage may be disabled. */ }
  if (!requestId) requestId = crypto.randomUUID();
  pending.set(key, requestId);
  try { sessionStorage.setItem(key, requestId); } catch { /* The current request still has an identity. */ }
  const response = await send(`/api/sessions/${sessionId}/${kind}`, {
    method: 'POST', headers: { 'Idempotency-Key': requestId },
  });
  // A transport/server failure may hide a committed admission. Preserve the
  // intent until a complete, definitive reply is received.
  if (response.status < 500) {
    try {
      await response.clone().json();
      if (pending.get(key) === requestId) pending.delete(key);
      try { if (sessionStorage.getItem(key) === requestId) sessionStorage.removeItem(key); } catch { /* In-memory acknowledgment is still definitive. */ }
    } catch { /* Keep an unknown reply retryable. */ }
  }
  return response;
}

export function installPreviewRequests(): void {
  const bridge = (window as any).UsernodeReact ||= {};
  bridge.postPreviewRequest = postPreviewRequest;
}
