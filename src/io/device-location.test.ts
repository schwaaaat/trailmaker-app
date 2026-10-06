import { describe, expect, it, vi } from 'vitest';
import { startDeviceLocationWatch, type GeolocationPort } from './device-location';

describe('device location watch', () => {
  it('requests local high-accuracy fixes and releases the watch', () => {
    const fix = vi.fn();
    const error = vi.fn();
    const clearWatch = vi.fn();
    let onSuccess!: PositionCallback;
    let options!: PositionOptions;
    const geolocation: GeolocationPort = {
      watchPosition(success, _error, requestedOptions) {
        onSuccess = success;
        options = requestedOptions!;
        return 19;
      },
      clearWatch,
    };

    const stop = startDeviceLocationWatch(fix, error, geolocation);
    onSuccess({ coords: { latitude: 27.1, longitude: -80.2, accuracy: 8 } } as GeolocationPosition);

    expect(fix).toHaveBeenCalledWith({ location: [27.1, -80.2], accuracyMeters: 8 });
    expect(options).toMatchObject({ enableHighAccuracy: true, maximumAge: 5_000, timeout: 30_000 });
    expect(error).not.toHaveBeenCalled();
    stop();
    expect(clearWatch).toHaveBeenCalledWith(19);
  });

  it('explains denied permission without retaining the location', () => {
    const onError = vi.fn();
    const geolocation: GeolocationPort = {
      watchPosition(_success, error) {
        error?.({ code: 1 } as GeolocationPositionError);
        return 2;
      },
      clearWatch: vi.fn(),
    };

    startDeviceLocationWatch(vi.fn(), onError, geolocation);

    expect(onError).toHaveBeenCalledWith(
      'Location permission was denied. Enable location access to show your position.',
    );
  });
});
