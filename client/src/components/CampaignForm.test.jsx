import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CampaignForm from './CampaignForm.jsx';

function makeApi(overrides = {}) {
  return { post: vi.fn(), get: vi.fn(), ...overrides };
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
});
