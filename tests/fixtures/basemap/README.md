# Offline Playwright basemap

`style.json` is a MapLibre raster style centered on the T-002 fixture truth. Its
XYZ tiles are generated deterministically by `tiles.ts` for zooms 10–16. The
extent covers every synthetic fixture, including the 3000 × 2200 benchmark map.
It has no glyph or sprite requests.

`tests/e2e/offline-basemap.ts` intercepts the style and tile URLs on the local
Playwright server. The guard in `tests/e2e/network-fixture.ts` aborts and fails
every browser request to a host other than `127.0.0.1`.

For MapLibre 6 in Vite, import the worker with
`maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url` and pass it to
`setWorkerUrl` before constructing the map. The ordinary auto-detected worker
URL points into Vite's dependency optimizer and fails in dev; a plain `?url`
also leaves the worker's shared-module import unbundled in production.
