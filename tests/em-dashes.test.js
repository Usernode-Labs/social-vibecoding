'use strict';

// No em dashes in what a model writes for people (src/services/em-dashes.js).
//
// 5 Oct 2026, production: the Homeroom bot's change descriptions, shown on
// the change page to every member and as the pull request's body, said
// "Members do nothing extra — finishing a book happens by picking the next
// one." and "Everything else on the card — the hosting label, the date, the
// 7:00 pm time and the countdown — is unchanged". The platform's copy has no
// em dashes (#1389). Pinned here, pure: each dash between words becomes what
// fits there, and nothing that is not an em dash between words changes:
// code, URLs, en dashes in ranges, hyphens, a table's empty cell.
//
// Run with: node --test tests/em-dashes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { withoutEmDashes: plain } = require('../src/services/em-dashes');

const EM = '—';
const EN = '–';

test('the two sentences from production read without their dashes', () => {
  assert.equal(
    plain(`Members do nothing extra ${EM} finishing a book happens by picking the next one.`),
    'Members do nothing extra: finishing a book happens by picking the next one.',
  );
  assert.equal(
    plain(`Everything else on the card ${EM} the hosting label, the date, the 7:00 pm time and the countdown ${EM} is unchanged.`),
    'Everything else on the card (the hosting label, the date, the 7:00 pm time and the countdown) is unchanged.',
    'an aside that is a list goes in brackets',
  );
});

test('each dash between words becomes a comma, a colon or a full stop, by the words around it', () => {
  const cases = [
    // An aside without a list: in commas.
    [`The card ${EM} shown at the top ${EM} lists who is in.`, 'The card, shown at the top, lists who is in.'],
    // A joining word after the dash: a comma.
    [`It works offline ${EM} and syncs when you are back.`, 'It works offline, and syncs when you are back.'],
    [`Pick a time ${EM} with a reminder the day before.`, 'Pick a time, with a reminder the day before.'],
    // A new clause after it: a full stop, and a capital, even after a short lead.
    [`Good idea ${EM} I can file a request for that.`, 'Good idea. I can file a request for that.'],
    [`Adds a countdown to the next session ${EM} it updates every minute.`, 'Adds a countdown to the next session. It updates every minute.'],
    [`Sorry about that ${EM} that sounds like a bug.`, 'Sorry about that. That sounds like a bug.'],
    // "that" as a determiner is not a new sentence.
    [`The list keeps one row a person ${EM} that week's answer.`, 'The list keeps one row a person: that week\'s answer.'],
    // A label before it: a colon.
    [`- **Countdown** ${EM} shows the days to go`, '- **Countdown**: shows the days to go'],
    [`- **Driving** ${EM} with a seat count`, '- **Driving**: with a seat count'],
    [`- Who's coming ${EM} a list of names`, '- Who\'s coming: a list of names'],
    [`## Climbing ${EM} who's in and who drives`, '## Climbing: who\'s in and who drives'],
    // Otherwise a colon, or a comma once the sentence has one.
    [`Three sessions a month ${EM} 3 of them this week.`, 'Three sessions a month: 3 of them this week.'],
    [`Note: the order changed ${EM} the newest is first.`, 'Note: the order changed, the newest is first.'],
    // A time's colon is not a colon in the sentence.
    [`Next session at 6:30 pm on Wednesday ${EM} bring shoes.`, 'Next session at 6:30 pm on Wednesday: bring shoes.'],
    // With or without spaces around it.
    [`the date${EM}and the time`, 'the date, and the time'],
    // Two labels are not an aside.
    [`Bins ${EM} Member 1, Dishes ${EM} Member 2`, 'Bins: Member 1, Dishes: Member 2'],
    // Two sentences, two dashes, each on its own.
    [`One. Two ${EM} three. Four ${EM} five ${EM} six.`, 'One. Two: three. Four, five, six.'],
    // Beside other punctuation, it just goes.
    [`Saved, ${EM} reload to see it.`, 'Saved, reload to see it.'],
    [`(${EM} aside)`, '(aside)'],
    [`That's all ${EM}.`, 'That\'s all.'],
    // Its HTML entities are the same dash.
    ['a &mdash; b and c &#8212; d.', 'a, b and c, d.'],
  ];
  for (const [input, want] of cases) assert.equal(plain(input), want, input);
});

test('a dash that starts or ends a line, or stands alone, is a bullet, a colon or left as a glyph', () => {
  assert.equal(plain(`${EM} first\n${EM} second`), '- first\n- second');
  assert.equal(plain(`  ${EM} indented`), '  - indented');
  assert.equal(plain(`- ${EM} doubled marker`), '- doubled marker');
  assert.equal(plain(`What changed ${EM}\n\n- a`), 'What changed:\n\n- a');
  assert.equal(plain(`Done.${EM}`), 'Done.');
  // A table's empty cell, and a dash on a line of its own, are glyphs.
  assert.equal(plain(`| Driving | ${EM} |\n|---|---|`), `| Driving | ${EM} |\n|---|---|`);
  assert.equal(plain(`Above\n${EM}\nBelow`), `Above\n${EM}\nBelow`);
  // Lines stay apart; a Windows line ending stays.
  assert.equal(plain(`Line one\r\nTwo ${EM} three\r\n`), 'Line one\r\nTwo: three\r\n');
});

