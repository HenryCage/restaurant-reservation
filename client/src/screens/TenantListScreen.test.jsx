import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TenantListScreen from './TenantListScreen.jsx';

function makeApi(overrides = {}) {
  return { get: vi.fn().mockResolvedValue([]), post: vi.fn(), patch: vi.fn(), ...overrides };
}

describe('TenantListScreen', () => {
  it('renders active and inactive tenants with the right badge', async () => {
    const api = makeApi({
      get: vi.fn().mockResolvedValue([
        { id: 'swift-logistics', name: 'Swift Logistics', active: true, sheetId: 'sheet-1' },
        { id: 'lagos-couriers', name: 'Lagos Couriers', active: false, sheetId: 'sheet-2' },
      ]),
    });
    render(<TenantListScreen api={api} onEdit={vi.fn()} onCreate={vi.fn()} onBack={vi.fn()} />);

    expect(await screen.findByText('Swift Logistics')).toBeInTheDocument();
    expect(screen.getByText('Lagos Couriers')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('inactive')).toBeInTheDocument();
  });

  it('shows an empty state with no tenants', async () => {
    render(<TenantListScreen api={makeApi()} onEdit={vi.fn()} onCreate={vi.fn()} onBack={vi.fn()} />);
    expect(await screen.findByText('No tenants yet.')).toBeInTheDocument();
  });

  it('calls onEdit with the tenant when its Edit button is clicked', async () => {
    const tenant = { id: 'swift-logistics', name: 'Swift Logistics', active: true, sheetId: 'sheet-1' };
    const api = makeApi({ get: vi.fn().mockResolvedValue([tenant]) });
    const onEdit = vi.fn();
    render(<TenantListScreen api={api} onEdit={onEdit} onCreate={vi.fn()} onBack={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
    expect(onEdit).toHaveBeenCalledWith(tenant);
  });

  it('calls onCreate when "Create new tenant" is clicked', () => {
    const onCreate = vi.fn();
    render(<TenantListScreen api={makeApi()} onEdit={vi.fn()} onCreate={onCreate} onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /create new tenant/i }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('re-fetches when refreshKey changes', async () => {
    const api = makeApi();
    const { rerender } = render(
      <TenantListScreen api={api} refreshKey={0} onEdit={vi.fn()} onCreate={vi.fn()} onBack={vi.fn()} />,
    );
    await screen.findByText('No tenants yet.');
    expect(api.get).toHaveBeenCalledTimes(1);

    rerender(<TenantListScreen api={api} refreshKey={1} onEdit={vi.fn()} onCreate={vi.fn()} onBack={vi.fn()} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('renders a fetch error instead of crashing', async () => {
    const api = makeApi({ get: vi.fn().mockRejectedValue(new Error('backend unavailable')) });
    render(<TenantListScreen api={api} onEdit={vi.fn()} onCreate={vi.fn()} onBack={vi.fn()} />);
    expect(await screen.findByText('backend unavailable')).toBeInTheDocument();
  });
});
