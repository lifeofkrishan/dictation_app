// Crash guard.
//
// When Safari runs out of memory (or hits one of its own bugs) it kills the
// page and reloads it. Left alone, the page would then do the same thing
// again and crash again, forever.
//
// To prevent that, the app leaves a short note in the browser's storage just
// before doing anything heavy ("loading Whisper base on the graphics engine")
// and removes the note when the work finishes. If the page starts up and finds
// a note still there, the previous attempt must have killed the page, so the
// app picks something safer instead of repeating it.

const NOTE_KEY = 'dictation.guard.v1';
const HISTORY_KEY = 'dictation.crashes.v1';

let current = null; // the note for work in progress right now

function read(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the guard simply does nothing */
  }
}

/** Call just before heavy work. `info` describes it, e.g. {activity, model, engine}. */
export function beginRisky(info) {
  const same = current && current.activity === info.activity && current.model === info.model && current.engine === info.engine;
  if (same) return;
  current = { ...info, at: new Date().toISOString() };
  if (!document.hidden) write(NOTE_KEY, current);
}

/** Call when the heavy work has finished (successfully or with an ordinary error). */
export function endRisky() {
  current = null;
  write(NOTE_KEY, null);
}

/**
 * Call once at startup. Returns the note left behind by a previous page that
 * died mid-work (and adds it to the crash history), or null if all was well.
 */
export function takeCrash() {
  const note = read(NOTE_KEY, null);
  if (!note) return null;
  write(NOTE_KEY, null);
  const history = read(HISTORY_KEY, []);
  history.push(note);
  write(HISTORY_KEY, history.slice(-10));
  return note;
}

export const crashHistory = () => read(HISTORY_KEY, []);
export const clearCrashHistory = () => write(HISTORY_KEY, null);

// iOS routinely discards pages that are in the background. That is not a
// crash, so the note only exists while the page is actually on screen.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) write(NOTE_KEY, null);
    else if (current) write(NOTE_KEY, current);
  });
  window.addEventListener('pagehide', () => write(NOTE_KEY, null));
  window.addEventListener('pageshow', () => {
    if (current && !document.hidden) write(NOTE_KEY, current);
  });
}
