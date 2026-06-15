// Tests for the live-streaming holdback helpers behind the dev-chat
// proposal/dev-session view (checkbox-flicker fix).
//
// public/js/streaming-markdown.js is a plain browser script with a
// module.exports guard (same pattern as cc-progress-summary.js), so we
// require the REAL helpers the UI ships rather than mirroring their logic.
// `marked` / `DOMPurify` only exist in the browser, so the markdown
// renderer is injected: these tests pass a tiny stand-in that emits one
// `dc-task-check` span per COMPLETED GFM task line — mirroring the real
// renderer's task-item branch closely enough to assert the holdback
// contract (an incomplete trailing line never reaches the renderer).
//
// Run with: node --test tests/streaming-markdown.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  splitStreamingMarkdown,
  renderStreamingHtml,
  clipSpecSnippet,
} = require('../public/js/streaming-markdown.js');

// ── Test doubles ─────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Stand-in for DevChat.renderMarkdown: emits a dc-task-check span for every
// line that is a complete GFM task item, exactly the shape the real
// renderer's listitem() branch produces. Plain lines pass through escaped.
const TASK_RE = /^\s*[-*+]\s+\[[ xX]\]\s+/;
function fakeRenderMarkdown(md) {
  return String(md)
    .split('\n')
    .map((line) => {
      if (TASK_RE.test(line)) {
        const checked = /\[[xX]\]/.test(line);
        const glyph = checked
          ? '<span class="dc-task-check dc-task-checked">&#10003;</span>'
          : '<span class="dc-task-check">&#9744;</span>';
        return `<li class="dc-task-item">${glyph} ${escapeHtml(line)}</li>`;
      }
      return escapeHtml(line);
    })
    .join('\n');
}

