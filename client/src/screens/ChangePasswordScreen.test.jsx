import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ChangePasswordScreen from './ChangePasswordScreen.jsx';

function makeApi(overrides = {}) {
  return { post: vi.fn(), get: vi.fn(), ...overrides };
}

describe('ChangePasswordScreen', () => {
  it('blocks submit client-side when confirmation does not match, without calling the API', async () => {
    const api = makeApi();
    render(<ChangePasswordScreen api={api} onChanged={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'old-password' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new-password' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'mismatch' } });
    fireEvent.click(screen.getByRole('button', { name: /change password/i }));

    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('submits and calls onChanged on success', async () => {
    const api = makeApi({ post: vi.fn().mockResolvedValue({ ok: true }) });
    const onChanged = vi.fn();
    render(<ChangePasswordScreen api={api} onChanged={onChanged} />);

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'old-password' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new-password' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'new-password' } });
    fireEvent.click(screen.getByRole('button', { name: /change password/i }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledWith('/auth/change-password', {
      currentPassword: 'old-password',
      newPassword: 'new-password',
    });
  });

  it('renders the server error on a rejected submit', async () => {
    const api = makeApi({ post: vi.fn().mockRejectedValue(new Error('current password is incorrect')) });
    render(<ChangePasswordScreen api={api} onChanged={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'wrong-password' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new-password' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'new-password' } });
    fireEvent.click(screen.getByRole('button', { name: /change password/i }));

    expect(await screen.findByText('current password is incorrect')).toBeInTheDocument();
  });
});
