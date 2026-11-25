'use strict';

// #7136: what the model is told about a file somebody attached for Homeroom
// bot, and what the draft says it carries. Pure: the lines and the body are
// all this checks.
//
// Before this, a file that was not a picture read "[Homeroom: they attached
// the file notes.md, which you cannot open.]", so nothing the bot filed ever
// carried one and no build saw it. Now the line says a request they file can
// carry it to its build, and the draft and the filed request list it.
//
// Run with: node --test tests/homeroom-bot-attached-file-line.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const mayor = require('../src/services/homeroom-bot-mayor');

test('a file that is not a picture says a request can carry it to a build', () => {
  assert.equal(
    mayor.attachedLine({ id: 'a1b2c3', kind: 'binary', filename: 'site.zip' }),
    '[Homeroom: they attached the file site.zip (id a1b2c3). You cannot open it, but a request they file can carry it to its build: put its id in offer_request\'s attachmentIds when they ask for it to be used.]',
  );
  // A thread with no offer tool has no id to pass: the line still says the
  // file can reach a build.
  assert.equal(
    mayor.attachedLine({ id: 'a1b2c3', kind: 'markdown', filename: 'notes.md' }, { withId: false }),
    '[Homeroom: they attached the file notes.md. You cannot open it, but a request filed from this thread can carry it to its build.]',
  );
});

test('the picture lines are unchanged', () => {
  const shot = { id: 'f1', kind: 'image', filename: 'desktop.png' };
  assert.equal(
    mayor.attachedLine(shot, { picture: { mimeType: 'image/png', data: 'AAAA' }, imageInput: true }),
    '[Homeroom: they attached the picture desktop.png (id f1), shown below.]',
  );
  assert.equal(
    mayor.attachedLine(shot, { imageInput: false }),
    '[Homeroom: they attached the picture desktop.png (id f1), which you cannot see: your model reads text only.]',
  );
  assert.equal(
    mayor.attachedLine(shot, { imageInput: true }),
    '[Homeroom: they attached the picture desktop.png (id f1). Only the newest pictures are shown.]',
  );
});

test('the draft names the files it carries, before its Done when', () => {
  const text = mayor.draftExtrasText({
    files: [{ id: 'f'.repeat(32), name: 'site.zip', size: 4 * 1024 * 1024 + 200 * 1024 }],
    doneWhen: ['The pages are the ones in the zip'],
  });
  assert.match(text, /\*\*Files it carries:\*\* site\.zip \(4\.2 MB\)\. Anyone who can see the request sees their names, and its build can open them\./);
  assert.ok(text.indexOf('Files it carries') < text.indexOf('**Done when:**'), 'its own line, before Done when');
});

test('a draft with no files says nothing about them', () => {
  const text = mayor.draftExtrasText({ files: [], doneWhen: ['It works'] });
  assert.doesNotMatch(text, /Files it carries/);
  assert.match(text, /\*\*Done when:\*\*/);
});

test('the preview lists a carried file by name and size', () => {
  const view = mayor.draftExtrasView({ files: [{ id: 'x', name: 'budget.csv', size: 812 }] });
  assert.deepEqual(view.files, [{ name: 'budget.csv', size: 812 }]);
  // A malformed entry, or none, gives an empty list rather than a crash.
  assert.deepEqual(mayor.draftExtrasView({}).files, []);
  assert.deepEqual(mayor.draftExtrasView({ files: [{ size: 3 }, null] }).files, []);
});

test('the filed request lists its files by name, size and the id its build uses', () => {
  const body = mayor.requestBody({
    details: 'Build it from the zip.',
    username: 'ada',
    extras: { files: [{ name: 'site.zip', size: 4300800 }] },
    files: [{ id: 'a'.repeat(32), name: 'site.zip', size: 4300800 }],
  });
  assert.match(body, /^Build it from the zip\./);
  assert.match(body, /\*\*Files\*\*\n- site\.zip \(4\.1 MB\), file id a{32}/);
  // It is part of the extras: the pictures' embed, then the files.
  assert.ok(body.indexOf('**Files**') < body.indexOf('Filed from'), 'before the chat footer');
  // A request with no files keeps the body it always had.
  const plain = mayor.requestBody({ details: 'Words.', username: 'ada', extras: { files: [] } });
  assert.doesNotMatch(plain, /\*\*Files\*\*/);
});
