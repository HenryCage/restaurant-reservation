import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import DashboardScreen from './DashboardScreen.jsx';

function makeApi({ contacts = [], campaigns = [], orders = [], failContacts = false } = {}) {
  return {
    get: vi.fn(async (path) => {
      if (path === '/api/contacts') {
        if (failContacts) throw new Error('backend unavailable');
        return contacts;
      }
      if (path === '/api/campaigns') return campaigns;
      if (path === '/api/orders') return orders;
      throw new Error(`unexpected path: ${path}`);
    }),
    post: vi.fn(),
  };
}

describe('DashboardScreen', () => {
  it('renders all five regions given mocked api responses', async () => {
    const api = makeApi({
      contacts: [{ id: 'c1', name: 'Ada', phone: '+2348012345678' }],
      campaigns: [{ id: 'camp1', name: 'Promo', sendTo: 'all', scheduledTime: '2026-01-01T00:00:00.000Z', status: 'sent' }],
      orders: [{ rowNumber: 2, orderId: 'O1', name: 'Ada', phone: '+2348012345678', status: 'Delivered', lastNotifiedStatus: 'delivered', lastError: '' }],
    });
    render(<DashboardScreen api={api} onLogout={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'Contacts' })).toBeInTheDocument(); // ContactsPanel
    expect(screen.getByRole('heading', { name: 'New campaign' })).toBeInTheDocument(); // CampaignForm
    expect(screen.getByRole('heading', { name: 'Campaign History' })).toBeInTheDocument(); // CampaignHistory
    expect(screen.getByRole('heading', { name: 'Orders' })).toBeInTheDocument(); // OrdersTable
    expect(screen.getByText('Queued')).toBeInTheDocument(); // StatTiles
  });

  it('renders an error state instead of a half-populated screen when the initial fetch fails', async () => {
    const api = makeApi({ failContacts: true });
    render(<DashboardScreen api={api} onLogout={vi.fn()} />);

    expect(await screen.findByText('backend unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'New campaign' })).not.toBeInTheDocument();
  });
});
