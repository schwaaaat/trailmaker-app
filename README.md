# Trailmaker

Trailmaker turns a park or trail map (a photo, scan, screenshot or PDF) into GPS files: GPX, KML,
KMZ and GeoJSON. The files work in Gaia GPS, AllTrails, CalTopo, OsmAnd, Garmin and Google Earth.
You pin a few spots on the map to real coordinates, trace the trails by hand or let Trailmaker find
them by color, then export.

It runs entirely in your browser and works offline once loaded. You can install it as an app (PWA).

## Privacy

- **Your map image and trail data stay on your device.** Opening, tracing, auto-tracing, fitting
  and exporting all run locally, in the page and a Web Worker. Autosave uses the browser's own
  storage (IndexedDB), and projects save as `.trailmaker` files on your disk.
- **Nothing goes over the network unless you turn it on.** Two optional features use it, and each
  says so before it does anything:
  - **Live basemap** (off until you click *Enable*). It loads map tiles from
    `tiles.openfreemap.org` by default. The tile server sees which area you're viewing. Your map
    image and trails aren't sent.
  - **Place search** (a separate checkbox, off by default). It sends only the text you type to
    `nominatim.openstreetmap.org`. No map image, coordinates or project data is sent.
- The *Google Maps* link in the anchors step is an ordinary link that you choose to open. It's a
  handy place to copy coordinates from, and Trailmaker sends nothing to it.

## Two-minute walkthrough

The screenshots use the public-domain NPS
[Dickey Ridge Area map](https://www.nps.gov/shen/planyourvisit/upload/DickeyRidgeArea_RoadTrail.pdf)
from Shenandoah National Park. It's in `tests/fixtures/real/`.

**1. Open the map.** Click **Open image or PDF**, or drop a file on the page. PDFs open on page 1; switch pages from the
**Page** menu for multi-page files. Straight-on scans trace best.

![The Dickey Ridge map open in Trailmaker](docs/screenshots/1-open.png)

**2. Pin it to the real world with four anchors.** Click **Add anchor**, then click a spot you can
recognize, such as a visitor center, trailhead, junction or overlook. Paste its coordinates
(decimal, degrees-minutes-seconds, or a Google Maps URL) and press Enter. Repeat for three or
four spots spread toward the edges of the map.

Trailmaker fits the map and shows each anchor's disagreement with the others. If one anchor is
well off from the rest, it turns red so you can re-check it. In the screenshot, the four anchors
agree within 48 m on average, and pin 1 is flagged as the one to re-check. For warped or
hand-drawn maps, pick *Rubber sheet* under **Fit method**.

![Four anchors placed, with the fit summary](docs/screenshots/2-anchors.png)

**3. Trace a trail.** Pick **Trail** in the toolbar, or press `T`. With **Follow the line's color
while tracing** on, click on the trail line and then further along it. The path follows the ink
between your clicks. Click the last point again, or press Enter, to finish. Use **Point** for
trailheads and other points of interest, and **Area** for zones.

To trace many trails at once, go to **Find trails automatically**. Scan or pick the trail colors,
click **Find trails**, review the candidates, and accept them.

![A traced trail following the dashed hiking-trail ink](docs/screenshots/3-trace.png)

**4. Export.** In **Export**, choose **GPX** for Gaia GPS, AllTrails, CalTopo, OsmAnd or Garmin,
**KML** or **KMZ with map overlay** for Google Earth, or **GeoJSON**. **Download all (.zip)**
gives you every format. **Save project** writes a `.trailmaker` file you can reopen later.

![The export step with the traced trail](docs/screenshots/4-export.png)

**5. Open it in Google Earth.** Open the `.kmz` in Google Earth (Pro or web). The trails appear
in their map colors, and the KMZ carries the original park map as a ground overlay you can switch
on and off.

## Keyboard

Every tool works from the keyboard. Press `?` in the app for the full list of shortcuts. The
toolbar keys are `V` Select, `A` Anchor, `T` Trail, `P` Point and `R` Area.

## Development

Requires Node 22.17 or newer and pnpm 10 (`corepack enable` picks up the pinned version).

```sh
pnpm install
pnpm dev               # Vite dev server
pnpm build             # typecheck + production build into dist/
pnpm preview           # serve the production build
```

Quality gates (all must pass before a merge):

```sh
pnpm typecheck         # strict TypeScript
pnpm lint              # ESLint, zero warnings
pnpm test              # Vitest with coverage (src/core >= 85% lines) + KMZ stress
pnpm fixtures          # regenerate the synthetic benchmark maps
pnpm test:e2e          # Playwright golden flows, dev and preview builds
pnpm test:trace-bench  # tracer quality and speed on synthetic + NPS fixtures
pnpm gate              # all of the above, then build
```

To regenerate the README screenshots, run
`README_SHOTS=1 pnpm exec playwright test readme-screenshots`. On Windows PowerShell, set
`$env:README_SHOTS='1'` first.

Layout: `src/core` holds the pure TypeScript (geo fits, tracing, export, project format,
topology), `src/worker` the Comlink worker, `src/state` the Zustand store, `src/ui` the canvas
editor, panels, files and georeferencing, and `src/io` loading, autosave and the PWA.

## License

MIT. See [LICENSE](LICENSE).

## Map sources

The NPS maps in `tests/fixtures/real/` are US government works in the public domain. Their
sources are listed in `tests/fixtures/real/README.md`.
