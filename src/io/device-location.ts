import type { DeviceLocationFix } from '../ui/georef/location-overlay';

export type GeolocationPort = Pick<Geolocation, 'watchPosition' | 'clearWatch'>;

function locationErrorMessage(error: GeolocationPositionError): string {
  if (error.code === 1) {
    return 'Location permission was denied. Enable location access to show your position.';
  }
  if (error.code === 3) return 'The location request timed out. Try again.';
  return 'Your location is unavailable right now.';
}

/** Watches device GPS locally and exposes only the current fix to its caller. */
export function startDeviceLocationWatch(
  onFix: (fix: DeviceLocationFix) => void,
  onError: (message: string) => void,
  geolocation: GeolocationPort | null = typeof navigator !== 'undefined'
    ? navigator.geolocation
    : null,
): () => void {
  if (!geolocation) {
    onError('Location is not available in this browser.');
    return () => {};
  }

  const watchId = geolocation.watchPosition(
    ({ coords }) => {
      onFix({
        location: [coords.latitude, coords.longitude],
        accuracyMeters: coords.accuracy,
      });
    },
    (error) => onError(locationErrorMessage(error)),
    { enableHighAccuracy: true, maximumAge: 5_000, timeout: 30_000 },
  );
  return () => geolocation.clearWatch(watchId);
}
