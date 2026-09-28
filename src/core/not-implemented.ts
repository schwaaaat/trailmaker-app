// M0 contract seed (DECISIONS D-004). Each stub below throws until its card lands.
// A card is not done while its module still calls notImplemented(). The Architect deletes
// this file when nothing imports it.

/** Throws the standard "not implemented" error for a contract stub. */
export function notImplemented(what: string): never {
  throw new Error(`not implemented: ${what}`);
}
