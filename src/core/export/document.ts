// Lane B. Resolves a Project through a GeoFit into writer input (prototype exportFeatures).
import type { ExportDocument, GeoFeature, GeoFit, Project } from '../types';
import { pathLength } from '../geo/distance';
import { forward, projectPath } from '../geo/fit';
import { drain } from './steps';

const ORDER = { trail: 0, area: 1, poi: 2 } as const;

// Image provenance is consumed by KML/KMZ but stays private to the export implementation so the
// shared ExportDocument contract remains unchanged for other lanes and writers.
type ProvenanceDocument = ExportDocument & {
  readonly imageAttribution?: string;
  readonly acquisitionYear?: number;
};

/**
 * toExportDocument one feature per step (card T-211): yields after each feature is projected and
 * returns the document, so the app can spread a large export over time slices.
 */
export function* exportDocumentSteps(
  project: Project,
  fit: GeoFit,
): Generator<void, ExportDocument, undefined> {
  const sorted = [...project.features].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]); // stable
  const features: GeoFeature[] = [];
  for (const f of sorted) {
    if (f.kind === 'poi') {
      features.push({ ...f, ll: forward(fit, f.at) });
    } else {
      const ll = projectPath(fit, f.pts);
      features.push(
        f.kind === 'area'
          ? { ...f, ll, lengthM: pathLength(ll, true) }
          : { ...f, ll, lengthM: pathLength(ll) },
      );
    }
    yield;
  }
  const { attribution, acquisitionYear } = project.image;
  return {
    name: project.name || 'Park map',
    features,
    ...(attribution ? { imageAttribution: attribution } : {}),
    ...(acquisitionYear === undefined ? {} : { acquisitionYear }),
  } as ProvenanceDocument;
}

/** Project features -> GeoFeatures (lat/lon + length in meters), ordered trails, areas, POIs. */
export function toExportDocument(project: Project, fit: GeoFit): ExportDocument {
  return drain(exportDocumentSteps(project, fit));
}
