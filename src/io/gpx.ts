// Lane C. Local GPX 1.0 and 1.1 parser with decimation for large files (card T-312).
import type { LatLon } from '../core/types';

export interface GpxPoint {
  readonly id: string;
  readonly name: string;
  readonly ll: LatLon;
  readonly kind: 'wpt' | 'trkpt' | 'rtept';
  readonly ele?: number | undefined;
  readonly desc?: string | undefined;
  readonly time?: string | undefined;
}

export interface GpxTrackSegment {
  readonly name: string;
  readonly points: readonly LatLon[];
}

export interface GpxParseResult {
  readonly ok: true;
  readonly fileName: string;
  readonly points: readonly GpxPoint[];
  readonly tracks: readonly GpxTrackSegment[];
  readonly totalPointsInFile: number;
  readonly wasDecimated: boolean;
  readonly notice?: string | undefined;
  readonly rawGpx?: string | undefined;
}

export interface GpxParseError {
  readonly ok: false;
  readonly error: string;
}

export type GpxResult = GpxParseResult | GpxParseError;

export const MAX_DISPLAY_POINTS = 10000;
export const LARGE_FILE_THRESHOLD_BYTES = 10 * 1024 * 1024; // 10 MB
export const LARGE_POINT_COUNT_THRESHOLD = 50000;

export const FAST_GPX_THRESHOLD_BYTES = 250_000;

export interface ParseGpxOptions {
  readonly fileName?: string;
  readonly fileSizeBytes?: number;
  readonly forceEngine?: 'fast' | 'dom';
}

interface ExtractedChildText {
  name?: string | undefined;
  desc?: string | undefined;
  ele?: number | undefined;
  time?: string | undefined;
}

export function decodeXmlEntities(str: string): string {
  if (!str.includes('&')) return str;
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export function cleanTagText(text: string): string {
  const t = text.trim();
  if (!t.includes('<![CDATA[')) {
    return decodeXmlEntities(t);
  }

  // Preserve literal content inside CDATA sections (XML entities are not decoded inside CDATA)
  let result = '';
  let lastIdx = 0;
  let cdataStart = 0;

  while ((cdataStart = t.indexOf('<![CDATA[', lastIdx)) !== -1) {
    if (cdataStart > lastIdx) {
      result += decodeXmlEntities(t.slice(lastIdx, cdataStart));
    }
    const cdataEnd = t.indexOf(']]>', cdataStart + 9);
    if (cdataEnd === -1) {
      result += t.slice(cdataStart + 9);
      lastIdx = t.length;
      break;
    } else {
      result += t.slice(cdataStart + 9, cdataEnd);
      lastIdx = cdataEnd + 3;
    }
  }

  if (lastIdx < t.length) {
    result += decodeXmlEntities(t.slice(lastIdx));
  }

  return result;
}

export function hasXmlIncompatibilities(xml: string): boolean {
  if (xml.includes('&') || xml.includes('<![CDATA[') || xml.includes('<!--')) {
    return true;
  }
  if (/<[a-zA-Z0-9_]+:[a-zA-Z0-9_]+/.test(xml)) {
    return true;
  }
  if (/(?:lat|lon)\s+=\s*|(?:lat|lon)\s*=\s+/.test(xml)) {
    return true;
  }
  return false;
}

function findElementsByLocalName(parent: Document | Element, localName: string): Element[] {
  if (typeof parent.getElementsByTagNameNS === 'function') {
    try {
      const list = parent.getElementsByTagNameNS('*', localName);
      if (list && list.length > 0) return Array.from(list);
    } catch {
      // ignore
    }
  }
  try {
    const list = parent.getElementsByTagName(localName);
    if (list && list.length > 0) return Array.from(list);
  } catch {
    // ignore
  }
  try {
    return Array.from(parent.querySelectorAll(localName));
  } catch {
    return [];
  }
}

function extractChildProperties(el: Element): ExtractedChildText {
  const result: ExtractedChildText = {};
  if (!el.firstElementChild) return result;

  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i];
    if (!child) continue;
    const tag = (child.localName || child.nodeName).toLowerCase().replace(/^.*:/, '');
    const text = child.textContent?.trim();
    if (!text) continue;

    if (tag === 'name' && !result.name) {
      result.name = text;
    } else if (tag === 'desc' && !result.desc) {
      result.desc = text;
    } else if (tag === 'ele' && result.ele === undefined) {
      const val = parseFloat(text);
      if (Number.isFinite(val)) {
        result.ele = val;
      }
    } else if (tag === 'time' && !result.time) {
      result.time = text;
    }
  }

  return result;
}

