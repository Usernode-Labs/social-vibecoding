/**
 * The Needs-you deck's ask route, read as a stream.
 *
 * Its own module rather than a helper inside workshop.tsx because it is
 * protocol code, not view code: SSE framing, chunk boundaries and UTF-8
 * continuation bytes are the kind of thing that is right or wrong on its
 * own terms, and a module can be EXECUTED by the test suite
 * (tests/lib/render-tsx.js `loadTsx`) where a function closed over a
 * component cannot.
 */

/** What the route says when the answer is complete, or when it could not be. */
export interface AskStreamResult {
  text: string;
  model?: string;
  error?: string;
}

const GENERIC_FAILURE = 'That did not go through. Try asking again.';

/**
 * Read the ask route's SSE body to completion.
 *
 * A hand-rolled reader rather than `EventSource`, for one reason: this is a
 * POST with a JSON body and EventSource can only issue a GET. The framing
 * is the same either way — `event:` and `data:` lines, one blank line
 * between frames — and the parsing rule that matters is that a chunk
 * boundary can fall ANYWHERE, including mid-frame and mid-UTF-8-character.
 * So the decoder is `{ stream: true }` and the buffer is only consumed as
 * far as the last completed frame.
 *
 * `onProgress` is handed the text SO FAR, not the delta, so the caller
 * renders rather than accumulates. Returns the `done` payload, or an
 * `error` the server sent after the stream had already opened.
 */
export async function readAskStream(
  body: ReadableStream<Uint8Array>,
  onProgress: (soFar: string) => void,
): Promise<AskStreamResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let soFar = '';
  let result: AskStreamResult = { text: '' };

  const handle = (frame: string) => {
    let event = 'message';
    const data: string[] = [];
    // \r\n is legal SSE framing and some proxies rewrite to it, so the
    // carriage return is stripped rather than left on the value.
    for (const raw of frame.split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) return;
    let payload: { text?: string; model?: string; error?: string };
    // A frame that is not JSON is a frame from something that is not this
    // route (a proxy's error page, say). Skipping it beats throwing away
    // an answer that is otherwise fine.
    try { payload = JSON.parse(data.join('\n')); } catch { return; }
    if (event === 'token' && typeof payload.text === 'string') {
      soFar += payload.text;
      onProgress(soFar);
    } else if (event === 'done') {
      result = {
        text: typeof payload.text === 'string' ? payload.text : soFar,
        model: payload.model,
      };
    } else if (event === 'error') {
      result = { text: '', error: payload.error || GENERIC_FAILURE };
    }
  };

  // A frame ends at a blank line, which is \n\n or \r\n\r\n — and searching
  // for '\n\n' does NOT find the second one: \r\n\r\n is \r \n \r \n, whose
  // only adjacent pair is \n\r. So line endings are normalised on the way
  // in and the scan then has one terminator to look for.
  //
  // Normalising the whole BUFFER rather than each chunk is what makes a
  // \r\n straddling two reads work: the lone \r sits at the end of the
  // buffer until the next read brings its \n, and the next pass collapses
  // the pair. Buffers here are one short answer, so the repeated scan costs
  // nothing worth saving.
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
    let split = buf.indexOf('\n\n');
    while (split !== -1) {
      handle(buf.slice(0, split));
      buf = buf.slice(split + 2);
      split = buf.indexOf('\n\n');
    }
  }
  // A final frame with no trailing blank line — a stream cut at exactly the
  // wrong moment — is still worth reading.
  buf = (buf + decoder.decode()).replace(/\r\n/g, '\n');
  if (buf.trim()) handle(buf);

  // The stream ended without saying so: neither `done` nor `error` arrived,
  // but tokens did. Keep them rather than reporting a failure over an
  // answer the reader can already see on screen.
  if (!result.text && !result.error && soFar) return { text: soFar };
  return result;
}
