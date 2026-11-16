// The screen: wires the button, the microphone, the transcription engine,
// the clean-up rules and the clipboard together.

import { Mic } from './recorder.js';
import { Engine } from './engine.js';
import { MODELS, DEFAULT_MODEL } from './models.js';
import { cleanTranscript, parseDictionary } from './cleanup.js';

const VERSION = self.APP_VERSION || 'dev';
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search); // e.g. ?device=wasm for troubleshooting

const TAP_MS = 350; // shorter than this = a tap (keeps recording), longer = a hold
const MAX_SECONDS = 300; // safety limit for one recording
const SILENCE_PEAK = 0.004;

// ------------------------------------------------------------------ settings
const SETTINGS_KEY = 'dictation.settings.v1';
const DICTIONARY_KEY = 'dictation.dictionary.v1';
const DEFAULTS = {
  model: DEFAULT_MODEL,
  setupDone: false,
  micGranted: false,
  keepMicReady: true,
  rawAudio: true,
  captureMethod: 'auto',
  commands: true,
  fillers: true,
  repeats: true,
  append: false,
};

function readStored(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function writeStored(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private browsing: settings simply are not remembered */
  }
}
let settings = { ...DEFAULTS };
try {
  settings = { ...DEFAULTS, ...JSON.parse(readStored(SETTINGS_KEY, '{}')) };
} catch {
  /* keep defaults */
}
if (!MODELS[settings.model]) settings.model = DEFAULT_MODEL;
const saveSettings = () => writeStored(SETTINGS_KEY, JSON.stringify(settings));
let dictionary = parseDictionary(readStored(DICTIONARY_KEY, ''));

// ------------------------------------------------------------------ diagnostics log
const log = { errors: [], clipboard: [], csp: [], lastRun: null, events: [] };
const remember = (list, entry, max = 8) => {
  list.push(entry);
  if (list.length > max) list.shift();
};
const describeError = (error) => `${error?.name || 'Error'}: ${error?.message || error}`;
window.addEventListener('error', (event) => remember(log.errors, `${event.message} @ ${String(event.filename).split('/').pop()}:${event.lineno}`));
window.addEventListener('unhandledrejection', (event) => remember(log.errors, 'unhandled: ' + describeError(event.reason)));
document.addEventListener('securitypolicyviolation', (event) => remember(log.csp, `${event.violatedDirective} blocked ${event.blockedURI}`));

// ------------------------------------------------------------------ elements
const el = {
  body: document.body,
  text: $('text'),
  note: $('note'),
  talk: $('talk'),
  talkLabel: $('talkLabel'),
  talkHint: $('talkHint'),
  pill: $('engineStatus'),
  progress: $('progress'),
  progressFill: $('progressFill'),
  progressText: $('progressText'),
  setup: $('setup'),
  settings: $('settings'),
};

function note(message, kind = '') {
  el.note.textContent = message;
  el.note.dataset.kind = kind;
}

// ------------------------------------------------------------------ engine (Whisper)
const megabytes = (bytes) => `${Math.round(bytes / 1e6)} MB`;

const engine = new Engine((status) => {
  renderEngine(status);
  if (status.state === 'ready' || status.state === 'error') renderEngineFacts();
});

function renderEngine(status) {
  el.pill.dataset.state = status.state;
  const loading = status.state === 'loading';
  el.progress.hidden = !loading;
  if (loading) {
    const percent = Math.round((status.progress || 0) * 100);
    el.progressFill.style.width = percent + '%';
    if (status.stage === 'warmup') {
      el.pill.textContent = 'Preparing…';
      el.progressText.textContent = 'Getting the model ready…';
    } else {
      el.pill.textContent = `Loading ${percent}%`;
      el.progressText.textContent = status.totalBytes
        ? `Loading speech model: ${megabytes(status.loadedBytes)} of ${megabytes(status.totalBytes)}. Only the first time uses the internet.`
        : 'Loading speech model…';
    }
  } else if (status.state === 'ready') {
    el.pill.textContent = status.device === 'webgpu' ? 'Ready · WebGPU' : 'Ready · WASM (slower)';
  } else if (status.state === 'error') {
    el.pill.textContent = 'Model failed';
    note('The speech model could not be loaded. Open Settings → Troubleshooting for details.', 'error');
    remember(log.errors, 'engine: ' + status.error);
  } else {
    el.pill.textContent = 'Not set up';
  }
}

