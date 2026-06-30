// sms/httpClient.js — fetch with a hard timeout (shared by the SMS adapters).
//
// A hung provider connection must never stall the poll tick (spec §9/§14), so
// every request is bounded by an AbortController-based timeout.

/**
 * Perform an HTTP request with a timeout. Rejects on network error or timeout.
 * @param {typeof fetch} fetchFn
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
export async function requestWithTimeout(fetchFn, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetchFn(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
