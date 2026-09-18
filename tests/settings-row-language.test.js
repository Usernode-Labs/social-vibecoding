// #2438 (from the #2383 audit): one row language on the Settings screen.
//
// Six list islands draw rows on that screen. Four already shared
// `ROW_CLASS` — a white card on the zinc-100 page ground — while the CLI
// credentials and local agents lists still drew the pre-reskin row: a
// zinc-100 fill (the same colour as the page, so it did nothing) held
// together by a border. Their row actions were also the last two bordered
// controls there, where the language fills its controls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, 'frontend/src/features/settings', rel), 'utf8');

const ROW_CLASS = "const ROW_CLASS = 'rounded-lg bg-white dark:bg-zinc-900 px-3 py-2 text-xs';";
const LISTS = [
  'grants-list.tsx',
  'notification-prefs-list.tsx',
  'agent-files-list.tsx',
  'app-permissions-list.tsx',
  'cli-tokens-list.tsx',
  'local-agents-list.tsx',
];

test('every Settings list row is the same white card row', () => {
  for (const file of LISTS) {
    const src = read(file);
    assert.ok(src.includes(ROW_CLASS), `${file} declares the shared ROW_CLASS`);
    assert.match(src, /className=\{ROW_CLASS\}/, `${file} draws its row with it`);
    // The fill it replaced is the page's own colour, so a row drawn in it is
    // a row drawn by its border alone.
    assert.doesNotMatch(src, /bg-zinc-100 dark:bg-zinc-800 border/, `${file} keeps no bordered zinc row`);
  }
});

test('their row actions are filled, not outlined', () => {
  // The language draws no outlined control (@/components/ui/button.tsx), and
  // Revoke keeps its red because it IS destructive — only the box changed.
  const cli = read('cli-tokens-list.tsx');
  assert.match(cli, /rounded bg-red-50 hover:bg-red-100 dark:bg-red-950 dark:hover:bg-red-900/);
  assert.doesNotMatch(cli, /border border-red-400/);
  const agents = read('local-agents-list.tsx');
  assert.match(agents, /rounded bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700/);
  assert.doesNotMatch(agents, /border border-zinc-400/);
});
