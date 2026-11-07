// Offline cache. Bump VERSION whenever app files change so phones pick up the update.
const VERSION = 'v69';
const FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './src/app.js',
  './src/icons.js',
  './src/native.js',
  './src/foods.js',
  './src/recipes.js',
  './src/menu.js',
  './src/meter.js',
  './src/cloud-config.js',
  './src/cloud.js',
  './src/familycode.js',
  './src/phone.js',
  './src/meds.js',
  './src/report.js',
  './src/xlsx.js',
  './src/reportfont.js',
  './vendor/firebase/firebase-app.js',
  './vendor/firebase/firebase-auth.js',
  './vendor/firebase/firebase-firestore.js',
  './vendor/qrcode.js',
  './fonts/Poppins-Regular.ttf',
  './fonts/Poppins-Medium.ttf',
  './fonts/Poppins-SemiBold.ttf',
  './fonts/HindSiliguri-Regular.ttf',
  './fonts/HindSiliguri-Medium.ttf',
  './fonts/HindSiliguri-SemiBold.ttf',
  './src/engine.js',
  './src/plan.js',
  './src/i18n.js',
  './src/store.js',
  './src/notify.js',
  './src/sync.js',
  './src/styles.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// App files: network first (so updates arrive), cached copy when offline.
// Everything else (Firebase, ntfy) goes straight to the network.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