function startEngine() {
  const options = {};
  if (params.get('device') === 'wasm' || params.get('device') === 'webgpu') options.device = params.get('device');
  if (params.get('encoder')) options.encoder = params.get('encoder');
  engine.load(settings.model, options).catch(() => {});
}

// ------------------------------------------------------------------ microphone
let levelFrame = 0;
let pendingLevel = 0;
const mic = new Mic({
  onChange: () => renderTalk(),
  onLevel: (peak) => {
    pendingLevel = Math.max(pendingLevel, peak);
    if (!levelFrame) {
      levelFrame = requestAnimationFrame(() => {
        levelFrame = 0;
        el.talk.style.setProperty('--level', Math.min(1, Math.sqrt(pendingLevel) * 1.6).toFixed(3));
        pendingLevel = 0;
      });
    }
  },
});
function applyMicOptions() {
  mic.options.rawAudio = settings.rawAudio;
  mic.options.method = settings.captureMethod;
}
applyMicOptions();

function explainMicError(error) {
  remember(log.errors, 'mic: ' + describeError(error));
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    settings.micGranted = false;
    saveSettings();
    return 'Microphone access was refused. On iPhone: Settings → Apps → Safari → Microphone → Allow, then reopen this page.';
  }
  if (error?.name === 'NotFoundError') return 'No microphone was found.';
  if (error?.name === 'NotReadableError') return 'The microphone is busy in another app. Close it and try again.';
  return 'Could not start the microphone: ' + (error?.message || error);
}

function armQuietly() {
  if (!settings.setupDone || !settings.keepMicReady || !settings.micGranted || document.hidden) return;
  mic.arm().catch((error) => note(explainMicError(error), 'error'));
}

// ------------------------------------------------------------------ recording flow
let phase = 'idle'; // idle | starting | recording | locked | busy
let downAt = 0;
let pendingRelease = null; // what the finger did while the mic was still starting
let stopOnRelease = false;
let recordStartedAt = 0;
let timer = 0;
let wakeLock = null;
let lastRecording = null;
let copyAttempt = null; // { job, results: Promise<boolean>[] }

function setPhase(next) {
  phase = next;
  renderTalk();
}

function renderTalk() {
  el.body.dataset.phase = phase;
  const labels = {
    idle: ['Hold to talk', 'Hold and speak, then let go. Or tap once to keep it on.'],
    starting: ['Starting microphone…', 'Wait for the button to turn red.'],
    recording: ['Listening…', 'Let go when you are done.'],
    locked: ['Listening…', 'Tap the button to stop.'],
    busy: ['Transcribing…', ''],
  };
  if (phase !== 'recording' && phase !== 'locked') el.talkLabel.textContent = labels[phase][0];
  el.talkHint.textContent = labels[phase][1];
  el.talk.setAttribute('aria-label', phase === 'locked' ? 'Stop' : 'Hold to talk');
  if (phase !== 'recording' && phase !== 'locked') el.talk.style.setProperty('--level', '0');
}

