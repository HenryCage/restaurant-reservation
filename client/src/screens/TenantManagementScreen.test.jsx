import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TenantManagementScreen from './TenantManagementScreen.jsx';

function makeApi(overrides = {}) {
  return { get: vi.fn().mockResolvedValue([]), post: vi.fn(), patch: vi.fn(), ...overrides };
}

function baseProps(overrides = {}) {
  return {
    api: makeApi(),
    onViewDashboard: vi.fn(),
    onManageUsers: vi.fn(),
    onManageSuperadmins: vi.fn(),
    onLogout: vi.fn(),
    ...overrides,
  };
}

describe('TenantManagementScreen', () => {
  it('starts on the list view', async () => {
    render(<TenantManagementScreen {...baseProps()} />);
    expect(await screen.findByRole('heading', { name: 'Tenants' })).toBeInTheDocument();
  });

  it('navigates to the create form and back to the list on cancel', async () => {
    render(<TenantManagementScreen {...baseProps()} />);
    await screen.findByRole('heading', { name: 'Tenants' });

    fireEvent.click(screen.getByRole('button', { name: /create new tenant/i }));
    expect(screen.getByRole('heading', { name: 'Create tenant' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(await screen.findByRole('heading', { name: 'Tenants' })).toBeInTheDocument();
  });

  it('navigates to the edit form for a tenant', async () => {
    const tenant = { id: 'swift-logistics', name: 'Swift Logistics', active: true, sheetId: 'sheet-1', notifyStatuses: [], templates: {} };
    const api = makeApi({ get: vi.fn().mockResolvedValue([tenant]) });
    render(<TenantManagementScreen {...baseProps({ api })} />);

    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    expect(screen.getByRole('heading', { name: 'Edit tenant' })).toBeInTheDocument();
  });

  it('calls onViewDashboard when "Dashboard" is clicked on a row', async () => {
    const tenant = { id: 'swift-logistics', name: 'Swift Logistics', active: true, sheetId: 'sheet-1' };
    const api = makeApi({ get: vi.fn().mockResolvedValue([tenant]) });
    const onViewDashboard = vi.fn();
    render(<TenantManagementScreen {...baseProps({ api, onViewDashboard })} />);

    fireEvent.click(await screen.findByRole('button', { name: /^dashboard$/i }));
    expect(onViewDashboard).toHaveBeenCalledWith('swift-logistics');
  });

  it('calls onLogout from the list view', async () => {
    const onLogout = vi.fn();
    render(<TenantManagementScreen {...baseProps({ onLogout })} />);
    fireEvent.click(await screen.findByRole('button', { name: /log out/i }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});
