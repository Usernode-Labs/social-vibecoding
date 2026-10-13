// #4125: some models write the suggest_replies call into the reply as text,
// and people saw "<suggest_replies> [...] </suggest_replies>" in the chat.
// takeTextualReplies cuts every such block out and hands back the replies
// it named. The turn itself is covered in tests/agent-mayor-turn.test.js.
//
// Run with: node --test tests/mayor-textual-pills.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { takeTextualReplies } = require('../src/services/mayor/messages');

test('a reply with no tag comes back unchanged, with no replies', () => {
  assert.deepEqual(takeTextualReplies('Just words.'), { text: 'Just words.', replies: null });
  assert.deepEqual(takeTextualReplies(undefined), { text: '', replies: null });
});

test('the reported reply: the block is cut and its replies kept', () => {
  const raw = 'PR #39 is now up for the group vote on Lost Starways.\n<suggest_replies> ["Start the Escape from Dracula change on Game Corner", "How is the vote going?", "What\'s left in the spec?"] </suggest_replies>';
  assert.deepEqual(takeTextualReplies(raw), {
    text: 'PR #39 is now up for the group vote on Lost Starways.',
    replies: ['Start the Escape from Dracula change on Game Corner', 'How is the vote going?', "What's left in the spec?"],
  });
});

test('the tool\'s own input shape and an unclosed block at the end are read too', () => {
  assert.deepEqual(takeTextualReplies('Hi <SUGGEST_REPLIES>{"replies":["A","B"]}</SUGGEST_REPLIES>').replies, ['A', 'B']);
  assert.deepEqual(takeTextualReplies('Hi <suggest_replies>["A"]'), { text: 'Hi', replies: ['A'] });
});

test('a block that is not JSON, or a suggest_answers block, is cut with no replies', () => {
  assert.deepEqual(takeTextualReplies('Hi <suggest_replies>Do it, Wait</suggest_replies>'), { text: 'Hi', replies: null });
  assert.deepEqual(takeTextualReplies('Pick one. <suggest_answers>[{"q":1}]</suggest_answers> Thanks.'), { text: 'Pick one.  Thanks.', replies: null });
});
