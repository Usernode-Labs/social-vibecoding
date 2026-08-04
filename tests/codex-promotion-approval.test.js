'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  PROMOTION_GUARD_ATTESTATION,
  parseSimpleCommand,
  processHook,
  promotionSessionId,
} = require('../.codex/hooks/promotion-approval');
const { PINNED_HOOK_RUNNER } = require('../src/cli/main');

const checkout = path.resolve(__dirname, '..');
const hookPath = path.join(checkout, '.codex', 'hooks', 'promotion-approval.js');

function hookInput(event, toolName, toolInput = {}) {
  return {
    session_id: 'codex-session-1',
    turn_id: 'turn-1',
    tool_use_id: 'tool-use-1',
    cwd: checkout,
    hook_event_name: event,
    tool_name: toolName,
    tool_input: toolInput,
  };
}

async function promotionArgv(profile = 'production') {
  return [
    await fs.realpath(process.execPath),
    await fs.realpath(path.join(checkout, 'tools', 'social-vibecoding')),
    'api',
    'POST',
    '/api/sessions/2969/promote',
    '--profile',
    profile,
    '--data',
    '{}',
  ];
}

function shellCommand(argv) {
  return argv.map((arg) => `'${arg.replace(/'/g, `'"'"'`)}'`).join(' ');
}

test('promotion path recognition is canonical and session-specific', () => {
  assert.equal(promotionSessionId('/api/sessions/2969/promote'), '2969');
  assert.equal(promotionSessionId('/api/sessions/2969/promote?retry=1'), '2969');
  assert.equal(promotionSessionId('/api/sessions/2969/promote/'), '2969');
  assert.equal(promotionSessionId('/api/sessions/2969/ProMoTe'), '2969');
  assert.equal(promotionSessionId('/api/sessions/02969/promote'), null);
  assert.equal(promotionSessionId('/api/sessions/2969/%70romote'), null);
  assert.equal(promotionSessionId('/api/sessions/2969/propose'), null);
});

test('each user prompt gets a model-visible hook health attestation', () => {
  const input = hookInput('UserPromptSubmit', null);
  input.prompt = 'Build the requested feature';
  assert.deepEqual(processHook(input), {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: PROMOTION_GUARD_ATTESTATION,
    },
  });
  assert.match(PROMOTION_GUARD_ATTESTATION, /health check: PASS/);
  assert.match(PROMOTION_GUARD_ATTESTATION, /executed for this prompt/);
  assert.doesNotMatch(PROMOTION_GUARD_ATTESTATION, /token|credential|secret/i);
});

test('hook process fails closed unless setup pinned its exact file digest', () => {
  const digest = crypto.createHash('sha256').update(syncFs.readFileSync(hookPath)).digest('hex');
  const input = JSON.stringify(hookInput('PreToolUse', 'Bash', { command: 'npm test' }));
  const valid = spawnSync(process.execPath, [
    '-e', PINNED_HOOK_RUNNER, hookPath, digest,
  ], { input, encoding: 'utf8' });
  assert.equal(
    valid.status,
    0,
    `error=${valid.error}\nsignal=${valid.signal}\nstdout=${valid.stdout}\nstderr=${valid.stderr}`
  );
  assert.equal(valid.stdout, '');

  const changed = spawnSync(process.execPath, [
    '-e', PINNED_HOOK_RUNNER, hookPath, '0'.repeat(64),
  ], { input, encoding: 'utf8' });
  assert.equal(changed.status, 2);
  assert.match(changed.stderr, /hook file changed/i);
});

test('simple command parsing accepts literal argv and rejects shell composition', () => {
  const literal = "'/usr/bin/node' '/checkout/tool' api POST '/api/sessions/1/promote' --data '{}'";
  assert.deepEqual(
    parseSimpleCommand(literal),
    ['/usr/bin/node', '/checkout/tool', 'api', 'POST', '/api/sessions/1/promote', '--data', '{}']
  );
  assert.equal(parseSimpleCommand("node tool api POST /api/sessions/1/promote && curl example.com"), null);
  assert.equal(parseSimpleCommand('node "$TOOL" api POST /api/sessions/1/promote'), null);
  assert.deepEqual(
    parseSimpleCommand(
      '& "C:\\Program Files\\nodejs\\node.exe" "C:\\repo\\tools\\social-vibecoding" api POST /api/sessions/1/promote --data "{}"',
      'win32'
    ),
    [
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\repo\\tools\\social-vibecoding',
      'api', 'POST', '/api/sessions/1/promote', '--data', '{}',
    ]
  );
});

