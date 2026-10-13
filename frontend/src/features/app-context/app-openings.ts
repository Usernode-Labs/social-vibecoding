/**
 * Durable delivery for the server's `dapp_opened` history.
 *
 * The navigation creates an opening before its async app load starts, then
 * commits it only once the accessible App tab is really on screen. A tiny
 * per-user queue survives reload/offline failures and always retries the same
 * UUID and occurrence timestamp. The server's unique index is the final
 * idempotency boundary.
 */

const STORAGE_KEY = 'usernode_app_openings_v1';
export const MAX_PENDING_OPENINGS = 50;
export const MAX_PENDING_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 30_000];
export const DELIVERY_TIMEOUT_MS = 15_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PendingAppOpening = {
  openingId: string;
  occurredAt: string;
  slug: string;
  userId: string;
  attempts: number;
};

type Host = typeof globalThis & {
  App?: {
    user?: { id?: string | number } | null;
    _sessionFromSnapshot?: boolean;
  };
  UsernodeReact?: Record<string, unknown>;
};

type RecorderOptions = {
  now?: () => number;
  retryDelays?: number[];
  deliveryTimeoutMs?: number;
};

function userId(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value);
  return normalized && normalized !== 'undefined' && normalized !== 'null'
    ? normalized : null;
}

function newUuid(host: Host): string | null {
  const cryptoApi = host.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues !== 'function') return null;
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validEntry(value: unknown, now: number): value is PendingAppOpening {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<PendingAppOpening>;
  const occurredMs = typeof entry.occurredAt === 'string' ? Date.parse(entry.occurredAt) : NaN;
  return typeof entry.openingId === 'string' && UUID_RE.test(entry.openingId)
    && typeof entry.slug === 'string' && entry.slug.length > 0 && entry.slug.length <= 200
    && typeof entry.userId === 'string' && entry.userId.length > 0 && entry.userId.length <= 40
    && Number.isInteger(entry.attempts) && Number(entry.attempts) >= 0
    && Number.isFinite(occurredMs) && occurredMs >= now - MAX_PENDING_AGE_MS;
}

