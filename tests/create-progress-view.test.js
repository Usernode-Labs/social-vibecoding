// The create dialog's progress view —
// frontend/src/features/dialogs/create-progress.tsx.
//
// After a successful POST /api/apps the dialog stops being a form and
// becomes a report on what the server is doing. The component is
// deliberately PURE — it takes the store state and four callbacks, and
// the parent owns the subscription and the poll — so the four outcomes
// and their copy can be rendered and asserted here without a browser.
//
// Effects do NOT run under renderToStaticMarkup (see tests/lib/render-tsx.js),
// which is exactly why the branching lives in props rather than in a
// hook inside this component.
//
// Run with: node --test tests/create-progress-view.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

let cached = null;
const mod = () => (cached || (cached = loadTsx('frontend/src/features/dialogs/create-progress.tsx')));

const PROGRESS = {
  slug: 'my-app', status: 'creating', phase: null,
  url: null, errorReason: null, missingSecrets: null,
};

function html(over, props) {
  const m = mod();
  return renderToHtml(createElement(m.CreateProgress, {
    appName: 'My App',
    mode: 'new',
    progress: { ...PROGRESS, ...over },
    onOpenApp: () => {},
    onRetry: () => {},
    onSetSecrets: () => {},
    onClose: () => {},
    ...props,
  }));
}

const text = (over, props) => html(over, props).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

// ── The step list ─────────────────────────────────────────────────

test('all four steps are always listed, so the user sees the whole shape', () => {
  const t = text({ phase: 'database' });
  for (const label of ['database', 'repository', 'Building', 'live']) {
    assert.ok(t.includes(label), `missing step copy: ${label}`);
  }
});

test('the running step is marked active and the finished ones done', () => {
  const out = html({ phase: 'build' });
  assert.match(out, /data-step="database"[^>]*data-state="done"/);
  assert.match(out, /data-step="repository"[^>]*data-state="done"/);
  assert.match(out, /data-step="build"[^>]*data-state="active"/);
  assert.match(out, /data-step="deploy"[^>]*data-state="idle"/);
});

test('a failure marks the step it died in', () => {
  const out = html({ phase: 'build', status: 'error', errorReason: 'Build failed: no Dockerfile' });
  assert.match(out, /data-step="build"[^>]*data-state="failed"/);
});

// ── The four outcomes ─────────────────────────────────────────────

test('pending says it is still working and that leaving is safe', () => {
  const t = text({ phase: 'repository' });
  assert.match(t, /Creating .?My App/, 'headline names the app being created');
  assert.match(t, /close this|keep going|background/i,
    'the user must be told they are not required to wait here');
});

test('an import says importing, not creating', () => {
  assert.match(text({ phase: 'repository' }, { mode: 'import' }), /Importing .?My App/);
});

test('live shows the app is up and offers to open it', () => {
  const out = html({ status: 'running', url: 'https://my-app.example.test' });
  assert.match(out.replace(/<[^>]*>/g, ' '), /live/i);
  assert.match(out, /id="create-progress-primary"/);
  assert.match(out.replace(/<[^>]*>/g, ' '), /Open app/);
});

test('needs-secrets names the keys and offers the secrets panel, not a retry', () => {
  const out = html({ status: 'awaiting_secrets', phase: 'repository', missingSecrets: ['API_KEY', 'DB_TOKEN'] });
  const t = out.replace(/<[^>]*>/g, ' ');
  assert.ok(t.includes('API_KEY') && t.includes('DB_TOKEN'), 'the user needs to know WHICH keys');
  assert.match(t, /secret/i);
  assert.doesNotMatch(t, /Retry/, 'nothing failed — there is nothing to retry');
});

test('a failure shows the reason and offers a retry', () => {
  const t = text({ status: 'error', phase: 'build', errorReason: 'Build failed: no Dockerfile' });
  assert.ok(t.includes('Build failed: no Dockerfile'), 'the concise reason is the whole point');
  assert.match(t, /Retry/);
});

test('a failure with no reason still says something useful', () => {
  const t = text({ status: 'error', phase: null });
  assert.match(t, /Retry/);
  assert.ok(t.trim().length > 40, 'an empty error screen is worse than a vague one');
});

// ── Next steps ────────────────────────────────────────────────────

test('next steps are shown while pending and once live, but not on a failure', () => {
  assert.match(html({ phase: 'build' }), /id="create-progress-next"/);
  assert.match(html({ status: 'running' }), /id="create-progress-next"/);
  assert.doesNotMatch(
    html({ status: 'error', errorReason: 'boom' }), /id="create-progress-next"/,
    'telling someone to "describe your first change" under a failure is noise'
  );
});

// ── Always available ──────────────────────────────────────────────

test('every outcome offers a way out of the dialog', () => {
  for (const over of [
    { phase: 'build' },
    { status: 'running' },
    { status: 'awaiting_secrets', missingSecrets: ['K'] },
    { status: 'error', errorReason: 'boom' },
  ]) {
    assert.match(html(over), /id="create-progress-close"/,
      `no close button for ${JSON.stringify(over)}`);
  }
});

test('the status line is a live region, so it is announced as it changes', () => {
  const out = html({ phase: 'build' });
  assert.match(out, /id="create-progress-status"/);
  assert.match(out, /aria-live="polite"/);
});

test('the app name is escaped, never interpolated as markup', () => {
  const out = html({ phase: 'build' }, { appName: '<img src=x onerror=alert(1)>' });
  assert.ok(!out.includes('<img'), 'React escapes text children — keep it a text child');
  assert.ok(out.includes('&lt;img'), 'and the name is still shown');
});

// ── Surface ───────────────────────────────────────────────────────

test('the inset panel does not paint itself the dialog card\'s own background', () => {
  // DialogCard is `bg-white dark:bg-zinc-900` (@/components/ui/dialog.tsx).
  // An inset block that reaches for dark:bg-zinc-900 disappears in dark
  // mode — it is the same colour as the card behind it, and only the
  // border survives. The dialog already has an idiom for this: its
  // segmented pills sit on `bg-zinc-100 dark:bg-zinc-800`.
  const out = html({ phase: 'build' });
  const panel = out.match(/<div id="create-progress-next"[^>]*class="([^"]*)"/);
  assert.ok(panel, 'the next-steps panel renders');
  assert.doesNotMatch(panel[1], /dark:bg-zinc-900/,
    'invisible against the card in dark mode');
  assert.match(panel[1], /dark:bg-zinc-800/, 'use the dialog\'s existing inset tone');
});
