const CACHE_NAME = "gfxutl-shell-v2";
const STATIC_SHELL = ["/manifest.webmanifest", "/icons/gfxutl.svg", "/icons/gfxutl-192.png", "/icons/gfxutl-512.png"];

async function precacheAppShell() {
  const cache = await caches.open(CACHE_NAME);
  const documentResponse = await fetch("/index.html", { cache: "reload" });
  if (!documentResponse.ok) throw new Error("GfxUtl app shell could not be fetched");
  const html = await documentResponse.clone().text();
  const generatedAssets = new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]));
  // Only precache the entry chunks referenced by index.html. Feature chunks,
  // the renderer worker and large WASM assets are cached on first use instead
  // of competing with the first navigation for bandwidth and compilation.
  await Promise.all([
    cache.put("/", documentResponse.clone()),
    cache.put("/index.html", documentResponse),
    cache.addAll([...STATIC_SHELL, ...generatedAssets]),
  ]);
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheAppShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request)
      .then((response) => {
        const copy = response.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", copy));
        return response;
      })
      .catch(async () => (await caches.match("/index.html")) || Response.error()));
    return;
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
    }
    return response;
  })));
});
