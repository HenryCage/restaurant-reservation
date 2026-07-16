import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TenantFormScreen from './TenantFormScreen.jsx';

function makeApi(overrides = {}) {
  return { get: vi.fn(), post: vi.fn(), patch: vi.fn(), ...overrides };
}

function fillCoreFields({ id = true } = {}) {
  if (id) fireEvent.change(screen.getByLabelText('Tenant ID'), { target: { value: 'swift-logistics' } });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Swift Logistics' } });
  fireEvent.change(screen.getByLabelText('Sheet ID'), { target: { value: 'sheet-1' } });
  fireEvent.change(screen.getByLabelText('Sender ID'), { target: { value: 'SwiftLog' } });
  fireEvent.change(screen.getByLabelText('Status 1'), { target: { value: 'Out for delivery' } });
  fireEvent.change(screen.getByLabelText('Template 1'), { target: { value: 'Hi {name}' } });
}

describe('TenantFormScreen', () => {
  it('create mode: submits the expected payload including id, calls onSaved', async () => {
    const api = makeApi({ post: vi.fn().mockResolvedValue({ id: 'swift-logistics' }) });
    const onSaved = vi.fn();
    render(<TenantFormScreen api={api} mode="create" tenant={null} onSaved={onSaved} onCancel={vi.fn()} />);

    fillCoreFields();
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith(
      '/api/tenants',
      expect.objectContaining({
        id: 'swift-logistics',
        name: 'Swift Logistics',
        sheetId: 'sheet-1',
        senderId: 'SwiftLog',
        notifyStatuses: ['Out for delivery'],
        templates: { 'Out for delivery': 'Hi {name}' },
      }),
    );
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('edit mode: id field is disabled, submits via PATCH to the tenant-specific path', async () => {
    const tenant = {
      id: 'swift-logistics',
      name: 'Swift Logistics',
      active: true,
      sheetId: 'sheet-1',
      sheetName: 'Orders',
      senderId: 'SwiftLog',
      channel: 'dnd',
      testNumber: '',
      syncContactsFromSheet: false,
      notifyStatuses: ['Out for delivery'],
      templates: { 'Out for delivery': 'Hi {name}' },
    };
    const api = makeApi({ patch: vi.fn().mockResolvedValue(tenant) });
    const onSaved = vi.fn();
    render(<TenantFormScreen api={api} mode="edit" tenant={tenant} onSaved={onSaved} onCancel={vi.fn()} />);

    expect(screen.getByLabelText('Tenant ID')).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Swift Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(api.patch).toHaveBeenCalledWith(
      '/api/tenants/swift-logistics',
      expect.objectContaining({ name: 'Swift Renamed' }),
    );
    expect(api.post).not.toHaveBeenCalled();
  });

  it('adds and removes notifyStatus/template rows', () => {
    render(<TenantFormScreen api={makeApi()} mode="create" tenant={null} onSaved={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByLabelText('Status 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /add status/i }));
    expect(screen.getByLabelText('Status 2')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: /remove/i })[0]);
    expect(screen.queryByLabelText('Status 2')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Status 1')).toBeInTheDocument();
  });

  it('renders a server conflict error without crashing', async () => {
    const api = makeApi({ post: vi.fn().mockRejectedValue(new Error('"senderId" is shared with another active tenant')) });
    render(<TenantFormScreen api={api} mode="create" tenant={null} onSaved={vi.fn()} onCancel={vi.fn()} />);

    fillCoreFields();
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText('"senderId" is shared with another active tenant')).toBeInTheDocument();
  });

  it('calls onCancel when Cancel is clicked', () => {
    const onCancel = vi.fn();
    render(<TenantFormScreen api={makeApi()} mode="create" tenant={null} onSaved={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
