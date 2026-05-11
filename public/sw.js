const CACHE_NAME = "projection-cue-player-v9";
const VOSK_CACHE_NAME = "projection-cue-player-vosk-v2";
const VOSK_MODEL_RELATIVE_PATH = "vosk/vosk-model-small-ja-0.22.tar.gz";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-192.svg",
  "./icons/icon-512.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME && key !== VOSK_CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname.includes("/vosk/") && url.searchParams.has("download")) {
    return;
  }

  if (url.pathname.includes("/vosk/")) {
    event.respondWith(
      (async () => {
        const voskCache = await caches.open(VOSK_CACHE_NAME);
        const scopedModelUrl = new URL(VOSK_MODEL_RELATIVE_PATH, self.registration.scope).href;
        const rootModelUrl = new URL(`/${VOSK_MODEL_RELATIVE_PATH}`, self.location.origin).href;
        const cachedResponses = await Promise.all([
          voskCache.match(request),
          voskCache.match(url.href),
          voskCache.match(scopedModelUrl),
          voskCache.match(rootModelUrl),
          voskCache.match(VOSK_MODEL_RELATIVE_PATH),
          voskCache.match(`./${VOSK_MODEL_RELATIVE_PATH}`),
        ]);
        const cachedResponse = cachedResponses.find(Boolean);

        if (cachedResponse) {
          return cachedResponse;
        }

        try {
          return await fetch(request);
        } catch {
          return Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const fetchPromise = fetch(request)
        .then((networkResponse) => {
          if (networkResponse.ok) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
          }

          return networkResponse;
        })
        .catch(() => {
          if (cachedResponse) {
            return cachedResponse;
          }

          if (request.mode === "navigate") {
            return caches.match("./index.html");
          }

          return Response.error();
        });

      return fetchPromise;
    }),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
    return;
  }

  if (event.data?.type === "CLEAR_VOSK_CACHE") {
    event.waitUntil(
      caches.keys().then((keys) =>
        Promise.all(
          keys.map(async (key) => {
            const cache = await caches.open(key);
            const requests = await cache.keys();
            await Promise.all(
              requests
                .filter((request) => new URL(request.url).pathname.includes("/vosk/"))
                .map((request) => cache.delete(request)),
            );

            if (key.includes("vosk")) {
              await caches.delete(key);
            }
          }),
        ),
      ),
    );
  }
});
