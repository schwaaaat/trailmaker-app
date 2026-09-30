/** Joins an app-relative path to Vite's BASE_URL without introducing a root-relative URL. */
export function withBaseUrl(path: string, baseUrl: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${base}${path.replace(/^\/+/, '')}`;
}

export function normalizeBaseUrl(baseUrl: string): string {
  if (!baseUrl.startsWith('/')) throw new Error('The app base URL must be an absolute path');
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}
