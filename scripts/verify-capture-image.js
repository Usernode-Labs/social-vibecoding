'use strict';
// Run on stdin inside the finished capture image, with --network none.
// Exercise its actual entrypoint, browser, cookie handling and ffmpeg after
// dependency updates. The only HTTP server and all data are local fixtures.
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');

async function main() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><style>
      body { margin: 0; height: 1800px; background: #eee; color: #111; }
      h1 { padding: 30px; } #moving { position: fixed; top: 130px; width: 30px;
        height: 30px; background: #7355cb; animation: move 1s linear infinite alternate; }
      @keyframes move { from { left: 10px; } to { left: 100px; } }
      </style><h1 id="ready">Capture fixture</h1><div id="moving"></div><script>
      document.body.dataset.cookie = document.cookie.includes('capture_fixture=1') ? 'yes' : 'no';
      ${req.url === '/error' ? "console.error('fixture-console-error');" : ''}
      </script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const cookie = 'capture_fixture=1';
    const child = spawn(process.execPath, ['/app/capture.js'], {
      env: { ...process.env, MEDIA: '1', DEVICE_SCALE_FACTOR: '1', TEST_RETRY_RUNS: '0',
        TARGETS: JSON.stringify([{ index: 0, afterUrl: `${url}/media`, afterCookie: cookie,
          ready: { expectSelector: 'body[data-cookie="yes"] #ready' },
          companion: { index: 1, viewport: { width: 390, height: 844 } } }]),
        TESTS: JSON.stringify([
          { index: 0, name: 'isolated check context', url, expectSelector: 'body[data-cookie="no"] #ready' },
          { index: 1, name: 'console error fixture', url: `${url}/error`, expectSelector: '#ready' },
        ]),
      }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 32 * 1024 * 1024) child.kill('SIGKILL'); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    try {
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      assert.equal(code, 0, stderr);
    } finally { clearTimeout(timer); }
    assert.doesNotMatch(stderr, /capture: fatal/, stderr);
    assert.deepEqual(stdout.match(/^__USERNODE_SHOT_FAIL__.*$/gm) || [], []);
    const lines = stdout.split('\n');
    const media = new Set(), checks = new Map();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('__USERNODE_SHOT__ ')) {
        const attrs = Object.fromEntries([...line.matchAll(/(\w+)=(\S+)/g)].map(m => [m[1], m[2]]));
        const bytes = Buffer.from(lines[i + 1], 'base64');
        assert.equal(bytes.length, Number(attrs.bytes));
        if (attrs.media === 'png') assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        if (attrs.media === 'webm') assert.equal(bytes.subarray(0, 4).toString('hex'), '1a45dfa3');
        if (attrs.media === 'gif') assert.equal(bytes.subarray(0, 3).toString(), 'GIF');
        media.add(`${attrs.index}:${attrs.media}`);
      } else if (line.startsWith('__USERNODE_TEST__ ')) {
        const index = Number(/index=(\d+)/.exec(line)[1]);
        checks.set(index, { passed: line.includes('status=pass'), ...JSON.parse(Buffer.from(lines[i + 1], 'base64')) });
      }
    }
    for (const artifact of ['0:png', '0:webm', '0:gif', '1:png']) assert.ok(media.has(artifact), `missing ${artifact}`);
    assert.equal(checks.get(0)?.passed, true, JSON.stringify(checks.get(0)));
    assert.equal(checks.get(1)?.passed, false);
    assert.ok(checks.get(1)?.consoleErrors.some(e => e.message.includes('fixture-console-error')));
    console.log('Capture image verified: authenticated media, isolated checks, console errors, desktop/mobile PNG, WebM and GIF.');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(err => { console.error(err); process.exit(1); });
