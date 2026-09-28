import type * as MapLibreGL from 'maplibre-gl';

let maplibrePromise: Promise<typeof MapLibreGL> | null = null;

/**
 * Lazily loads MapLibre GL JS and configures its web worker URL.
 * Keeps MapLibre out of the main application entry bundle.
 */
export async function loadMapLibre(): Promise<typeof MapLibreGL> {
  if (!maplibrePromise) {
    maplibrePromise = (async () => {
      const [maplibre, workerMod] = await Promise.all([
        import('maplibre-gl'),
        import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'),
        import('maplibre-gl/dist/maplibre-gl.css'),
      ]);
      maplibre.setWorkerUrl(workerMod.default);
      return maplibre;
    })();
  }
  return maplibrePromise;
}
