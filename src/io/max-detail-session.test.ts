import { describe, expect, it, vi } from 'vitest';
import { createMaximumDetailFillInController } from './max-detail-session';
import type { DetailExportDownloadResult, PoliteExportDownloader } from './max-detail-downloader';
import { detailExportKey } from './max-detail-downloader';
import { planDetailExportAt } from './max-detail-planner';
import type { DetailExportCell } from './max-detail-planner';
import { detailExportLocalTiles, type DetailMapExtent } from './max-detail-export';

function fullNeighborhoodExtent(focus: [number, number]): DetailMapExtent {
  const center = planDetailExportAt(focus);
  return {
    sourceZoom: 20,
    origin: { x: center.left / 2 - 1024, y: center.top / 2 - 1024 },
    width: 3072,
    height: 3072,
    tileSize: 256,
  };
}

function fakeSession(): PoliteExportDownloader {
  let finish!: (result: DetailExportDownloadResult) => void;
  const promise = new Promise<DetailExportDownloadResult>((resolve) => {
    finish = resolve;
  });
  return {
    promise,
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(() =>
      finish({
        completed: [],
        completedKeys: [],
        missing: [],
        deferred: [],
        budgetExhausted: false,
        cancelled: true,
      }),
    ),
  };
}

describe('maximum-detail fill-in focus controller', () => {
  it('requests only neighborhood exports that overlap the saved map, center first', async () => {
    const focus: [number, number] = [27.135, -80.172];
    const center = planDetailExportAt(focus);
    let requestedCells: readonly DetailExportCell[] = [];
    const startDownload = vi.fn(
      async (
        _mapId: string,
        _sourceId: string,
        _extent: DetailMapExtent,
        cells: readonly DetailExportCell[],
      ) => {
        requestedCells = cells;
        return fakeSession();
      },
    );
    const controller = createMaximumDetailFillInController(
      'map-id',
      'martin-county',
      {
        sourceZoom: 20,
        origin: { x: center.left / 2, y: center.top / 2 },
        width: 3072,
        height: 2048,
        tileSize: 256,
      },
      { startDownload },
    );

    await controller.updateFocus(focus);
    await controller.setEnabled(true);

    expect(requestedCells.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: center.x, y: center.y },
      { x: center.x, y: center.y + 1 },
      { x: center.x + 1, y: center.y },
      { x: center.x + 1, y: center.y + 1 },
    ]);
    expect(startDownload).toHaveBeenCalledOnce();
  });

  it('starts off, reuses the current neighborhood, and cancels far queued cells on movement', async () => {
    const sessions: PoliteExportDownloader[] = [];
    const plans: Array<readonly DetailExportCell[]> = [];
    const focus: [number, number] = [27.135, -80.172];
    const startDownload = vi.fn(
      async (
        _mapId: string,
        _sourceId: string,
        _extent: DetailMapExtent,
        cells: readonly DetailExportCell[],
      ) => {
        plans.push(cells);
        const session = fakeSession();
        sessions.push(session);
        return session;
      },
    );
    const controller = createMaximumDetailFillInController(
      'map-id',
      'martin-county',
      fullNeighborhoodExtent(focus),
      { startDownload },
    );

    await controller.updateFocus(focus);
    expect(startDownload).not.toHaveBeenCalled();
    await controller.setEnabled(true);
    expect(startDownload).toHaveBeenCalledTimes(1);
    expect(plans[0]).toHaveLength(9);

    const firstCell = detailExportKey({ x: plans[0]![0]!.x, y: plans[0]![0]!.y });
    await controller.updateFocus([27.13501, -80.17201]);
    expect(startDownload).toHaveBeenCalledTimes(1);

    await controller.updateFocus([27.135, -80.162]);
    expect(sessions[0]!.cancel).toHaveBeenCalledOnce();
    expect(startDownload).toHaveBeenCalledTimes(2);
    expect(plans[1]!.some((cell) => detailExportKey(cell) === firstCell)).toBe(false);
    expect(
      plans[1]!.every(
        (cell) => detailExportLocalTiles(cell, fullNeighborhoodExtent(focus)).length > 0,
      ),
    ).toBe(true);

    await controller.setEnabled(false);
    await controller.updateFocus([27.135, -80.15]);
    expect(sessions[1]!.cancel).toHaveBeenCalledOnce();
    expect(startDownload).toHaveBeenCalledTimes(2);
  });

  it('reports a failed start and can retry the same focus on a later update', async () => {
    const startDownload = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(async () => fakeSession());
    const onError = vi.fn();
    const controller = createMaximumDetailFillInController(
      'map-id',
      'martin-county',
      fullNeighborhoodExtent([27.135, -80.172]),
      { startDownload, onError },
    );

    await controller.updateFocus([27.135, -80.172]);
    await expect(controller.setEnabled(true)).rejects.toThrow('offline');
    expect(onError).toHaveBeenCalledWith(expect.any(Error));

    await controller.updateFocus([27.13501, -80.17201]);
    expect(startDownload).toHaveBeenCalledTimes(2);
  });

  it('does not restart a completed same-cell neighborhood until disabled and re-enabled', async () => {
    const completedSession: PoliteExportDownloader = {
      promise: Promise.resolve({
        completed: [],
        completedKeys: [],
        missing: [],
        deferred: [],
        budgetExhausted: false,
        cancelled: false,
      }),
      pause: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
    };
    const startDownload = vi.fn(async () => completedSession);
    const controller = createMaximumDetailFillInController(
      'map-id',
      'martin-county',
      fullNeighborhoodExtent([27.135, -80.172]),
      { startDownload },
    );

    await controller.updateFocus([27.135, -80.172]);
    await controller.setEnabled(true);
    await Promise.resolve();
    await controller.updateFocus([27.13501, -80.17201]);
    expect(startDownload).toHaveBeenCalledOnce();

    await controller.setEnabled(false);
    await controller.setEnabled(true);
    expect(startDownload).toHaveBeenCalledTimes(2);
  });
});
