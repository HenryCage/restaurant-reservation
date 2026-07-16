import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import UserManagementScreen from './UserManagementScreen.jsx';

function makeApi(overrides = {}) {
  return { get: vi.fn().mockResolvedValue([]), post: vi.fn(), patch: vi.fn(), ...overrides };
}

const tenantScope = { type: 'tenant', tenantId: 'swift-logistics' };

describe('UserManagementScreen', () => {
  it('starts on the list view', async () => {
    render(<UserManagementScreen api={makeApi()} scope={tenantScope} onBack={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: 'Users' })).toBeInTheDocument();
  });

  it('navigates to the create form and back to the list on cancel', async () => {
    render(<UserManagementScreen api={makeApi()} scope={tenantScope} onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: 'Users' });

    fireEvent.click(screen.getByRole('button', { name: /create new user/i }));
    expect(screen.getByRole('heading', { name: 'Create user' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(await screen.findByRole('heading', { name: 'Users' })).toBeInTheDocument();
  });

  it('after a successful create, shows the returned temp password on the list and re-fetches', async () => {
    const api = makeApi({
      post: vi.fn().mockResolvedValue({ user: { id: 'u1', email: 'new@example.com' }, temporaryPassword: 'gen-pw-123' }),
    });
    render(<UserManagementScreen api={api} scope={tenantScope} onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: 'Users' });

    fireEvent.click(screen.getByRole('button', { name: /create new user/i }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText('gen-pw-123')).toBeInTheDocument();
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2)); // initial + post-create refresh
  });

  it('calls onBack from the list view', async () => {
    const onBack = vi.fn();
    render(<UserManagementScreen api={makeApi()} scope={tenantScope} onBack={onBack} />);
    fireEvent.click(await screen.findByRole('button', { name: /back/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('superadmin scope: heading reads "Superadmins" and create form reads "Create superadmin"', async () => {
    render(<UserManagementScreen api={makeApi()} scope={{ type: 'superadmin' }} onBack={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: 'Superadmins' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /create new superadmin/i }));
    expect(screen.getByRole('heading', { name: 'Create superadmin' })).toBeInTheDocument();
  });
});
