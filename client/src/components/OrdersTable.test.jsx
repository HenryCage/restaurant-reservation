import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import OrdersTable from './OrdersTable.jsx';

function ordersResponse(rows, over = {}) {
  return { rows, columns: ['orderId', 'name', 'phone', 'amount', 'status'], notifyStatuses: ['Out for delivery', 'Delivered'], ...over };
}

function makeApi(overrides = {}) {
  return { get: vi.fn().mockResolvedValue(ordersResponse([])), post: vi.fn(), patch: vi.fn(), ...overrides };
}

describe('OrdersTable', () => {
  it('renders fetched rows', async () => {
    const api = makeApi({
      get: vi.fn().mockResolvedValue(
        ordersResponse([
          { rowNumber: 2, orderId: 'O1', name: 'Ada', phone: '+2348012345678', status: 'Delivered', lastNotifiedStatus: 'delivered', lastError: '' },
        ]),
      ),
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

  describe('New order', () => {
    it('only renders fields present in columns', async () => {
      const api = makeApi({ get: vi.fn().mockResolvedValue(ordersResponse([], { columns: ['orderId', 'phone', 'status'] })) });
      render(<OrdersTable api={api} />);
      await screen.findByText('No orders yet.');

      fireEvent.click(screen.getByRole('button', { name: /new order/i }));
      expect(screen.queryByLabelText('New order name')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('New order amount')).not.toBeInTheDocument();
      expect(screen.getByLabelText('New order phone')).toBeInTheDocument();
      expect(screen.getByLabelText('New order status')).toBeInTheDocument();
    });

    it('submits the expected payload and refetches on success', async () => {
      const api = makeApi({ post: vi.fn().mockResolvedValue({}) });
      render(<OrdersTable api={api} />);
      await screen.findByText('No orders yet.');

      fireEvent.click(screen.getByRole('button', { name: /new order/i }));
      fireEvent.change(screen.getByLabelText('New order name'), { target: { value: 'Ada' } });
      fireEvent.change(screen.getByLabelText('New order phone'), { target: { value: '8012345678' } });
      fireEvent.change(screen.getByLabelText('New order status'), { target: { value: 'Processing' } });
      fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

      await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/orders', expect.objectContaining({
        name: 'Ada',
        phone: '8012345678',
        countryCode: '234',
        status: 'Processing',
      })));
      await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2)); // initial load + refetch after create
    });

    it('shows an error message on a failed create without crashing', async () => {
      const api = makeApi({ post: vi.fn().mockRejectedValue(new Error('invalid phone: nope')) });
      render(<OrdersTable api={api} />);
      await screen.findByText('No orders yet.');

      fireEvent.click(screen.getByRole('button', { name: /new order/i }));
      fireEvent.change(screen.getByLabelText('New order phone'), { target: { value: 'nope' } });
      fireEvent.change(screen.getByLabelText('New order status'), { target: { value: 'Processing' } });
      fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

      expect(await screen.findByText('invalid phone: nope')).toBeInTheDocument();
    });
  });

  describe('Edit', () => {
    function rowsWithOne() {
      return ordersResponse([
        { rowNumber: 2, orderId: 'ORD-1', name: 'Ada', phone: '+2348012345678', amount: '15000', status: 'Processing', lastNotifiedStatus: '', lastError: '' },
      ]);
    }

    it('pre-fills the edit form and submits a PATCH with expectedOrderId', async () => {
      const api = makeApi({ get: vi.fn().mockResolvedValue(rowsWithOne()), patch: vi.fn().mockResolvedValue({}) });
      render(<OrdersTable api={api} />);
      await screen.findByText('ORD-1');

      fireEvent.click(screen.getByRole('button', { name: /edit order ord-1/i }));
      expect(screen.getByLabelText('Edit name for order ORD-1').value).toBe('Ada');
      expect(screen.getByLabelText('Edit phone for order ORD-1').value).toBe('+2348012345678');

      fireEvent.change(screen.getByLabelText('Edit status for order ORD-1'), { target: { value: 'Delivered' } });
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() =>
        expect(api.patch).toHaveBeenCalledWith(
          '/api/orders/2',
          expect.objectContaining({ expectedOrderId: 'ORD-1', status: 'Delivered' }),
        ),
      );
    });

    it('a 409 conflict shows a refresh message and triggers a refetch', async () => {
      const api = makeApi({
        get: vi.fn().mockResolvedValue(rowsWithOne()),
        patch: vi.fn().mockRejectedValue(new Error('this order changed, please refresh')),
      });
      render(<OrdersTable api={api} />);
      await screen.findByText('ORD-1');

      fireEvent.click(screen.getByRole('button', { name: /edit order ord-1/i }));
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      expect(await screen.findByText(/changed elsewhere/i)).toBeInTheDocument();
      await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2)); // initial load + refetch after conflict
    });
  });
});
