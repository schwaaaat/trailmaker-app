import { test as base, expect } from '@playwright/test';

/** Applied automatically to every dev and preview e2e spec. */
const test = base.extend<{ localNetworkOnly: void }>({
  localNetworkOnly: [
    async ({ context }, use) => {
      const external: string[] = [];
      context.on('request', (request) => {
        const url = new URL(request.url());
        if (/^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1')
          external.push(request.url());
      });
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (/^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1') {
          await route.abort('blockedbyclient');
          return;
        }
        await route.continue();
      });
      await use();
      expect(external, 'Browser requests must remain on 127.0.0.1').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect, test };
