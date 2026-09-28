import React, { type FC, useEffect, useId, useRef, useState } from 'react';
import { GeocoderError, search, type GeocodeResult } from '../../io/geocoder';

void React;

export interface GeoSearchBoxProps {
  /** Place search remains absent until its independent D-018 opt-in is enabled. */
  enabled: boolean;
  onSelect: (result: GeocodeResult) => void;
  searchPlaces?: (query: string, signal?: AbortSignal) => Promise<GeocodeResult[]>;
  debounceMs?: number;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof GeocoderError)) return 'Place search is temporarily unavailable.';
  switch (error.code) {
    case 'disabled':
      return 'Enable place search in Settings to search.';
    case 'rate-limited':
      return 'Place search is paused after a rate limit. Try again in a minute.';
    case 'offline':
      return 'Place search is unavailable while offline.';
    case 'invalid-url':
      return 'Place search has an invalid service URL.';
    case 'invalid-response':
      return 'Place search returned an invalid response.';
    case 'service-unavailable':
      return 'Place search is temporarily unavailable.';
    default:
      return 'Place search is temporarily unavailable.';
  }
}

export const GeoSearchBox: FC<GeoSearchBoxProps> = ({
  enabled,
  onSelect,
  searchPlaces = search,
  debounceMs = 500,
}) => {
  const id = useId().replaceAll(':', '');
  const inputId = `geocoder-query-${id}`;
  const listboxId = `geocoder-results-${id}`;
  const controllerRef = useRef<AbortController | null>(null);
  const selectedQueryRef = useRef<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const typedQuery = query.trim();
    if (!enabled || !typedQuery || selectedQueryRef.current === typedQuery) {
      if (selectedQueryRef.current === typedQuery) selectedQueryRef.current = null;
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    const timeout = setTimeout(() => {
      setIsLoading(true);
      void searchPlaces(typedQuery, controller.signal)
        .then((places) => {
          if (controller.signal.aborted) return;
          setResults(places);
          setActiveIndex(-1);
          setError(null);
        })
        .catch((reason: unknown) => {
          if (
            controller.signal.aborted ||
            (reason instanceof Error && reason.name === 'AbortError')
          ) {
            return;
          }
          setResults([]);
          setError(errorMessage(reason));
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsLoading(false);
        });
    }, debounceMs);

    return () => {
      clearTimeout(timeout);
      controller.abort();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [debounceMs, enabled, query, searchPlaces]);

  const select = (result: GeocodeResult): void => {
    controllerRef.current?.abort();
    setResults([]);
    setActiveIndex(-1);
    selectedQueryRef.current = result.name;
    setQuery(result.name);
    setError(null);
    onSelect(result);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' && results.length > 0) {
      event.preventDefault();
      setActiveIndex((index) => Math.min(results.length - 1, index + 1));
    } else if (event.key === 'ArrowUp' && results.length > 0) {
      event.preventDefault();
      setActiveIndex((index) => (index <= 0 ? results.length - 1 : index - 1));
    } else if (event.key === 'Enter' && activeIndex >= 0) {
      event.preventDefault();
      const selected = results[activeIndex];
      if (selected) select(selected);
    } else if (event.key === 'Escape') {
      controllerRef.current?.abort();
      setResults([]);
      setActiveIndex(-1);
      setError(null);
    }
  };

  if (!enabled) return null;

  return (
    <div className="trailmaker-geocoder" role="search" aria-label="Place search">
      <label className="trailmaker-geocoder-label" htmlFor={inputId}>
        Search for a place
      </label>
      <input
        id={inputId}
        className="trailmaker-geocoder-input"
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={results.length > 0}
        aria-controls={results.length > 0 ? listboxId : undefined}
        aria-activedescendant={activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
        autoComplete="off"
        value={query}
        onChange={(event) => {
          controllerRef.current?.abort();
          setQuery(event.target.value);
          setResults([]);
          setActiveIndex(-1);
          setError(null);
        }}
        onKeyDown={onKeyDown}
      />
      {isLoading && (
        <div className="trailmaker-geocoder-status" role="status">
          Searching…
        </div>
      )}
      {error && (
        <div className="trailmaker-geocoder-error" role="status">
          {error}
        </div>
      )}
      {results.length > 0 && (
        <>
          <ul className="trailmaker-geocoder-results" id={listboxId} role="listbox">
            {results.map((result, index) => (
              <li
                className="trailmaker-geocoder-result"
                id={`${listboxId}-option-${index}`}
                key={`${result.name}:${result.ll[0]}:${result.ll[1]}`}
                role="option"
                aria-selected={index === activeIndex}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(result)}
              >
                {result.name}
              </li>
            ))}
          </ul>
          <div className="trailmaker-geocoder-attribution">
            Results by Nominatim ·{' '}
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
              © OpenStreetMap contributors
            </a>
          </div>
        </>
      )}
    </div>
  );
};
