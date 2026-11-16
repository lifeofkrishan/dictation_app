// The 20 sentences for the accuracy test, and the rule that turns the scores
// into a suggestion. Kept separate from the page so it can be tested.

// Sentences 1-16 are everyday dictation. 17-20 are stand-ins for personal
// jargon: replace them on the test page with words you really use.
// They avoid digits, symbols and words spelled differently in British and
// American English, so that a "mistake" is always a real mis-hearing.
export const DEFAULT_SENTENCES = [
  'Thanks for getting back to me so quickly, I really appreciate it.',
  'Can we move our meeting to Thursday afternoon instead of Wednesday morning?',
  "I'll be about ten minutes late because the traffic is terrible today.",
  'Please remind me to call the dentist and book an appointment for next week.',
  'The quarterly report is nearly finished, but I still need to check the figures.',
  "Could you send me the address of the restaurant where we're having dinner?",
  'I think we should wait until the weather improves before we go hiking.',
  'She said the package would arrive on Friday, although it might be delayed.',
  "Don't forget to buy milk, eggs, butter, and a loaf of brown bread.",
  'My flight leaves at half past six, so I need to be at the airport by four.',
  'The children enjoyed the museum, especially the dinosaur exhibition upstairs.',
  "Honestly, I wasn't sure whether to accept the offer or keep looking.",
  "Let's schedule a quick call tomorrow to go through the budget together.",
  'He said sorry for the confusion and promised to fix the problem by Monday.',
  'We need three volunteers to help tidy up the park this weekend.',
  "If you have any questions, just send me a message and I'll reply tonight.",
  'I pushed the latest changes to GitHub and the page rebuilt automatically.',
  'The app runs Whisper on WebGPU and falls back to WebAssembly when it has to.',
  'I assigned the shortcut to the Action Button on my iPhone.',
  'The service worker caches the model, so transcription works offline.',
];

const percent = (rate) => (rate * 100).toFixed(1) + '%';

/**
 * A rule of thumb for which model to make the default.
 * `base` and `small` are result objects from the test page (or undefined).
 * @returns {{pick: 'base'|'small'|null, reason: string}}
 */
export function recommend(base, small) {
  const done = (r) => r && r.status === 'done';
  if (!done(base) && !done(small)) return { pick: null, reason: 'Run the test first.' };
  if (!done(base)) return { pick: null, reason: 'Whisper base has no result yet, so there is nothing to compare against.' };
  if (!small) return { pick: 'base', reason: 'Only Whisper base was tested.' };
  if (small.status === 'crashed') {
    return { pick: 'base', reason: 'Whisper small made the page restart on this phone (most likely it ran out of memory), so it cannot be relied on. Use Whisper base.' };
  }
  if (small.status !== 'done') return { pick: 'base', reason: `Whisper small failed on this phone (${small.error || 'unknown error'}). Use Whisper base.` };

  const fewer = base.clean.errors - small.clean.errors;
  const gap = base.clean.rate - small.clean.rate;
  const numbers = `Base got ${base.clean.errors} of ${base.clean.words} words wrong (${percent(base.clean.rate)}) at ${base.speed.toFixed(1)}x real time; small got ${small.clean.errors} wrong (${percent(small.clean.rate)}) at ${small.speed.toFixed(1)}x.`;
  // With ~250 words, a difference of one or two words is luck, not skill.
  const clearlyBetter = fewer >= 3 && gap >= 0.015;
  if (!clearlyBetter) {
    return { pick: 'base', reason: `${numbers} That difference is too small to matter on a test this size, so the faster, lighter model wins: use Whisper base.` };
  }
  if (small.speed >= 3) {
    return { pick: 'small', reason: `${numbers} Small is clearly more accurate and still fast enough (a ten-second dictation takes about ${(10 / small.speed).toFixed(1)} s): use Whisper small.` };
  }
  if (gap >= 0.05) {
    return { pick: 'small', reason: `${numbers} Small is much more accurate but slow on this phone (a ten-second dictation takes about ${(10 / small.speed).toFixed(1)} s). Accuracy wins here, but it is a judgement call.` };
  }
  return { pick: 'base', reason: `${numbers} Small is more accurate but too slow on this phone to be pleasant (a ten-second dictation takes about ${(10 / small.speed).toFixed(1)} s): use Whisper base.` };
}
