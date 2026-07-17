const CACHE_NAME = 'fulfillment-v2'; // ★ 2026-07-17: v1→v2 (HTTP 캐시까지 확실히 우회하도록 수정)

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll([
        '/fulfillment/',
        '/fulfillment/index.html',
        '/fulfillment/manifest.json',
        '/fulfillment/icon-192.png',
        '/fulfillment/icon-512.png'
      ]);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) { return key !== CACHE_NAME; })
            .map(function(key) { return caches.delete(key); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(event) {
  if (event.request.url.includes('script.google.com')) {
    event.respondWith(fetch(event.request));
    return;
  }
  // ★ 2026-07-17 수정: 예전엔 fetch(event.request)만 호출해서, 서비스워커
  //   입장에선 "네트워크로 요청"했다고 생각해도 브라우저의 일반 HTTP 캐시가
  //   GitHub Pages의 캐시 응답(Cache-Control)을 그대로 재사용해버릴 수 있었음.
  //   { cache: 'no-store' }를 명시해서 HTTP 캐시까지 확실히 건너뛰고 매번
  //   진짜 최신 파일을 받아오도록 함 — batch.html/board.html을 새로 올려도
  //   반영이 늦게 되거나 안 되는 것처럼 보이던 문제의 실제 원인.
  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then(function(response) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(event.request, clone);
        });
        return response;
      })
      .catch(function() {
        return caches.match(event.request);
      })
  );
});
