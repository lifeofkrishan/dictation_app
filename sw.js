// Service worker: a small script the browser keeps installed for this site.
// It does two jobs.
//
// 1. OFFLINE. It keeps a copy of the app's own files on the device, so the
//    app opens instantly and works with no internet.
//
// 2. PRIVACY GUARD. Every network request the app makes passes through here.
//    Only two kinds are let through:
//      - reading this app's own files
//      - reading model files from huggingface.co (the one-time download)
//    Anything else, and anything that tries to SEND data, is refused.

importScripts('js/version.js');

const SHELL = `shell-${self.APP_VERSION}`;

// Small files that make up the app. Refreshed in the background on each visit.
const APP_FILES = [
  './',
  'index.html',
  'test.html',
  'css/style.css',
  'js/version.js',
  'js/app.js',
  'js/test.js',
  'js/recorder.js',
  'js/pcm-worklet.js',
  'js/resample.js',
  'js/engine.js',
  'js/worker.js',
  'js/models.js',
  'js/cleanup.js',
  'js/wer.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];
// Large library files that never change for a given version.
const LIBRARY_FILES = [
  'vendor/transformers/transformers.min.js',
  'vendor/ort/ort-wasm-simd-threaded.asyncify.mjs',
  'vendor/ort/ort-wasm-simd-threaded.asyncify.wasm',
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

async function fromCacheThenRefresh(request, url) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(request, { ignoreSearch: true });
  const isLibrary = url.pathname.includes('/vendor/');

  const refresh = async () => {
    const response = await fetch(url.href, { cache: 'no-cache' });
    if (response.ok) await cache.put(url.origin + url.pathname, response.clone());
    return response;
  };

  if (cached) {
    // Answer immediately from the device; update the copy quietly for next time.
    if (!isLibrary) refresh().catch(() => {});
    return cached;
  }
  try {
    return await refresh();
  } catch {
    if (request.mode === 'navigate') {
      const page = await cache.match('index.html');
      if (page) return page;
    }
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    event.respondWith(Response.error()); // this app never sends data anywhere
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(fromCacheThenRefresh(request, url));
    return;
  }
  if (url.protocol === 'https:' && isModelHost(url.hostname)) {
    return; // model download: handled by the browser directly
  }
  event.respondWith(Response.error()); // any other website: refused
});
