import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import UserListScreen from './UserListScreen.jsx';

function makeApi(overrides = {}) {
  return { get: vi.fn().mockResolvedValue([]), post: vi.fn(), patch: vi.fn(), ...overrides };
}

const tenantScope = { type: 'tenant', tenantId: 'swift-logistics' };
const superadminScope = { type: 'superadmin' };

describe('UserListScreen', () => {
  it('fetches with ?tenantId= for a tenant scope', async () => {
    const api = makeApi();
    render(<UserListScreen api={api} scope={tenantScope} onCreate={vi.fn()} onBack={vi.fn()} onDismissPendingReveal={vi.fn()} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/users?tenantId=swift-logistics'));
  });

  it('fetches with ?superadmins=true for a superadmin scope', async () => {
    const api = makeApi();
    render(<UserListScreen api={api} scope={superadminScope} onCreate={vi.fn()} onBack={vi.fn()} onDismissPendingReveal={vi.fn()} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/users?superadmins=true'));
  });

  it('renders active/inactive and must-change-password state per row', async () => {
    const api = makeApi({
      get: vi.fn().mockResolvedValue([
        { id: 'u1', email: 'a@example.com', active: true, mustChangePassword: true },
        { id: 'u2', email: 'b@example.com', active: false, mustChangePassword: false },
      ]),
    });
    render(<UserListScreen api={api} scope={tenantScope} onCreate={vi.fn()} onBack={vi.fn()} onDismissPendingReveal={vi.fn()} />);

    expect(await screen.findByText('a@example.com')).toBeInTheDocument();
    expect(screen.getByText('b@example.com')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('inactive')).toBeInTheDocument();
  });

  it('shows an empty state with no users', async () => {
    render(<UserListScreen api={makeApi()} scope={tenantScope} onCreate={vi.fn()} onBack={vi.fn()} onDismissPendingReveal={vi.fn()} />);
    expect(await screen.findByText('No users yet.')).toBeInTheDocument();
  });

  it('calls onCreate when "Create new user" is clicked', () => {
    const onCreate = vi.fn();
    render(<UserListScreen api={makeApi()} scope={tenantScope} onCreate={onCreate} onBack={vi.fn()} onDismissPendingReveal={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /create new user/i }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('Deactivate/Reactivate toggles active via PATCH and re-fetches', async () => {
    const api = makeApi({
      get: vi.fn().mockResolvedValue([{ id: 'u1', email: 'a@example.com', active: true, mustChangePassword: false }]),
      patch: vi.fn().mockResolvedValue({ user: { id: 'u1', active: false } }),
    });
    render(<UserListScreen api={api} scope={tenantScope} onCreate={vi.fn()} onBack={vi.fn()} onDismissPendingReveal={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /deactivate/i }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/users/u1', { active: false }));
  });

  it('Reset password shows a dismissible one-time banner', async () => {
    const api = makeApi({
      get: vi.fn().mockResolvedValue([{ id: 'u1', email: 'a@example.com', active: true, mustChangePassword: false }]),
      post: vi.fn().mockResolvedValue({ temporaryPassword: 'brand-new-secret' }),
    });
    render(<UserListScreen api={api} scope={tenantScope} onCreate={vi.fn()} onBack={vi.fn()} onDismissPendingReveal={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /reset password/i }));
    expect(await screen.findByText('brand-new-secret')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText('brand-new-secret')).not.toBeInTheDocument();
  });

  it('shows a pendingReveal (from a create) and calls onDismissPendingReveal', async () => {
    const onDismissPendingReveal = vi.fn();
    render(
      <UserListScreen
        api={makeApi()}
        scope={tenantScope}
        pendingReveal={{ email: 'new@example.com', temporaryPassword: 'fresh-pw' }}
        onDismissPendingReveal={onDismissPendingReveal}
        onCreate={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    expect(await screen.findByText('fresh-pw')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismissPendingReveal).toHaveBeenCalledTimes(1);
  });

  it('renders a fetch error instead of crashing', async () => {
    const api = makeApi({ get: vi.fn().mockRejectedValue(new Error('backend unavailable')) });
    render(<UserListScreen api={api} scope={tenantScope} onCreate={vi.fn()} onBack={vi.fn()} onDismissPendingReveal={vi.fn()} />);
    expect(await screen.findByText('backend unavailable')).toBeInTheDocument();
  });

  it('calls onBack when "Back" is clicked', async () => {
    const onBack = vi.fn();
    render(<UserListScreen api={makeApi()} scope={tenantScope} onCreate={vi.fn()} onBack={onBack} onDismissPendingReveal={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /back/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