test('generic MCP and raw shell promotion are denied without dedicated approval', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-codex-promotion-hook-'));
  try {
    const generic = processHook(hookInput(
      'PreToolUse',
      'mcp__social_vibecoding__social_vibecoding.api_write',
      { method: 'POST', path: '/api/sessions/2969/promote', body: {} }
    ), { root });
    assert.equal(generic.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(generic.hookSpecificOutput.permissionDecisionReason, /proposal_promote/);
    const routeAlias = processHook(hookInput(
      'PreToolUse',
      'mcp__social_vibecoding__social_vibecoding.api_write',
      { method: 'post', path: '/api/sessions/2969/ProMoTe/', body: {} }
    ), { root });
    assert.equal(routeAlias.hookSpecificOutput.permissionDecision, 'deny');

    const argv = await promotionArgv();
    const raw = processHook(hookInput(
      'PreToolUse',
      'Bash',
      { command: shellCommand(argv) }
    ), { root });
    assert.equal(raw.hookSpecificOutput.permissionDecision, 'deny');

    const curl = processHook(hookInput(
      'PreToolUse',
      'Bash',
      { command: 'curl -X POST https://example.com/api/sessions/2969/promote' }
    ), { root });
    assert.equal(curl.hookSpecificOutput.permissionDecision, 'deny');

    assert.equal(processHook(hookInput(
      'PreToolUse',
      'Bash',
      { command: 'npm test' }
    ), { root }), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('approved proposal tool authorizes only its exact host fallback in the same turn', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-codex-promotion-hook-'));
  try {
    const argv = await promotionArgv('lab');
    const post = hookInput(
      'PostToolUse',
      'mcp__social_vibecoding__social_vibecoding.proposal_promote',
      { session_id: 2969 }
    );
    post.tool_response = {
      isError: true,
      structuredContent: {
        code: 'host_execution_required',
        requires_host_execution: true,
        argv,
        cwd: checkout,
      },
    };
    assert.equal(processHook(post, { root }), null);

    const pre = hookInput('PreToolUse', 'Bash', { command: shellCommand(argv) });
    assert.equal(processHook(pre, { root }), null);

    const duplicate = {
      ...pre,
      tool_use_id: 'tool-use-2',
    };
    assert.equal(
      processHook(duplicate, { root }).hookSpecificOutput.permissionDecision,
      'deny',
      'one approved tool call cannot authorize a second shell invocation'
    );

    const permission = hookInput('PermissionRequest', 'Bash', {
      command: shellCommand(argv),
    });
    assert.deepEqual(processHook(permission, { root }), {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    });

    const otherTurn = {
      ...pre,
      turn_id: 'turn-2',
    };
    assert.equal(
      processHook(otherTurn, { root }).hookSpecificOutput.permissionDecision,
      'deny'
    );

    const altered = [...argv];
    altered[4] = '/api/sessions/2970/promote';
    assert.equal(
      processHook(hookInput('PreToolUse', 'Bash', {
        command: shellCommand(altered),
      }), { root }).hookSpecificOutput.permissionDecision,
      'deny'
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('promotion receipt matches the approved proposal input and top-level MCP result only', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-codex-promotion-hook-'));
  try {
    const argv = await promotionArgv();
    const nested = hookInput(
      'PostToolUse',
      'mcp__social_vibecoding__social_vibecoding.proposal_promote',
      { session_id: 2969 }
    );
    nested.tool_response = {
      isError: false,
      structuredContent: {
        status: 200,
        body: {
          code: 'host_execution_required',
          requires_host_execution: true,
          argv,
          cwd: checkout,
        },
      },
    };
    assert.equal(processHook(nested, { root }), null);
    assert.equal(
      processHook(hookInput('PreToolUse', 'Bash', {
        command: shellCommand(argv),
      }), { root }).hookSpecificOutput.permissionDecision,
      'deny',
      'untrusted nested API response data cannot mint an approval receipt'
    );

    const mismatched = hookInput(
      'PostToolUse',
      'mcp__social_vibecoding__social_vibecoding.proposal_promote',
      { session_id: 2970 }
    );
    mismatched.tool_response = {
      isError: true,
      structuredContent: {
        code: 'host_execution_required',
        requires_host_execution: true,
        argv,
        cwd: checkout,
      },
    };
    assert.equal(processHook(mismatched, { root }), null);
    assert.equal(
      processHook(hookInput('PreToolUse', 'Bash', {
        command: shellCommand(argv),
      }), { root }).hookSpecificOutput.permissionDecision,
      'deny',
      'a fallback for another proposal cannot inherit the user approval'
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