export function createAppOpeningRecorder(host: Host, options: RecorderOptions = {}) {
  const now = options.now || (() => Date.now());
  const retryDelays = options.retryDelays || RETRY_DELAYS_MS;
  const deliveryTimeoutMs = options.deliveryTimeoutMs || DELIVERY_TIMEOUT_MS;
  const setTimer = host.setTimeout.bind(host);
  const clearTimer = host.clearTimeout.bind(host);
  let pending: PendingAppOpening[] = [];
  let verifiedUserId: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushing = false;
  let active: { entry: PendingAppOpening; controller: AbortController | null } | null = null;

  // Safari private mode and hardened browsers may throw while GETTING the
  // property, before getItem itself can be guarded.
  function storage(): Storage | null {
    try { return host.localStorage || null; } catch { return null; }
  }

  function read(): PendingAppOpening[] {
    try {
      const parsed = JSON.parse(storage()?.getItem(STORAGE_KEY) || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry) => validEntry(entry, now())).slice(-MAX_PENDING_OPENINGS);
    } catch {
      return [];
    }
  }

  function write(): void {
    try {
      storage()?.setItem(STORAGE_KEY, JSON.stringify(pending.slice(-MAX_PENDING_OPENINGS)));
    } catch {
      // A live-page delivery can still succeed when private mode refuses
      // storage; persistence is an extra reliability layer, not a gate.
    }
  }

  function currentUserId(): string | null {
    return userId(host.App?.user?.id);
  }

  function pruneExpired(): void {
    const currentTime = now();
    const kept = pending.filter((entry) => validEntry(entry, currentTime));
    if (kept.length === pending.length) return;
    pending = kept;
    if (!pending.length) clearRetry();
    write();
  }

  function remove(openingId: string): void {
    pending = pending.filter((entry) => entry.openingId !== openingId);
    if (!pending.length) clearRetry();
    write();
  }

  function clearRetry(): void {
    if (timer != null) clearTimer(timer);
    timer = null;
  }

  function schedule(attempts: number): void {
    clearRetry();
    if (!pending.length || !verifiedUserId) return;
    const index = Math.min(Math.max(attempts - 1, 0), retryDelays.length - 1);
    timer = setTimer(() => {
      timer = null;
      void flush();
    }, retryDelays[index] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]);
  }

  function cancelForUser(rawUserId: unknown): void {
    const cancelled = userId(rawUserId);
    if (!cancelled) return;
    if (active?.entry.userId === cancelled) active.controller?.abort();
    pending = pending.filter((entry) => entry.userId !== cancelled);
    if (verifiedUserId === cancelled) verifiedUserId = null;
    clearRetry();
    write();
  }

  async function flush(): Promise<void> {
    if (flushing || !verifiedUserId) return;
    flushing = true;
    try {
      pruneExpired();
      while (pending.length) {
        const entry = pending[0];
        if (entry.userId !== verifiedUserId || currentUserId() !== entry.userId) {
          remove(entry.openingId);
          continue;
        }
        const Controller = host.AbortController;
        const controller = typeof Controller === 'function' ? new Controller() : null;
        active = { entry, controller };
        let response: Response | null = null;
        let deliveryTimer: ReturnType<typeof setTimeout> | null = null;
        try {
          const request = host.fetch(`/api/apps/${encodeURIComponent(entry.slug)}/openings`, {
            method: 'POST',
            credentials: 'same-origin',
            keepalive: true,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              openingId: entry.openingId,
              occurredAt: entry.occurredAt,
            }),
            ...(controller ? { signal: controller.signal } : {}),
          });
          response = await Promise.race([
            request,
            new Promise<null>((resolve) => {
              deliveryTimer = setTimer(() => {
                controller?.abort();
                resolve(null);
              }, deliveryTimeoutMs);
            }),
          ]);
        } catch {
          response = null;
        } finally {
          if (deliveryTimer != null) clearTimer(deliveryTimer);
          active = null;
        }

        if (response?.ok) {
          remove(entry.openingId);
          continue;
        }
        if (response && (response.status === 401 || response.status === 403)) {
          cancelForUser(entry.userId);
          return;
        }
        const retryable = !response || response.status === 408 || response.status === 425
          || response.status === 429 || response.status >= 500;
        if (!retryable) {
          // Invalid/inaccessible app openings cannot become valid by retrying.
          remove(entry.openingId);
          continue;
        }
        entry.attempts += 1;
        write();
        schedule(entry.attempts);
        return;
      }
    } finally {
      flushing = false;
    }
  }

  function setUser(rawUserId: unknown, verified = true): void {
    const next = userId(rawUserId);
    if (active && active.entry.userId !== next) active.controller?.abort();
    pending = next ? pending.filter((entry) => entry.userId === next) : [];
    verifiedUserId = verified ? next : null;
    clearRetry();
    write();
    if (verifiedUserId) void flush();
  }

  function begin(rawUserId: unknown): PendingAppOpening | null {
    const owner = userId(rawUserId);
    const openingId = newUuid(host);
    if (!owner || !openingId) return null;
    return {
      openingId,
      occurredAt: new Date(now()).toISOString(),
      slug: '',
      userId: owner,
      attempts: 0,
    };
  }

  function commit(slug: string, opening: PendingAppOpening | null): void {
    if (!opening || !slug || currentUserId() !== opening.userId) return;
    pruneExpired();
    const entry = { ...opening, slug };
    if (!validEntry(entry, now())) return;
    if (!pending.some((item) => item.openingId === entry.openingId)) pending.push(entry);
    pending = pending.slice(-MAX_PENDING_OPENINGS);
    write();
    void flush();
  }

  pending = read();
  // The React bridge normally mounts before the legacy shell publishes the
  // session. If a slow chunk lands afterward, adopt an already-verified
  // identity here so retained work does not wait for another auth change.
  // A display-only snapshot may filter its own queue, but it must wait for
  // _reconcileSession before sending authenticated history.
  const initialOwner = currentUserId();
  if (initialOwner) setUser(initialOwner, host.App?._sessionFromSnapshot !== true);

  return {
    begin,
    cancelForUser,
    commit,
    flush,
    pending: () => pending.map((entry) => ({ ...entry })),
    setUser,
  };
}

if (typeof window !== 'undefined') {
  const host = window as unknown as Host;
  const bridge = (host.UsernodeReact ||= {});
  bridge.appOpenings = createAppOpeningRecorder(host);
}
