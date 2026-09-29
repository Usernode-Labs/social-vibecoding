#!/usr/bin/env node
'use strict';

// Deliberately stateless, self-contained app fixture. The local harness commits
// this source as the base revision, then changes one UI behaviour in a second
// local Git commit. Both app containers are replaced before the second replay.
const http = require('node:http');

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="data:,">
  <title>Local evidence fixture</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; color: #18181b; background: #f4f4f5; font: 16px system-ui, sans-serif; }
    header { background: #18181b; color: white; padding: 18px 40px; font-weight: 700; }
    main { max-width: 820px; margin: 58px auto; padding: 0 24px; }
    h1 { font-size: 28px; margin: 0 0 10px; }
    p { color: #52525b; line-height: 1.5; }
    .card { margin-top: 28px; padding: 28px; border: 1px solid #d4d4d8; border-radius: 16px; background: white; }
    button { border: 0; border-radius: 9px; background: #4f46e5; color: white; font: inherit; font-weight: 600; padding: 11px 16px; cursor: pointer; }
    button.secondary { background: #e4e4e7; color: #27272a; }
    [role=dialog] { width: 430px; margin-top: 22px; border: 1px solid #c4b5fd; border-radius: 12px; padding: 22px; background: #faf9ff; }
    [hidden] { display: none !important; }
    label { display: block; margin: 18px 0 7px; font-weight: 600; }
    input { width: 100%; height: 42px; padding: 8px 12px; border: 1px solid #a1a1aa; border-radius: 8px; font: inherit; }
    [role=listbox] { margin: 9px 0 14px; padding: 0; list-style: none; border: 1px solid #c4b5fd; border-radius: 8px; background: white; }
    [role=option] { padding: 11px 12px; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
  </style>
</head>
<body>
  <header>Homeroom local evidence lab</header>
  <main>
    <h1>Members</h1>
    <p>A deterministic UI change for testing real before and after captures.</p>
    <div class="card">
      <strong>Project team</strong>
      <p>Invite another member to collaborate on this project.</p>
      <button id="open-invite" type="button">Open invite</button>
      <section role="dialog" aria-label="Invite member" hidden>
        <h2>Invite member</h2>
        <p>Find a member by username.</p>
        <label for="username">Username</label>
        <input id="username" type="text" autocomplete="off">
        <ul role="listbox" aria-label="Username suggestions" hidden>
          <li role="option">marina</li>
        </ul>
        <div class="actions"><button class="secondary" type="button">Cancel</button><button type="button">Invite</button></div>
      </section>
    </div>
  </main>
  <script>
    const dialog = document.querySelector('[role=dialog]');
    const suggestions = document.querySelector('[role=listbox]');
    document.getElementById('open-invite').addEventListener('click', () => { dialog.hidden = false; });
    document.getElementById('username').addEventListener('input', (event) => {
      suggestions.hidden = true; // LOCAL_EVIDENCE_CHANGE_POINT
    });
  </script>
</body>
</html>`;

http.createServer((req, res) => {
  const path = new URL(req.url, 'http://fixture.local').pathname;
  if (path === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ready');
    return;
  }
  if (path === '/fixture') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
}).listen(3000, '0.0.0.0');
