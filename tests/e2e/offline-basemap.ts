import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { coversTile, fixtureTilePng } from '../fixtures/basemap/tiles';

export const offlineStylePath = '/__test_basemap/style.json';
export const basemapResponseHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin',
} as const;

/** Install before navigation. Every map response is local, including its style. */
export async function installOfflineBasemap(page: Page): Promise<void> {
  await page.route('**/__test_basemap/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === offlineStylePath) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: basemapResponseHeaders,
        body: await readFile('tests/fixtures/basemap/style.json'),
      });
      return;
    }
    const tile = /^\/__test_basemap\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(path);
    if (tile) {
      const [z, x, y] = tile.slice(1).map(Number);
      if (coversTile(z!, x!, y!)) {
        await route.fulfill({
          status: 200,
          contentType: 'image/png',
          headers: basemapResponseHeaders,
          body: await fixtureTilePng(z!, x!, y!),
        });
        return;
      }
    }
    await route.fulfill({ status: 404, body: 'Outside offline basemap fixture' });
  });
}
