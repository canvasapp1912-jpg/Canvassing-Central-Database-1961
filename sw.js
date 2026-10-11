/* Service worker: caches the whole app so it opens and works with no data or signal. */
const V = "canvass-v1";
const SHELL = ["./", "index.html", "sync.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png",
  "vendor/xlsx.full.min.js", "vendor/pdf-lib.min.js"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(V).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== location.origin) return;       // sync calls go straight to Google
  e.respondWith(caches.open(V).then(async c => {
    const hit = await c.match(r, { ignoreSearch: true });
    const net = fetch(r).then(res => { if (res && res.ok) c.put(r, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }                           // open instantly, refresh in background
    const res = await net;
    return res || (r.mode === "navigate" ? c.match("index.html") : new Response("", { status: 504 }));
  }));
});
