// Lane C. Imported GPX points list component (card T-312).
import React, { useId, useMemo, useState } from 'react';
import type { GpxPoint } from '../../io/gpx';
import type { StoredGpxLayer } from '../../io/gpxStorage';

void React;

export interface GpxPointsListProps {
  readonly gpx: StoredGpxLayer;
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onSelectPoint: (point: GpxPoint) => void;
  readonly onClearGpx: () => void;
}

const MAX_RENDERED_POINTS = 100;

export function GpxPointsList({
  gpx,
  isOpen,
  onClose,
  onSelectPoint,
  onClearGpx,
}: GpxPointsListProps) {
  const [filterQuery, setFilterQuery] = useState('');
  const titleId = useId();
  const searchId = useId();

  const filteredPoints = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    if (!q) return gpx.points;
    return gpx.points.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.desc && p.desc.toLowerCase().includes(q)) ||
        p.kind.toLowerCase().includes(q),
    );
  }, [gpx.points, filterQuery]);

  const displayedPoints = useMemo(() => {
    return filteredPoints.slice(0, MAX_RENDERED_POINTS);
  }, [filteredPoints]);

  if (!isOpen) return null;

  return (
    <div
      className="trailmaker-gpx-list-drawer"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
    >
      <div className="trailmaker-gpx-list-header">
        <div>
          <h3 id={titleId} className="trailmaker-gpx-list-title">
            GPX Points ({gpx.points.length})
          </h3>
          <div className="trailmaker-gpx-list-subtitle">
            {gpx.fileName}
            {gpx.wasDecimated ? ` (decimated from ${gpx.totalPointsInFile})` : ''}
          </div>
        </div>
        <button
          type="button"
          className="trailmaker-basemap-close-btn"
          onClick={onClose}
          aria-label="Close GPX points list"
        >
          ×
        </button>
      </div>

      <div className="trailmaker-gpx-list-filter-row">
        <label htmlFor={searchId} className="sr-only">
          Filter points by name
        </label>
        <input
          id={searchId}
          type="search"
          className="trailmaker-basemap-input"
          placeholder="Filter points by name…"
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
          aria-label="Filter points by name"
        />
      </div>

      {gpx.notice && (
        <div className="trailmaker-gpx-list-notice" role="status">
          {gpx.notice}
        </div>
      )}

      <ul className="trailmaker-gpx-list-items" role="list">
        {displayedPoints.length === 0 ? (
          <li className="trailmaker-gpx-list-empty">No points match “{filterQuery}”.</li>
        ) : (
          displayedPoints.map((pt) => {
            const latStr = pt.ll[0].toFixed(5);
            const lonStr = pt.ll[1].toFixed(5);
            return (
              <li key={pt.id} className="trailmaker-gpx-list-item">
                <button
                  type="button"
                  className="trailmaker-gpx-point-btn"
                  onClick={() => onSelectPoint(pt)}
                  aria-label={`Pair with ${pt.name} (${pt.kind}) at ${latStr}, ${lonStr}`}
                >
                  <span className="trailmaker-gpx-point-name">{pt.name}</span>
                  <span className="trailmaker-gpx-point-meta">
                    <span className={`trailmaker-gpx-kind-badge kind-${pt.kind}`}>{pt.kind}</span>
                    <span className="trailmaker-gpx-coords">
                      {latStr}, {lonStr}
                    </span>
                  </span>
                </button>
              </li>
            );
          })
        )}
      </ul>

      {filteredPoints.length > MAX_RENDERED_POINTS && (
        <div className="trailmaker-gpx-list-more">
          Showing {MAX_RENDERED_POINTS} of {filteredPoints.length} points. Use filter to narrow.
        </div>
      )}

      <div className="trailmaker-gpx-list-footer">
        <button
          type="button"
          className="btn"
          onClick={onClearGpx}
          aria-label="Remove imported GPX layer"
        >
          Remove GPX
        </button>
      </div>
    </div>
  );
}