function parsePointCoordinates(el: Element): LatLon | null {
  const latStr = el.getAttribute('lat');
  const lonStr = el.getAttribute('lon');
  if (!latStr || !lonStr) return null;

  const lat = parseFloat(latStr);
  const lon = parseFloat(lonStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  return [lat, lon];
}

function parseFastGpx(
  xmlText: string,
  fileName: string,
  byteLength: number,
): GpxResult {
  const trimmed = xmlText.trim();
  if (!trimmed) {
    return { ok: false, error: 'The GPX file is empty.' };
  }

  // Pre-process comments and tag prefixes for fast scanner parity
  const textWithoutComments = trimmed.includes('<!--')
    ? trimmed.replace(/<!--[\s\S]*?-->/g, '')
    : trimmed;

  const text = /<[a-zA-Z0-9_]+:[a-zA-Z0-9_]+/.test(textWithoutComments)
    ? textWithoutComments.replace(/<(\/)?([a-zA-Z0-9_]+:)/g, '<$1')
    : textWithoutComments;

  const rootMatch = text.match(/<([a-zA-Z0-9_]+)[\s>]/);
  if (!rootMatch) {
    return { ok: false, error: 'Invalid GPX file: empty XML document.' };
  }
  const rootTag = rootMatch[1]!.toLowerCase();
  if (rootTag !== 'gpx') {
    return { ok: false, error: 'Invalid GPX file: root element must be <gpx>.' };
  }

  const parsePointAttrsDirect = (start: number, end: number): LatLon | null => {
    // Fast path: standard lat="..." lon="..."
    const latIdx = text.indexOf('lat=', start);
    const lonIdx = text.indexOf('lon=', start);
    if (latIdx !== -1 && latIdx < end && lonIdx !== -1 && lonIdx < end) {
      const latQuote = text.charCodeAt(latIdx + 4);
      if (latQuote === 34 || latQuote === 39) {
        const lonQuote = text.charCodeAt(lonIdx + 4);
        if (lonQuote === 34 || lonQuote === 39) {
          const latStart = latIdx + 5;
          let latEnd = latStart;
          while (latEnd < end && text.charCodeAt(latEnd) !== latQuote) {
            latEnd++;
          }
          const lonStart = lonIdx + 5;
          let lonEnd = lonStart;
          while (lonEnd < end && text.charCodeAt(lonEnd) !== lonQuote) {
            lonEnd++;
          }
          if (latEnd < end && lonEnd < end) {
            const lat = parseFloat(text.slice(latStart, latEnd));
            const lon = parseFloat(text.slice(lonStart, lonEnd));
            if (Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
              return [lat, lon];
            }
          }
        }
      }
    }

    // Fallback: handle spaces around '=' or unconventional attribute formatting in point tag
    const attrSlice = text.slice(start, end);
    const latMatch = attrSlice.match(/\blat\s*=\s*(["'])(.*?)\1/);
    const lonMatch = attrSlice.match(/\blon\s*=\s*(["'])(.*?)\1/);
    if (!latMatch || !lonMatch) return null;
    const lat = parseFloat(latMatch[2]!);
    const lon = parseFloat(lonMatch[2]!);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return [lat, lon];
  };

  const parseTagsDirect = (start: number, end: number): ExtractedChildText => {
    if (end - start < 5) return {};

    // Fast-path: <ele>...</ele>
    if (text.startsWith('<ele>', start)) {
      const eEnd = text.indexOf('</ele>', start + 5);
      if (eEnd !== -1 && eEnd + 6 === end) {
        const val = parseFloat(cleanTagText(text.slice(start + 5, eEnd)));
        if (Number.isFinite(val)) return { ele: val };
      }
    }

    let name: string | undefined;
    let desc: string | undefined;
    let ele: number | undefined;
    let time: string | undefined;

    const eIdx = text.indexOf('<ele>', start);
    if (eIdx !== -1 && eIdx < end) {
      const eEnd = text.indexOf('</ele>', eIdx + 5);
      if (eEnd !== -1 && eEnd < end) {
        const val = parseFloat(cleanTagText(text.slice(eIdx + 5, eEnd)));
        if (Number.isFinite(val)) ele = val;
      }
    }

    const nIdx = text.indexOf('<name>', start);
    if (nIdx !== -1 && nIdx < end) {
      const nEnd = text.indexOf('</name>', nIdx + 6);
      if (nEnd !== -1 && nEnd < end) {
        const parsedName = cleanTagText(text.slice(nIdx + 6, nEnd));
        if (parsedName) name = parsedName;
      }
    }

    const dIdx = text.indexOf('<desc>', start);
    if (dIdx !== -1 && dIdx < end) {
      const dEnd = text.indexOf('</desc>', dIdx + 6);
      if (dEnd !== -1 && dEnd < end) {
        const parsedDesc = cleanTagText(text.slice(dIdx + 6, dEnd));
        if (parsedDesc) desc = parsedDesc;
      }
    }

    const tIdx = text.indexOf('<time>', start);
    if (tIdx !== -1 && tIdx < end) {
      const tEnd = text.indexOf('</time>', tIdx + 6);
      if (tEnd !== -1 && tEnd < end) {
        const parsedTime = cleanTagText(text.slice(tIdx + 6, tEnd));
        if (parsedTime) time = parsedTime;
      }
    }

    return { name, desc, ele, time };
  };

  let wptEst = 0;
  let idx = 0;
  while ((idx = text.indexOf('<wpt', idx)) !== -1) {
    const nextChar = text.charCodeAt(idx + 4);
    if (nextChar === 32 || nextChar === 9 || nextChar === 10 || nextChar === 13 || nextChar === 62 || nextChar === 47) {
      wptEst++;
    }
    idx += 4;
  }

  let rteptEst = 0;
  idx = 0;
  while ((idx = text.indexOf('<rtept', idx)) !== -1) {
    const nextChar = text.charCodeAt(idx + 6);
    if (nextChar === 32 || nextChar === 9 || nextChar === 10 || nextChar === 13 || nextChar === 62 || nextChar === 47) {
      rteptEst++;
    }
    idx += 6;
  }

  let trkptEst = 0;
  idx = 0;
  while ((idx = text.indexOf('<trkpt', idx)) !== -1) {
    const nextChar = text.charCodeAt(idx + 6);
    if (nextChar === 32 || nextChar === 9 || nextChar === 10 || nextChar === 13 || nextChar === 62 || nextChar === 47) {
      trkptEst++;
    }
    idx += 6;
  }

  const totalLinearEst = rteptEst + trkptEst;
  const estimatedTotalPoints = wptEst + totalLinearEst;
  if (estimatedTotalPoints === 0) {
    return { ok: false, error: 'No valid waypoints, track points, or route points found in GPX.' };
  }

  const needsDecimation =
    byteLength > LARGE_FILE_THRESHOLD_BYTES || estimatedTotalPoints > LARGE_POINT_COUNT_THRESHOLD;
  const availableBudget = Math.max(1000, MAX_DISPLAY_POINTS - wptEst);
  const stride = needsDecimation ? Math.max(1, Math.ceil(totalLinearEst / availableBudget)) : 1;

  const waypoints: GpxPoint[] = [];
  const linearPoints: GpxPoint[] = [];
  const tracks: GpxTrackSegment[] = [];

  // Parse waypoints: <wpt ...>...</wpt>
  let wptIndex = 1;
  let wptPos = 0;
  while ((wptPos = text.indexOf('<wpt', wptPos)) !== -1) {
    const nextChar = text.charCodeAt(wptPos + 4);
    if (nextChar !== 32 && nextChar !== 9 && nextChar !== 10 && nextChar !== 13 && nextChar !== 62 && nextChar !== 47) {
      wptPos += 4;
      continue;
    }
    const tagEnd = text.indexOf('>', wptPos + 4);
    if (tagEnd === -1) break;

    const isSelfClosing = text.charCodeAt(tagEnd - 1) === 47;
    let contentEnd = tagEnd;
    let nextPos = tagEnd + 1;

    if (!isSelfClosing) {
      const closeIdx = text.indexOf('</wpt>', tagEnd + 1);
      if (closeIdx !== -1) {
        contentEnd = closeIdx;
        nextPos = closeIdx + 6;
      }
    }

    const coords = parsePointAttrsDirect(wptPos + 4, isSelfClosing ? tagEnd - 1 : tagEnd);
    if (coords) {
      let tags: ExtractedChildText = {};
      if (!isSelfClosing && contentEnd > tagEnd + 1) {
        tags = parseTagsDirect(tagEnd + 1, contentEnd);
      }
      waypoints.push({
        id: `wpt-${wptIndex}`,
        name: tags.name || `Waypoint ${wptIndex}`,
        ll: coords,
        kind: 'wpt',
        ele: tags.ele,
        desc: tags.desc,
        time: tags.time,
      });
      wptIndex++;
    }

    wptPos = nextPos;
  }

  let linearIndex = 0;

  // Parse routes: <rte>...</rte>
  let rtePos = 0;
  let rteIndex = 1;
  while ((rtePos = text.indexOf('<rte', rtePos)) !== -1) {
    const nextChar = text.charCodeAt(rtePos + 4);
    if (nextChar !== 32 && nextChar !== 9 && nextChar !== 10 && nextChar !== 13 && nextChar !== 62 && nextChar !== 47) {
      rtePos += 4;
      continue;
    }
    const rteClose = text.indexOf('</rte>', rtePos + 4);
    const rteEnd = rteClose !== -1 ? rteClose : text.length;

    let rteName = `Route ${rteIndex}`;
    const firstPt = text.indexOf('<rtept', rtePos);
    const headerEnd = firstPt !== -1 && firstPt < rteEnd ? firstPt : rteEnd;
    const nameStart = text.indexOf('<name>', rtePos);
    if (nameStart !== -1 && nameStart < headerEnd) {
      const nameEnd = text.indexOf('</name>', nameStart + 6);
      if (nameEnd !== -1 && nameEnd < headerEnd) {
        const parsedName = cleanTagText(text.slice(nameStart + 6, nameEnd));
        if (parsedName) rteName = parsedName;
      }
    }

    const lineCoords: LatLon[] = [];
    let ptIndex = 1;
    let rteptPos = rtePos;

    while ((rteptPos = text.indexOf('<rtept', rteptPos)) !== -1 && rteptPos < rteEnd) {
      const nextC = text.charCodeAt(rteptPos + 6);
      if (nextC !== 32 && nextC !== 9 && nextC !== 10 && nextC !== 13 && nextC !== 62 && nextC !== 47) {
        rteptPos += 6;
        continue;
      }

      const isKept =
        !needsDecimation ||
        linearIndex === 0 ||
        linearIndex === totalLinearEst - 1 ||
        linearIndex % stride === 0;

      if (!isKept) {
        rteptPos += 6;
        linearIndex++;
        ptIndex++;
        continue;
      }

      const tagEnd = text.indexOf('>', rteptPos + 6);
      if (tagEnd === -1 || tagEnd >= rteEnd) break;

      const isSelfClosing = text.charCodeAt(tagEnd - 1) === 47;
      let contentEnd = tagEnd;
      let nextPtPos = tagEnd + 1;

      if (!isSelfClosing) {
        const closeIdx = text.indexOf('</rtept>', tagEnd + 1);
        if (closeIdx !== -1 && closeIdx < rteEnd) {
          contentEnd = closeIdx;
          nextPtPos = closeIdx + 8;
        }
      }

      const coords = parsePointAttrsDirect(rteptPos + 6, isSelfClosing ? tagEnd - 1 : tagEnd);
      if (!coords) {
        rteptPos = nextPtPos;
        linearIndex++;
        ptIndex++;
        continue;
      }
      lineCoords.push(coords);

      let tags: ExtractedChildText = {};
      if (!isSelfClosing && contentEnd > tagEnd + 1) {
        tags = parseTagsDirect(tagEnd + 1, contentEnd);
      }

      linearPoints.push({
        id: 'rte-' + rteIndex + '-' + ptIndex,
        name: tags.name || (rteName + ' pt ' + ptIndex),
        ll: coords,
        kind: 'rtept',
        ele: tags.ele,
        desc: tags.desc,
        time: tags.time,
      });

      rteptPos = nextPtPos;
      linearIndex++;
      ptIndex++;
    }

    if (lineCoords.length > 0) {
      tracks.push({ name: rteName, points: lineCoords });
    }

    rtePos = rteEnd + (rteClose !== -1 ? 6 : 0);
    rteIndex++;
  }

  // Parse tracks: <trk>...</trk>
  let trkPos = 0;
  let trkIndex = 1;
  while ((trkPos = text.indexOf('<trk', trkPos)) !== -1) {
    const nextChar = text.charCodeAt(trkPos + 4);
    if (nextChar !== 32 && nextChar !== 9 && nextChar !== 10 && nextChar !== 13 && nextChar !== 62 && nextChar !== 47) {
      trkPos += 4;
      continue;
    }
    const trkClose = text.indexOf('</trk>', trkPos + 4);
    const trkEnd = trkClose !== -1 ? trkClose : text.length;

    let trkName = `Track ${trkIndex}`;
    const firstSeg = text.indexOf('<trkseg', trkPos);
    const headerEnd = firstSeg !== -1 && firstSeg < trkEnd ? firstSeg : trkEnd;
    const nameStart = text.indexOf('<name>', trkPos);
    if (nameStart !== -1 && nameStart < headerEnd) {
      const nameEnd = text.indexOf('</name>', nameStart + 6);
      if (nameEnd !== -1 && nameEnd < headerEnd) {
        const parsedName = cleanTagText(text.slice(nameStart + 6, nameEnd));
        if (parsedName) trkName = parsedName;
      }
    }

    // Count how many trkseg are in this trk
    let segCount = 0;
    let countPos = trkPos;
    while ((countPos = text.indexOf('<trkseg', countPos)) !== -1 && countPos < trkEnd) {
      const nextC = text.charCodeAt(countPos + 7);
      if (nextC === 32 || nextC === 9 || nextC === 10 || nextC === 13 || nextC === 62 || nextC === 47) {
        segCount++;
      }
      countPos += 7;
    }

    let segPos = trkPos;
    let segIndex = 1;

    while ((segPos = text.indexOf('<trkseg', segPos)) !== -1 && segPos < trkEnd) {
      const nextChar = text.charCodeAt(segPos + 7);
      if (nextChar !== 32 && nextChar !== 9 && nextChar !== 10 && nextChar !== 13 && nextChar !== 62 && nextChar !== 47) {
        segPos += 7;
        continue;
      }
      const segClose = text.indexOf('</trkseg>', segPos + 7);
      const segEnd = segClose !== -1 && segClose < trkEnd ? segClose : trkEnd;

      const lineCoords: LatLon[] = [];
      let ptIndex = 1;
      let trkptPos = segPos;

      while ((trkptPos = text.indexOf('<trkpt', trkptPos)) !== -1 && trkptPos < segEnd) {
        const nextC = text.charCodeAt(trkptPos + 6);
        if (nextC !== 32 && nextC !== 9 && nextC !== 10 && nextC !== 13 && nextC !== 62 && nextC !== 47) {
          trkptPos += 6;
          continue;
        }

        const isKept =
          !needsDecimation ||
          linearIndex === 0 ||
          linearIndex === totalLinearEst - 1 ||
          linearIndex % stride === 0;

        if (!isKept) {
          trkptPos += 6;
          linearIndex++;
          ptIndex++;
          continue;
        }

        const tagEnd = text.indexOf('>', trkptPos + 6);
        if (tagEnd === -1 || tagEnd >= segEnd) break;

        const isSelfClosing = text.charCodeAt(tagEnd - 1) === 47;
        let contentEnd = tagEnd;
        let nextPos = tagEnd + 1;

        if (!isSelfClosing) {
          const closeIdx = text.indexOf('</trkpt>', tagEnd + 1);
          if (closeIdx !== -1 && closeIdx < segEnd) {
            contentEnd = closeIdx;
            nextPos = closeIdx + 8;
          }
        }

        const coords = parsePointAttrsDirect(trkptPos + 6, isSelfClosing ? tagEnd - 1 : tagEnd);
        if (!coords) {
          trkptPos = nextPos;
          linearIndex++;
          ptIndex++;
          continue;
        }
        lineCoords.push(coords);

        let tags: ExtractedChildText = {};
        if (!isSelfClosing && contentEnd > tagEnd + 1) {
          tags = parseTagsDirect(tagEnd + 1, contentEnd);
        }

        linearPoints.push({
          id: 'trk-' + trkIndex + '-' + segIndex + '-' + ptIndex,
          name: tags.name || (trkName + ' pt ' + ptIndex),
          ll: coords,
          kind: 'trkpt',
          ele: tags.ele,
          desc: tags.desc,
          time: tags.time,
        });

        trkptPos = nextPos;
        linearIndex++;
        ptIndex++;
      }

      if (lineCoords.length > 0) {
        const segName = segCount > 1 ? trkName + ' (seg ' + segIndex + ')' : trkName;
        tracks.push({ name: segName, points: lineCoords });
      }

      segPos = segEnd + (segClose !== -1 ? 9 : 0);
      segIndex++;
    }

    trkPos = trkEnd + (trkClose !== -1 ? 6 : 0);
    trkIndex++;
  }

  const totalPointsInFile = waypoints.length + linearIndex;
  if (totalPointsInFile === 0) {
    return { ok: false, error: 'No valid waypoints, track points, or route points found in GPX.' };
  }

  const finalPoints: GpxPoint[] = [...waypoints, ...linearPoints];
  const wasDecimated = needsDecimation;
  const notice = wasDecimated
    ? `Large GPX (${totalPointsInFile.toLocaleString()} points) decimated to ${finalPoints.length.toLocaleString()} points for smooth display.`
    : undefined;

  return {
    ok: true,
    fileName,
    points: finalPoints,
    tracks,
    totalPointsInFile,
    wasDecimated,
    notice,
    rawGpx: xmlText,
  };
}

function parseDomGpx(
  xmlText: string,
  fileName: string,
  byteLength: number,
): GpxResult {
  let doc: Document;
  try {
    const parser = new DOMParser();
    doc = parser.parseFromString(xmlText, 'application/xml');
  } catch (err) {
    return {
      ok: false,
      error: `Could not parse GPX file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Check for DOMParser error document
  const parserErrors = doc.querySelectorAll('parsererror');
  if (parserErrors.length > 0) {
    const msg = parserErrors[0]?.textContent?.trim() || 'Malformed XML';
    return {
      ok: false,
      error: `Invalid GPX file: ${msg.split('\n')[0]}`,
    };
  }

  const root = doc.documentElement;
  if (!root) {
    return { ok: false, error: 'Invalid GPX file: empty XML document.' };
  }

  const rootName = (root.localName || root.nodeName).toLowerCase().replace(/^.*:/, '');
  if (rootName !== 'gpx') {
    return { ok: false, error: 'Invalid GPX file: root element must be <gpx>.' };
  }

  const waypoints: GpxPoint[] = [];
  const wptNodes = findElementsByLocalName(doc, 'wpt');
  let wptIndex = 1;

  for (const wpt of wptNodes) {
    const coords = parsePointCoordinates(wpt);
    if (!coords) continue;

    const props = extractChildProperties(wpt);
    const name = props.name || `Waypoint ${wptIndex}`;

    waypoints.push({
      id: `wpt-${wptIndex}`,
      name,
      ll: coords,
      kind: 'wpt',
      ele: props.ele,
      desc: props.desc,
      time: props.time,
    });
    wptIndex++;
  }

  // Routes
  const routePoints: GpxPoint[] = [];
  const tracks: GpxTrackSegment[] = [];
  const rteNodes = findElementsByLocalName(doc, 'rte');
  let rteIndex = 1;

  for (const rte of rteNodes) {
    const rteProps = extractChildProperties(rte);
    const rteName = rteProps.name || `Route ${rteIndex}`;
    const rteptNodes = findElementsByLocalName(rte, 'rtept');
    const lineCoords: LatLon[] = [];
    let ptIndex = 1;

    for (const rtept of rteptNodes) {
      const coords = parsePointCoordinates(rtept);
      if (!coords) continue;
      lineCoords.push(coords);

      const props = extractChildProperties(rtept);
      const name = props.name || `${rteName} pt ${ptIndex}`;

      routePoints.push({
        id: `rte-${rteIndex}-${ptIndex}`,
        name,
        ll: coords,
        kind: 'rtept',
        ele: props.ele,
        desc: props.desc,
        time: props.time,
      });
      ptIndex++;
    }

    if (lineCoords.length > 0) {
      tracks.push({ name: rteName, points: lineCoords });
    }
    rteIndex++;
  }

  // Tracks
  const trackPoints: GpxPoint[] = [];
  const trkNodes = findElementsByLocalName(doc, 'trk');
  let trkIndex = 1;

  for (const trk of trkNodes) {
    const trkProps = extractChildProperties(trk);
    const trkName = trkProps.name || `Track ${trkIndex}`;
    const trksegNodes = findElementsByLocalName(trk, 'trkseg');
    let segIndex = 1;

    for (const trkseg of trksegNodes) {
      const trkptNodes = findElementsByLocalName(trkseg, 'trkpt');
      const lineCoords: LatLon[] = [];
      let ptIndex = 1;

      for (const trkpt of trkptNodes) {
        const coords = parsePointCoordinates(trkpt);
        if (!coords) continue;
        lineCoords.push(coords);

        const props = extractChildProperties(trkpt);
        const name = props.name || `${trkName} pt ${ptIndex}`;

        trackPoints.push({
          id: `trk-${trkIndex}-${segIndex}-${ptIndex}`,
          name,
          ll: coords,
          kind: 'trkpt',
          ele: props.ele,
          desc: props.desc,
          time: props.time,
        });
        ptIndex++;
      }

      if (lineCoords.length > 0) {
        const segName = trksegNodes.length > 1 ? `${trkName} (seg ${segIndex})` : trkName;
        tracks.push({ name: segName, points: lineCoords });
      }
      segIndex++;
    }
    trkIndex++;
  }

  const totalPointsInFile = waypoints.length + routePoints.length + trackPoints.length;

  if (totalPointsInFile === 0) {
    return { ok: false, error: 'No valid waypoints, track points, or route points found in GPX.' };
  }

  const needsDecimation =
    byteLength > LARGE_FILE_THRESHOLD_BYTES || totalPointsInFile > LARGE_POINT_COUNT_THRESHOLD;

  let finalPoints: GpxPoint[];
  let wasDecimated = false;
  let notice: string | undefined;

  if (!needsDecimation) {
    finalPoints = [...waypoints, ...routePoints, ...trackPoints];
  } else {
    wasDecimated = true;
    // Always preserve all waypoints (wpts are discrete landmarks/GCPS)
    const combinedLinearPoints = [...routePoints, ...trackPoints];
    const availableBudget = Math.max(1000, MAX_DISPLAY_POINTS - waypoints.length);
    const stride = Math.max(1, Math.ceil(combinedLinearPoints.length / availableBudget));

    const decimatedLinear: GpxPoint[] = [];
    for (let i = 0; i < combinedLinearPoints.length; i++) {
      // Keep endpoints and every stride-th point
      if (i === 0 || i === combinedLinearPoints.length - 1 || i % stride === 0) {
        decimatedLinear.push(combinedLinearPoints[i]!);
      }
    }

    finalPoints = [...waypoints, ...decimatedLinear];
    notice = `Large GPX (${totalPointsInFile.toLocaleString()} points) decimated to ${finalPoints.length.toLocaleString()} points for smooth display.`;
  }

  return {
    ok: true,
    fileName,
    points: finalPoints,
    tracks,
    totalPointsInFile,
    wasDecimated,
    notice,
    rawGpx: xmlText,
  };
}

/**
 * Parse a GPX 1.0 or 1.1 XML string into candidate points and track polylines.
 * Handles malformed input safely without throwing into the UI.
 * Decimates files over 10 MB or with more than 50k points for smooth rendering.
 */
export function parseGpx(
  xmlText: string,
  fileNameOrOptions?: string | ParseGpxOptions,
  fileSizeBytes?: number,
): GpxResult {
  if (!xmlText || typeof xmlText !== 'string' || !xmlText.trim()) {
    return { ok: false, error: 'The GPX file is empty.' };
  }

  const forceEngine = typeof fileNameOrOptions === 'object' ? fileNameOrOptions.forceEngine : undefined;
  const fileName = (typeof fileNameOrOptions === 'object' ? fileNameOrOptions.fileName : fileNameOrOptions) ?? 'track.gpx';
  const byteLength = (typeof fileNameOrOptions === 'object' ? fileNameOrOptions.fileSizeBytes : fileSizeBytes) ??
    (xmlText.length > 500_000 ? xmlText.length : new TextEncoder().encode(xmlText).length);

  // If forceEngine is 'fast', use parseFastGpx directly.
  // If forceEngine is 'dom', use DOMParser directly.
  // Otherwise, use parseFastGpx for large files (> FAST_GPX_THRESHOLD_BYTES) unless
  // the XML contains constructs requiring DOMParser (entities, CDATA, comments, prefixes, spaced attributes).
  const shouldUseFast =
    forceEngine === 'fast' ||
    (forceEngine !== 'dom' &&
      (byteLength > FAST_GPX_THRESHOLD_BYTES || xmlText.length > FAST_GPX_THRESHOLD_BYTES) &&
      !hasXmlIncompatibilities(xmlText));

  if (shouldUseFast) {
    return parseFastGpx(xmlText, fileName, byteLength);
  }

  return parseDomGpx(xmlText, fileName, byteLength);
}
