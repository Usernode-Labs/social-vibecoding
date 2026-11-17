'use strict';

// #6783: the New project card Homeroom bot offers in a private thread. The
// card's own body, its buttons and its made state, and the body Make it posts
// to /api/apps. Nothing here needs a browser: the card is rendered with
// react-dom/server, and what a button posts is the pure body it builds.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const BRIEF = 'A shared list of the plants in our flat, who waters which one and when it was last done. '
  + 'Each plant has a photo, a watering rhythm and a reminder for whoever\'s turn it is. Just the three of us use it, '
  + 'and nothing goes to anybody outside the flat. When somebody is away it says who is looking after their plants '
  + 'that week.';

test('#6783: the New project card shows the name, what it will do and Show all, and posts the brief', () => {
  const { ProjectOfferCard, makeBody, briefNeedsMore } = loadTsx('frontend/src/features/messages/bot-make.tsx');
  // Four lines show before Show all: more than four lines, or a long one.
  assert.equal(briefNeedsMore(BRIEF), true);
  assert.equal(briefNeedsMore('A chore chart for our flat.'), false);
  assert.equal(briefNeedsMore('one\ntwo\nthree\nfour'), false);
  assert.equal(briefNeedsMore('one\ntwo\nthree\nfour\nfive'), true);

  const project = { name: 'Plant Pal', rootId: 42, version: null, brief: BRIEF };
  const html = renderToHtml(createElement(ProjectOfferCard, { project }));
  assert.match(html, /data-bot-project-card=""/);
  assert.match(html, /class="[^"]*line-clamp-4[^"]*" data-bot-project-brief=""/, 'four lines until Show all');
  assert.equal(message('messages:bot.make.briefLabel'), 'What it will do');
  assert.ok(html.includes('>What it will do</div>'));
  assert.match(html, /data-bot-project-more=""[^>]*aria-expanded="false"/);
  assert.equal(message('messages:bot.make.showAll'), 'Show all');
  assert.equal(message('messages:bot.make.showLess'), 'Show less');
  assert.equal(message('messages:bot.make.cardSubmit'), 'Make it');
  assert.equal(message('messages:bot.make.editFirst'), 'Edit first');
  assert.match(html, /<span>Make it<\/span>/);
  assert.match(html, /<span>Edit first<\/span>/);
  // A brief of a few lines has nothing more to show.
  const short = renderToHtml(createElement(ProjectOfferCard, { project: { ...project, brief: 'A chore chart for our flat.' } }));
  assert.doesNotMatch(short, /data-bot-project-more=""/);
  assert.match(short, /A chore chart for our flat\./);

  // What Make it posts: the name, who it is for, the brief, and the thread
  // its card is in. No design and no `from`.
  assert.deepEqual(makeBody(project, ' Plant Pal ', 'solo', 'Europe/London'), {
    name: 'Plant Pal', audience: 'solo', brief: BRIEF, thread: { rootId: 42 }, timeZone: 'Europe/London',
  });
  assert.deepEqual(Object.keys(makeBody(project, 'Plant Pal', 'invited')), ['name', 'audience', 'brief', 'thread']);
  // The design card's body is unchanged.
  assert.deepEqual(makeBody({ name: 'Watering can', rootId: 77, version: 2 }, ' Watering can ', 'solo', 'Europe/London'), {
    name: 'Watering can', audience: 'solo', brief: 'Watering can', from: 'design', design: { rootId: 77, version: 2 }, timeZone: 'Europe/London',
  });

  // Where the card's own buttons go.
  const src = read('frontend/src/features/messages/bot-make.tsx');
  assert.match(src, /setMaking\(true\)/, 'Make it opens the sheet');
  assert.match(src, /app\?\.showCreateModal\?\.\(\{ idea: brief, name: project\.name \}\)/, 'Edit first opens Create filled in');
  assert.match(src, /<MakeSheet\s+project=\{project\}/, 'the sheet makes this very project');
});

