import { test as base, expect } from '@playwright/test';

/** Applied automatically to every dev and preview e2e spec. */
const test = base.extend<{ stubbedHosts: string[]; localNetworkOnly: void }>({
  /**
   * External hosts a spec answers itself with page.route() (T-316's satellite tiles). Requests to
   * them never leave the machine: the spec's route fulfills them, and anything it doesn't handle
   * still falls through to the abort below.
   */
  stubbedHosts: [[], { option: true }],
  localNetworkOnly: [
    async ({ context, stubbedHosts }, use) => {
      const external: string[] = [];
      const stubbed = (url: URL) => stubbedHosts.includes(url.hostname);
      context.on('request', (request) => {
        const url = new URL(request.url());
        if (/^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1' && !stubbed(url))
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