function startTimer() {
  const tick = () => {
    const seconds = Math.floor((performance.now() - recordStartedAt) / 1000);
    el.talkLabel.textContent = `Listening… ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    if (seconds >= MAX_SECONDS) finish(false);
  };
  tick();
  timer = setInterval(tick, 250);
  navigator.wakeLock?.request('screen').then((lock) => (wakeLock = lock)).catch(() => {});
}
function stopTimer() {
  clearInterval(timer);
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

async function begin() {
  const wasLive = mic.state === 'ready';
  pendingRelease = null;
  stopOnRelease = false;
  downAt = performance.now();
  setPhase('starting');
  note('');
  try {
    await mic.start();
  } catch (error) {
    setPhase('idle');
    note(explainMicError(error), 'error');
    return;
  }
  if (!settings.micGranted) {
    settings.micGranted = true;
    saveSettings();
  }
  const waited = performance.now() - downAt;
  if (pendingRelease) {
    // The finger came up before the microphone was ready.
    const sawPermissionPrompt = !wasLive && waited > 1200;
    if (pendingRelease === 'tap' && !sawPermissionPrompt) {
      recordStartedAt = performance.now();
      setPhase('locked');
      startTimer();
      return;
    }
    await mic.stop();
    if (!settings.keepMicReady) mic.disarm();
    setPhase('idle');
    note(sawPermissionPrompt ? 'Microphone is ready. Hold the button to talk.' : 'The microphone was not ready yet. Try again.', 'warn');
    return;
  }
  recordStartedAt = performance.now();
  setPhase('recording');
  startTimer();
}

class Quiet extends Error {} // an expected outcome with a friendly message, not a fault

function joinText(existing, addition) {
  const before = existing.replace(/[ \t]+$/, '');
  if (!before.trim()) return addition;
  if (before.endsWith('\n')) return before + addition;
  return before + (addition.startsWith('• ') ? '\n' : ' ') + addition;
}

function cleanupOptions() {
  return { commands: settings.commands, fillers: settings.fillers, repeats: settings.repeats, dictionary };
}

/**
 * Safari only allows copying to the clipboard as a direct result of a tap.
 * Transcription finishes a moment AFTER the tap, so the copy is requested
 * immediately, with a promise for the text that will arrive.
 */
function requestCopy(job) {
  const textReady = job.then((text) => new Blob([text], { type: 'text/plain' }));
  textReady.catch(() => {});
  try {
    if (navigator.clipboard?.write && window.ClipboardItem) {
      return navigator.clipboard.write([new ClipboardItem({ 'text/plain': textReady })]).then(
        () => true,
        (error) => {
          remember(log.clipboard, 'auto-copy refused: ' + describeError(error));
          return false;
        },
      );
    }
  } catch (error) {
    remember(log.clipboard, 'auto-copy unavailable: ' + describeError(error));
  }
  return job
    .then((text) => navigator.clipboard.writeText(text))
    .then(
      () => true,
      (error) => {
        remember(log.clipboard, 'late copy refused: ' + describeError(error));
        return false;
      },
    );
}

async function finish(fromTap) {
  if (phase !== 'recording' && phase !== 'locked') return;
  const wasLocked = phase === 'locked';
  setPhase('busy');
  stopTimer();
  const run = { at: new Date().toISOString(), trigger: fromTap ? (wasLocked ? 'tap' : 'release') : 'automatic' };

  const job = (async () => {
    const recording = await mic.stop();
    if (!settings.keepMicReady || document.hidden) mic.disarm();
    if (!recording) throw new Quiet('Nothing was recorded.');
    lastRecording = recording;
    Object.assign(run, { audioSeconds: +recording.seconds.toFixed(2), capture: recording.method, peak: +recording.peak.toFixed(4) });
    if (recording.seconds < 0.4) throw new Quiet('That was too short. Hold the button while you speak.');
    if (recording.peak < SILENCE_PEAK) throw new Quiet('No sound was picked up. Check the microphone and try again.');
    if (recording.method === 'pcm' && recording.capturedSeconds < recording.wallSeconds * 0.85) {
      run.warning = `audio dropouts: captured ${recording.capturedSeconds.toFixed(1)}s of ${recording.wallSeconds.toFixed(1)}s`;
    }
    if (engine.status.state === 'loading') note('Waiting for the speech model to finish loading…');
    const { text: raw, ms } = await engine.transcribe(recording.samples);
    const cleaned = cleanTranscript(raw, cleanupOptions());
    Object.assign(run, { transcribeMs: ms, speed: +(recording.seconds / (ms / 1000)).toFixed(1), device: engine.status.device, model: engine.status.model, rawLength: raw.length });
    if (!cleaned) throw new Quiet('No words were recognised.');
    return settings.append ? joinText(el.text.value, cleaned) : cleaned;
  })();
  job.catch(() => {});

  copyAttempt = { job, results: [requestCopy(job)] };
  const attempt = copyAttempt;
  try {
    const finalText = await job;
    el.text.value = finalText;
    el.text.scrollTop = el.text.scrollHeight;
    const copied = (await Promise.all(attempt.results)).some(Boolean);
    run.copied = copied;
    remember(log.clipboard, `${run.trigger}: ${copied ? 'copied automatically' : 'needed the Copy button'}`);
    const speed = `${run.audioSeconds}s of speech in ${(run.transcribeMs / 1000).toFixed(1)}s`;
    note(copied ? `Copied. Paste it anywhere. (${speed})` : `Done. Tap Copy. (${speed})`, copied ? 'ok' : 'warn');
  } catch (error) {
    if (error instanceof Quiet) {
      note(error.message, 'warn');
      run.outcome = error.message;
    } else {
      note('Something went wrong: ' + (error?.message || error), 'error');
      run.outcome = describeError(error);
      remember(log.errors, 'transcribe: ' + describeError(error));
      if (engine.status.state === 'error') note('The speech model stopped working. Open Settings and tap “Reload model”.', 'error');
    }
  } finally {
    log.lastRun = run;
    if (copyAttempt === attempt) copyAttempt = null;
    setPhase('idle');
  }
}

// The button. Pointer events cover finger, mouse and pen alike.
el.talk.addEventListener('pointerdown', (event) => {
  if (event.button > 0) return;
  mic.resumeAudio();
  if (phase === 'idle') {
    try {
      el.talk.setPointerCapture(event.pointerId);
    } catch {
      /* not essential */
    }
    begin();
  } else if (phase === 'locked') {
    stopOnRelease = true;
  }
});
el.talk.addEventListener('pointerup', () => {
  mic.resumeAudio();
  const held = performance.now() - downAt;
  if (phase === 'starting') {
    pendingRelease = held < TAP_MS ? 'tap' : 'hold';
  } else if (phase === 'recording') {
    if (held < TAP_MS) setPhase('locked');
    else finish(true);
  } else if (phase === 'locked' && stopOnRelease) {
    stopOnRelease = false;
    finish(true);
  }
});
el.talk.addEventListener('pointercancel', () => {
  // iOS took the touch away (a system gesture, an alert, the permission prompt).
  if (phase === 'starting') pendingRelease = 'cancel';
  else if (phase === 'recording') finish(false);
});
// Safari counts "touchend" as the moment of the tap. If the copy request made
// a split second earlier was not accepted, this second request will be.
el.talk.addEventListener('touchend', () => {
  mic.resumeAudio();
  if (copyAttempt && phase === 'busy' && copyAttempt.results.length < 2) copyAttempt.results.push(requestCopy(copyAttempt.job));
});
el.talk.addEventListener('contextmenu', (event) => event.preventDefault());
// Keyboard (Space / Enter on a focused button): acts like a tap.
el.talk.addEventListener('click', (event) => {
  if (event.detail !== 0) return;
  if (phase === 'idle') {
    begin().then(() => {
      if (phase === 'recording') setPhase('locked');
    });
  } else if (phase === 'locked' || phase === 'recording') {
    finish(true);
  }
});

// Leaving the app: finish what is being said, then switch the microphone off.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (phase === 'recording' || phase === 'locked') finish(false);
    else if (phase === 'idle') mic.disarm();
  } else {
    armQuietly();
  }
});
window.addEventListener('pagehide', () => {
  if (phase === 'idle') mic.disarm();
});
// Any tap anywhere lets the browser un-pause audio if it had paused it.
document.addEventListener('pointerup', () => mic.resumeAudio(), true);

// ------------------------------------------------------------------ copy / share / clear
function legacyCopy() {
  try {
    el.text.focus();
    el.text.select();
    return document.execCommand('copy');
  } catch {
    return false;
  }
}
$('copy').addEventListener('click', async () => {
  const value = el.text.value;
  if (!value) return note('Nothing to copy yet.', 'warn');
  let ok = false;
  try {
    await navigator.clipboard.writeText(value);
    ok = true;
  } catch (error) {
    remember(log.clipboard, 'Copy button: ' + describeError(error));
    ok = legacyCopy();
  }
  note(ok ? 'Copied. Paste it anywhere.' : 'Could not copy. Select the text and copy it by hand.', ok ? 'ok' : 'error');
});
if (navigator.share) {
  $('share').hidden = false;
  $('share').addEventListener('click', () => {
    if (el.text.value) navigator.share({ text: el.text.value }).catch(() => {});
  });
}
$('clear').addEventListener('click', () => {
  el.text.value = '';
  note('');
});
$('append').checked = settings.append;
$('append').addEventListener('change', (event) => {
  settings.append = event.target.checked;
  saveSettings();
});

// ------------------------------------------------------------------ first-run setup
function renderSetup() {
  el.setup.hidden = settings.setupDone;
  el.talk.disabled = !settings.setupDone;
  $('setupSize').textContent = 'about 200 MB';
}
$('setupButton').addEventListener('click', async () => {
  settings.setupDone = true;
  saveSettings();
  renderSetup();
  startEngine();
  navigator.storage?.persist?.().catch(() => {});
  try {
    await mic.arm();
    settings.micGranted = true;
    saveSettings();
    if (!settings.keepMicReady) mic.disarm();
  } catch (error) {
    note(explainMicError(error), 'error');
  }
});

// ------------------------------------------------------------------ settings sheet
function renderModelChoices() {
  const box = $('modelChoices');
  box.textContent = '';
  for (const [key, model] of Object.entries(MODELS)) {
    const label = document.createElement('label');
    label.className = 'choice';
    const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'model', value: key, checked: key === settings.model });
    input.addEventListener('change', () => {
      settings.model = key;
      saveSettings();
      if (settings.setupDone) startEngine();
    });
    const words = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = model.label;
    const detail = document.createElement('span');
    detail.textContent = `${model.blurb} Download: about ${model.webgpu.megabytes} MB.`;
    words.append(title, detail);
    label.append(input, words);
    box.append(label);
  }
}
function renderEngineFacts() {
  const s = engine.status;
  const facts = $('engineFacts');
  if (s.state === 'ready') {
    facts.textContent =
      `${MODELS[s.model].label} is running on ${s.device === 'webgpu' ? 'WebGPU (fast path)' : 'WASM (slower fallback)'}. ` +
      `Loaded in ${((s.loadMs + s.warmupMs) / 1000).toFixed(1)} s.` +
      (s.notes?.length ? ' Note: ' + s.notes.join('; ') : '');
  } else if (s.state === 'error') {
    facts.textContent = 'Loading failed: ' + s.error;
  } else {
    facts.textContent = s.state === 'loading' ? 'Loading…' : '';
  }
}
$('reloadModel').addEventListener('click', () => {
  if (!settings.setupDone) return;
  note('');
  startEngine();
});

function bindCheckbox(id, key, after) {
  const box = $(id);
  box.checked = settings[key];
  box.addEventListener('change', () => {
    settings[key] = box.checked;
    saveSettings();
    after?.();
  });
}
bindCheckbox('optCommands', 'commands');
bindCheckbox('optFillers', 'fillers');
bindCheckbox('optRepeats', 'repeats');
const rearm = () => {
  applyMicOptions();
  if (phase !== 'idle') return;
  mic.disarm();
  armQuietly();
};
bindCheckbox('optKeepReady', 'keepMicReady', rearm);
bindCheckbox('optRaw', 'rawAudio', rearm);
$('optMethod').value = settings.captureMethod;
$('optMethod').addEventListener('change', (event) => {
  settings.captureMethod = event.target.value;
  saveSettings();
  rearm();
});

const dictionaryBox = $('dictionary');
dictionaryBox.value = readStored(DICTIONARY_KEY, '');
function renderDictionaryStatus() {
  $('dictionaryStatus').textContent = dictionary.length ? `${dictionary.length} ${dictionary.length === 1 ? 'entry' : 'entries'} in use. Saved on this device only.` : 'No entries yet.';
}
dictionaryBox.addEventListener('input', () => {
  writeStored(DICTIONARY_KEY, dictionaryBox.value);
  dictionary = parseDictionary(dictionaryBox.value);
  renderDictionaryStatus();
});

// Hear exactly what the model was given: the quickest way to spot audio trouble.
$('playLast').addEventListener('click', async () => {
  if (!lastRecording) return note('Record something first.', 'warn');
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioContextClass();
  const input = lastRecording.samples;
  const factor = 3; // 16,000 -> 48,000 so every browser can play it
  const buffer = ctx.createBuffer(1, input.length * factor, 16000 * factor);
  const out = buffer.getChannelData(0);
  for (let i = 0; i < input.length; i++) {
    const next = input[Math.min(i + 1, input.length - 1)];
    for (let k = 0; k < factor; k++) out[i * factor + k] = input[i] + ((next - input[i]) * k) / factor;
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.onended = () => ctx.close().catch(() => {});
  await ctx.resume().catch(() => {});
  source.start();
});

// ------------------------------------------------------------------ diagnostics
async function collectDiagnostics() {
  const lines = [];
  const add = (label, value) => lines.push(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  add('app version', VERSION);
  add('opened as', standalone ? 'Home Screen app' : 'browser tab');
  add('browser', navigator.userAgent);
  add('secure page (https)', window.isSecureContext);
  add('WebGPU in this browser', 'gpu' in navigator);
  let permission = 'unknown';
  try {
    permission = (await navigator.permissions.query({ name: 'microphone' })).state;
  } catch {
    permission = 'cannot be queried';
  }
  add('microphone permission', permission);
  add('microphone state', mic.state);
  add('microphone details', mic.info);
  const e = engine.status;
  add('model', e.state === 'ready' ? { model: e.modelId, device: e.device, dtype: e.dtype, loadMs: e.loadMs, warmupMs: e.warmupMs, gpu: e.gpu, notes: e.notes } : { state: e.state, error: e.error, progress: e.progress });
  add('last dictation', log.lastRun);
  add('clipboard log', log.clipboard);
  try {
    const estimate = await navigator.storage.estimate();
    add('storage', { usedMB: Math.round(estimate.usage / 1e6), quotaMB: Math.round(estimate.quota / 1e6), protectedFromCleanup: await navigator.storage.persisted() });
  } catch {
    add('storage', 'cannot be read');
  }
  add('offline support (service worker)', navigator.serviceWorker?.controller ? 'active' : 'not active yet');
  add('settings', { ...settings, dictionaryEntries: dictionary.length });
  add('blocked connections', log.csp);
  add('errors', log.errors);
  return lines.join('\n');
}
async function renderDiagnostics() {
  $('diagnostics').textContent = await collectDiagnostics();
}
$('refreshDiagnostics').addEventListener('click', renderDiagnostics);
$('copyDiagnostics').addEventListener('click', async () => {
  const report = await collectDiagnostics();
  $('diagnostics').textContent = report;
  try {
    await navigator.clipboard.writeText(report);
    $('copyDiagnostics').textContent = 'Copied';
  } catch {
    $('copyDiagnostics').textContent = 'Select the text below';
  }
  setTimeout(() => ($('copyDiagnostics').textContent = 'Copy diagnostics'), 2000);
});

$('updateApp').addEventListener('click', async () => {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    await registration?.update();
    for (const name of await caches.keys()) if (name.startsWith('shell-')) await caches.delete(name);
  } catch {
    /* reload regardless */
  }
  location.reload();
});
$('deleteModels').addEventListener('click', async () => {
  if (!confirm('Delete the downloaded speech models from this device? They will be downloaded again next time.')) return;
  engine.dispose();
  try {
    await caches.delete('transformers-cache');
  } catch {
    /* nothing to delete */
  }
  settings.setupDone = false;
  saveSettings();
  location.reload();
});

$('openSettings').addEventListener('click', () => {
  renderEngineFacts();
  renderDiagnostics();
  el.settings.showModal();
});
$('version').textContent = VERSION;

// ------------------------------------------------------------------ start
renderModelChoices();
renderDictionaryStatus();
renderSetup();
renderTalk();
renderEngine(engine.status);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((error) => remember(log.errors, 'service worker: ' + describeError(error)));
}
if (settings.setupDone) {
  startEngine();
  armQuietly();
}

// For the automated tests only.
window.__dictation = { engine, mic, settings, log, collectDiagnostics };
