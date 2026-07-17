import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ContactsPanel from './ContactsPanel.jsx';

function makeApi(overrides = {}) {
  return { get: vi.fn().mockResolvedValue([]), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), ...overrides };
}

describe('ContactsPanel', () => {
  it('renders a fetched list', async () => {
    const api = makeApi({ get: vi.fn().mockResolvedValue([{ id: '1', name: 'Ada', phone: '+2348012345678', tags: [] }]) });
    render(<ContactsPanel api={api} />);

    expect(await screen.findByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('+2348012345678')).toBeInTheDocument();
  });

  it('submits a new contact and shows it after refetch', async () => {
    const api = makeApi({
      get: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: '1', name: 'Ada', phone: '+2348012345678', tags: [] }]),
      post: vi.fn().mockResolvedValue({ id: '1', name: 'Ada', phone: '+2348012345678' }),
    });
    render(<ContactsPanel api={api} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '+2348012345678' } });
    fireEvent.click(screen.getByRole('button', { name: /add contact/i }));

    expect(await screen.findByText('Ada')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/api/contacts', {
      name: 'Ada',
      phone: '+2348012345678',
      countryCode: '234',
      tags: [],
    });
  });

  it('submits the selected country code', async () => {
    const api = makeApi({ post: vi.fn().mockResolvedValue({ id: '1', name: 'Rimas', phone: '+37060012345' }) });
    render(<ContactsPanel api={api} />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Rimas' } });
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: '370' } });
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '60012345' } });
    fireEvent.click(screen.getByRole('button', { name: /add contact/i }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/contacts', {
        name: 'Rimas',
        phone: '60012345',
        countryCode: '370',
        tags: [],
      }),
    );
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

  describe('tags', () => {
    it('shows each tag as a pill on the contact card', async () => {
      const api = makeApi({
        get: vi.fn().mockResolvedValue([{ id: '1', name: 'Ada', phone: '+2348012345678', tags: ['vip', 'wholesale'] }]),
      });
      render(<ContactsPanel api={api} />);

      expect(await screen.findByText('vip')).toBeInTheDocument();
      expect(screen.getByText('wholesale')).toBeInTheDocument();
    });

    it('shows no tag pills when the contact has none', async () => {
      const api = makeApi({ get: vi.fn().mockResolvedValue([{ id: '1', name: 'Ada', phone: '+2348012345678', tags: [] }]) });
      render(<ContactsPanel api={api} />);
      await screen.findByText('Ada');
      expect(screen.queryByText('vip')).not.toBeInTheDocument();
    });

    it('prefills the edit form with the existing tags and saves the edited list', async () => {
      const api = makeApi({
        get: vi.fn().mockResolvedValue([{ id: '1', name: 'Ada', phone: '+2348012345678', tags: ['vip'] }]),
        patch: vi.fn().mockResolvedValue({ id: '1', name: 'Ada', phone: '+2348012345678', tags: ['vip', 'new'] }),
      });
      render(<ContactsPanel api={api} />);
      await screen.findByText('Ada');

      fireEvent.click(screen.getByRole('button', { name: 'Edit Ada' }));
      expect(screen.getByLabelText('Edit tags for Ada').value).toBe('vip');

      fireEvent.change(screen.getByLabelText('Edit tags for Ada'), { target: { value: 'vip, new' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(api.patch).toHaveBeenCalledWith('/api/contacts/1', {
          name: 'Ada',
          phone: '+2348012345678',
          countryCode: '234',
          tags: ['vip', 'new'],
        }),
      );
    });
  });

  describe('search', () => {
    const CONTACTS = [
      { id: '1', name: 'Ada Lovelace', phone: '+2348012345678', tags: [] },
      { id: '2', name: 'Bola Adeyemi', phone: '+2348023456789', tags: [] },
    ];

    it('filters the list by name', async () => {
      const api = makeApi({ get: vi.fn().mockResolvedValue(CONTACTS) });
      render(<ContactsPanel api={api} />);
      await screen.findByText('Ada Lovelace');

      fireEvent.change(screen.getByLabelText('Search contacts'), { target: { value: 'bola' } });

      expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument();
      expect(screen.getByText('Bola Adeyemi')).toBeInTheDocument();
    });

    it('filters the list by phone', async () => {
      const api = makeApi({ get: vi.fn().mockResolvedValue(CONTACTS) });
      render(<ContactsPanel api={api} />);
      await screen.findByText('Ada Lovelace');

      fireEvent.change(screen.getByLabelText('Search contacts'), { target: { value: '23456789' } });

      expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument();
      expect(screen.getByText('Bola Adeyemi')).toBeInTheDocument();
    });

    it('shows a "no match" message instead of an empty list', async () => {
      const api = makeApi({ get: vi.fn().mockResolvedValue(CONTACTS) });
      render(<ContactsPanel api={api} />);
      await screen.findByText('Ada Lovelace');

      fireEvent.change(screen.getByLabelText('Search contacts'), { target: { value: 'nobody' } });

      expect(await screen.findByText('No contacts match "nobody".')).toBeInTheDocument();
    });

    it('does not show the search box when there are no contacts at all', () => {
      render(<ContactsPanel api={makeApi()} />);
      expect(screen.queryByLabelText('Search contacts')).not.toBeInTheDocument();
    });
  });

  describe('editing a contact', () => {
    it('shows an inline edit form, saves via PATCH, and refetches', async () => {
      const api = makeApi({
        get: vi
          .fn()
          .mockResolvedValueOnce([{ id: '1', name: 'Ada', phone: '+2348012345678', tags: [] }])
          .mockResolvedValueOnce([{ id: '1', name: 'Ada Lovelace', phone: '+2348012345678', tags: [] }]),
        patch: vi.fn().mockResolvedValue({ id: '1', name: 'Ada Lovelace', phone: '+2348012345678', tags: [] }),
      });
      render(<ContactsPanel api={api} />);
      await screen.findByText('Ada');

      fireEvent.click(screen.getByRole('button', { name: 'Edit Ada' }));
      fireEvent.change(screen.getByLabelText('Edit name for Ada'), { target: { value: 'Ada Lovelace' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(api.patch).toHaveBeenCalledWith('/api/contacts/1', {
          name: 'Ada Lovelace',
          phone: '+2348012345678',
          countryCode: '234',
          tags: [],
        }),
      );
      expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    });

    it('cancels out of edit mode without saving', async () => {
      const api = makeApi({ get: vi.fn().mockResolvedValue([{ id: '1', name: 'Ada', phone: '+2348012345678', tags: [] }]) });
      render(<ContactsPanel api={api} />);
      await screen.findByText('Ada');

      fireEvent.click(screen.getByRole('button', { name: 'Edit Ada' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByLabelText('Edit name for Ada')).not.toBeInTheDocument();
      expect(api.patch).not.toHaveBeenCalled();
    });

    it("shows the server's error message on a failed edit", async () => {
      const api = makeApi({
        get: vi.fn().mockResolvedValue([{ id: '1', name: 'Ada', phone: '+2348012345678', tags: [] }]),
        patch: vi.fn().mockRejectedValue(new Error('invalid phone: nope')),
      });
      render(<ContactsPanel api={api} />);
      await screen.findByText('Ada');

      fireEvent.click(screen.getByRole('button', { name: 'Edit Ada' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByText('invalid phone: nope')).toBeInTheDocument();
    });
  });

  describe('deleting a contact', () => {
    it('shows a confirm dialog, then deletes via DELETE and refetches on confirm', async () => {
      const api = makeApi({
        get: vi.fn().mockResolvedValueOnce([{ id: '1', name: 'Ada', phone: '+2348012345678', tags: [] }]).mockResolvedValueOnce([]),
        delete: vi.fn().mockResolvedValue(undefined),
      });
      render(<ContactsPanel api={api} />);
      await screen.findByText('Ada');

      fireEvent.click(screen.getByRole('button', { name: 'Delete Ada' }));
      expect(await screen.findByText('Delete Ada?')).toBeInTheDocument();
      expect(api.delete).not.toHaveBeenCalled(); // not yet -- only opened the dialog

      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

      await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/api/contacts/1'));
      await waitFor(() => expect(screen.queryByText('Ada')).not.toBeInTheDocument());
    });

    it('does nothing if the dialog is cancelled', async () => {
      const api = makeApi({ get: vi.fn().mockResolvedValue([{ id: '1', name: 'Ada', phone: '+2348012345678', tags: [] }]) });
      render(<ContactsPanel api={api} />);
      await screen.findByText('Ada');

      fireEvent.click(screen.getByRole('button', { name: 'Delete Ada' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(api.delete).not.toHaveBeenCalled();
      expect(screen.queryByText('Delete Ada?')).not.toBeInTheDocument();
    });

    it("shows the server's error message when delete is blocked (e.g. existing campaign history)", async () => {
      const api = makeApi({
        get: vi.fn().mockResolvedValue([{ id: '1', name: 'Ada', phone: '+2348012345678', tags: [] }]),
        delete: vi.fn().mockRejectedValue(new Error('cannot delete a contact with existing campaign history')),
      });
      render(<ContactsPanel api={api} />);
      await screen.findByText('Ada');

      fireEvent.click(screen.getByRole('button', { name: 'Delete Ada' }));
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

      expect(await screen.findByText('cannot delete a contact with existing campaign history')).toBeInTheDocument();
    });
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