test('#6783: once made, the card says what it made and opens it, with no buttons', () => {
  const { ProjectOfferCard } = loadTsx('frontend/src/features/messages/bot-make.tsx');
  const project = { name: 'Plant Pal', rootId: 42, version: null, brief: 'A shared list of the plants in our flat.' };
  const made = renderToHtml(createElement(ProjectOfferCard, {
    project, made: { slug: 'plant-pal', name: 'Plant Pal' },
  }));
  assert.match(made, /href="#app\/plant-pal"/);
  assert.equal(message('messages:bot.make.open', { project: 'Plant Pal' }), 'Open Plant Pal');
  assert.ok(made.includes('Open Plant Pal'));
  assert.doesNotMatch(made, /data-bot-project-make=""/);
  assert.doesNotMatch(made, /data-bot-project-edit=""/);
});

test('#6783: BotQuestion draws the card for a make_offer with a brief, and the design card as it was', () => {
  const { BotQuestion } = loadTsx('frontend/src/features/messages/bot-question.tsx', {
    stubs: { './store': { answerBotQuestion() {}, quoteInComposer() {}, async tapBotAction() {} } },
  });
  const messageOf = (meta) => ({
    id: 9, conversationId: 3, sender: { id: 4, username: 'homeroom_bot', bot: true },
    content: '**Plant Pal** · a new project', deleted: false, metadata: { homeroomBot: meta },
  });
  const html = renderToHtml(createElement(BotQuestion, {
    message: messageOf({
      kind: 'make_offer', status: 'open', question: 'Make Plant Pal?',
      makeProject: { name: 'Plant Pal', rootId: 42, version: null, brief: 'A shared list of the plants in our flat.' },
      actions: [{ id: 'make', label: 'Make it', style: 'primary', type: 'make' }],
    }),
    conversationId: 3,
  }));
  assert.match(html, /data-bot-project-card=""/);
  assert.match(html, /A shared list of the plants in our flat\./);
  assert.match(html, /data-bot-question="open"/);
  // Made, on every device: the message's own state, not a device's guess.
  const made = renderToHtml(createElement(BotQuestion, {
    message: messageOf({
      kind: 'make_offer', status: 'answered', answer: 'Make it', madeSlug: 'plant-pal', madeName: 'Plant Pal',
      makeProject: { name: 'Plant Pal', rootId: 42, version: null, brief: 'A shared list of the plants in our flat.' },
      actions: [{ id: 'make', label: 'Make it', style: 'primary', type: 'make' }],
    }),
    conversationId: 3,
  }));
  assert.match(made, /href="#app\/plant-pal"/);
  assert.doesNotMatch(made, /data-bot-project-make=""/);
  // A design's own card (no brief) keeps its one Make the project button.
  const design = renderToHtml(createElement(BotQuestion, {
    message: messageOf({
      kind: 'make_offer', status: 'open', question: 'Make Watering can?',
      makeProject: { name: 'Watering can', rootId: 77, version: 2 },
      actions: [{ id: 'make', label: 'Make the project', style: 'primary', type: 'make' }],
    }),
    conversationId: 3,
  }));
  assert.doesNotMatch(design, /data-bot-project-card=""/);
  assert.match(design, /<span>Make the project<\/span>/);
  // Closed, it says why in its buttons' place (never a dead Make it).
  const closed = renderToHtml(createElement(BotQuestion, {
    message: messageOf({
      kind: 'make_offer', status: 'closed',
      makeProject: { name: 'Plant Pal', rootId: 42, version: null, brief: 'A shared list of the plants in our flat.' },
      actions: [{ id: 'make', label: 'Make it', style: 'primary', type: 'make' }],
    }),
    conversationId: 3,
  }));
  assert.match(closed, /data-bot-question="closed"/);
  assert.doesNotMatch(closed, /data-bot-project-make=""/);
  assert.equal(message('messages:bot.actions.closed'), 'No longer needed.');
});

test('#6783: the client keeps a card with a brief and no name, and drops one with neither', () => {
  const { normalizeBotMeta } = loadTsx('frontend/src/features/messages/api.ts');
  const withBrief = normalizeBotMeta({
    homeroomBot: { kind: 'make_offer', makeProject: { name: '', rootId: 42, version: null, brief: 'A chore chart for our flat.' } },
  });
  assert.deepEqual(withBrief.homeroomBot.makeProject, {
    name: '', rootId: 42, version: null, brief: 'A chore chart for our flat.',
  });
  const neither = normalizeBotMeta({ homeroomBot: { kind: 'make_offer', makeProject: { name: '', rootId: 42, version: null } } });
  assert.equal(neither.homeroomBot.makeProject, undefined);
});
