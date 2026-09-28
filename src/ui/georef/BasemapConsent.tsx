import React, { type FC, useMemo, useRef } from 'react';
import { useFocusTrap } from './focusTrap';

void React;

export interface BasemapConsentProps {
  styleUrl: string;
  geocoderUrl?: string;
  geocoderEnabled?: boolean;
  onToggleGeocoder?: (enabled: boolean) => void;
  onEnable: () => void;
  onDismiss: () => void;
  isDismissed?: boolean;
  onOpenSettings?: () => void;
}

export function getStyleHost(styleUrl: string): string {
  try {
    const origin = typeof window !== 'undefined' ? window.location.href : 'http://localhost';
    const parsed = new URL(styleUrl, origin);
    return parsed.host || styleUrl;
  } catch {
    return styleUrl;
  }
}

export const BasemapConsent: FC<BasemapConsentProps> = ({
  styleUrl,
  geocoderUrl,
  geocoderEnabled = false,
  onToggleGeocoder,
  onEnable,
  onDismiss,
  isDismissed = false,
  onOpenSettings,
}) => {
  const host = useMemo(() => getStyleHost(styleUrl), [styleUrl]);
  const geocoderHost = useMemo(() => (geocoderUrl ? getStyleHost(geocoderUrl) : ''), [geocoderUrl]);
  const cardRef = useRef<HTMLDivElement>(null);

  useFocusTrap({
    active: !isDismissed,
    containerRef: cardRef,
    onClose: onDismiss,
  });

  if (isDismissed) {
    return (
      <div
        className="trailmaker-basemap-disabled-placeholder"
        role="region"
        aria-label="Basemap disabled"
      >
        <div className="trailmaker-basemap-disabled-card">
          <p className="trailmaker-basemap-disabled-text">Basemap is disabled.</p>
          <div className="trailmaker-basemap-consent-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={onEnable}
              aria-label="Enable basemap"
            >
              Enable basemap
            </button>
            {onOpenSettings && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onOpenSettings}
                aria-label="Basemap settings"
              >
                Settings
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="trailmaker-basemap-consent-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="basemap-consent-title"
    >
      <div ref={cardRef} className="trailmaker-basemap-consent-card">
        <h3 id="basemap-consent-title" className="trailmaker-basemap-consent-title">
          Live Basemap
        </h3>
        <p className="trailmaker-basemap-consent-text">
          Shows a live map from {host}. Your map image and trails stay on this device; the tile
          server sees which area you view.
        </p>
        {onToggleGeocoder && geocoderHost && (
          <label className="trailmaker-geocoder-consent">
            <input
              type="checkbox"
              checked={geocoderEnabled}
              onChange={(event) => onToggleGeocoder(event.target.checked)}
            />
            <span>
              Sends your search text to {geocoderHost}. No map image, coordinates, or project data
              is sent.
            </span>
          </label>
        )}
        <div className="trailmaker-basemap-consent-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={onEnable}
            aria-label="Enable basemap"
          >
            Enable
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onDismiss}
            aria-label="Not now"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
};

