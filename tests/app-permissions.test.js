// The gated-capability contract (#2219).
//
// Apps reach a powerful browser capability only by Permissions Policy
// delegation — the shell's `allow` attribute on the frame. Until this change
// the shell delegated a fixed list to every app frame unconditionally, and
// `geolocation` was on it. That is a weaker gate than it looks, because of
// how browsers attribute a nested frame's request: the prompt names the
// TOP-LEVEL origin, so it never said which app was asking, and its answer is
// remembered per origin, so one "allow" was inherited by every app after it.
//
// Nine capabilities are gated on a per-user, per-app grant now. What this
// file pins is the part of that with no screenshot and no obvious failure
// mode:
//
//   1. THE CATALOGUE EXISTS THREE TIMES and the copies must agree. The
//      server needs it in node, the shell's React island needs it in the
//      bundle, and the DOM adapter needs it in a classic script that cannot
//      import either. A capability added to one and not the others is a
//      capability that is gated in one place and invisible in another.
//   2. `allowAttribute` IS THE LAST LINE before a capability name reaches a
//      live DOM attribute, and what it is handed came over the network.
//   3. DECLARING IS NOT BEING GRANTED. The manifest bounds what an app may
//      ask for; the grant decides what it gets; dropping a declaration must
//      stop the delegation even though the grant row survives.
//
// Run with: node --test tests/app-permissions.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const appPermissions = require('../src/services/app-permissions');
const appManifest = require('../src/services/app-manifest');
const { declaredFor, effectiveCapabilities } = require('../src/routes/app-permissions');

const loadPolicy = () => import(
  pathToFileURL(path.join(root, 'frontend/src/features/app-frame/app-frame-policy.js')).href
);

// ── 1. One catalogue, three copies ──────────────────────────────────────

test('the nine gated capabilities are the ones the request asked for', () => {
  assert.deepEqual(appPermissions.GATED_NAMES, [
    'geolocation', 'microphone', 'camera', 'display-capture',
    'usb', 'serial', 'hid', 'bluetooth', 'midi',
  ]);
});

test('the ungated base is the two capabilities that need no prompt', () => {
  // Both shipped in the frame's `allow` before this change and both stay.
  // `geolocation` was the third and is deliberately not here.
  assert.deepEqual([...appPermissions.UNGATED_CAPABILITIES], ['clipboard-write', 'pointer-lock']);
  assert.ok(!appPermissions.UNGATED_CAPABILITIES.includes('geolocation'));
});

test('every catalogue entry carries the copy the prompt renders', () => {
  for (const entry of appPermissions.GATED_CAPABILITIES) {
    assert.equal(typeof entry.name, 'string');
    assert.ok(entry.label && typeof entry.label === 'string', `${entry.name} has a label`);
    assert.ok(entry.blurb && typeof entry.blurb === 'string', `${entry.name} has a blurb`);
    // The blurb completes "<App> wants to ...", so it is a verb phrase with
    // no trailing stop, and the platform's copy convention bars em dashes.
    assert.ok(!entry.blurb.endsWith('.'), `${entry.name} blurb has no trailing stop`);
    assert.ok(!entry.blurb.includes('—'), `${entry.name} blurb has no em dash`);
    assert.ok(!entry.label.includes('—'), `${entry.name} label has no em dash`);
  }
});

test('the frontend policy copy agrees with the server catalogue', async () => {
  const policy = await loadPolicy();
  assert.deepEqual(policy.GATED_CAPABILITIES, appPermissions.GATED_NAMES);
  assert.deepEqual(policy.UNGATED_CAPABILITIES, [...appPermissions.UNGATED_CAPABILITIES]);
  assert.equal(policy.BASE_ALLOW, appPermissions.allowAttribute([]));
});

test('the DOM adapter copy agrees with the server catalogue', () => {
  // app-view.js is a classic script that can import neither of the others,
  // so its copy is parsed out of the source the same way the `allow`
  // attribute's two copies have always been compared.
  const src = read('public/js/app-view.js');
  const ungated = src.match(/_appIframeUngated: \[([^\]]+)\]/);
  const gated = src.match(/_appIframeGated: \[([\s\S]*?)\]/);
  assert.ok(ungated && gated, 'both adapter lists should be found');
  const parse = (s) => s.split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(parse(ungated[1]), [...appPermissions.UNGATED_CAPABILITIES]);
  assert.deepEqual(parse(gated[1]), appPermissions.GATED_NAMES);
});

// ── 2. allowAttribute is the last line before the DOM ───────────────────

