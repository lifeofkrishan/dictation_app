// The accuracy-test page. Record each sentence once, then let every model
// transcribe the same recordings so the comparison is fair.
//
// Everything survives a page restart: recordings are kept in the browser's
// on-device database and results are saved after every model. That matters
// because the most likely failure is the large model running out of memory,
// which on an iPhone simply reloads the page.

import { Mic } from './recorder.js';
import { Engine } from './engine.js';
import { MODELS } from './models.js';
import { cleanTranscript, parseDictionary } from './cleanup.js';
import { wordErrors, totalWordErrors } from './wer.js';
import { DEFAULT_SENTENCES, recommend } from './test-script.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SENTENCES_KEY = 'dictation.test.sentences.v1';
const RESULTS_KEY = 'dictation.test.results.v1';
const RUNNING_KEY = 'dictation.test.running.v1';

const readJson = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (key, value) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: results just are not remembered */
  }
};

// ---------------------------------------------------------------- recordings database
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('dictation-test', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('clips');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function withStore(mode, action) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('clips', mode);
      const request = action(tx.objectStore('clips'));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
const saveClip = (index, clip) => withStore('readwrite', (store) => store.put(clip, index));
const loadClip = (index) => withStore('readonly', (store) => store.get(index));
const clearClips = () => withStore('readwrite', (store) => store.clear());
async function loadAllClips() {
  const [keys, values] = await Promise.all([withStore('readonly', (s) => s.getAllKeys()), withStore('readonly', (s) => s.getAll())]);
  return new Map(keys.map((key, i) => [key, values[i]]));
}

// ---------------------------------------------------------------- state
let sentences = readJson(SENTENCES_KEY, null) || DEFAULT_SENTENCES;
let results = readJson(RESULTS_KEY, {});
let clips = new Map(); // index -> { text, samples, seconds }
let current = 0;
let busy = false;

const settings = readJson('dictation.settings.v1', {});
const dictionaryText = (() => {
  try {
    return localStorage.getItem('dictation.dictionary.v1') || '';
  } catch {
    return '';
  }
})();
const dictionary = parseDictionary(dictionaryText);

const mic = new Mic({});
mic.options.rawAudio = settings.rawAudio ?? true;
mic.options.method = settings.captureMethod ?? 'auto';

const isRecorded = (index) => clips.has(index) && clips.get(index).text === sentences[index];
const recordedCount = () => sentences.filter((_, i) => isRecorded(i)).length;

// A model that was running when the page last died never got to save a result.
const interrupted = readJson(RUNNING_KEY, null);
if (interrupted) {
  results[interrupted.model] = { status: 'crashed', stage: interrupted.stage, at: interrupted.at };
  writeJson(RESULTS_KEY, results);
  writeJson(RUNNING_KEY, null);
  $('crashNotice').hidden = false;
  $('crashNotice').textContent = `The page restarted while testing ${MODELS[interrupted.model]?.label || interrupted.model} (${interrupted.stage}). That usually means the phone ran out of memory. Your recordings are safe; the result has been marked as a crash.`;
}

// ---------------------------------------------------------------- step 1: recording
function renderRecorder() {
  const total = sentences.length;
  $('recordProgress').textContent = `Sentence ${current + 1} of ${total} · ${recordedCount()} recorded`;
  $('sentence').textContent = sentences[current];
  const recording = mic.state === 'recording';
  $('record').textContent = recording ? 'Stop' : isRecorded(current) ? 'Record again' : 'Record';
  $('record').classList.toggle('danger', recording);
  $('play').disabled = !isRecorded(current) || recording;
  $('prev').disabled = current === 0 || recording;
  $('next').disabled = current === total - 1 || recording;
  $('next').textContent = isRecorded(current) ? 'Next' : 'Skip';
  $('run').disabled = busy || recording || recordedCount() === 0;
  $('record').disabled = busy;
}
const recordNote = (message, kind = '') => {
  $('recordNote').textContent = message;
  $('recordNote').dataset.kind = kind;
};

$('record').addEventListener('click', async () => {
  mic.resumeAudio();
  if (mic.state !== 'recording') {
    try {
      recordNote('Starting microphone…');
      await mic.start();
      recordNote('Recording. Read the sentence, then tap Stop.');
    } catch (error) {
      recordNote('Could not start the microphone: ' + (error?.message || error), 'error');
    }
    renderRecorder();
    return;
  }
  const recording = await mic.stop();
  mic.disarm();
  if (!recording || recording.seconds < 0.6 || recording.peak < 0.004) {
    recordNote('That did not pick up any speech. Try again.', 'warn');
    renderRecorder();
    return;
  }
  const clip = { text: sentences[current], samples: recording.samples, seconds: recording.seconds, method: recording.method };
  clips.set(current, clip);
  try {
    await saveClip(current, clip);
  } catch (error) {
    recordNote('Recorded, but it could not be saved to the device: ' + (error?.message || error), 'warn');
  }
  const nextMissing = sentences.findIndex((_, i) => i > current && !isRecorded(i));
  if (nextMissing !== -1) {
    current = nextMissing;
    recordNote(`Saved (${recording.seconds.toFixed(1)} s). Next sentence.`, 'ok');
  } else if (recordedCount() === sentences.length) {
    recordNote('All sentences recorded. Now run the comparison below.', 'ok');
  } else {
    recordNote(`Saved (${recording.seconds.toFixed(1)} s).`, 'ok');
  }
  renderRecorder();
});
$('prev').addEventListener('click', () => {
  current = Math.max(0, current - 1);
  renderRecorder();
});
$('next').addEventListener('click', () => {
  current = Math.min(sentences.length - 1, current + 1);
  renderRecorder();
});
$('play').addEventListener('click', async () => {
  const clip = clips.get(current);
  if (!clip) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioContextClass();
  const factor = 3;
  const buffer = ctx.createBuffer(1, clip.samples.length * factor, 16000 * factor);
  const out = buffer.getChannelData(0);
  for (let i = 0; i < clip.samples.length; i++) for (let k = 0; k < factor; k++) out[i * factor + k] = clip.samples[i];
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.onended = () => ctx.close().catch(() => {});
  await ctx.resume().catch(() => {});
  source.start();
});

$('sentenceEditor').value = sentences.join('\n');
$('saveSentences').addEventListener('click', () => {
  const lines = $('sentenceEditor').value.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return;
  sentences = lines;
  writeJson(SENTENCES_KEY, sentences);
  current = Math.min(current, sentences.length - 1);
  recordNote(`Saved ${sentences.length} sentences. Any sentence you changed needs recording again.`, 'ok');
  renderRecorder();
});
$('resetSentences').addEventListener('click', () => {
  sentences = DEFAULT_SENTENCES;
  writeJson(SENTENCES_KEY, null);
  $('sentenceEditor').value = sentences.join('\n');
  current = 0;
  renderRecorder();
});

// ---------------------------------------------------------------- step 2: running
const runNote = (message, kind = '') => {
  $('runNote').textContent = message;
  $('runNote').dataset.kind = kind;
};
const setRunProgress = (fraction) => {
  $('runProgress').hidden = fraction === null;
  if (fraction !== null) $('runFill').style.width = Math.round(fraction * 100) + '%';
};
const punctuationCount = (text) => (text.match(/[,.;:?!]/g) || []).length;

async function testModel(key, indexes) {
  const label = MODELS[key].label;
  const mark = (stage) => writeJson(RUNNING_KEY, { model: key, stage, at: new Date().toISOString() });
  mark('loading the model');
  const engine = new Engine((status) => {
    if (status.state !== 'loading') return;
    setRunProgress(status.progress || 0);
    runNote(status.stage === 'warmup' ? `${label}: preparing…` : `${label}: loading ${Math.round((status.progress || 0) * 100)}%`);
  });
  try {
    const options = {};
    if (params.get('device')) options.device = params.get('device');
    if (params.get('encoder')) options.encoder = params.get('encoder');
    const facts = await engine.load(key, options);
    const rows = [];
    let transcribeMs = 0;
    let audioSeconds = 0;
    for (let n = 0; n < indexes.length; n++) {
      const index = indexes[n];
      const clip = clips.get(index);
      mark(`sentence ${n + 1} of ${indexes.length}`);
      setRunProgress(n / indexes.length);
      runNote(`${label}: sentence ${n + 1} of ${indexes.length}`);
      const { text, ms } = await engine.transcribe(clip.samples);
      const cleaned = cleanTranscript(text, { dictionary });
      transcribeMs += ms;
      audioSeconds += clip.seconds;
      rows.push({ index, reference: clip.text, raw: text.trim(), cleaned, ms, seconds: +clip.seconds.toFixed(2), rawScore: wordErrors(clip.text, text), cleanScore: wordErrors(clip.text, cleaned) });
    }
    return {
      status: 'done',
      at: new Date().toISOString(),
      device: facts.device,
      dtype: facts.dtype,
      gpu: facts.gpu,
      notes: facts.notes,
      loadMs: facts.loadMs + facts.warmupMs,
      audioSeconds: +audioSeconds.toFixed(1),
      transcribeMs,
      speed: audioSeconds / (transcribeMs / 1000),
      raw: totalWordErrors(rows.map((r) => r.rawScore)),
      clean: totalWordErrors(rows.map((r) => r.cleanScore)),
      punctuation: { produced: rows.reduce((sum, r) => sum + punctuationCount(r.raw), 0), inScript: rows.reduce((sum, r) => sum + punctuationCount(r.reference), 0) },
      rows,
    };
  } catch (error) {
    return { status: 'failed', at: new Date().toISOString(), error: String(error?.message || error) };
  } finally {
    engine.dispose();
    writeJson(RUNNING_KEY, null);
  }
}

$('run').addEventListener('click', async () => {
  const chosen = [$('runBase').checked && 'base', $('runSmall').checked && 'small'].filter(Boolean);
  const indexes = sentences.map((_, i) => i).filter(isRecorded);
  if (!chosen.length || !indexes.length) return;
  busy = true;
  renderRecorder();
  mic.disarm();
  let lock = null;
  try {
    lock = await navigator.wakeLock?.request('screen');
  } catch {
    /* the screen may dim; the test still runs */
  }
  for (const key of chosen) {
    results[key] = await testModel(key, indexes);
    writeJson(RESULTS_KEY, results);
    renderResults();
    await new Promise((resolve) => setTimeout(resolve, 500)); // let memory settle before the next model
  }
  lock?.release().catch(() => {});
  setRunProgress(null);
  runNote('Finished. Results are below.', 'ok');
  busy = false;
  renderRecorder();
});

$('eraseAll').addEventListener('click', async () => {
  if (!confirm('Erase all test recordings and results from this device?')) return;
  await clearClips().catch(() => {});
  clips = new Map();
  results = {};
  writeJson(RESULTS_KEY, null);
  current = 0;
  renderRecorder();
  renderResults();
  runNote('');
});

// ---------------------------------------------------------------- step 3: results
const pct = (rate) => (rate * 100).toFixed(1) + '%';
function make(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function renderResults() {
  const box = $('results');
  box.textContent = '';
  const keys = ['base', 'small'].filter((key) => results[key]);
  if (!keys.length) {
    box.append(make('p', 'Nothing yet.', 'small-print'));
    return;
  }
  const verdict = recommend(results.base, results.small);
  box.append(make('p', verdict.reason, 'verdict'));

  const wrap = make('div', undefined, 'table-wrap');
  const table = make('table');
  const head = make('tr');
  for (const [title, cls] of [['Model', ''], ['Words wrong', 'num'], ['Error rate', 'num'], ['Speed', 'num'], ['Load', 'num'], ['Runs on', '']]) head.append(make('th', title, cls));
  table.append(head);
  for (const key of keys) {
    const r = results[key];
    const row = make('tr');
    row.append(make('td', MODELS[key].label));
    if (r.status === 'done') {
      row.append(make('td', `${r.clean.errors} / ${r.clean.words}`, 'num'), make('td', pct(r.clean.rate), 'num'), make('td', r.speed.toFixed(1) + 'x', 'num'), make('td', (r.loadMs / 1000).toFixed(1) + ' s', 'num'), make('td', r.device === 'webgpu' ? 'WebGPU' : 'WASM'));
    } else {
      const cell = make('td', r.status === 'crashed' ? `Page restarted while ${r.stage} (probably out of memory)` : `Failed: ${r.error}`, 'miss');
      cell.colSpan = 5;
      row.append(cell);
    }
    table.append(row);
  }
  wrap.append(table);
  box.append(wrap);
  box.append(make('p', 'Error rate = words wrong ÷ words in the script, after your clean-up rules and dictionary. Speed = seconds of speech handled per second (higher is faster). With about 250 words, a gap of one or two words is not meaningful.', 'small-print'));

  const done = keys.filter((key) => results[key].status === 'done');
  if (done.length) {
    const details = make('details');
    details.append(make('summary', 'Every sentence'));
    const list = make('div', undefined, 'per-sentence');
    const rowCount = Math.max(...done.map((key) => results[key].rows.length));
    for (let n = 0; n < rowCount; n++) {
      const item = make('div');
      const reference = results[done[0]].rows[n]?.reference ?? '';
      item.append(make('b', `${n + 1}. ${reference}`));
      for (const key of done) {
        const row = results[key].rows[n];
        if (!row) continue;
        const line = make('p', `${MODELS[key].label}: ${row.cleaned}  (${row.cleanScore.errors} wrong, ${(row.ms / 1000).toFixed(1)} s)`);
        if (row.cleanScore.errors) line.className = 'miss';
        item.append(line);
      }
      list.append(item);
    }
    details.append(list);
    box.append(details);
  }
}

async function environmentSummary() {
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  return { appVersion: self.APP_VERSION, openedAs: standalone ? 'Home Screen app' : 'browser tab', browser: navigator.userAgent, dictionaryEntries: dictionary.length, rawAudio: mic.options.rawAudio, captureMethod: mic.options.method };
}
$('copyResults').addEventListener('click', async () => {
  const compact = {};
  for (const [key, r] of Object.entries(results)) {
    compact[key] = r.status === 'done' ? { ...r, rows: r.rows.map((row) => ({ n: row.index + 1, said: row.reference, heard: row.raw, cleaned: row.cleaned, wrong: row.cleanScore.errors, ms: row.ms, seconds: row.seconds })) } : r;
  }
  const report = JSON.stringify({ suggestion: recommend(results.base, results.small), environment: await environmentSummary(), results: compact }, null, 1);
  try {
    await navigator.clipboard.writeText(report);
    $('copyResults').textContent = 'Copied';
  } catch {
    $('copyResults').textContent = 'Could not copy';
  }
  setTimeout(() => ($('copyResults').textContent = 'Copy results'), 2000);
});

// ---------------------------------------------------------------- start
document.addEventListener('visibilitychange', () => {
  if (document.hidden && mic.state !== 'recording') mic.disarm();
});
loadAllClips()
  .then((stored) => {
    clips = stored;
    const firstMissing = sentences.findIndex((_, i) => !isRecorded(i));
    current = firstMissing === -1 ? 0 : firstMissing;
  })
  .catch(() => recordNote('This browser cannot save recordings between visits; keep the page open until the test finishes.', 'warn'))
  .finally(() => {
    renderRecorder();
    renderResults();
  });

window.__test = { results: () => results, clips: () => clips, saveClip, setClips: (map) => (clips = map), renderRecorder };
