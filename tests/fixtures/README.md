# Synthetic fixtures

Run `pnpm fixtures` (or `pnpm gate`) to generate ignored PNG, two-page PDF and truth JSON
in `generated/`. Seed defaults to 20260924. The generator is importable with a different
seed/output directory. PDF page 1 is a cover, page 2 contains vector trail strokes.
`solid.pdf` has two colors for golden flow 2. `benchmark.png` is 3000x2200 with three colors.

Truth uses [x,y] working pixels and [lat,lon] degrees. `pixelToLatLon` applies the serialized
transform independently of application code. For the warped fixture it first inverts the
sinusoidal x displacement. All six anchors and the POI include both coordinate systems.
Dashed/dotted truth describes the complete trail centerline, including gaps.

`jpeg-noise.png` is a real quality-38 JPEG encode/decode preserved in PNG;
`blur.png` applies sigma 0.7. PDFs remain vector originals, not degraded raster copies.
Clutter includes filled trail-color regions, trail-color labels and legend swatches;
these are deliberately absent from truth polylines. Small raster/PDF font differences
do not change the truth geometry. Byte reproducibility is tested in the same pinned
toolchain; font rasterization can differ across operating systems.

Geometry metrics live in `tests/metrics/geometry.ts`. Recall/precision integrate exact
covered lengths against the union of tolerance capsules, with no vertex-density bias.
Hausdorff samples segment interiors every 0.25 units by default; its maximum underestimation
is 0.125 units. Add that bound for strict threshold assertions. The geographic helper uses
a local equirectangular frame intended for park-sized (<20km) comparisons.

GPX validation uses the vendored official 1.1 XSD and libxml2-wasm. KML parsing checks
well-formedness, namespace and coordinates; it is not full KML schema validation.

The Node benchmark reports each color separately, and enforces live recall >=95%,
precision >=90% within 5px, three-color time <1500ms, and smart-hop time <100ms.
Exact contract stubs are explicitly pending. Worker and UI responsiveness budgets
are a separate pending Playwright test, enabled after T-106/T-206.
