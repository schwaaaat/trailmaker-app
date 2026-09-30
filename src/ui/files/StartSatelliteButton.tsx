// Lane C: "Start from satellite" entry button (card T-318, D-031).
import React, { type FC, useEffect, useState } from 'react';
import { loadSettings, subscribeSettings, updateBasemapSettings, type AppSettings } from '../../io/settings';
import { useOnlineStatus } from '../georef/satellite';
import { BasemapConsent } from '../georef/BasemapConsent';
import { requestSatelliteCapture } from '../../state/store';

import type { SessionBridge } from '../contract';

void React;

export interface StartSatelliteButtonProps {
  readonly className?: string | undefined;
  readonly id?: string | undefined;
  readonly label?: string | undefined;
  readonly onStart?: (() => void) | undefined;
  readonly showToast?: ((message: string) => void) | undefined;
  readonly bridge?: SessionBridge | undefined;
}

export const StartSatelliteButton: FC<StartSatelliteButtonProps> = ({
  className = 'btn',
  id = 'startSatelliteBtn',
  label = 'Start from satellite',
  onStart,
}) => {
  const isOnline = useOnlineStatus();
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [showConsent, setShowConsent] = useState(false);

  useEffect(() => {
    return subscribeSettings(setSettings);
  }, []);

  const handleClick = () => {
    if (!isOnline) return;

    if (!settings.basemap.enabled) {
      setShowConsent(true);
      return;
    }

    // Switch to satellite imagery
    updateBasemapSettings({ imagery: 'satellite' });

    // Request satellite capture through app store (T-318)
    requestSatelliteCapture();

    onStart?.();
  };

  const handleConsentGranted = () => {
    updateBasemapSettings({ enabled: true, imagery: 'satellite' });
    setShowConsent(false);

    // Request satellite capture through app store (T-318)
    requestSatelliteCapture();

    onStart?.();
  };

  const offlineTooltip = 'Satellite view requires an internet connection';

  return (
    <>
      <button
        type="button"
        id={id}
        className={`${className} ${!isOnline ? 'offline' : ''}`}
        disabled={!isOnline}
        onClick={handleClick}
        title={!isOnline ? offlineTooltip : 'Make a map from scratch using satellite imagery'}
        aria-label={!isOnline ? `${label} (${offlineTooltip})` : label}
      >
        {label}
      </button>

      {showConsent && (
        <BasemapConsent
          styleUrl={settings.basemap.styleUrl}
          satelliteHost="imagery.nationalmap.gov"
          onEnable={handleConsentGranted}
          onDismiss={() => setShowConsent(false)}
        />
      )}
    </>
  );
};
