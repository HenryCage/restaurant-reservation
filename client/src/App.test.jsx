import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App.jsx';

function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, statusText: 'Status', json: async () => body };
}

beforeEach(() => {
  global.fetch = vi.fn();
});

describe('App — auth state machine driven by GET /auth/me', () => {
  it('renders LoginScreen when /auth/me returns 401', async () => {
    global.fetch.mockResolvedValue(jsonResponse(401, { error: 'not authenticated' }));
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('renders ChangePasswordScreen when mustChangePassword is true', async () => {
    global.fetch.mockResolvedValue(jsonResponse(200, { mustChangePassword: true, tenantId: 't1', isSuperadmin: false }));
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Set a new password' })).toBeInTheDocument();
  });

  it('renders the tenant list (superadmin home) for a superadmin with no tenant chosen yet', async () => {
    global.fetch.mockImplementation(async (url) => {
      if (url === '/auth/me') return jsonResponse(200, { mustChangePassword: false, tenantId: null, isSuperadmin: true });
      return jsonResponse(200, []); // TenantListScreen's own /api/tenants fetch
    });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Tenants' })).toBeInTheDocument();
  });

  it('renders DashboardScreen for a normal, non-gated tenant user', async () => {
    global.fetch.mockImplementation(async (url) => {
      if (url === '/auth/me') return jsonResponse(200, { mustChangePassword: false, tenantId: 't1', isSuperadmin: false });
      if (url === '/api/orders') return jsonResponse(200, { rows: [], headers: [], roles: {}, notifyStatuses: [] });
      return jsonResponse(200, []); // DashboardScreen's own contacts/campaigns fetch
    });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'SMS Dispatch' })).toBeInTheDocument();
  });

  it('returns to LoginScreen with the expiry message when a later call gets 401', async () => {
    let callCount = 0;
    global.fetch.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) return jsonResponse(200, { mustChangePassword: false, tenantId: 't1', isSuperadmin: false });
      return jsonResponse(401, { error: 'not authenticated' }); // session died on a later call
    });

    render(<App />);
    await screen.findByRole('heading', { name: 'SMS Dispatch' }); // reached the dashboard first

    expect(await screen.findByText('Session expired, please log in again.')).toBeInTheDocument();
  });
});
