import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CampaignForm from './CampaignForm.jsx';

function makeApi(overrides = {}) {
  return { post: vi.fn(), get: vi.fn(), patch: vi.fn(), ...overrides };
}

const CONTACTS = [
  { id: 'c1', name: 'Ada', phone: '+2348012345678' },
  { id: 'c2', name: 'Bola', phone: '+2348023456789' },
];

describe('CampaignForm', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('submits the expected payload, defaulting a blank schedule to "now"', async () => {
    // Fake only Date (not setTimeout/setInterval), so RTL's waitFor below
    // -- which itself relies on real timers -- still works normally.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));

    const api = makeApi({ post: vi.fn().mockResolvedValue({ id: 'camp1' }) });
    render(<CampaignForm api={api} contacts={CONTACTS} />);

    fireEvent.change(screen.getByLabelText('Campaign Name'), { target: { value: 'Promo' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hello there' } });
    fireEvent.change(screen.getByLabelText('Send To'), { target: { value: 'c1' } });
    fireEvent.click(screen.getByRole('button', { name: /create campaign/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledWith('/api/campaigns', {
      name: 'Promo',
      message: 'Hello there',
      sendTo: 'c1',
      scheduledTime: '2026-01-01T12:00:00.000Z',
    });
  });

  it('defaults sendTo to "all" and lists each contact as an option', () => {
    render(<CampaignForm api={makeApi()} contacts={CONTACTS} />);
    expect(screen.getByLabelText('Send To').value).toBe('all');
    expect(screen.getByRole('option', { name: /Ada/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Bola/ })).toBeInTheDocument();
  });

  it('calls onCreated and clears the form on success', async () => {
    const api = makeApi({ post: vi.fn().mockResolvedValue({ id: 'camp1' }) });
    const onCreated = vi.fn();
    render(<CampaignForm api={api} contacts={CONTACTS} onCreated={onCreated} />);

    fireEvent.change(screen.getByLabelText('Campaign Name'), { target: { value: 'Promo' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hi' } });
    fireEvent.click(screen.getByRole('button', { name: /create campaign/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('Campaign Name').value).toBe('');
  });

  it('shows the server error on a rejected submit', async () => {
    const api = makeApi({ post: vi.fn().mockRejectedValue(new Error('sendTo "x" is not a known contact for this tenant')) });
    render(<CampaignForm api={api} contacts={CONTACTS} />);

    fireEvent.change(screen.getByLabelText('Campaign Name'), { target: { value: 'Promo' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hi' } });
    fireEvent.click(screen.getByRole('button', { name: /create campaign/i }));

    expect(await screen.findByText('sendTo "x" is not a known contact for this tenant')).toBeInTheDocument();
  });

  describe('Send To search filter', () => {
    const MANY_CONTACTS = [
      { id: 'c1', name: 'Ada Lovelace', phone: '+2348012345678' },
      { id: 'c2', name: 'Bola Adeyemi', phone: '+2348023456789' },
      { id: 'c3', name: 'Chidi Okafor', phone: '+2348034567890' },
      { id: 'c4', name: 'Dupe Balogun', phone: '+2348045678901' },
      { id: 'c5', name: 'Emeka Nwosu', phone: '+2348056789012' },
      { id: 'c6', name: 'Fatima Bello', phone: '+2348067890123' },
    ];

    it('does not show a search box for a handful of contacts', () => {
      render(<CampaignForm api={makeApi()} contacts={CONTACTS} />);
      expect(screen.queryByLabelText('Search recipients')).not.toBeInTheDocument();
    });

    it('shows a search box and filters options once there are many contacts', () => {
      render(<CampaignForm api={makeApi()} contacts={MANY_CONTACTS} />);
      expect(screen.getByRole('option', { name: /Ada Lovelace/ })).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Search recipients'), { target: { value: 'bola' } });

      expect(screen.queryByRole('option', { name: /Ada Lovelace/ })).not.toBeInTheDocument();
      expect(screen.getByRole('option', { name: /Bola Adeyemi/ })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'All contacts' })).toBeInTheDocument(); // always present
    });

    it('keeps the already-selected contact visible even when the search filters it out', () => {
      render(<CampaignForm api={makeApi()} contacts={MANY_CONTACTS} />);
      fireEvent.change(screen.getByLabelText('Send To'), { target: { value: 'c1' } });

      fireEvent.change(screen.getByLabelText('Search recipients'), { target: { value: 'bola' } });

      expect(screen.getByRole('option', { name: /Ada Lovelace/ })).toBeInTheDocument();
      expect(screen.getByLabelText('Send To').value).toBe('c1');
    });
  });

  describe('editing a campaign', () => {
    const EDITING = {
      id: 'camp1',
      name: 'Old promo',
      message: 'Old message',
      sendTo: 'c2',
      scheduledTime: '2026-01-05T10:30:00.000Z',
    };

    it('prefills the form from editingCampaign and shows "Edit campaign"', () => {
      render(<CampaignForm api={makeApi()} contacts={CONTACTS} editingCampaign={EDITING} />);

      expect(screen.getByRole('heading', { name: 'Edit campaign' })).toBeInTheDocument();
      expect(screen.getByLabelText('Campaign Name').value).toBe('Old promo');
      expect(screen.getByLabelText('Message').value).toBe('Old message');
      expect(screen.getByLabelText('Send To').value).toBe('c2');
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });

    it('submits a PATCH to the campaign and calls onCreated + onCancelEdit on success', async () => {
      const api = makeApi({ patch: vi.fn().mockResolvedValue({ id: 'camp1' }) });
      const onCreated = vi.fn();
      const onCancelEdit = vi.fn();
      render(
        <CampaignForm
          api={api}
          contacts={CONTACTS}
          editingCampaign={EDITING}
          onCreated={onCreated}
          onCancelEdit={onCancelEdit}
        />,
      );

      fireEvent.change(screen.getByLabelText('Campaign Name'), { target: { value: 'New promo name' } });
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
      const [path, body] = api.patch.mock.calls[0];
      expect(path).toBe('/api/campaigns/camp1');
      expect(body).toMatchObject({ name: 'New promo name', message: 'Old message', sendTo: 'c2' });
      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(onCancelEdit).toHaveBeenCalledTimes(1);
    });

    it('the Cancel button resets the form and calls onCancelEdit without saving', () => {
      const onCancelEdit = vi.fn();
      const api = makeApi();
      render(<CampaignForm api={api} contacts={CONTACTS} editingCampaign={EDITING} onCancelEdit={onCancelEdit} />);

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(onCancelEdit).toHaveBeenCalledTimes(1);
      expect(api.patch).not.toHaveBeenCalled();
    });

    it('shows the server error on a rejected edit submit', async () => {
      const api = makeApi({ patch: vi.fn().mockRejectedValue(new Error('only a pending campaign can be edited')) });
      render(<CampaignForm api={api} contacts={CONTACTS} editingCampaign={EDITING} />);

      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

      expect(await screen.findByText('only a pending campaign can be edited')).toBeInTheDocument();
    });
  });
});
