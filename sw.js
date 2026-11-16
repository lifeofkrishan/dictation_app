// Service worker: a small script the browser keeps installed for this site.
// It does two jobs.
//
// 1. OFFLINE. It keeps a copy of the app's own files on the device, so the
//    app works with no internet.
//
// 2. PRIVACY GUARD. Every network request the app makes passes through here.
//    Only two kinds are let through:
//      - reading this app's own files
//      - reading model files from huggingface.co (the one-time download)
//    Anything else, and anything that tries to SEND data, is refused.

importScripts('js/version.js');

const SHELL = `shell-${self.APP_VERSION}`;
const NETWORK_WAIT_MS = 2500;

// Small files that make up the app.
const APP_FILES = [
  './',
  'index.html',
  'test.html',
  'css/style.css',
  'js/version.js',
  'js/app.js',
  'js/accuracy-test.js',
  'js/test-script.js',
  'js/recorder.js',
  'js/pcm-worklet.js',
  'js/resample.js',
  'js/engine.js',
  'js/worker.js',
  'js/models.js',
  'js/guard.js',
  'js/cleanup.js',
  'js/wer.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];
// Large library files that never change for a given version. (The WebGPU
// engine build in vendor/ort-webgpu/ is only fetched if that engine is used.)
const LIBRARY_FILES = [
  'vendor/transformers/transformers.min.js',
  'vendor/ort/ort-wasm-simd-threaded.mjs',
  'vendor/ort/ort-wasm-simd-threaded.wasm',
];

const isModelHost = (host) => host === 'huggingface.co' || host.endsWith('.huggingface.co') || host.endsWith('.hf.co');

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // 'reload' = fetch a fresh copy, do not trust the browser's short-term cache.
      const fresh = APP_FILES.map(async (path) => {
        try {
          const response = await fetch(new Request(path, { cache: 'reload' }));
          if (response.ok) await cache.put(path, response);
        } catch {
          /* a missing optional file must not block installation */
        }
      });
      await Promise.all([...fresh, cache.addAll(LIBRARY_FILES)]);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('shell-') && name !== SHELL) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

async function fetchAndStore(cache, url) {
  const response = await fetch(url.href, { cache: 'no-cache' });
  if (response.ok) await cache.put(url.origin + url.pathname, response.clone());
  return response;
}

// Library files: the saved copy is always right, so use it without asking the network.
async function libraryFile(request, url) {
  const cache = await caches.open(SHELL);
  return (await cache.match(request, { ignoreSearch: true })) || fetchAndStore(cache, url).catch(() => Response.error());
}

// App files: ask the network first so updates arrive immediately; if there is
// no connection (or it is too slow), use the saved copy.
async function appFile(request, url) {
  const cache = await caches.open(SHELL);
  const saved = await cache.match(request, { ignoreSearch: true });
  const fromNetwork = fetchAndStore(cache, url);
  if (!saved) {
    try {
      return await fromNetwork;
    } catch {
      const page = request.mode === 'navigate' ? await cache.match('index.html') : null;
      return page || Response.error();
    }
  }
  const tooSlow = new Promise((resolve) => setTimeout(() => resolve(null), NETWORK_WAIT_MS));
  const fresh = await Promise.race([fromNetwork.then((response) => (response.ok ? response : null)).catch(() => null), tooSlow]);
  return fresh || saved;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    event.respondWith(Response.error()); // this app never sends data anywhere
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(url.pathname.includes('/vendor/') ? libraryFile(request, url) : appFile(request, url));
    return;
  }
  if (url.protocol === 'https:' && isModelHost(url.hostname)) {
    return; // model download: handled by the browser directly
  }
  event.respondWith(Response.error()); // any other website: refused
});
