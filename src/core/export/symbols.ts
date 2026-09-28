// Lane B. Port of prototype SYMS: each POI type's GPX <sym> (Garmin names) and KML icon.
import type { PoiType } from '../types';

/** GPX symbol name and Google Earth icon for one POI type. */
export interface PoiSymbol {
  /** GPX <sym> value (Garmin symbol name, understood by Gaia/OsmAnd/CalTopo). */
  readonly gpx: string;
  /** Icon name under https://maps.google.com/mapfiles/kml/shapes/. */
  readonly icon: string;
}

/** POI type -> symbols (prototype table). */
export const POI_SYMBOLS: Readonly<Record<PoiType, PoiSymbol>> = {
  Trailhead: { gpx: 'Trailhead', icon: 'hiker' },
  Parking: { gpx: 'Parking Area', icon: 'parking_lot' },
  Restroom: { gpx: 'Restroom', icon: 'toilets' },
  Viewpoint: { gpx: 'Scenic Area', icon: 'camera' },
  Campsite: { gpx: 'Campground', icon: 'campground' },
  Water: { gpx: 'Drinking Water', icon: 'placemark_circle' },
  Information: { gpx: 'Information', icon: 'info-i' },
  Junction: { gpx: 'Crossing', icon: 'placemark_square' },
  Waypoint: { gpx: 'Waypoint', icon: 'placemark_circle' },
};

/** Full KML icon URL for a POI type. */
export function kmlIconHref(type: PoiType): string {
  return `https://maps.google.com/mapfiles/kml/shapes/${POI_SYMBOLS[type].icon}.png`;
}
