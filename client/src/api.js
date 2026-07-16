// api.js — thin fetch wrapper (Dashboard UI spec).
//
// Always sends the session cookie and centralizes 401 handling in one place
// (onUnauthorized), so individual screens/components never need their own
// "did my session expire?" branch.

/**
 * @param {{ baseUrl?: string, onUnauthorized?: () => void }} [opts]
 */
export function createApiClient({ baseUrl = '', onUnauthorized } = {}) {
  /**
   * @param {string} path
   * @param {RequestInit} [options]
   */
  async function request(path, options = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      ...options,
      credentials: 'include',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });

    if (res.status === 401) {
      onUnauthorized?.();
      throw new Error('not authenticated');
    }

    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    if (!res.ok) {
      throw new Error(body?.error ?? res.statusText ?? `request failed with status ${res.status}`);
    }

    return body;
  }

  return {
    /** @param {string} path */
    get(path) {
      return request(path, { method: 'GET' });
    },
    /** @param {string} path @param {object} body */
    post(path, body) {
      return request(path, { method: 'POST', body: JSON.stringify(body) });
    },
  };
}
