import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import UserFormScreen from './UserFormScreen.jsx';

function makeApi(overrides = {}) {
  return { get: vi.fn(), post: vi.fn(), patch: vi.fn(), ...overrides };
}

describe('UserFormScreen', () => {
  it('tenant scope: submits { tenantId, email } and calls onSaved with the result', async () => {
    const result = { user: { id: 'u1', email: 'new@example.com' }, temporaryPassword: 'gen-pw' };
    const api = makeApi({ post: vi.fn().mockResolvedValue(result) });
    const onSaved = vi.fn();
    render(
      <UserFormScreen api={api} scope={{ type: 'tenant', tenantId: 'swift-logistics' }} onSaved={onSaved} onCancel={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(result));
    expect(api.post).toHaveBeenCalledWith('/api/users', { tenantId: 'swift-logistics', email: 'new@example.com' });
  });

  it('superadmin scope: submits { email, isSuperadmin: true }', async () => {
    const result = { user: { id: 'u2', email: 'admin2@example.com' }, temporaryPassword: 'gen-pw' };
    const api = makeApi({ post: vi.fn().mockResolvedValue(result) });
    render(<UserFormScreen api={api} scope={{ type: 'superadmin' }} onSaved={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'admin2@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/users', { email: 'admin2@example.com', isSuperadmin: true }),
    );
  });

  it('renders a server conflict error without crashing', async () => {
    const api = makeApi({ post: vi.fn().mockRejectedValue(new Error('a user with email x@example.com already exists')) });
    render(<UserFormScreen api={api} scope={{ type: 'tenant', tenantId: 't1' }} onSaved={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'x@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText('a user with email x@example.com already exists')).toBeInTheDocument();
  });

  it('calls onCancel when Cancel is clicked', () => {
    const onCancel = vi.fn();
    render(<UserFormScreen api={makeApi()} scope={{ type: 'tenant', tenantId: 't1' }} onSaved={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
