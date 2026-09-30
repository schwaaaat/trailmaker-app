import React, { type FC, useEffect, useRef, useState } from 'react';
import {
  RESET_INTERFACE_ITEMS,
  RESET_INTERFACE_NOTE,
  resetSettings,
  type SatelliteProviderId,
} from '../../io/settings';
import { useFocusTrap } from './focusTrap';
import { getSatelliteHost } from './satellite';

void React;

export interface BasemapSettingsPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  styleUrl: string;
  enabled: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  onChangeStyleUrl: (url: string) => void;
  onResetStyleUrl: () => void;
  onResetInterface?: (() => void) | undefined;
  satelliteProvider?: SatelliteProviderId;
  onChangeSatelliteProvider?: (provider: SatelliteProviderId) => void;
  esriApiKey?: string;
  onChangeEsriApiKey?: (key: string) => void;
  onStartFraming?: () => void;
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
  onResetInterface,
  satelliteProvider = 'naip',
  onChangeSatelliteProvider,
  esriApiKey = '',
  onChangeEsriApiKey,
  onStartFraming,
  geocoderUrl = '',
  geocoderEnabled = false,
  onToggleGeocoder,
  onChangeGeocoderUrl,
  onResetGeocoderUrl,
}) => {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);

  useFocusTrap({
    active: isOpen,
    containerRef: popoverRef,
    onClose,
  });

  useEffect(() => {
    if (!isOpen) setConfirmingReset(false);
  }, [isOpen]);

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

      {confirmingReset ? (
        <div
          className="trailmaker-reset-interface-confirm"
          role="alertdialog"
          aria-labelledby="popover-reset-confirm-title"
        >
          <h4 id="popover-reset-confirm-title" className="trailmaker-basemap-settings-title">
            Reset interface to defaults?
          </h4>
          <p className="trailmaker-reset-confirm-desc">This will reset:</p>
          <ul className="trailmaker-reset-confirm-list">
            {RESET_INTERFACE_ITEMS.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
          <p className="trailmaker-reset-confirm-note">{RESET_INTERFACE_NOTE}</p>
          <div className="trailmaker-basemap-settings-actions">
            <button
              type="button"
              className="btn btn-danger trailmaker-btn-confirm-reset"
              onClick={() => {
                if (onResetInterface) {
                  onResetInterface();
                } else {
                  resetSettings();
                }
                setConfirmingReset(false);
                onClose();
              }}
              aria-label="Confirm reset interface"
            >
              Reset interface
            </button>
            <button
              type="button"
              className="btn btn-secondary trailmaker-btn-cancel-reset"
              onClick={() => setConfirmingReset(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
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

        <div className="trailmaker-basemap-setting-row">
          <label htmlFor="satellite-provider-select" className="trailmaker-basemap-label">
            Satellite imagery source
          </label>
          <select
            id="satellite-provider-select"
            className="trailmaker-basemap-input trailmaker-basemap-select"
            value={satelliteProvider}
            onChange={(e) =>
              onChangeSatelliteProvider?.(e.target.value as SatelliteProviderId)
            }
            aria-label="Satellite imagery source"
          >
            <option value="naip">
              USGS NAIP (US, sharpest)
            </option>
            <option value="usgs">
              USGS Imagery Only (basemap.nationalmap.gov — US, public domain)
            </option>
            <option value="esri" disabled={!esriApiKey.trim()}>
              Esri World Imagery{esriApiKey ? '' : ' (requires ArcGIS API key)'}
            </option>
          </select>
          <label htmlFor="esri-api-key-input" className="trailmaker-basemap-label">
            ArcGIS API key
          </label>
          <input
            type="password"
            id="esri-api-key-input"
            className="trailmaker-basemap-input"
            value={esriApiKey}
            autoComplete="new-password"
            onChange={(e) => onChangeEsriApiKey?.(e.target.value)}
            aria-label="ArcGIS API key"
          />
          {!esriApiKey && (
            <p className="trailmaker-geocoder-settings-disclosure">
              Esri imagery is disabled until you add your own key.{' '}
              <a href="https://developers.arcgis.com/sign-up/" target="_blank" rel="noreferrer">
                Create a free ArcGIS developer account
              </a>.
            </p>
          )}
          <p className="trailmaker-geocoder-settings-disclosure">
            Saved in this browser only and sent with Esri tile requests. Restrict the key to this
            site&apos;s address in the ArcGIS dashboard. Esri imagery is for non-revenue apps under
            1 million tiles per month; give the required credit. Offline capture is unavailable.
          </p>
          <p className="trailmaker-geocoder-settings-disclosure">
            Tiles are requested directly from {getSatelliteHost(satelliteProvider)}. No map image or project data is sent.
          </p>
          {onStartFraming && (
            <div style={{ marginTop: '8px' }}>
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  onClose();
                  onStartFraming();
                }}
                aria-label="Use this view as my map"
              >
                Use this view as my map
              </button>
            </div>
          )}
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
            className="btn btn-secondary trailmaker-btn-reset-interface"
            onClick={() => setConfirmingReset(true)}
            aria-label="Reset interface"
          >
            Reset interface…
          </button>
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
    )}
  </div>
);
};