test('no grants delegates exactly the ungated base', () => {
  assert.equal(appPermissions.allowAttribute([]), 'clipboard-write; pointer-lock');
  assert.equal(appPermissions.allowAttribute(null), 'clipboard-write; pointer-lock');
  assert.equal(appPermissions.allowAttribute(undefined), 'clipboard-write; pointer-lock');
});

test('a granted capability is appended after the base', () => {
  assert.equal(
    appPermissions.allowAttribute(['microphone']),
    'clipboard-write; pointer-lock; microphone'
  );
});

test('the attribute is catalogue-ordered, so it is stable and comparable', () => {
  const a = appPermissions.allowAttribute(['midi', 'camera', 'geolocation']);
  const b = appPermissions.allowAttribute(['geolocation', 'camera', 'midi']);
  assert.equal(a, b);
  assert.equal(a, 'clipboard-write; pointer-lock; geolocation; camera; midi');
});

test('anything not in the catalogue is dropped rather than delegated', () => {
  // The security property: this value came over the network. A capability
  // the platform does not gate must never reach the attribute just because
  // something upstream put it in a list.
  assert.equal(
    appPermissions.allowAttribute(['payment', 'idle-detection', 'camera', '', null, 42]),
    'clipboard-write; pointer-lock; camera'
  );
});

test('an injected attribute fragment cannot escape into the allow value', () => {
  const evil = 'camera; geolocation *; fullscreen" onload="x';
  assert.equal(appPermissions.allowAttribute([evil]), 'clipboard-write; pointer-lock');
});

test('duplicates collapse', () => {
  assert.equal(
    appPermissions.allowAttribute(['camera', 'camera', 'camera']),
    'clipboard-write; pointer-lock; camera'
  );
});

test('the frontend copy of allowAttribute answers identically', async () => {
  const policy = await loadPolicy();
  for (const granted of [
    [], ['camera'], ['midi', 'camera', 'geolocation'],
    ['payment', 'camera'], ['camera', 'camera'],
  ]) {
    assert.equal(
      policy.allowAttribute(granted),
      appPermissions.allowAttribute(granted),
      `same answer for ${JSON.stringify(granted)}`
    );
  }
});

// ── 3. Declaring is not being granted ───────────────────────────────────

