/**
 * Verify, in place of a refusal (#6632).
 *
 * An admin can have Homeroom bot work for verified accounts only (Admin,
 * Homeroom bot, "Who Homeroom bot works for";
 * src/services/homeroom-bot-verified.js). A press that asks the bot for
 * something from an account without one of the signals that count (Build
 * it, "Ask Homeroom bot to build this", a new thread or design thread, a
 * described project's first version) is answered 403 with
 * `code: 'bot_verify_required'` and the signals. Like `join_required`
 * (./join-required.ts), that answer is a question, asked in one place: the
 * verify sheet (features/auth/verify-identity.tsx), with the bot's wording
 * and what counts. Verified there (a phone number, when it counts), the
 * refused request is sent again, so the press simply lands.
 *
 * The same rules as the Join wrapper: only a 403 whose JSON says so, on a
 * method that writes; every other response passes through unread (the body
 * is read from a clone); the retry is sent with the original fetch, so a
 * second refusal goes back to the caller and nothing loops; a Request is
 * cloned before it is first sent. A person who closes the sheet, or leaves
 * for Settings to link an account, gets the original 403 back, with its
 * sentence in `error`.
 */

export type BotVerifyRequired = {
  code: 'bot_verify_required';
  error?: string;
  signals?: string[];
};

export function isBotVerifyRequired(body: unknown): body is BotVerifyRequired {
  return !!body && typeof body === 'object' && (body as { code?: unknown }).code === 'bot_verify_required';
}

type Ask = (signals?: readonly string[]) => Promise<boolean>;

function askOf(win: any): Ask | null {
  const ask = win?.UsernodeReact?.verifyIdentity?.askForBot;
  return typeof ask === 'function' ? ask : null;
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  const own = init?.method || (typeof Request !== 'undefined' && input instanceof Request ? input.method : '');
  return String(own || 'GET').toUpperCase();
}

/**
 * Wrap `window.fetch` once. Exported for the test, which hands in its own
 * window; the browser installs it from main.tsx.
 */
export function installBotVerifyRequired(win: any = typeof window !== 'undefined' ? window : null): void {
  if (!win || typeof win.fetch !== 'function' || win.__botVerifyRequiredInstalled) return;
  const send: typeof fetch = win.fetch.bind(win);
  win.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = methodOf(input, init);
    if (method === 'GET' || method === 'HEAD') return send(input, init);
    const again = typeof Request !== 'undefined' && input instanceof Request ? input.clone() : input;
    const res = await send(input, init);
    if (res.status !== 403) return res;
    let body: unknown = null;
    try {
      body = await res.clone().json();
    } catch {
      return res;
    }
    if (!isBotVerifyRequired(body)) return res;
    const ask = askOf(win);
    if (!ask) return res;
    const verified = await ask(Array.isArray(body.signals) ? body.signals : undefined).catch(() => false);
    return verified ? send(again, init) : res;
  };
  win.__botVerifyRequiredInstalled = true;
}
