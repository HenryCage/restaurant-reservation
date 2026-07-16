import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import CampaignHistory from './CampaignHistory.jsx';

function makeApi(overrides = {}) {
  return { get: vi.fn().mockResolvedValue([]), ...overrides };
}

describe('CampaignHistory', () => {
  it('renders fetched rows', async () => {
    const api = makeApi({
      get: vi.fn().mockResolvedValue([
        { id: 'c1', name: 'Promo', sendTo: 'all', scheduledTime: '2026-01-01T00:00:00.000Z', status: 'sent' },
      ]),
    });
    render(<CampaignHistory api={api} />);

    expect(await screen.findByText('Promo')).toBeInTheDocument();
    expect(screen.getByText('All contacts')).toBeInTheDocument();
    expect(screen.getByText('sent')).toBeInTheDocument();
  });

  it('shows an empty state with no campaigns', async () => {
    render(<CampaignHistory api={makeApi()} />);
    expect(await screen.findByText('No campaigns yet.')).toBeInTheDocument();
  });

  it('resolves a single-contact sendTo (a contact id) to that contact\'s name', async () => {
    const api = makeApi({
      get: vi.fn().mockResolvedValue([
        { id: 'c1', name: 'Solo', sendTo: 'contact-123', scheduledTime: '2026-01-01T00:00:00.000Z', status: 'sent' },
      ]),
    });
    render(<CampaignHistory api={api} contacts={[{ id: 'contact-123', name: 'Ada' }]} />);

    expect(await screen.findByText('Ada')).toBeInTheDocument();
    expect(screen.queryByText('contact-123')).not.toBeInTheDocument();
  });

  it('falls back to "Unknown contact" instead of showing a raw id when the contact is not found', async () => {
    const api = makeApi({
      get: vi.fn().mockResolvedValue([
        { id: 'c1', name: 'Solo', sendTo: 'missing-id', scheduledTime: '2026-01-01T00:00:00.000Z', status: 'sent' },
      ]),
    });
    render(<CampaignHistory api={api} contacts={[]} />);

    expect(await screen.findByText('Unknown contact')).toBeInTheDocument();
  });

  describe('polling', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('polls every 5s and stops on unmount', async () => {
      const api = makeApi();
      const { unmount } = render(<CampaignHistory api={api} />);
      await vi.advanceTimersByTimeAsync(0);
      expect(api.get).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5000);
      expect(api.get).toHaveBeenCalledTimes(2);

      unmount();
      await vi.advanceTimersByTimeAsync(10000);
      expect(api.get).toHaveBeenCalledTimes(2);
    });
  });
});
