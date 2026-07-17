// api.js — thin fetch wrapper (Dashboard UI spec).
//
// Always sends the session cookie and centralizes 401 handling in one place
// (onUnauthorized), so individual screens/components never need their own
// "did my session expire?" branch.

/**
 * @param {string} path
 * @param {string} tenantId
 * @returns {string}
 */
function appendTenantId(path, tenantId) {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}tenantId=${encodeURIComponent(tenantId)}`;
}

/**
 * @param {{ baseUrl?: string, onUnauthorized?: () => void, tenantId?: string }} [opts]
 */
export function createApiClient({ baseUrl = '', onUnauthorized, tenantId } = {}) {
  /**
   * @param {string} path
   * @param {RequestInit} [options]
   */
  async function request(path, options = {}) {
    // Only relevant for a superadmin (a regular tenant user's requests are
    // always scoped server-side to their own tenant regardless of this) --
    // see resolveTenantId() in the backend's requireAuth middleware.
    const resolvedPath = tenantId ? appendTenantId(path, tenantId) : path;
    const res = await fetch(`${baseUrl}${resolvedPath}`, {
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
    /** @param {string} path @param {object} body */
    patch(path, body) {
      return request(path, { method: 'PATCH', body: JSON.stringify(body) });
    },
    /** @param {string} path */
    delete(path) {
      return request(path, { method: 'DELETE' });
    },
  };
}
