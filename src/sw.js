/*
 * Forgecraft tools - offline support.
 * Online: always fetches the newest pages (so updates arrive straight away).
 * Offline: falls back to the last copy it saw. The tool pages are saved on install;
 * libraries and fonts they load from CDNs are saved the first time a tool is opened online.
 */
var CACHE = 'forgecraft-__VERSION__';
var SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png',
  './icons/icon-maskable-512.png'/*__APP_FILES__*/];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('forgecraft-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || !/^https?:/.test(req.url)) return;
  e.respondWith(
    fetch(req).then(function (res) {
      // same-site files, plus CDN libraries and fonts (opaque = cross-site without CORS, e.g. font CSS)
      if (res && (res.ok || res.type === 'opaque')) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreVary: true }).then(function (hit) {
        if (hit) return hit;
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
    })
  );
});