function withManifest(manifest, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-manifest-'));
  try {
    fs.writeFileSync(path.join(dir, 'dapp.json'), JSON.stringify(manifest));
    return fn(appManifest.read(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the manifest reader accepts the bare-string form', () => {
  withManifest({ permissions: ['microphone', 'camera'] }, (m) => {
    assert.deepEqual(m.permissions, [
      { capability: 'camera', reason: null },
      { capability: 'microphone', reason: null },
    ].sort((a, b) => appPermissions.GATED_NAMES.indexOf(a.capability)
      - appPermissions.GATED_NAMES.indexOf(b.capability)));
  });
});

test('the manifest reader keeps the reason the prompt shows', () => {
  withManifest({
    permissions: [{ capability: 'microphone', reason: '  Records your voice notes  ' }],
  }, (m) => {
    assert.deepEqual(m.permissions, [{ capability: 'microphone', reason: 'Records your voice notes' }]);
  });
});

test('an unrecognized capability is dropped, not thrown', () => {
  withManifest({ permissions: ['microphone', 'teleportation', 'payment'] }, (m) => {
    assert.deepEqual(m.permissions, [{ capability: 'microphone', reason: null }]);
  });
});

test('a garbage permissions block resolves to no permissions', () => {
  for (const block of [{}, 'microphone', 42, null]) {
    withManifest({ permissions: block }, (m) => {
      assert.deepEqual(m.permissions, [], `block ${JSON.stringify(block)}`);
    });
  }
});

test('a manifest with no permissions block declares nothing', () => {
  // The whole back-compat story in one assertion: an app that says nothing
  // gets nothing, which is what makes geolocation stop being blanket.
  withManifest({ name: 'Legacy' }, (m) => {
    assert.deepEqual(m.permissions, []);
    assert.equal(appPermissions.allowAttribute(
      m.permissions.map((p) => p.capability)
    ), 'clipboard-write; pointer-lock');
  });
});

test('a reason longer than the prompt line is truncated, not rejected', () => {
  withManifest({
    permissions: [{ capability: 'camera', reason: 'x'.repeat(500) }],
  }, (m) => {
    assert.equal(m.permissions[0].reason.length, 140);
  });
});

test('declaredFor re-normalizes a snapshot written by an older reader', () => {
  // The snapshot is whatever the reader wrote at deploy time, and a
  // capability may have left the catalogue since.
  const declared = declaredFor({
    manifest_snapshot: {
      permissions: [
        { capability: 'camera', reason: 'Scan a code' },
        { capability: 'teleportation', reason: 'Nope' },
        { capability: 'geolocation' },
      ],
    },
  });
  assert.deepEqual(declared, [
    { capability: 'geolocation', reason: null },
    { capability: 'camera', reason: 'Scan a code' },
  ]);
});

test('declaredFor survives a missing or malformed snapshot', () => {
  assert.deepEqual(declaredFor({}), []);
  assert.deepEqual(declaredFor({ manifest_snapshot: null }), []);
  assert.deepEqual(declaredFor({ manifest_snapshot: 'nope' }), []);
  assert.deepEqual(declaredFor({ manifest_snapshot: { permissions: 'nope' } }), []);
});

test('dropping a declaration stops the delegation but keeps the grant', () => {
  // An app that removes a capability from its dapp.json must stop receiving
  // it on the next deploy, or the manifest stops being the audit surface the
  // whole design rests on. The grant row survives, so putting the
  // declaration back restores it without asking the user again.
  const granted = ['camera', 'microphone'];
  const stillDeclared = [{ capability: 'camera', reason: null }];
  assert.deepEqual(effectiveCapabilities(stillDeclared, granted), ['camera']);
  assert.equal(
    appPermissions.allowAttribute(effectiveCapabilities(stillDeclared, granted)),
    'clipboard-write; pointer-lock; camera'
  );
  // And the other way round: declared but not granted delegates nothing.
  assert.deepEqual(effectiveCapabilities(
    [{ capability: 'camera', reason: null }, { capability: 'usb', reason: null }],
    ['camera']
  ), ['camera']);
});

// ── 4. The two ends of the relay ────────────────────────────────────────

test('the bridge exposes the permission API and both copies are identical', () => {
  const bridge = read('public/usernode-bridge/v1/bridge.js');
  for (const fn of ['requestPermission', 'getPermission', 'getPermissions', 'hasCapability']) {
    assert.match(bridge, new RegExp(`window\\.usernode\\.${fn} = function`), `bridge defines ${fn}`);
  }
  assert.equal(read('public/usernode-bridge.js'), bridge, 'the unversioned mirror matches');
});

test('the shell answers the __usernode_permission family', () => {
  const shell = read('public/js/app-view.js');
  assert.match(shell, /__usernode_permission/);
  assert.match(shell, /try \{ AppView\.handlePermissionBridgeMessage\(e\); \} catch \{\}/,
    'the relay is registered on the top-level message listener');
  // Only frames this shell owns may ask, same gate as the LLM family.
  const handler = shell.slice(shell.indexOf('async handlePermissionBridgeMessage('));
  assert.match(handler.slice(0, 4000), /AppView\.ownedFrameFor\(e\.source\)/);
});

test('a dismissed prompt is a denial, never a grant', () => {
  // Backdrop, Escape and "Not now" all resolve the same way, and the POST
  // that stores a grant is only reached when the promise resolves truthy.
  const shell = read('public/js/app-view.js');
  assert.match(shell, /AppView\._permissionConsentSettle = \(allow\) => done\(allow \? true : null\);/);
  const handler = shell.slice(
    shell.indexOf('async handlePermissionBridgeMessage('),
    shell.indexOf('// ── App file storage relay')
  );
  assert.match(handler, /if \(!decision\) \{\s*\n\s*reply\(\{ capability, state: 'denied', active: false, reason: 'declined' \}\);/);
  assert.ok(handler.indexOf("reason: 'declined'") < handler.indexOf("'/api/me/permission-grants'"),
    'the decline path returns before the grant is stored');
});

test('the two ungated capabilities answer granted, not "unknown"', () => {
  // An app should be able to ask about any capability uniformly instead of
  // having to know which ones the platform gates. clipboard-write and
  // pointer-lock are delegated to every frame, so "granted" is the truth.
  const block = read('public/js/app-view.js');
  const handler = block.slice(
    block.indexOf('async handlePermissionBridgeMessage('),
    block.indexOf('// ── App file storage relay')
  );
  assert.match(handler, /AppView\._appIframeUngated\.includes\(capability\)/);
  assert.match(handler, /state: 'granted', active: true, reason: 'ungated'/);
  assert.ok(
    handler.indexOf("reason: 'ungated'") < handler.indexOf("reason: 'unknown_capability'"),
    'the ungated branch is reached before the unknown-capability denial'
  );
});

test('an undeclared capability is refused before any prompt is shown', () => {
  const handler = read('public/js/app-view.js');
  const block = handler.slice(
    handler.indexOf('async handlePermissionBridgeMessage('),
    handler.indexOf('// ── App file storage relay')
  );
  assert.ok(block.indexOf("reason: 'not_declared'") < block.indexOf('showPermissionConsentModal'),
    'the not_declared refusal precedes the dialog');
});
