import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

declare global {
  interface Window {
    __basemapHarness?: { ready: boolean; errors: string[]; tileLoads: number };
  }
}

const state = { ready: false, errors: [] as string[], tileLoads: 0 };
window.__basemapHarness = state;

void import('maplibre-gl')
  .then(({ Map, setWorkerUrl }) => {
    setWorkerUrl(workerUrl);
    const map = new Map({
      container: 'map',
      style: '/__test_basemap/style.json',
      center: [-78.395, 38.597],
      zoom: 14,
      attributionControl: false,
    });
    map.on('error', (event) => state.errors.push(String(event.error)));
    map.on('sourcedata', (event) => {
      if (event.dataType === 'source' && event.tile) state.tileLoads++;
    });
    map.once('idle', () => {
      state.ready = true;
    });
  })
  .catch((error: unknown) => state.errors.push(String(error)));
