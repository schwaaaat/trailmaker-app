import type { LatLon } from '../types';

const urlCoordinates = /(?:@|[?&](?:q|query|ll)=)(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i;
const dms =
  /(\d+(?:\.\d+)?)\s*(?:°|º|deg)\s*(?:(\d+(?:\.\d+)?)\s*(?:'|′|’)\s*)?(?:(\d+(?:\.\d+)?)\s*(?:"|″|”|''|’’)\s*)?([NSEW])/gi;
const decimalPair = /^(-?\d+(?:\.\d+)?)\s*([NSEW]?)\s*(?:,\s*|\s+)(-?\d+(?:\.\d+)?)\s*([NSEW]?)$/i;

/** Parse decimal, hemisphere-lettered, DMS, or Google Maps URL coordinates. */
export function parseLatLon(text: string): LatLon | null {
  const source = text.trim();
  if (!source) return null;
  let lat: number, lon: number;
  const url = source.match(urlCoordinates);
  if (url) {
    lat = Number(url[1]);
    lon = Number(url[2]);
  } else {
    const parts = [...source.matchAll(dms)];
    if (parts.length === 2 && source.replace(dms, '').replace(/[\s,;]+/g, '') === '') {
      const parsed = parts.map((part) => {
        const value = Number(part[1]) + Number(part[2] || 0) / 60 + Number(part[3] || 0) / 3600;
        const hemisphere = part[4]!.toUpperCase();
        return { value: /[SW]/.test(hemisphere) ? -value : value, hemisphere };
      });
      const a = parsed[0]!,
        b = parsed[1]!;
      if (/[NS]/.test(a.hemisphere) && /[EW]/.test(b.hemisphere)) [lat, lon] = [a.value, b.value];
      else if (/[EW]/.test(a.hemisphere) && /[NS]/.test(b.hemisphere))
        [lat, lon] = [b.value, a.value];
      else return null;
    } else {
      const pair = source.match(decimalPair);
      if (!pair) return null;
      let a = Number(pair[1]),
        b = Number(pair[3]);
      const ha = pair[2]!.toUpperCase(),
        hb = pair[4]!.toUpperCase();
      if (ha === 'S' || ha === 'W') a = -Math.abs(a);
      if (hb === 'S' || hb === 'W') b = -Math.abs(b);
      if (/[EW]/.test(ha) && /[NS]/.test(hb)) [lat, lon] = [b, a];
      else if ((/[NS]/.test(ha) && /[EW]/.test(hb)) || (!ha && !hb)) [lat, lon] = [a, b];
      else return null;
    }
  }
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
    ? [lat, lon]
    : null;
}

/** Format as "lat, lon" with six decimals by default. */
export function formatLatLon(ll: LatLon, decimals = 6): string {
  return ll[0].toFixed(decimals) + ', ' + ll[1].toFixed(decimals);
}
