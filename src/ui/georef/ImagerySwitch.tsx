// Lane C: Map / Satellite imagery switch component (card T-316).
import React, { type FC } from 'react';
import type { BasemapImageryType } from '../../io/settings';
import { useOnlineStatus } from './satellite';

void React;

export interface ImagerySwitchProps {
  imagery: BasemapImageryType;
  onChange: (imagery: BasemapImageryType) => void;
  className?: string;
  isOnline?: boolean;
}

export const ImagerySwitch: FC<ImagerySwitchProps> = ({
  imagery,
  onChange,
  className = '',
  isOnline: isOnlineProp,
}) => {
  const detectedOnline = useOnlineStatus();
  const isOnline = isOnlineProp !== undefined ? isOnlineProp : detectedOnline;

  return (
    <div
      className={`trailmaker-imagery-switch ${className}`}
      role="group"
      aria-label="Map imagery"
    >
      <button
        type="button"
        className={`trailmaker-imagery-btn ${imagery === 'vector' ? 'active' : ''}`}
        onClick={() => onChange('vector')}
        aria-pressed={imagery === 'vector'}
        title="Vector street and terrain map"
      >
        Map
      </button>
      <button
        type="button"
        className={`trailmaker-imagery-btn ${imagery === 'satellite' ? 'active' : ''} ${!isOnline ? 'offline' : ''}`}
        onClick={() => {
          if (!isOnline) return;
          onChange('satellite');
        }}
        aria-pressed={imagery === 'satellite'}
        disabled={!isOnline}
        title={!isOnline ? 'Satellite needs a connection' : 'Satellite imagery'}
        aria-label={!isOnline ? 'Satellite (Satellite needs a connection)' : 'Satellite'}
      >
        Satellite
      </button>
      {!isOnline && (
        <span
          className="trailmaker-imagery-offline-notice"
          role="status"
          aria-live="polite"
        >
          Satellite needs a connection
        </span>
      )}
    </div>
  );
};
