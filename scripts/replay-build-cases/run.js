#!/usr/bin/env node
'use strict';

// Replay the build turns behind Sheep countrr's faulty proposals with the old
// build prompt and the new one, and score what each produces.
//
//   node scripts/replay-build-cases/run.js                  # dry run: render every prompt
//   node scripts/replay-build-cases/run.js --live --case sheep-38-wolf
//
// A dry run clones nothing and calls no model: it renders both prompts for
// every case and reports their sizes. --live runs a real coding agent (Claude
// Code driving an OpenRouter model through worker/claude-openrouter-request.js,
// the same adapter a hosted GLM turn uses) with --dangerously-skip-permissions
// inside a fresh worktree of the app at the case's base commit. Run it only in
// a disposable container or VM. See README.md.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const { renderReplayPrompt, VARIANTS } = require('./prompt');
const { scoreReplay } = require('./score');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CASES_FILE = path.join(__dirname, 'cases.json');
const ADAPTER = path.join(REPO_ROOT, 'worker', 'claude-openrouter-request.js');

function loadCases(file = CASES_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).cases;
}

function parseArgs(argv) {
  const args = {
    live: false, cases: [], variants: [...VARIANTS], model: 'z-ai/glm-5.3-flash',
    effort: 'xhigh', timeoutMin: 30, workdir: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--live') args.live = true;
    else if (a === '--case') args.cases.push(next());
    else if (a === '--variant') {
      const v = next();
      if (!VARIANTS.includes(v)) throw new Error(`--variant must be one of ${VARIANTS.join(', ')}`);
      args.variants = [v];
    } else if (a === '--model') args.model = next();
    else if (a === '--effort') args.effort = next();
    else if (a === '--timeout-min') args.timeoutMin = Number(next());
    else if (a === '--workdir') args.workdir = next();
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function selectCases(all, ids) {
  if (!ids.length) return all;
  return ids.map((id) => {
    const c = all.find((x) => x.id === id);
    if (!c) throw new Error(`unknown case: ${id} (known: ${all.map((x) => x.id).join(', ')})`);
    return c;
  });
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

// One full clone per repository, so every worktree sees the other members'
// branches as origin/dev/* exactly as a hosted worker's clone does.
function ensureMirror(workdir, repo) {
  const dir = path.join(workdir, `repo-${crypto.createHash('sha1').update(repo).digest('hex').slice(0, 10)}`);
  if (!fs.existsSync(path.join(dir, '.git'))) git(workdir, 'clone', '--quiet', repo, dir);
  return dir;
}

function runAgent({ cwd, promptFile, systemFile, transcriptFile, model, effort, timeoutMin }) {
  const args = ['--print', '--dangerously-skip-permissions', '--verbose', '--output-format', 'stream-json', '--model', model];
  if (systemFile) args.push('--append-system-prompt-file', systemFile);
  return new Promise((resolve) => {
    const out = fs.openSync(transcriptFile, 'w');
    const child = spawn(process.execPath, [ADAPTER, ...args], {
      cwd,
      stdio: [fs.openSync(promptFile, 'r'), out, out],
      env: { ...process.env, AGENT_MODEL: model, AGENT_REASONING_EFFORT: effort, MODE: 'build' },
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMin * 60 * 1000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      fs.closeSync(out);
      resolve({ code, signal });
    });
  });
}

async function replayOne({ caseDef, variant, args, workdir }) {
  const rendered = renderReplayPrompt(caseDef, { variant });
  const stem = path.join(workdir, `${caseDef.id}.${variant}`);
  fs.writeFileSync(`${stem}.prompt.txt`, rendered.prompt);
  if (rendered.systemPrompt) fs.writeFileSync(`${stem}.system.txt`, rendered.systemPrompt);
  const summary = {
    case: caseDef.id, variant,
    promptChars: rendered.prompt.length,
    systemChars: rendered.systemPrompt ? rendered.systemPrompt.length : 0,
    promptSha256: crypto.createHash('sha256').update(rendered.prompt).digest('hex').slice(0, 12),
  };
  if (!args.live) return summary;

  const mirror = ensureMirror(workdir, caseDef.repo);
  const tree = `${stem}.tree`;
  git(mirror, 'worktree', 'add', '--quiet', '--detach', tree, caseDef.base);
  git(tree, 'switch', '--quiet', '-c', `replay/${caseDef.id}-${variant}-${Date.now()}`);
  const run = await runAgent({
    cwd: tree,
    promptFile: `${stem}.prompt.txt`,
    systemFile: rendered.systemPrompt ? `${stem}.system.txt` : null,
    transcriptFile: `${stem}.transcript.jsonl`,
    model: args.model, effort: args.effort, timeoutMin: args.timeoutMin,
  });
  git(tree, 'add', '-A');
  const diff = git(tree, 'diff', '--cached', caseDef.base);
  fs.writeFileSync(`${stem}.diff`, diff);
  const transcript = fs.readFileSync(`${stem}.transcript.jsonl`, 'utf8');
  const score = scoreReplay(caseDef, { diff, transcript });
  fs.writeFileSync(`${stem}.score.json`, JSON.stringify({ ...summary, exit: run, ...score }, null, 2));
  return { ...summary, exit: run.code, verdict: score.verdict, findings: score.findings.map((f) => f.id) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.live && !process.env.OPENROUTER_API_KEY) {
    throw new Error('--live needs OPENROUTER_API_KEY in the environment');
  }
  const cases = selectCases(loadCases(), args.cases);
  const workdir = args.workdir || fs.mkdtempSync(path.join(os.tmpdir(), 'replay-build-cases-'));
  fs.mkdirSync(workdir, { recursive: true });
  const rows = [];
  for (const caseDef of cases) {
    for (const variant of args.variants) {
      rows.push(await replayOne({ caseDef, variant, args, workdir }));
    }
  }
  process.stdout.write(`${args.live ? 'Replayed' : 'Rendered (dry run)'} in ${workdir}\n`);
  console.table(rows);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`replay-build-cases: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { loadCases, parseArgs, selectCases };
