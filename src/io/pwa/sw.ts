/// <reference lib="webworker" />
// Lane C. PWA Service Worker (card T-310).
import { injectIsolationHeaders, shouldInterceptRequest } from './isolation';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST?: Array<{ url: string; revision: string | null } | string>;
};

export const CACHE_NAME = 'trailmaker-v1';

// Assets from Vite build manifest
const manifestEntries = self.__WB_MANIFEST || [];
const basePath = new URL('./', self.location.href).pathname;
const scopedPath = (path: string) =>
  path.startsWith(basePath) ? path : `${basePath}${path.replace(/^\/+/, '')}`;
const indexPath = scopedPath('index.html');
export const PRECACHE_URLS: string[] = manifestEntries
  .map((entry) => scopedPath(typeof entry === 'string' ? entry : entry.url))
  .concat([basePath, indexPath, scopedPath('manifest.webmanifest'), scopedPath('favicon.svg')]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      for (const url of PRECACHE_URLS) {
        try {
          await cache.add(new Request(url, { cache: 'reload' }));
        } catch {
          // Continue if individual asset fails during development/offline
        }
      }
      try {
        const res = await fetch(indexPath);
        const html = await res.text();
        const matches = html.matchAll(/(?:href|src)="([^"]+)"/g);
        const urls = Array.from(matches, (m) => m[1]).filter(
          (url): url is string =>
            typeof url === 'string' &&
            new URL(url, self.location.origin).pathname.startsWith(`${basePath}assets/`),
        );
        for (const u of urls) {
          try {
            await cache.add(new Request(new URL(u, self.location.origin), { cache: 'reload' }));
          } catch {
            // Ignore individual asset failure
          }
        }
      } catch {
        // Ignore discovery failure
      }
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Strictly ignore cross-origin requests (basemap tiles, geocoder per D-018) and non-GET requests
  if (!shouldInterceptRequest(url, self.location.origin, event.request.method)) {
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      // Match cache
      let match = await cache.match(event.request, { ignoreVary: true });

      // For document navigation, fall back to the app's base-scoped index.
      if (!match && event.request.mode === 'navigate') {
        match =
          (await cache.match(indexPath, { ignoreVary: true })) ||
          (await cache.match(basePath, { ignoreVary: true }));
      }

      if (match) {
        return injectIsolationHeaders(match);
      }

      try {
        const response = await fetch(event.request);
        if (response.ok && response.status === 200) {
          // Cache same-origin static assets for offline use
          const isolated = injectIsolationHeaders(response);
          void cache.put(event.request, isolated.clone());
          return isolated;
        }
        return injectIsolationHeaders(response);
      } catch (err) {
        if (event.request.mode === 'navigate') {
          const fallback =
            (await cache.match(indexPath, { ignoreVary: true })) ||
            (await cache.match(basePath, { ignoreVary: true }));
          if (fallback) {
            return injectIsolationHeaders(fallback);
          }
        }
        throw err;
      }
    })(),
  );
});
