import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CampaignHistory from './CampaignHistory.jsx';

function makeApi(overrides = {}) {
  return { get: vi.fn().mockResolvedValue([]), post: vi.fn(), ...overrides };
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

  describe('recipient drill-down', () => {
    const PENDING_CAMPAIGN = { id: 'c1', name: 'Promo', sendTo: 'all', scheduledTime: '2026-01-01T00:00:00.000Z', status: 'sent' };

    it('fetches and shows recipients on expand, then hides them on collapse', async () => {
      const api = makeApi({
        get: vi.fn(async (path) => {
          if (path === '/api/campaigns') return [PENDING_CAMPAIGN];
          if (path === '/api/campaigns/c1/recipients') {
            return [{ id: 'r1', phone: '+2348012345678', status: 'failed', error: 'invalid number', sentAt: null }];
          }
          throw new Error(`unexpected path: ${path}`);
        }),
      });
      render(<CampaignHistory api={api} />);
      await screen.findByText('Promo');

      fireEvent.click(screen.getByRole('button', { name: 'Expand Promo' }));
      expect(await screen.findByText('+2348012345678')).toBeInTheDocument();
      expect(screen.getByText('invalid number')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Collapse Promo' }));
      expect(screen.queryByText('+2348012345678')).not.toBeInTheDocument();
    });

    it('does not refetch recipients on a second expand (cached)', async () => {
      const recipientsGet = vi.fn().mockResolvedValue([]);
      const api = makeApi({
        get: vi.fn(async (path) => {
          if (path === '/api/campaigns') return [PENDING_CAMPAIGN];
          return recipientsGet(path);
        }),
      });
      render(<CampaignHistory api={api} />);
      await screen.findByText('Promo');

      fireEvent.click(screen.getByRole('button', { name: 'Expand Promo' }));
      await screen.findByText('No recipients yet.');
      fireEvent.click(screen.getByRole('button', { name: 'Collapse Promo' }));
      fireEvent.click(screen.getByRole('button', { name: 'Expand Promo' }));

      await screen.findByText('No recipients yet.');
      expect(recipientsGet).toHaveBeenCalledTimes(1);
    });

    it('shows an error if fetching recipients fails', async () => {
      const api = makeApi({
        get: vi.fn(async (path) => {
          if (path === '/api/campaigns') return [PENDING_CAMPAIGN];
          throw new Error('backend unavailable');
        }),
      });
      render(<CampaignHistory api={api} />);
      await screen.findByText('Promo');

      fireEvent.click(screen.getByRole('button', { name: 'Expand Promo' }));
      expect(await screen.findByText('backend unavailable')).toBeInTheDocument();
    });
  });

  describe('pending campaign actions', () => {
    const PENDING = { id: 'c1', name: 'Promo', sendTo: 'all', scheduledTime: '2099-01-01T00:00:00.000Z', status: 'pending' };
    const SENT = { id: 'c2', name: 'Old promo', sendTo: 'all', scheduledTime: '2026-01-01T00:00:00.000Z', status: 'sent' };

    it('shows Edit/Cancel only for pending campaigns', async () => {
      const api = makeApi({ get: vi.fn().mockResolvedValue([PENDING, SENT]) });
      render(<CampaignHistory api={api} />);
      await screen.findByText('Promo');

      expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(1);
      expect(screen.getAllByRole('button', { name: 'Cancel Promo' })).toHaveLength(1);
    });

    it('calls onEdit with the campaign when Edit is clicked', async () => {
      const onEdit = vi.fn();
      const api = makeApi({ get: vi.fn().mockResolvedValue([PENDING]) });
      render(<CampaignHistory api={api} onEdit={onEdit} />);
      await screen.findByText('Promo');

      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      expect(onEdit).toHaveBeenCalledWith(PENDING);
    });

    it('shows a confirm dialog, then cancels the campaign on confirm and refetches', async () => {
      const api = makeApi({
        get: vi
          .fn()
          .mockResolvedValueOnce([PENDING])
          .mockResolvedValueOnce([{ ...PENDING, status: 'cancelled' }]),
        post: vi.fn().mockResolvedValue({ ...PENDING, status: 'cancelled' }),
      });
      render(<CampaignHistory api={api} />);
      await screen.findByText('Promo');

      fireEvent.click(screen.getByRole('button', { name: 'Cancel Promo' }));
      expect(await screen.findByText('Cancel "Promo"?')).toBeInTheDocument();
      expect(api.post).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Cancel campaign' }));

      await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/campaigns/c1/cancel', {}));
      await screen.findByText('cancelled');
    });

    it('does not cancel if the dialog is dismissed', async () => {
      const api = makeApi({ get: vi.fn().mockResolvedValue([PENDING]) });
      render(<CampaignHistory api={api} />);
      await screen.findByText('Promo');

      fireEvent.click(screen.getByRole('button', { name: 'Cancel Promo' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); // the dialog's own dismiss button

      expect(api.post).not.toHaveBeenCalled();
      expect(screen.queryByText('Cancel "Promo"?')).not.toBeInTheDocument();
    });

    it('shows an error if cancelling fails', async () => {
      const api = makeApi({
        get: vi.fn().mockResolvedValue([PENDING]),
        post: vi.fn().mockRejectedValue(new Error('only a pending campaign can be cancelled')),
      });
      render(<CampaignHistory api={api} />);
      await screen.findByText('Promo');

      fireEvent.click(screen.getByRole('button', { name: 'Cancel Promo' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel campaign' }));
      expect(await screen.findByText('only a pending campaign can be cancelled')).toBeInTheDocument();
    });
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
