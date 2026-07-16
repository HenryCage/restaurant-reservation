import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import OrdersTable from './OrdersTable.jsx';

function makeApi(overrides = {}) {
  return { get: vi.fn().mockResolvedValue([]), ...overrides };
}

describe('OrdersTable', () => {
  it('renders fetched rows', async () => {
    const api = makeApi({
      get: vi.fn().mockResolvedValue([
        { rowNumber: 2, orderId: 'O1', name: 'Ada', phone: '+2348012345678', status: 'Delivered', lastNotifiedStatus: 'delivered', lastError: '' },
      ]),
    });
    render(<OrdersTable api={api} />);

    expect(await screen.findByText('O1')).toBeInTheDocument();
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Delivered')).toBeInTheDocument();
  });

  it('distinguishes an empty-but-successful response from a failed one', async () => {
    render(<OrdersTable api={makeApi()} />);
    expect(await screen.findByText('No orders yet.')).toBeInTheDocument();
  });

  it('renders an error banner on a failed fetch instead of an empty table', async () => {
    const api = makeApi({ get: vi.fn().mockRejectedValue(new Error('sheet is empty (no header row)')) });
    render(<OrdersTable api={api} />);

    expect(await screen.findByText('sheet is empty (no header row)')).toBeInTheDocument();
    expect(screen.queryByText('No orders yet.')).not.toBeInTheDocument();
  });

  describe('polling', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('polls at 45s, not the 5s cadence used elsewhere', async () => {
      const api = makeApi();
      render(<OrdersTable api={api} />);
      await vi.advanceTimersByTimeAsync(0);
      expect(api.get).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5000);
      expect(api.get).toHaveBeenCalledTimes(1); // not yet -- 5s alone isn't enough

      await vi.advanceTimersByTimeAsync(40000); // total 45s
      expect(api.get).toHaveBeenCalledTimes(2);
    });
  });
});
