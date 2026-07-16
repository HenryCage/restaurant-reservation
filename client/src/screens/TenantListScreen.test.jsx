import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TenantListScreen from './TenantListScreen.jsx';

function makeApi(overrides = {}) {
  return { get: vi.fn().mockResolvedValue([]), post: vi.fn(), patch: vi.fn(), ...overrides };
}

function baseProps(overrides = {}) {
  return {
    api: makeApi(),
    onEdit: vi.fn(),
    onCreate: vi.fn(),
    onViewDashboard: vi.fn(),
    onManageUsers: vi.fn(),
    onManageSuperadmins: vi.fn(),
    onLogout: vi.fn(),
    ...overrides,
  };
}

describe('TenantListScreen', () => {
  it('renders active and inactive tenants with the right badge', async () => {
    const api = makeApi({
      get: vi.fn().mockResolvedValue([
        { id: 'swift-logistics', name: 'Swift Logistics', active: true, sheetId: 'sheet-1' },
        { id: 'lagos-couriers', name: 'Lagos Couriers', active: false, sheetId: 'sheet-2' },
      ]),
    });
    render(<TenantListScreen {...baseProps({ api })} />);

    expect(await screen.findByText('Swift Logistics')).toBeInTheDocument();
    expect(screen.getByText('Lagos Couriers')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('inactive')).toBeInTheDocument();
  });

  it('shows an empty state with no tenants', async () => {
    render(<TenantListScreen {...baseProps()} />);
    expect(await screen.findByText('No tenants yet.')).toBeInTheDocument();
  });

  it('calls onEdit with the tenant when its Edit button is clicked', async () => {
    const tenant = { id: 'swift-logistics', name: 'Swift Logistics', active: true, sheetId: 'sheet-1' };
    const api = makeApi({ get: vi.fn().mockResolvedValue([tenant]) });
    const onEdit = vi.fn();
    render(<TenantListScreen {...baseProps({ api, onEdit })} />);

    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    expect(onEdit).toHaveBeenCalledWith(tenant);
  });

  it('calls onViewDashboard with the tenant id when "Dashboard" is clicked', async () => {
    const tenant = { id: 'swift-logistics', name: 'Swift Logistics', active: true, sheetId: 'sheet-1' };
    const api = makeApi({ get: vi.fn().mockResolvedValue([tenant]) });
    const onViewDashboard = vi.fn();
    render(<TenantListScreen {...baseProps({ api, onViewDashboard })} />);

    fireEvent.click(await screen.findByRole('button', { name: /^dashboard$/i }));
    expect(onViewDashboard).toHaveBeenCalledWith('swift-logistics');
  });

  it('calls onManageUsers with the tenant id when "Users" is clicked', async () => {
    const tenant = { id: 'swift-logistics', name: 'Swift Logistics', active: true, sheetId: 'sheet-1' };
    const api = makeApi({ get: vi.fn().mockResolvedValue([tenant]) });
    const onManageUsers = vi.fn();
    render(<TenantListScreen {...baseProps({ api, onManageUsers })} />);

    fireEvent.click(await screen.findByRole('button', { name: /^users$/i }));
    expect(onManageUsers).toHaveBeenCalledWith('swift-logistics');
  });

  it('calls onCreate when "Create new tenant" is clicked', () => {
    const onCreate = vi.fn();
    render(<TenantListScreen {...baseProps({ onCreate })} />);

    fireEvent.click(screen.getByRole('button', { name: /create new tenant/i }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('calls onManageSuperadmins when "Manage superadmins" is clicked', () => {
    const onManageSuperadmins = vi.fn();
    render(<TenantListScreen {...baseProps({ onManageSuperadmins })} />);

    fireEvent.click(screen.getByRole('button', { name: /manage superadmins/i }));
    expect(onManageSuperadmins).toHaveBeenCalledTimes(1);
  });

  it('calls onLogout when "Log out" is clicked', () => {
    const onLogout = vi.fn();
    render(<TenantListScreen {...baseProps({ onLogout })} />);

    fireEvent.click(screen.getByRole('button', { name: /log out/i }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it('re-fetches when refreshKey changes', async () => {
    const api = makeApi();
    const { rerender } = render(<TenantListScreen {...baseProps({ api, refreshKey: 0 })} />);
    await screen.findByText('No tenants yet.');
    expect(api.get).toHaveBeenCalledTimes(1);

    rerender(<TenantListScreen {...baseProps({ api, refreshKey: 1 })} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('renders a fetch error instead of crashing', async () => {
    const api = makeApi({ get: vi.fn().mockRejectedValue(new Error('backend unavailable')) });
    render(<TenantListScreen {...baseProps({ api })} />);
    expect(await screen.findByText('backend unavailable')).toBeInTheDocument();
  });
});
