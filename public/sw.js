// NayFlow PWA Service Worker (Installability & passthrough)
const CACHE_NAME = "nayflow-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME) {
              return caches.delete(key);
            }
          }),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// A fetch listener is required by browsers to trigger the PWA install prompt.
// Dynamic API requests and non-GET requests bypass the worker completely.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || event.request.url.includes("/api/")) {
    return;
  }

  event.respondWith(
    fetch(event.request).catch((err) => {
      return Promise.reject(err);
    }),
  );
});
