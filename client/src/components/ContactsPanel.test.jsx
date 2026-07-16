import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ContactsPanel from './ContactsPanel.jsx';

function makeApi(overrides = {}) {
  return { get: vi.fn().mockResolvedValue([]), post: vi.fn(), ...overrides };
}

describe('ContactsPanel', () => {
  it('renders a fetched list', async () => {
    const api = makeApi({ get: vi.fn().mockResolvedValue([{ id: '1', name: 'Ada', phone: '+2348012345678' }]) });
    render(<ContactsPanel api={api} />);

    expect(await screen.findByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('+2348012345678')).toBeInTheDocument();
  });

  it('submits a new contact and shows it after refetch', async () => {
    const api = makeApi({
      get: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: '1', name: 'Ada', phone: '+2348012345678' }]),
      post: vi.fn().mockResolvedValue({ id: '1', name: 'Ada', phone: '+2348012345678' }),
    });
    render(<ContactsPanel api={api} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '+2348012345678' } });
    fireEvent.click(screen.getByRole('button', { name: /add contact/i }));

    expect(await screen.findByText('Ada')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/api/contacts', { name: 'Ada', phone: '+2348012345678', tags: [] });
  });

  it("shows the server's error message on a failed add", async () => {
    const api = makeApi({ post: vi.fn().mockRejectedValue(new Error('a contact with this phone already exists')) });
    render(<ContactsPanel api={api} />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '+2348012345678' } });
    fireEvent.click(screen.getByRole('button', { name: /add contact/i }));

    expect(await screen.findByText('a contact with this phone already exists')).toBeInTheDocument();
  });

  describe('polling', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('polls every 5s and stops on unmount', async () => {
      const api = makeApi();
      const { unmount } = render(<ContactsPanel api={api} />);
      // The mount-time fetch is a plain resolved promise, not a timer -- RTL's
      // waitFor deadlocks under fake timers (its own polling uses setTimeout,
      // which never auto-advances), so flush the microtask queue directly
      // instead of using it here.
      await vi.advanceTimersByTimeAsync(0);
      expect(api.get).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5000);
      expect(api.get).toHaveBeenCalledTimes(2);

      unmount();
      await vi.advanceTimersByTimeAsync(10000);
      expect(api.get).toHaveBeenCalledTimes(2); // no more calls after unmount
    });
  });
});
