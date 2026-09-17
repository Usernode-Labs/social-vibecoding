// The "set it up in Claude / ChatGPT" links in Settings → Connectors (#1607).
//
// The two product walkthroughs under the connector URL are six and seven
// steps, and the reported cost was reading them: "instructions ... are too
// long, maybe some link could be provided ... so that they imported the
// instructions to the chat". These links open a NEW chat pre-loaded with the
// server URL and the job.
//
// What they are NOT is a replacement for the steps, and that is deliberate:
// an assistant in a chat cannot click through Claude's or ChatGPT's own
// settings UI. The steps stay; this is a shortcut past the reading.
//
// Run with: node --test tests/connector-chat-links.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const TSX = 'frontend/src/features/settings/sections/connectors.tsx';
const SETTINGS = 'frontend/src/features/settings/settings.js';

test('#1607: both links exist and open in a new tab without handing over the opener', () => {
  const tsx = read(TSX);
  // #2370: both are spelled by ONE component, GuidedSetup, so the new-tab and
  // no-opener rules are written once and cannot hold for one link and not the
  // other. The ids are props on its two call sites.
  const helper = tsx.slice(tsx.indexOf('function GuidedSetup('), tsx.indexOf('/** The grey label'));
  assert.match(helper, /<a\b[\s\S]*?id=\{id\}[\s\S]*?href=\{href\}/, 'an anchor carrying the id and href it is given');
  assert.match(helper, /target="_blank"/, 'opens in a new tab');
  // Without rel, the opened page gets a live window.opener back into the
  // platform. Same rule #1532 applied to the waitlist connect links.
  assert.match(helper, /rel="noopener noreferrer"/, 'hands over no opener');
  for (const id of ['connector-open-claude', 'connector-open-chatgpt']) {
    assert.match(tsx, new RegExp(`<GuidedSetup id="${id}" href="https://[^"]+" product="[^"]+" />`), `${id} exists`);
  }
});

test('#2370: the guided chat is offered INSIDE its route, not beside the routes', () => {
  const tsx = read(TSX);
  // On the overview the two links read "Set it up in Claude" / "…in ChatGPT",
  // directly above rows titled "Claude.ai" and "ChatGPT": the same two
  // products twice, with nothing saying one was a chat that talks you through
  // it and the other the written steps. The overview asks WHICH app; the
  // opened row answers HOW, guided chat first.
  const at = (needle) => { const i = tsx.indexOf(needle); assert.ok(i > 0, `${needle} exists`); return i; };
  const claudeRow = at('<Disclosure title="Claude.ai"');
  const chatgptRow = at('<Disclosure title="ChatGPT"');
  const codexRow = at('id="connector-setup-codex"');
  const claudeLink = at('<GuidedSetup id="connector-open-claude"');
  const chatgptLink = at('<GuidedSetup id="connector-open-chatgpt"');
  assert.ok(claudeRow < claudeLink && claudeLink < chatgptRow, 'Claude\'s link is inside the Claude.ai row');
  assert.ok(chatgptRow < chatgptLink && chatgptLink < codexRow, 'ChatGPT\'s link is inside the ChatGPT row');
  assert.ok(claudeLink < tsx.indexOf('<SetupStep n={1} title="Open connector settings."'),
    'and it comes before the written steps');
  assert.doesNotMatch(tsx.replace(/\/\*[\s\S]*?\*\//g, ''), /Set it up in (Claude|ChatGPT)/,
    'the old labels are gone from the markup');
});

test('#1607: the href is built from the LIVE connector URL, never hardcoded', () => {
  const settings = read(SETTINGS);
  // The written steps deliberately point back at #connector-url rather than
  // naming a host, so a fork or a config change cannot stale them. These
  // links follow the same rule: the origin comes from the same derived value
  // the field is filled with.
  assert.match(settings, /const connectorUrl = `\$\{window\.location\.origin\}\/mcp`;/);
  assert.match(settings, /urlField\.value = connectorUrl/);
  assert.match(settings, /\$\{connectorUrl\}/, 'the prompt embeds the derived URL');
  assert.match(settings, /connector-open-claude', 'https:\/\/claude\.ai\/new\?q='/);
  assert.match(settings, /connector-open-chatgpt', 'https:\/\/chatgpt\.com\/\?q='/);
  assert.match(settings, /encodeURIComponent\(chatPrompt\)/, 'the prompt is encoded');
});

test('#1607: the prompt carries the two facts people get wrong, and nothing secret', () => {
  const settings = read(SETTINGS);
  const start = settings.indexOf('const chatPrompt =');
  assert.ok(start > 0, 'the prompt is built in one place');
  const prompt = settings.slice(start, settings.indexOf('const chatLinks', start));

  // Dynamic client registration: without this, people go hunting for a client
  // ID and secret that do not exist. It is step 4 of the Claude walkthrough.
  assert.match(prompt, /dynamic client registration/);
  // The exact name. Claude Code builds its permission rules from what the
  // human types, and one account typed `Uesrnode`, silently missing every
  // rule the platform ships (#1218).
  assert.match(prompt, /"homeroom"/);

  // Nothing sensitive may travel in a query string. Rather than scanning for
  // sensitive-sounding WORDS — the prompt legitimately says "no client ID or
  // secret to enter", so that scan flags itself — pin the property that
  // actually matters: the only value interpolated into the prompt is the
  // derived connector URL. Nothing else from the page can reach the link.
  const interpolations = [...prompt.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim());
  assert.deepEqual([...new Set(interpolations)], ['connectorUrl'],
    'only the derived connector URL is interpolated into the prompt');
});

test('#1607: the written walkthroughs stay, because a chat cannot click a settings UI', () => {
  const tsx = read(TSX);
  // The request hoped the link would replace the copy-paste. It cannot: an
  // assistant cannot operate the product's own settings screens. Removing the
  // reference on that hope would leave nothing authoritative behind, so both
  // walkthroughs are still here and still complete.
  // #2370 collapsed each route into a <details>, so the probe is the summary
  // row rather than the old <h4>. It is a slightly stronger check than before:
  // the hint states the step COUNT, so a walkthrough quietly losing steps now
  // fails here too. Whether the route starts open was never the point.
  assert.match(tsx, /6 steps &middot; also sets up Claude Code/);
  assert.match(tsx, /7 steps &middot; needs Developer mode/);
  assert.match(tsx, /Turn on Developer mode\./);
  assert.match(tsx, /Paste your MCP server URL\./);
});