// One task row == one opening `<span class="dc-task-check…` — matching the
// bare class avoids double-counting the checked variant's extra class token.
const countChecks = (html) => (html.match(/<span class="dc-task-check/g) || []).length;
const render = (text) => renderStreamingHtml(text, fakeRenderMarkdown, escapeHtml);

// ── splitStreamingMarkdown ───────────────────────────────────────────────

test('splitStreamingMarkdown: a line with no trailing newline is all held back', () => {
  assert.deepEqual(splitStreamingMarkdown('- ['), { committed: '', tail: '- [' });
  assert.deepEqual(splitStreamingMarkdown('- [ ] item'), { committed: '', tail: '- [ ] item' });
});

test('splitStreamingMarkdown: text splits at the LAST newline', () => {
  assert.deepEqual(
    splitStreamingMarkdown('- [ ] done\n- [ ] typ'),
    { committed: '- [ ] done\n', tail: '- [ ] typ' }
  );
});

test('splitStreamingMarkdown: a trailing newline leaves an empty tail', () => {
  assert.deepEqual(
    splitStreamingMarkdown('- [ ] done\n'),
    { committed: '- [ ] done\n', tail: '' }
  );
});

test('splitStreamingMarkdown: nullish input is safe', () => {
  assert.deepEqual(splitStreamingMarkdown(undefined), { committed: '', tail: '' });
  assert.deepEqual(splitStreamingMarkdown(null), { committed: '', tail: '' });
});

// ── (a) partial fragments render as plaintext, never a checkbox ──────────

test('(a) a `- [` / `- [ ]` fragment renders as plaintext, not a checkbox', () => {
  for (const frag of ['- [', '- [ ', '- [ ]', '- [ ] Add the widget']) {
    const html = render(frag);
    assert.equal(countChecks(html), 0, `fragment "${frag}" produced a checkbox`);
    assert.match(html, /dc-streaming-tail/, `fragment "${frag}" not held back as tail`);
  }
});

// ── (b) one completed task line → exactly one ☐ row ──────────────────────

test('(b) a completed `- [ ] item` line renders exactly one checkbox row', () => {
  const html = render('- [ ] Add the widget\n');
  assert.equal(countChecks(html), 1);
  // Fully consumed: no held-back tail for a newline-terminated line.
  assert.doesNotMatch(html, /dc-streaming-tail/);
});

test('(b) a completed checked `- [x] item` line renders a checked marker', () => {
  const html = render('- [x] Wire the route\n');
  assert.equal(countChecks(html), 1);
  assert.match(html, /dc-task-checked/);
});

// ── (c) char-by-char feed never exceeds completed-task count ─────────────

test('(c) feeding one char at a time never shows more checkboxes than completed task lines', () => {
  const full = '- [ ] Add the widget\n- [x] Wire the route\n- [ ] Half typed';
  for (let i = 1; i <= full.length; i++) {
    const prefix = full.slice(0, i);
    // Completed task lines = newline-terminated lines that are task items.
    const completed = prefix
      .split('\n')
      .slice(0, -1) // drop the in-progress (un-terminated) final line
      .filter((l) => TASK_RE.test(l)).length;
    const shown = countChecks(render(prefix));
    assert.ok(
      shown <= completed,
      `at len ${i} ("${prefix.replace(/\n/g, '\\n')}"): ${shown} checkboxes > ${completed} completed`
    );
  }
});

// ── (d) clipSpecSnippet never emits a half task item ─────────────────────

test('(d) clipSpecSnippet clips on whole-line boundaries — no partial task item', () => {
  const lines = [
    'Spec preview intro line that takes up some room here.',
    '- [ ] First task item, also reasonably long to push the boundary.',
    '- [x] Second already-done task item near the clip boundary here.',
    '- [ ] Third task item that should be entirely past the 200-char clip.',
  ];
  const text = lines.join('\n');
  const clipped = clipSpecSnippet(text, 200);

  // The trailing marker lives on its own line; strip it for line checks.
  const body = clipped.replace(/\n…$/, '');
  for (const line of body.split('\n')) {
    if (/^\s*[-*+]\s+\[/.test(line)) {
      // Any kept task line must be a COMPLETE original line — never a
      // bisected `- [` / `- [ ] half…` fragment.
      assert.ok(
        lines.includes(line),
        `kept a partial task line: "${line}"`
      );
    }
  }
  // And it actually clipped (text was longer than 200).
  assert.ok(clipped.endsWith('…'), 'expected a trailing ellipsis after clipping');
});

test('clipSpecSnippet: short text is returned unchanged', () => {
  const short = '- [ ] tiny\n- [x] done';
  assert.equal(clipSpecSnippet(short, 200), short);
});

test('clipSpecSnippet: a single over-long line with no newline falls back to a word clip', () => {
  const oneLine = 'word '.repeat(80).trim(); // 399 chars, no newline
  const clipped = clipSpecSnippet(oneLine, 200);
  assert.ok(clipped.length <= 201, 'word-boundary clip should respect the limit');
  assert.ok(clipped.endsWith('…'));
  assert.equal(clipped.charAt(clipped.length - 2), 'd', 'should cut on a whole word');
});

// ── regression: append vs full replace yield identical final HTML ────────

test('regression: incremental render and one-shot render of the same final text agree', () => {
  const full = '# Heading\n\n- [ ] one\n- [x] two\n';
  // "Replace" path: render the whole thing at once.
  const oneShot = render(full);
  // "Append" path: the helper is a pure function of the full text so far,
  // so the LAST incremental render (full text) must equal the one-shot.
  let lastIncremental = '';
  for (let i = 1; i <= full.length; i++) lastIncremental = render(full.slice(0, i));
  assert.equal(lastIncremental, oneShot);
  // A newline-terminated document holds nothing back — equals plain render.
  assert.equal(oneShot, fakeRenderMarkdown(full));
});

// ── Source guards — keep the helpers wired and non-dead ──────────────────

const indexHtml = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'), 'utf8'
);
const devChatSrc = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'dev-chat.js'), 'utf8'
);

test('index.html loads streaming-markdown.js before dev-chat.js', () => {
  const helperIdx = indexHtml.indexOf('/js/streaming-markdown.js');
  const devChatIdx = indexHtml.indexOf('/js/dev-chat.js');
  assert.ok(helperIdx !== -1, 'streaming-markdown.js script tag missing');
  assert.ok(devChatIdx !== -1, 'dev-chat.js script tag missing');
  assert.ok(helperIdx < devChatIdx, 'streaming-markdown.js must load before dev-chat.js');
});

test('dev-chat.js actually calls the streaming helpers (not dead code)', () => {
  assert.ok(/renderStreamingHtml\(/.test(devChatSrc), 'dev-chat.js must call renderStreamingHtml');
  assert.ok(/clipSpecSnippet\(/.test(devChatSrc), 'dev-chat.js must call clipSpecSnippet');
  assert.ok(/_renderStreamingMarkdown\(/.test(devChatSrc), 'dev-chat.js must use the throttled bubble updater');
  assert.ok(/_flushStreamingFinal\(/.test(devChatSrc), 'dev-chat.js must flush the bubble on turn end');
});
