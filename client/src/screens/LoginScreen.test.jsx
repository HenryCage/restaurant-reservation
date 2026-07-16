import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LoginScreen from './LoginScreen.jsx';

function makeApi(overrides = {}) {
  return { post: vi.fn(), get: vi.fn(), ...overrides };
}

describe('LoginScreen', () => {
  it('submits email/password and calls onLogin with the response', async () => {
    const me = { mustChangePassword: false, tenantId: 't1', isSuperadmin: false };
    const api = makeApi({ post: vi.fn().mockResolvedValue(me) });
    const onLogin = vi.fn();
    render(<LoginScreen api={api} onLogin={onLogin} />);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'longpassword' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(onLogin).toHaveBeenCalledWith(me));
    expect(api.post).toHaveBeenCalledWith('/auth/login', { email: 'a@example.com', password: 'longpassword' });
  });

  it('renders the error message on a rejected login', async () => {
    const api = makeApi({ post: vi.fn().mockRejectedValue(new Error('invalid email or password')) });
    render(<LoginScreen api={api} onLogin={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('invalid email or password')).toBeInTheDocument();
  });

  it('renders a rate-limit error message', async () => {
    const api = makeApi({ post: vi.fn().mockRejectedValue(new Error('too many attempts, try again later')) });
    render(<LoginScreen api={api} onLogin={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('too many attempts, try again later')).toBeInTheDocument();
  });
});
