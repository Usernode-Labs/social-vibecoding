// readAskStream — the Needs-you ask box's SSE reader, EXECUTED rather than
// grepped (tests/lib/render-tsx.js `loadTsx`, the same esbuild harness
// tests/estimator-card-render.test.js uses).
//
// It is executed because the bugs it can have are all invisible to a source
// scan: a chunk boundary landing mid-frame, a multi-byte character split
// across two reads, a stream that ends without its terminator. Every one of
// those produces a plausible-looking reader that drops or mangles an answer
// in production and passes any grep.
//
// The properties locked in here:
//
//   * A frame is reassembled however the chunks fall — byte at a time, or
//     several frames in one read.
//   * A UTF-8 character split across reads is not mangled (the decoder must
//     be streaming).
//   * `done`'s text WINS over what was accumulated, so a dropped token is a
//     flicker and not a wrong answer.
//   * An `error` frame after the stream opened is surfaced, not swallowed.
//   * A stream that just stops keeps the tokens already shown on screen
//     rather than reporting a failure over them.
//
// Run with: node --test tests/workshop-ask-stream.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');

const { readAskStream } = loadTsx('frontend/src/features/dev-board/workshop/ask-stream.ts');

const frame = (event, obj) => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;

/** A ReadableStream that yields exactly the byte slices given. */
function streamOf(chunks) {
  const encoder = new TextEncoder();
  const parts = chunks.map((c) => (typeof c === 'string' ? encoder.encode(c) : c));
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= parts.length) { controller.close(); return; }
      controller.enqueue(parts[i]);
      i += 1;
    },
  });
}

/** Cut a whole SSE body into fixed-size BYTE slices. */
function sliced(text, size) {
  const bytes = new TextEncoder().encode(text);
  const out = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}

test('reads tokens then done, reporting progress cumulatively', async () => {
  const body = streamOf([
    frame('token', { text: 'One ' }),
    frame('token', { text: 'two ' }),
    frame('token', { text: 'three.' }),
    frame('done', { text: 'One two three.', model: 'claude-haiku-4-5' }),
  ]);
  const progress = [];
  const out = await readAskStream(body, (s) => progress.push(s));
  // Cumulative, not deltas: the caller renders what it is handed.
  assert.deepEqual(progress, ['One ', 'One two ', 'One two three.']);
  assert.equal(out.text, 'One two three.');
  assert.equal(out.model, 'claude-haiku-4-5');
  assert.equal(out.error, undefined);
});

test('reassembles frames split across arbitrary chunk boundaries', async () => {
  const whole = frame('token', { text: 'Hello ' })
    + frame('token', { text: 'world' })
    + frame('done', { text: 'Hello world' });
  // One byte at a time is the worst case: every frame, every field and every
  // blank-line terminator is split.
  for (const size of [1, 2, 3, 7, 13, 64]) {
    // eslint-disable-next-line no-await-in-loop
    const out = await readAskStream(streamOf(sliced(whole, size)), () => {});
    assert.equal(out.text, 'Hello world', `chunk size ${size}`);
  }
});

test('several frames arriving in ONE read are all handled', async () => {
  const body = streamOf([
    frame('token', { text: 'a' }) + frame('token', { text: 'b' }) + frame('done', { text: 'ab' }),
  ]);
  const progress = [];
  const out = await readAskStream(body, (s) => progress.push(s));
  assert.deepEqual(progress, ['a', 'ab']);
  assert.equal(out.text, 'ab');
});

test('a multi-byte character split across reads is not mangled', async () => {
  // Every one of these is >1 byte in UTF-8, so a non-streaming decoder
  // produces replacement characters at the seams.
  const answer = 'naïve — café ☕ 日本語 🎉';
  const whole = frame('token', { text: answer }) + frame('done', { text: answer });
  for (const size of [1, 2, 3, 5, 11]) {
    // eslint-disable-next-line no-await-in-loop
    const out = await readAskStream(streamOf(sliced(whole, size)), () => {});
    assert.equal(out.text, answer, `chunk size ${size}`);
    assert.ok(!out.text.includes('�'), `chunk size ${size} produced a replacement char`);
  }
});

test("done's text wins over the accumulated tokens", async () => {
  // A token was dropped in transit. The assembled text on `done` is the
  // authority, so the reader recovers rather than returning a gap.
  const body = streamOf([
    frame('token', { text: 'One ' }),
    frame('token', { text: 'three.' }),
    frame('done', { text: 'One two three.' }),
  ]);
  const out = await readAskStream(body, () => {});
  assert.equal(out.text, 'One two three.');
});

test('an error frame after the stream opened is surfaced', async () => {
  const body = streamOf([
    frame('token', { text: 'Partial' }),
    frame('error', { error: 'Daily limit reached.' }),
  ]);
  const out = await readAskStream(body, () => {});
  assert.equal(out.error, 'Daily limit reached.');
  assert.equal(out.text, '');
});

test('an error frame with no message still reports a failure', async () => {
  const out = await readAskStream(streamOf([frame('error', {})]), () => {});
  assert.match(out.error, /did not go through/);
});

test('a stream that stops mid-answer keeps what was already shown', async () => {
  const body = streamOf([frame('token', { text: 'Half an ans' })]);
  const out = await readAskStream(body, () => {});
  // No `done`, no `error` — but the reader has already put this on screen,
  // so reporting a failure over it would be a lie about what happened.
  assert.equal(out.text, 'Half an ans');
  assert.equal(out.error, undefined);
});

test('a final frame with no trailing blank line is still read', async () => {
  const body = streamOf([
    frame('token', { text: 'x' }),
    'event: done\ndata: {"text":"xy"}',
  ]);
  const out = await readAskStream(body, () => {});
  assert.equal(out.text, 'xy');
});

test('an empty stream reports neither text nor error', async () => {
  const out = await readAskStream(streamOf([]), () => {});
  assert.equal(out.text, '');
  assert.equal(out.error, undefined);
});

test('a non-JSON frame is skipped rather than losing the answer', async () => {
  // A proxy interposing its own event, or a keepalive comment.
  const body = streamOf([
    ': keepalive\n\n',
    'event: token\ndata: not json at all\n\n',
    frame('token', { text: 'real' }),
    frame('done', { text: 'real' }),
  ]);
  const out = await readAskStream(body, () => {});
  assert.equal(out.text, 'real');
});

test('CRLF framing is read the same as LF', async () => {
  const body = streamOf([
    'event: token\r\ndata: {"text":"a"}\r\n\r\n',
    'event: done\r\ndata: {"text":"a"}\r\n\r\n',
  ]);
  const out = await readAskStream(body, () => {});
  assert.equal(out.text, 'a');
});

// The subtle half of CRLF handling: a \r that arrives at the end of one
// read and its \n at the start of the next. Normalising per-chunk would
// leave the pair uncollapsed and the frame unterminated forever.
test('a CRLF straddling two reads is still one line ending', async () => {
  const whole = 'event: token\r\ndata: {"text":"a"}\r\n\r\nevent: done\r\ndata: {"text":"a"}\r\n\r\n';
  // Every byte offset, so each \r\n in the body gets split at least once.
  for (const size of [1, 2, 3, 17]) {
    // eslint-disable-next-line no-await-in-loop
    const out = await readAskStream(streamOf(sliced(whole, size)), () => {});
    assert.equal(out.text, 'a', `chunk size ${size}`);
  }
});

test('a data value keeps interior spaces and only drops the framing one', async () => {
  const body = streamOf(['event: done\ndata: {"text":"  padded  "}\n\n']);
  const out = await readAskStream(body, () => {});
  assert.equal(out.text, '  padded  ');
});
