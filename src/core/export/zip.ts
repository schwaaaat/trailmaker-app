// Lane B. Deterministic zip writing shared by the KMZ and the "Download all" bundle.
import { zipSync, type Zippable } from 'fflate';

const DOS_MIN = Date.UTC(1980, 0, 1);
const DOS_MAX = Date.UTC(2099, 11, 31, 23, 59, 58);

/**
 * The mtime to give fflate so zip entries carry `isoTime` as UTC fields. fflate encodes a
 * Date's *local* fields, so the Date is shifted so its local fields read as UTC, independent of
 * the machine's time zone. Out-of-range or invalid times clamp to the DOS date range (1980..2099).
 */
export function zipMtime(isoTime: string): Date {
  const parsed = Date.parse(isoTime);
  const utc = Math.min(DOS_MAX, Math.max(DOS_MIN, Number.isNaN(parsed) ? DOS_MIN : parsed));
  return new Date(utc + new Date(utc).getTimezoneOffset() * 60_000);
}

/** Zip entries (in insertion order) with every timestamp taken from `isoTime`, so the bytes depend only on the inputs. */
export function zipDeterministic(entries: Zippable, isoTime: string): Uint8Array {
  return zipSync(entries, { mtime: zipMtime(isoTime) });
}
