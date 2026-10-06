export interface TileEstimateState {
  readonly estimatedBytes: number;
  readonly estimatedSeconds: number;
  readonly enoughSpace: boolean | null;
}

export interface TileProgressState {
  readonly complete: number;
  readonly total: number;
  readonly missing: number;
}

export interface TiledDownloadUiState {
  readonly estimate: TileEstimateState | null;
  readonly progress: TileProgressState | null;
}

/** A new tile session must never inherit estimate or progress from an earlier plan. */
export function resetTiledDownloadUiState(): TiledDownloadUiState {
  return { estimate: null, progress: null };
}

/** Keep stale estimates from authorizing a download while its replacement session loads. */
export function isTiledDownloadDisabled(
  loading: boolean,
  downloading: boolean,
  enoughSpace: boolean | null | undefined,
  storageConfirmed: boolean,
): boolean {
  return loading || downloading || (enoughSpace === false && !storageConfirmed);
}
