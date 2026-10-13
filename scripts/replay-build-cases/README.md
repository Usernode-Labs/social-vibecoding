# Replay build cases

Puts two build prompts to the same model on the same task, and scores what
each one changes:

- **legacy**: what a GLM build turn got before the shared build contract
  (`src/services/build-contract.js`). That is the dispatched block from the
  platform's first commit ("Spend minimal time reading files … Just build
  it."), the note that the platform-issue helper is unavailable, and the
  handbook inline in the user message.
- **contract**: what the same turn gets now. That is the new dispatched block,
  the shared contract, the `PLATFORM ISSUE` escalation, and the handbook as
  system context, because the turn runs in Claude Code.

The cases are the build turns behind three faulty proposals on Sheep countrr
(`usernode-bot/sheep-countrr-a08857`; its #48 tells the story):

| Case | Proposal | What went wrong |
| --- | --- | --- |
| `sheep-38-wolf` | #38 | `server.js` answered the app's own compiled `/tailwind.css` (and the bridge prefix) with 204 to quiet a sandbox error. Production lost its stylesheet. |
| `sheep-34-calm` | #34 | Unsure whether its edits had landed, the agent ran `git checkout 79dbe00 -- …` and shipped another member's unmerged feature. |
| `sheep-37-resume` | #37 | The agent rewired the frame loop onto a clock only a resume advanced, so every normal round froze. Its checks loaded frozen fixtures. |

`cases.json` gives each case's task, base commit and signatures. A
signature is a diff or transcript pattern for what went wrong. A `fail`
signature firing means the replay repeated the fault. A `warn` signature means
a person should look at the diff.

## Run it

A dry run is the default. It clones nothing and calls no model. It renders
both prompts for every case into a work directory and prints their sizes:

```sh
node scripts/replay-build-cases/run.js
```

A live run replays a case against a real model:

```sh
OPENROUTER_API_KEY=… node scripts/replay-build-cases/run.js --live --case sheep-38-wolf
```

Options:

- `--case <id>` (repeatable): pick cases. The default is all of them.
- `--variant legacy|contract`: run one variant. The default is both.
- `--model <openrouter id>`: the default is `z-ai/glm-5.3-flash`, the model
  the faulty turns ran.
- `--effort <level>`: the default is `xhigh`.
- `--timeout-min <n>`: the default is 30.
- `--workdir <dir>`: the default is a new temporary directory.

For each case and variant the work directory gets:

- `<case>.<variant>.prompt.txt` and `.system.txt`: the prompts sent.
- `.transcript.jsonl`: the agent's stream-json output.
- `.diff`: everything the turn changed against the base, including
  uncommitted and untracked files.
- `.score.json`: the verdict and each signature that fired, with its evidence.

## Safety

A live run executes a coding agent with `--dangerously-skip-permissions` in a
clone of a public app repository, and that repository's code comes from other
people. **Run `--live` only in a disposable container or VM** that holds no
credentials beyond the OpenRouter key. Never run it on a workstation or in the
platform's own environment.

The run uses `worker/claude-openrouter-request.js`, the same adapter a hosted
GLM turn runs in, so it needs Claude Code on `PATH`.

## Fidelity

A replay is close to the original turns, not the same:

- **The requests are reconstructed** from the merged commits. `requestSource`
  in `cases.json` says so. For a faithful replay, copy the session's first
  message from `chat_session_messages` for the named `session`, paste it into
  `request`, and set `requestSource` to `exact`.
- **Both variants leave out the same parts of the real prompt:** the spec
  block, the repo `CLAUDE.md` note, and the notes for services that need a
  platform behind them (`usernode-issues`, the Homeroom read tools).
- **There is no hosted worker.** It has no preview, no `usernode-run-checks`
  and no in-loop browser. #38's fault began with a sandbox 401 from a local
  boot, and a replay reproduces that only if the model boots the app itself.
- **One run is a sample, not a rate.** Models are not deterministic, so
  compare several runs per variant before drawing a conclusion.

The scorer, the case file and both prompts are pinned without a model in
`tests/replay-build-cases.test.js`.
