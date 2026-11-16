# Private Dictation

A personal dictation web app for iPhone. You hold a button and speak; the words
appear as text and are copied to the clipboard, ready to paste into any app.

**Your voice never leaves the phone.** Speech is turned into text on the device
by [Whisper](https://github.com/openai/whisper), running in the browser through
[Transformers.js](https://huggingface.co/docs/transformers.js). The only
internet use is loading the app itself and, once, downloading the speech model.

## Using it

1. Open the page in Safari and tap **Download model and turn on microphone**
   (about 200 MB, once, so use Wi-Fi).
2. **Hold** the big button and speak, then let go. Or **tap** once to keep it
   listening and tap again to stop.
3. The text is copied automatically. Switch to any app and paste.

### Spoken commands

| Say | You get |
| --- | --- |
| "new line" | a line break |
| "new paragraph" | a blank line |
| "bullet point" | a new line starting with • |
| "scratch that" | the previous sentence is removed |

Filler sounds ("um", "uh") and stuttered short words ("the the") are removed.
In **Settings → Personal dictionary** you can list names and technical words:

```
GitHub
cube control = kubectl
```

A plain line means "always spell it like this". `heard = written` means "when
the app writes the left side, replace it with the right side".

All of this is fixed rules, not AI, and can be switched off in Settings.

## How it is built

There is no build step. The files in this folder *are* the app.

| File | What it does |
| --- | --- |
| `index.html`, `css/style.css` | The screen |
| `js/app.js` | Connects the button, microphone, model, clean-up and clipboard |
| `js/recorder.js`, `js/pcm-worklet.js` | Microphone capture |
| `js/resample.js` | Converts audio to the 16 kHz that Whisper expects |
| `js/worker.js`, `js/engine.js` | Runs Whisper in the background (WebGPU, or WASM as a fallback) |
| `js/models.js` | Which models are offered, and their sizes |
| `js/cleanup.js` | Spoken commands, filler removal, personal dictionary |
| `sw.js` | Offline support, and a guard that blocks every other network request |
| `test.html`, `js/accuracy-test.js`, `js/test-script.js`, `js/wer.js` | The accuracy test (word error rate for each model) |
| `vendor/` | Transformers.js and its engine files, kept locally |
| `tests/` | Automated checks for the rules and the maths |

### Privacy, concretely

- No analytics, no accounts, no server. The site is static files.
- Third-party code is stored in `vendor/`, so nothing is loaded from a CDN.
- The page's Content-Security-Policy and the service worker both refuse any
  connection except to this site and to `huggingface.co` (model download), and
  refuse anything that sends data.
- Your dictionary, settings and test recordings are stored only in the browser
  on your phone. They are not in this repository.
- To check for yourself: turn on Airplane Mode. Dictation still works.

## Running the checks

```bash
npm test
```

No packages need installing; it uses Node's built-in test runner.

## Hosting

The app is served by GitHub Pages from the `main` branch (repository
**Settings → Pages → Deploy from a branch → main → / (root)**). HTTPS is
required for the microphone, and GitHub Pages provides it.
