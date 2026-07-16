import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TenantManagementScreen from './TenantManagementScreen.jsx';

function makeApi(overrides = {}) {
  return { get: vi.fn().mockResolvedValue([]), post: vi.fn(), patch: vi.fn(), ...overrides };
}

describe('TenantManagementScreen', () => {
  it('starts on the list view', async () => {
    render(<TenantManagementScreen api={makeApi()} onBack={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: 'Tenants' })).toBeInTheDocument();
  });

  it('navigates to the create form and back to the list on cancel', async () => {
    render(<TenantManagementScreen api={makeApi()} onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: 'Tenants' });

    fireEvent.click(screen.getByRole('button', { name: /create new tenant/i }));
    expect(screen.getByRole('heading', { name: 'Create tenant' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(await screen.findByRole('heading', { name: 'Tenants' })).toBeInTheDocument();
  });

  it('navigates to the edit form for a tenant', async () => {
    const tenant = { id: 'swift-logistics', name: 'Swift Logistics', active: true, sheetId: 'sheet-1', notifyStatuses: [], templates: {} };
    const api = makeApi({ get: vi.fn().mockResolvedValue([tenant]) });
    render(<TenantManagementScreen api={api} onBack={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
    expect(screen.getByRole('heading', { name: 'Edit tenant' })).toBeInTheDocument();
  });

  it('calls onBack from the list view', async () => {
    const onBack = vi.fn();
    render(<TenantManagementScreen api={makeApi()} onBack={onBack} />);
    fireEvent.click(await screen.findByRole('button', { name: /back/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
