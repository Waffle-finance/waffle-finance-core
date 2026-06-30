import { fetchWithRetry } from './fetchWithRetry';

/** Tell the relayer someone opened the app so chain pollers stay attentive. */
export function pingBackendWake(): void {
  const apiBase = import.meta.env.PROD ? '' : (import.meta.env.VITE_API_BASE_URL || '');
  fetchWithRetry(`${apiBase}/api/wake`, {
    method: 'POST',
    keepalive: true,
    maxRetries: 2,
    retryDelayMs: 500,
  }).catch(() => {
    // Best-effort — site works without it; order creation also wakes pollers.
  });
}