test('code, URLs and link targets are left exactly as written', () => {
  assert.equal(plain(`Run \`a ${EM} b\` now ${EM} it is quick.`), `Run \`a ${EM} b\` now. It is quick.`);
  assert.equal(plain(`Use \`\`x ${EM} \`y\`\`\` here ${EM} and there.`), `Use \`\`x ${EM} \`y\`\`\` here, and there.`);
  const fenced = `The list is new ${EM} it shows everyone.\n\n\`\`\`js\nconst a = "x ${EM} y";\n\`\`\`\n\n~~~\n${EM} kept\n~~~\nThe tests pass ${EM} all of them.`;
  assert.equal(plain(fenced), `The list is new. It shows everyone.\n\n\`\`\`js\nconst a = "x ${EM} y";\n\`\`\`\n\n~~~\n${EM} kept\n~~~\nThe tests pass, all of them.`);
  // An unclosed fence runs to the end.
  assert.equal(plain(`Hi ${EM} there.\n\`\`\`\nopen ${EM} fence`), `Hi: there.\n\`\`\`\nopen ${EM} fence`);
  // A URL is kept whole, whatever is in it, up to the next space.
  assert.equal(plain(`See https://example.com/a${EM}b-c?d=e ${EM} and more.`), `See https://example.com/a${EM}b-c?d=e, and more.`);
  assert.equal(plain(`[Read it](https://x.example/z${EM}y) ${EM} then vote`), `[Read it](https://x.example/z${EM}y), then vote`);
  assert.equal(plain(`Open www.example.com/${EM} now ${EM} it's live`), `Open www.example.com/${EM} now. It's live`);
  // Entities inside code are code too.
  assert.equal(plain('`&mdash;` is the entity'), '`&mdash;` is the entity');
});

test('en dashes, ranges, hyphens and double hyphens are not em dashes', () => {
  for (const same of [
    `Open 6:30${EN}8pm, Mon${EN}Fri, 1${EN}3 people`,
    `Open 6:30 pm ${EN} 8 pm`,
    'A first-Saturday day-out, in-or-out, can-drive',
    'Old -- new, and a - b',
    'Nothing here at all.',
  ]) {
    assert.equal(plain(same), same, same);
  }
  // A range written with an em dash and no spaces is a range, in an en dash.
  assert.equal(plain(`6:30pm${EM}8pm, Monday${EM}Friday, 2024${EM}2025, May${EM}June`),
    `6:30pm${EN}8pm, Monday${EN}Friday, 2024${EN}2025, May${EN}June`);
  // With spaces, or with a word on one side, it is not.
  assert.equal(plain(`page 3${EM}it's where`), 'page 3. It\'s where');
  assert.equal(plain(`page 3${EM}the last one`), 'page 3: the last one');
});

test('the same text comes back when there is nothing to do, and a second pass changes nothing', () => {
  const same = 'No dash here, only a hyphen-ed word.';
  assert.equal(plain(same), same);
  for (const value of [null, undefined, 42, '', { a: 1 }]) assert.equal(plain(value), value);
  // Text holding the placeholder characters is never read (it would be put back wrong).
  const odd = `0 ${EM} x`;
  assert.equal(plain(odd), odd);
  const inputs = [
    `Everything else on the card ${EM} the hosting label, the date ${EM} is unchanged.`,
    `Adds a countdown ${EM} it updates.\n${EM} bullet\n| a | ${EM} |`,
    `Run \`a ${EM} b\` now ${EM} quick. https://x.example/${EM}`,
    `Members do nothing extra ${EM} finishing a book happens by picking the next one.`,
  ];
  for (const input of inputs) {
    const once = plain(input);
    assert.equal(plain(once), once, input);
  }
});

test('a whole description comes out with no em dash outside its code', () => {
  const description = [
    `## What changes ${EM} for members`,
    '',
    `The card now shows who's coming to the next session ${EM} and whether they can drive.`,
    `Everything else on the card ${EM} the date, the 6:30 pm time and the countdown ${EM} is unchanged.`,
    '',
    `- **In or out** ${EM} one tap each`,
    `- **Driving** ${EM} a seat count`,
    '',
    `Try it at https://app.example/climb ${EM} it's on the first tab.`,
    '',
    '```',
    `npm test ${EM} passes`,
    '```',
  ].join('\n');
  const out = plain(description);
  const outsideCode = out.replace(/```[\s\S]*?```/g, '').replace(/https?:\/\/\S+/g, '');
  assert.doesNotMatch(outsideCode, /—/);
  assert.match(out, new RegExp(`npm test ${EM} passes`), 'the code block is as it was');
  assert.equal(out.split('\n')[0], '## What changes, for members', 'a joining word after it: a comma');
  assert.equal(out.split('\n')[2], 'The card now shows who\'s coming to the next session, and whether they can drive.');
  assert.equal(out.split('\n')[3], 'Everything else on the card (the date, the 6:30 pm time and the countdown) is unchanged.');
  assert.equal(out.split('\n')[5], '- **In or out**: one tap each');
  assert.equal(out.split('\n')[8], 'Try it at https://app.example/climb. It\'s on the first tab.');
});
