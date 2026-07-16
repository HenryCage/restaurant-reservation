import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApiClient } from './api.js';

function mockFetchOnce({ status = 200, json = {} } = {}) {
  const fn = vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    statusText: 'Status',
    json: async () => json,
  });
  global.fetch = fn;
  return fn;
}

beforeEach(() => {
  global.fetch = vi.fn();
});

describe('createApiClient', () => {
  it('always sets credentials: "include"', async () => {
    const fetchMock = mockFetchOnce({ status: 200, json: { ok: true } });
    const api = createApiClient();
    await api.get('/api/contacts');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/contacts',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('resolves with the parsed JSON body on 2xx', async () => {
    mockFetchOnce({ status: 200, json: { id: '1', name: 'Ada' } });
    const api = createApiClient();
    const result = await api.get('/api/contacts');
    expect(result).toEqual({ id: '1', name: 'Ada' });
  });

  it('calls onUnauthorized and rejects on a 401', async () => {
    mockFetchOnce({ status: 401, json: { error: 'not authenticated' } });
    const onUnauthorized = vi.fn();
    const api = createApiClient({ onUnauthorized });

    await expect(api.get('/api/contacts')).rejects.toThrow();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('rejects with the server error message on a non-2xx, non-401 response', async () => {
    mockFetchOnce({ status: 400, json: { error: 'a contact with this phone already exists' } });
    const api = createApiClient();
    await expect(api.post('/api/contacts', { name: 'Ada' })).rejects.toThrow(
      'a contact with this phone already exists',
    );
  });

  it('sends a JSON content-type and body for post()', async () => {
    const fetchMock = mockFetchOnce({ status: 201, json: { id: '1' } });
    const api = createApiClient();
    await api.post('/api/contacts', { name: 'Ada', phone: '+2348012345678' });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(options.body)).toEqual({ name: 'Ada', phone: '+2348012345678' });
  });

  it('sends a JSON content-type and body for patch()', async () => {
    const fetchMock = mockFetchOnce({ status: 200, json: { id: '1' } });
    const api = createApiClient();
    await api.patch('/api/tenants/swift-logistics', { name: 'Renamed' });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/tenants/swift-logistics');
    expect(options.method).toBe('PATCH');
    expect(options.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(options.body)).toEqual({ name: 'Renamed' });
  });

  describe('tenantId (superadmin)', () => {
    it('appends ?tenantId= to a path with no existing query string', async () => {
      const fetchMock = mockFetchOnce({ status: 200, json: [] });
      const api = createApiClient({ tenantId: 'swift-logistics' });
      await api.get('/api/contacts');

      expect(fetchMock).toHaveBeenCalledWith('/api/contacts?tenantId=swift-logistics', expect.anything());
    });

    it('does not append tenantId when none was configured', async () => {
      const fetchMock = mockFetchOnce({ status: 200, json: [] });
      const api = createApiClient();
      await api.get('/api/contacts');

      expect(fetchMock).toHaveBeenCalledWith('/api/contacts', expect.anything());
    });
  });
});
