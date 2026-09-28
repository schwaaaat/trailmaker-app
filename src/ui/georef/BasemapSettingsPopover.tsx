import React, { type FC, useEffect, useRef } from 'react';
import { useFocusTrap } from './focusTrap';

void React;

export interface BasemapSettingsPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  styleUrl: string;
  enabled: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  onChangeStyleUrl: (url: string) => void;
  onResetStyleUrl: () => void;
  geocoderUrl?: string;
  geocoderEnabled?: boolean;
  onToggleGeocoder?: (enabled: boolean) => void;
  onChangeGeocoderUrl?: (url: string) => void;
  onResetGeocoderUrl?: () => void;
}

function getGeocoderHost(serviceUrl: string): string {
  try {
    const origin = typeof window !== 'undefined' ? window.location.href : 'http://localhost';
    return new URL(serviceUrl, origin).host || serviceUrl;
  } catch {
    return serviceUrl;
  }
}

export const BasemapSettingsPopover: FC<BasemapSettingsPopoverProps> = ({
  isOpen,
  onClose,
  styleUrl,
  enabled,
  onToggleEnabled,
  onChangeStyleUrl,
  onResetStyleUrl,
  geocoderUrl = '',
  geocoderEnabled = false,
  onToggleGeocoder,
  onChangeGeocoderUrl,
  onResetGeocoderUrl,
}) => {
  const popoverRef = useRef<HTMLDivElement>(null);

  useFocusTrap({
    active: isOpen,
    containerRef: popoverRef,
    onClose,
  });

  useEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(event: MouseEvent): void {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose]);

  const geocoderHost = geocoderUrl ? getGeocoderHost(geocoderUrl) : '';

  if (!isOpen) return null;

  return (
    <div
      ref={popoverRef}
      className="trailmaker-basemap-settings-popover"
      role="dialog"
      aria-modal="true"
      aria-label="Basemap settings"
      aria-labelledby="basemap-settings-title"
    >
      <div className="trailmaker-basemap-settings-header">
        <h4 id="basemap-settings-title" className="trailmaker-basemap-settings-title">
          Basemap Settings
        </h4>
        <button
          type="button"
          className="trailmaker-basemap-close-btn"
          onClick={onClose}
          aria-label="Close settings"
        >
          ×
        </button>
      </div>

      <div className="trailmaker-basemap-settings-content">
        <label className="trailmaker-basemap-setting-row trailmaker-basemap-toggle-row">
          <input
            type="checkbox"
            id="basemap-enabled-checkbox"
            checked={enabled}
            onChange={(e) => onToggleEnabled(e.target.checked)}
            aria-label="Enable basemap"
          />
          <span>Enable live basemap</span>
        </label>

        <div className="trailmaker-basemap-setting-row">
          <label htmlFor="basemap-style-url-input" className="trailmaker-basemap-label">
            Style URL
          </label>
          <input
            type="text"
            id="basemap-style-url-input"
            className="trailmaker-basemap-input"
            value={styleUrl}
            onChange={(e) => onChangeStyleUrl(e.target.value)}
            aria-label="Style URL"
          />
        </div>

        {onToggleGeocoder && onChangeGeocoderUrl && (
          <>
            <label className="trailmaker-basemap-setting-row trailmaker-basemap-toggle-row">
              <input
                type="checkbox"
                checked={geocoderEnabled}
                onChange={(e) => onToggleGeocoder(e.target.checked)}
                aria-label="Enable place search"
              />
              <span>Enable place search</span>
            </label>
            {geocoderHost && (
              <p className="trailmaker-geocoder-settings-disclosure">
                Sends your search text to {geocoderHost}. No map image, coordinates, or project data
                is sent.
              </p>
            )}
            <div className="trailmaker-basemap-setting-row">
              <label htmlFor="geocoder-service-url-input" className="trailmaker-basemap-label">
                Geocoder service URL
              </label>
              <input
                type="text"
                id="geocoder-service-url-input"
                className="trailmaker-basemap-input"
                value={geocoderUrl}
                onChange={(e) => onChangeGeocoderUrl(e.target.value)}
                aria-label="Geocoder service URL"
              />
            </div>
            {onResetGeocoderUrl && (
              <div className="trailmaker-basemap-settings-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={onResetGeocoderUrl}
                  aria-label="Reset geocoder to default"
                >
                  Reset geocoder to default
                </button>
              </div>
            )}
          </>
        )}

        <div className="trailmaker-basemap-settings-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onResetStyleUrl}
            aria-label="Reset to default"
          >
            Reset to default
          </button>
        </div>
      </div>
    </div>
  );
};
