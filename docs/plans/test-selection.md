# Test selection: the 23 Nov back-test, and when to run it again

Written 2026-11-23 against canonical main `170eceaf96b3`. The question was
whether a proposal's checks could run only the unit suites its change
touches, using the mapping in `scripts/test-changed.js` (names, one level of
importers, and the `when` and `always` markers). This records what a
back-test over 30 days of real checks found, what changed because of it,
and the plan to measure again.

**Decision for now:** `test:changed` stays a local tool. Homeroom keeps
running the whole unit suite on every submission, because the mapping
still misses real failures (below).

## 1. What was measured

- 2,478 checks runs of the platform app over the 30 days to 23 Nov, on
  2,061 distinct heads. 475 runs had unit-suite failures that named test
  files, on 323 proposals.
- For each failed run: the change is the diff from `merge-base(head, main)`
  to the head. The mapping is today's `scripts/test-changed.js`, evaluated
  against the head's own tree (read with `git cat-file`, never checked out).
  A failing file the mapping did not select is a miss.
- A miss is only a problem when the change caused it. Each one was judged
  by what the proposal itself changed between the failing head and the next
  head where that file passed, and by how many proposals the file failed on.

## 2. What it found

Of 704 (proposal, failing file) pairs that a later head fixed, the mapping
skipped 80 (11%) the first time they failed:

| The 80 misses | Count |
| --- | --- |
| Flaky, or main's fault: only main moved before the file passed, or it failed on 4+ unrelated proposals | 30 |
| Caught by markers added since (mostly `sql-validation`'s `when src/`) | 9 |
| Suites since removed | 4 |
| Real: a suite that walks a whole tree with no marker saying so | 18 |
| Real: a dependency the mapping cannot see | 19 |

The 18 were five suites. This change marks each with the tree it walks,
and a re-run of the back-test with the marked text selects every one of
their 20 misses (the 18, plus two that fell in the first row):

| Suite | Marker |
| --- | --- |
| `shell-build` (the whitespace-expression lint) | `when frontend/src/ frontend/@/` |
| `rtl-logical-css` | `when frontend/src/ frontend/@/components/ui/` |
| `section-heading-primitives` | `when frontend/src/ frontend/@/ public/js/` |
| `workflow-types` (tsc) | `when src/workflow/` |
| `header-height-parity` (reads the rendered shell) | `when frontend/src/ frontend/@/` |

The 19 are the open gaps:

- **Copy.** A suite that renders a screen depends on `frontend/locales/`
  through the words on it, and names no locale file. One proposal that
  changed eight locale files broke six suites this way.
- **Files a module reads at runtime**, such as the prompt markdown under
  `src/prompts/`, unless the suite declares them with `when`.
- **Imports more than one level deep.** A primitive's change reaches the
  screens that import it, but not the suites of the screens that import
  those.
- **The rendered shell, more widely.** 127 suites read the generated
  `public/index.html` (through `tests/lib/shell-markup` or by path). It is
  built from every file under `frontend/src`, which the mapping links only
  by name. Only `header-height-parity` missed in the window, but nothing
  stops another.

Separately, five suites failed often enough on unrelated proposals to be
treated as flaky: `ws-current-access-postgres`, `workflow-processes-postgres`,
`bot-build-crash-postgres`, `platform-preview-data-policy-postgres` and
`capture-switch-window`.

Declared browser checks in `dapp.json` (233 failed runs in the window) were
not part of this: they are selected by route, not by this mapping.

## 3. What a selection would save

Weighted by `tests/baselines/test-durations.json`, a head would run a median
of 26% of the unit suite's seconds, and 36% on average. That counts a full
run when the change touches the harness or the packages (`package*.json`,
`tests/lib/`, `tests/baselines/` other than `test-durations.json` and
`workflow-process-state.json`, the Dockerfiles, `scripts/test-*`), which
happens on 6% of heads. A quarter of heads would run under a tenth of the
suite; 12% would still run three quarters or more.

The ceiling is set by hub files. A change to `src/services/homeroom-bot.js`,
`homeroom-bot-dm.js`, `src/workflow/platform.ts` or
`src/services/notifications.js` selects about half the suite's seconds,
through the names of the modules that import it.

## 4. Retest

**When:** whichever comes first:

1. File-read tracking exists: each suite's opened files are recorded during
   main's full run and used as the mapping. This is what would close the
   gaps above, and the back-test is how to know it did.
2. A month after this change merges, to check that the markers held and
   that no new whole-tree guard arrived without one.

**How**, the same way as this one:

1. Export the window's history with a read-only query on a replica: one
   JSON line per settled `checks.run` work item of the platform app, with
   the session, PR, head, trigger, settled time and failing rows (with the
   unit suite's failure text). The rows sit at any depth of `wf_work.result`
   (it is `{ value, outcome }`), so find them with a JSON path, not a fixed
   key.
2. Fetch every head by sha from the canonical repository into one clone.
3. For each failed run, evaluate the mapping against the head's own tree
   and record whether each failing file was selected. Two things keep it
   fast. First, every name pattern contains the file's bare basename, so a
   suite without it as a substring cannot match. Second, cache each (file,
   suite blob) answer, because most suites are the same blob across heads.
   Write rows as you go: holding every blob runs out of heap.
4. Classify each miss as in section 1, then evaluate the misses again with
   the current suite text, so that what has been fixed since is counted
   apart.
5. Size the selection over every distinct head, in suite seconds.

**The bar** before a selection decides anything Homeroom runs: no real miss
in a whole-tree guard, and under 1% of the real failures missed. Even then,
the whole suite would still run once before merge.
