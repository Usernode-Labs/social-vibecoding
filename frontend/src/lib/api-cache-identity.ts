/** Session partitions are cache labels, never credentials or authorization. */
export const API_SCOPE_COOKIE = 'usernode_api_scope';
export const API_SCOPE_HEADER = 'X-Usernode-Cache-Scope';
const EXPIRY_HEADER = 'X-Usernode-Cache-Expires';
const BOUNDARY_KEY = 'usernode.api-identity-boundary';

export function readApiCacheScope(doc: Pick<Document, 'cookie'> | undefined = typeof document !== 'undefined' ? document : undefined): string | null {
  try {
    if (!doc) return null;
    const value = doc.cookie.split(';').map(s => s.trim())
      .find(s => s.startsWith(API_SCOPE_COOKIE + '='))?.slice(API_SCOPE_COOKIE.length + 1);
    return /^[a-f0-9]{64}$/.test(value || '') ? value! : null;
  } catch { return null; }
}

type Context = { epoch: number; scope: string | null; nativeEpoch: number };

export function installApiCacheIdentity(win: any = typeof window !== 'undefined' ? window : null): void {
  if (!win || typeof win.fetch !== 'function' || win.__apiCacheIdentityInstalled) return;
  const send: typeof fetch = win.fetch.bind(win);
  const scope = () => readApiCacheScope(win.document);
  const renewal = () => {
    try { return win.NativeChrome?.webSessionRenewal?.() || { epoch: 0, settled: null }; }
    catch { return { epoch: 0, settled: null }; }
  };
  let epoch = 0;
  let observedScope = scope();
  let observedNativeEpoch = renewal().epoch;
  let verifiedNativeEpoch = observedNativeEpoch;
  let viewer: string | null | undefined;

  const changed = () => new DOMException('Session changed', 'AbortError');
  function observe(): Context {
    const next = scope(), nativeEpoch = renewal().epoch;
    // Bootstrapping a legacy session's missing hint need not discard its
    // already-running, server-confirmed reads. Replacing a real hint does.
    if ((observedScope !== null && next !== observedScope) || nativeEpoch !== observedNativeEpoch) epoch++;
    observedScope = next;
    observedNativeEpoch = nativeEpoch;
    return { epoch, scope: next, nativeEpoch };
  }
  function current(context: Context, responseScope: string | null): boolean {
    const now = observe();
    return now.epoch === context.epoch && now.nativeEpoch === context.nativeEpoch
      && (now.scope === context.scope || (context.scope === null && now.scope === responseScope))
      && (now.scope === null || responseScope === null || now.scope === responseScope);
  }
  function broadcastBoundary(): void {
    try { win.localStorage.setItem(BOUNDARY_KEY, `${Date.now()}:${Math.random()}`); } catch { /* no storage */ }
  }
  function reset({ broadcast = false } = {}): void {
    epoch++;
    observedScope = scope();
    observedNativeEpoch = renewal().epoch;
    if (broadcast) broadcastBoundary();
  }

  // Fence body consumption as well as fetch resolution. JSON parsing or a
  // stream may complete after logout even when response headers arrived first.
  function guarded(res: Response, context: Context, responseScope: string | null): Response {
    const check = () => { if (!current(context, responseScope)) throw changed(); };
    let stream: ReadableStream | null | undefined;
    return new Proxy(res, {
      get(target, prop) {
        if (prop === 'clone') return () => {
          check();
          if (stream?.locked) throw new TypeError('Response body is locked');
          return guarded(target.clone(), context, responseScope);
        };
        if (['json', 'text', 'arrayBuffer', 'blob', 'formData', 'bytes'].includes(String(prop))) {
          const read = (target as any)[prop];
          if (typeof read !== 'function') return read;
          return async () => {
            check();
            if (stream?.locked) throw new TypeError('Response body is locked');
            const body = await read.call(target); check(); return body;
          };
        }
        if (prop === 'body') {
          check();
          if (stream !== undefined) return stream;
          if (!target.body) return (stream = null);
          let reader: ReadableStreamDefaultReader | undefined;
          stream = new ReadableStream({
            async pull(controller) {
              try {
                check();
                reader ||= target.body!.getReader();
                const item = await reader.read();
                check();
                if (item.done) controller.close(); else controller.enqueue(item.value);
              } catch (err) {
                void reader?.cancel(err).catch(() => {});
                controller.error(err);
              }
            },
            cancel: reason => reader ? reader.cancel(reason) : target.body!.cancel(reason),
          // No speculative pull: a chunk queued for the former identity
          // must not bypass the check when the next reader consumes it.
          }, { highWaterMark: 0 });
          return stream;
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  win.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof Request !== 'undefined' && input instanceof Request ? input.url : String(input);
    const url = new URL(raw, win.location.href);
    if (url.origin !== win.location.origin || !url.pathname.startsWith('/api/')) return send(input, init);
    const req = new Request(typeof Request !== 'undefined' && input instanceof Request ? input : url.href, init);
    const auth = url.pathname.startsWith('/api/auth/');
    const mutation = auth && req.method !== 'GET' && req.method !== 'HEAD';
    const identityRead = req.method === 'GET' && url.pathname === '/api/auth/me';
    if (mutation) { reset({ broadcast: true }); }
    // Native restoration installs its HttpOnly cookie outside this document.
    // Wait for that boundary, and use network-only reads until /me confirms it.
    const restoring = !mutation && renewal().settled;
    if (restoring) { try { await restoring; } catch { /* the server still decides */ } }
    const before = observe();
    const headers = new Headers(req.headers);
    headers.delete(API_SCOPE_HEADER);
    const tokenRequest = headers.has('authorization') || headers.has('x-usernode-token')
      || url.searchParams.has('token') || new URL(win.location.href).searchParams.has('token');
    const permitted = !!before.scope && !auth && !tokenRequest && req.credentials !== 'omit'
      && verifiedNativeEpoch === before.nativeEpoch;
    if (permitted) headers.set(API_SCOPE_HEADER, before.scope!);
    // Revalidate the browser's HTTP copy too. Permitted offline fallbacks
    // still work in the worker; private reads do not race a stale deadline
    // against the server's current permission decision.
    const res = await send(new Request(req, { headers,
      cache: permitted && req.cache !== 'no-store' ? 'reload' : 'no-store' }));
    const responseScope = /^[a-f0-9]{64}$/.test(res.headers.get(API_SCOPE_HEADER) || '')
      ? res.headers.get(API_SCOPE_HEADER) : null;
    let context = before;
    const now = observe();
    const unchanged = now.epoch === before.epoch && now.nativeEpoch === before.nativeEpoch && now.scope === before.scope;
    if (identityRead && res.ok && responseScope && unchanged) {
      // Existing sessions predate the hint cookie. Only a fresh /me may
      // bootstrap it, and an intervening login always wins over this read.
      const expiry = Date.parse(res.headers.get(EXPIRY_HEADER) || '');
      if (Number.isFinite(expiry) && expiry > Date.now()) {
        try {
          win.document.cookie = `${API_SCOPE_COOKIE}=${responseScope}; Path=/; SameSite=Lax; Expires=${new Date(expiry).toUTCString()}${url.protocol === 'https:' ? '; Secure' : ''}`;
        } catch { /* unavailable cookies disable the offline partition */ }
      }
      context = observe();
      verifiedNativeEpoch = context.nativeEpoch;
    } else if (mutation) {
      context = observe();
      broadcastBoundary();
    }
    // A response for another partition is never handed to a screen. The
    // 401 status remains visible to the native-renewal retry wrapper; its
    // old body is still fenced by guarded().
    if (res.ok && (!current(context, responseScope)
        || (context.scope !== null && responseScope !== null && context.scope !== responseScope))) throw changed();
    return guarded(res, context, responseScope);
  };
  const bridge = (win.UsernodeReact ||= {});
  bridge.apiCache = {
    scope,
    reset,
    setViewer(id: number | string | null, verified = true) {
      const next = id == null ? null : String(id);
      if (viewer !== undefined && next !== viewer) reset({ broadcast: verified });
      viewer = next;
    },
  };
  win.addEventListener?.('storage', (event: StorageEvent) => {
    if (event.key !== BOUNDARY_KEY) return;
    reset();
    // Other tabs share the cookie jar. Discard the former viewer's memory
    // and display state as well as its cached responses.
    if (win.App?.user) {
      win.App._dropCachedSession?.({ apiCache: false });
      win.location.reload();
    }
  });
  win.__apiCacheIdentityInstalled = true;
}
