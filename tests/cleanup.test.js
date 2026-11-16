import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTranscript, parseDictionary } from '../js/cleanup.js';

const clean = (text, dictionary) => cleanTranscript(text, { dictionary: parseDictionary(dictionary || '') });
const cases = (name, table) => {
  for (const [input, expected, dictionary] of table) {
    test(`${name}: ${JSON.stringify(input)}`, () => assert.equal(clean(input, dictionary), expected));
  }
};

cases('plain text is left alone', [
  ['Hello there, how are you?', 'Hello there, how are you?'],
  ['  Extra   spaces  are   tidied. ', 'Extra spaces are tidied.'],
  ['', ''],
  ['Wait... what? It costs 3.5 dollars, e.g. this one.', 'Wait... what? It costs 3.5 dollars, e.g. this one.'],
]);

cases('new line', [
  ['Hello there. New line. This is next.', 'Hello there.\nThis is next.'],
  ['Hello there, new line, this is next', 'Hello there\nThis is next'],
  ['Hello there new line this is next', 'Hello there\nThis is next'],
  ['Hello there. Newline. Next.', 'Hello there.\nNext.'],
  ['First. New line. New line. Second.', 'First.\n\nSecond.'],
  ['Hello. New line.', 'Hello.'],
]);

cases('new paragraph', [
  ['Dear Sam. New paragraph. Thanks for the note.', 'Dear Sam.\n\nThanks for the note.'],
  ['One, new paragraph, two, new paragraph, three', 'One\n\nTwo\n\nThree'],
]);

cases('bullet point', [
  ['Shopping list. Bullet point, milk. Bullet point, eggs. Bullet point, bread.', 'Shopping list.\n• Milk.\n• Eggs.\n• Bread.'],
  ['Bullet point milk bullet point eggs', '• Milk\n• Eggs'],
]);

cases('command words used as ordinary speech are kept', [
  ['We launched a new line of products.', 'We launched a new line of products.'],
  ['Start the new paragraph with a quote.', 'Start the new paragraph with a quote.'],
  ['The first bullet point is the key one.', 'The first bullet point is the key one.'],
  ['Add some bullet points to the slide.', 'Add some bullet points to the slide.'],
  ['I need to scratch that itch.', 'I need to scratch that itch.'],
  ['They have new lines every season.', 'They have new lines every season.'],
]);

cases('scratch that', [
  ["I'll be there at five. Actually make it six. Scratch that.", "I'll be there at five."],
  ['Meet at five. Scratch that. Meet at six.', 'Meet at six.'],
  ['Meet at five, scratch that, meet at six.', 'Meet at six.'],
  ['One. Two. Three. Scratch that. Scratch that.', 'One.'],
  ['One. Two. Scratch that. three.', 'One. Three.'],
  ['Scratch that.', ''],
  ['Buy milk. New line. Buy eggs. Scratch that. Buy bread.', 'Buy milk.\nBuy bread.'],
  ['Buy milk. New line. Scratch that. And eggs.', 'Buy milk. And eggs.'],
  ['List. Bullet point, milk. Bullet point, eggs. Scratch that.', 'List.\n• Milk.'],
  ['I spoke to Dr. Patel today. Scratch that.', ''],
  ['Hello. I spoke to Dr. Patel today. Scratch that.', 'Hello.'],
  ['Is it ready? Tell me now! Scratch that.', 'Is it ready?'],
]);

cases('filler sounds', [
  ['Um, I think we should go.', 'I think we should go.'],
  ['um so I think we should go', 'So I think we should go'],
  ['I think, uh, we should go.', 'I think, we should go.'],
  ['So I was, um. Then we left.', 'So I was. Then we left.'],
  ['Okay. Um. So here it is.', 'Okay. So here it is.'],
  ['It was, er, hmm, fine.', 'It was, fine.'],
  ['Go to the ER now.', 'Go to the ER now.'],
  ['Bring an umbrella, uh-huh.', 'Bring an umbrella, uh-huh.'],
  ['The hummus was erm great', 'The hummus was great'],
]);

cases('repeated short words', [
  ['I I think the the plan is good.', 'I think the plan is good.'],
  ['I, I, I think so.', 'I think so.'],
  ['The the plan.', 'The plan.'],
  ['We went to to the shop and and then home.', 'We went to the shop and then home.'],
  ['I know that that is true.', 'I know that that is true.'],
  ['It was very very good, no no.', 'It was very very good, no no.'],
  ['The the um the plan.', 'The plan.'],
  ['Really really good and 5 5 times.', 'Really really good and 5 5 times.'],
  ['Either theme or the mean.', 'Either theme or the mean.'],
]);

cases('non-speech tags', [
  ['[BLANK_AUDIO]', ''],
  ['Hello [MUSIC] there (upbeat music) friend.', 'Hello there friend.'],
  ['Call me (after lunch) please.', 'Call me (after lunch) please.'],
]);

cases('personal dictionary', [
  ['i spoke to krishan about git hub', 'I spoke to Krishan about GitHub', 'Krishan\nGitHub'],
  ['Run cube control get pods.', 'Run kubectl get pods.', 'cube control = kubectl'],
  ['Cube-control is fine. cube   control too.', 'kubectl is fine. kubectl too.', 'cube control = kubectl'],
  ['kubectl is installed. New line. iphone works.', 'kubectl is installed.\niPhone works.', 'kubectl\niPhone'],
  ['The New York Times and New York.', 'The NYT and NY.', 'New York = NY\nNew York Times = NYT'],
  ['Sam said hi to Samantha.', 'Sam Smith said hi to Samantha.', 'Sam = Sam Smith'],
  ['Price is in $ (see c++ notes).', 'Price is in $ (see C++ notes).', '# a comment line\nC++'],
  ['postgres sequel is up, open ai too', 'PostgreSQL is up, OpenAI too', 'postgres sequel => PostgreSQL\nOpenAI'],
  ['nothing changes here', 'Nothing changes here', 'broken =\n= also broken\n\n'],
]);

test('each rule can be switched off', () => {
  const raw = 'um the the plan. New line. done';
  assert.equal(cleanTranscript(raw, { fillers: false }), 'Um the plan.\nDone');
  assert.equal(cleanTranscript(raw, { repeats: false }), 'The the plan.\nDone');
  assert.equal(cleanTranscript(raw, { commands: false }), 'The plan. New line. done');
});

test('a long transcript is cleaned quickly', () => {
  const raw = 'Um, the the meeting is at five. New line. Bullet point, bring notes. Scratch that. '.repeat(400);
  const t0 = performance.now();
  cleanTranscript(raw, { dictionary: parseDictionary('GitHub\ncube control = kubectl') });
  assert.ok(performance.now() - t0 < 500);
});
