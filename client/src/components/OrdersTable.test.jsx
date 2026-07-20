import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import OrdersTable from './OrdersTable.jsx';

const HEADERS = ['Order ID', 'Customer Name', 'Phone', 'Amount', 'Status', 'Last Notified Status', 'Notified At', 'Last Error'];
const ROLES = {
  orderId: 'Order ID',
  phone: 'Phone',
  status: 'Status',
  lastNotifiedStatus: 'Last Notified Status',
  notifiedAt: 'Notified At',
  lastError: 'Last Error',
};

function rowValues(over = {}) {
  return Object.fromEntries(HEADERS.map((h) => [h, over[h] ?? '']));
}

function ordersResponse(rows, over = {}) {
  return { headers: HEADERS, rows, roles: ROLES, notifyStatuses: ['Out for delivery', 'Delivered'], ...over };
}

function makeApi(overrides = {}) {
  return { get: vi.fn().mockResolvedValue(ordersResponse([])), post: vi.fn(), patch: vi.fn(), ...overrides };
}

describe('OrdersTable', () => {
  it('renders fetched rows, headers in sheet order, including an unrecognised column', async () => {
    const headersWithNotes = [...HEADERS, 'Notes'];
    const api = makeApi({
      get: vi.fn().mockResolvedValue(
        ordersResponse(
          [
            {
              rowNumber: 2,
              orderId: 'O1',
              values: { ...rowValues({ 'Order ID': 'O1', 'Customer Name': 'Ada', Phone: '+2348012345678', Status: 'Delivered' }), Notes: 'fragile' },
            },
          ],
          { headers: headersWithNotes },
        ),
      ),
    });
    render(<OrdersTable api={api} />);

    expect(await screen.findByText('O1')).toBeInTheDocument();
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Delivered')).toBeInTheDocument();
    expect(screen.getByText('fragile')).toBeInTheDocument();

    // Table headers render in sheet order, including the unrecognised column.
    const headerCells = screen.getAllByRole('columnheader').map((th) => th.textContent);
    expect(headerCells).toEqual([...headersWithNotes, '']);
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

  it('an unexpected response shape (e.g. a not-yet-restarted backend) shows the error banner instead of crashing', async () => {
    const api = makeApi({ get: vi.fn().mockResolvedValue([]) }); // old shape: no .rows/.headers/.roles at all
    render(<OrdersTable api={api} />);

    expect(await screen.findByText(/unexpected response from the server/i)).toBeInTheDocument();
  });

  it('a row missing .values (e.g. the old flat-field shape) also shows the error banner instead of crashing', async () => {
    const api = makeApi({
      get: vi.fn().mockResolvedValue(ordersResponse([{ rowNumber: 2, orderId: 'O1', name: 'Ada' }])),
    });
    render(<OrdersTable api={api} />);

    expect(await screen.findByText(/unexpected response from the server/i)).toBeInTheDocument();
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
    it('renders one field per header, skipping Order ID and never disabling Phone/Status', async () => {
      const api = makeApi({ get: vi.fn().mockResolvedValue(ordersResponse([], { headers: ['Order ID', 'Phone', 'Status'] })) });
      render(<OrdersTable api={api} />);
      await screen.findByText('No orders yet.');

      fireEvent.click(screen.getByRole('button', { name: /new order/i }));
      expect(screen.queryByLabelText('New order Order ID')).not.toBeInTheDocument();
      expect(screen.getByLabelText('New order Phone')).toBeInTheDocument();
      expect(screen.getByLabelText('New order Status')).toBeInTheDocument();
    });

    it('renders an arbitrary column as a plain labeled text input', async () => {
      const api = makeApi({ get: vi.fn().mockResolvedValue(ordersResponse([], { headers: [...HEADERS, 'Notes'] })) });
      render(<OrdersTable api={api} />);
      await screen.findByText('No orders yet.');

      fireEvent.click(screen.getByRole('button', { name: /new order/i }));
      expect(screen.getByLabelText('New order Notes')).toBeInTheDocument();
    });

    it('service columns render disabled and blank (nothing to show yet on a new order)', async () => {
      const api = makeApi({ get: vi.fn().mockResolvedValue(ordersResponse([])) });
      render(<OrdersTable api={api} />);
      await screen.findByText('No orders yet.');

      fireEvent.click(screen.getByRole('button', { name: /new order/i }));
      const field = screen.getByLabelText('New order Last Notified Status');
      expect(field).toBeDisabled();
      expect(field.value).toBe('');
    });

    it('submits the expected payload and refetches on success', async () => {
      const api = makeApi({ post: vi.fn().mockResolvedValue({}) });
      render(<OrdersTable api={api} />);
      await screen.findByText('No orders yet.');

      fireEvent.click(screen.getByRole('button', { name: /new order/i }));
      fireEvent.change(screen.getByLabelText('New order Customer Name'), { target: { value: 'Ada' } });
      fireEvent.change(screen.getByLabelText('New order Phone'), { target: { value: '8012345678' } });
      fireEvent.change(screen.getByLabelText('New order Status'), { target: { value: 'Processing' } });
      fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

      await waitFor(() =>
        expect(api.post).toHaveBeenCalledWith('/api/orders', {
          values: { 'Customer Name': 'Ada', Phone: '8012345678', Status: 'Processing' },
          countryCode: '234',
        }),
      );
      await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2)); // initial load + refetch after create
    });

    it('shows an error message on a failed create without crashing', async () => {
      const api = makeApi({ post: vi.fn().mockRejectedValue(new Error('invalid phone: nope')) });
      render(<OrdersTable api={api} />);
      await screen.findByText('No orders yet.');

      fireEvent.click(screen.getByRole('button', { name: /new order/i }));
      fireEvent.change(screen.getByLabelText('New order Phone'), { target: { value: 'nope' } });
      fireEvent.change(screen.getByLabelText('New order Status'), { target: { value: 'Processing' } });
      fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

      expect(await screen.findByText('invalid phone: nope')).toBeInTheDocument();
    });
  });

  describe('Edit', () => {
    function rowsWithOne(over = {}) {
      return ordersResponse([
        {
          rowNumber: 2,
          orderId: 'ORD-1',
          values: rowValues({ 'Order ID': 'ORD-1', 'Customer Name': 'Ada', Phone: '+2348012345678', Amount: '15000', Status: 'Processing' }),
        },
      ], over);
    }

    it('pre-fills the edit form (Order ID read-only) and submits a PATCH with expectedOrderId', async () => {
      const api = makeApi({ get: vi.fn().mockResolvedValue(rowsWithOne()), patch: vi.fn().mockResolvedValue({}) });
      render(<OrdersTable api={api} />);
      await screen.findByText('ORD-1');

      fireEvent.click(screen.getByRole('button', { name: /edit order ord-1/i }));
      expect(screen.getByLabelText('Edit Customer Name for order ORD-1').value).toBe('Ada');
      expect(screen.getByLabelText('Edit Phone for order ORD-1').value).toBe('+2348012345678');
      const orderIdField = screen.getByLabelText('Edit Order ID for order ORD-1');
      expect(orderIdField.value).toBe('ORD-1');
      expect(orderIdField).toBeDisabled();

      fireEvent.change(screen.getByLabelText('Edit Status for order ORD-1'), { target: { value: 'Delivered' } });
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() =>
        expect(api.patch).toHaveBeenCalledWith('/api/orders/2', {
          expectedOrderId: 'ORD-1',
          values: { 'Customer Name': 'Ada', Phone: '+2348012345678', Amount: '15000', Status: 'Delivered' },
          countryCode: '234',
        }),
      );
    });

    it('service columns show the row\'s current value, disabled', async () => {
      const api = makeApi({
        get: vi.fn().mockResolvedValue(
          ordersResponse([
            {
              rowNumber: 2,
              orderId: 'ORD-1',
              values: rowValues({ 'Order ID': 'ORD-1', 'Last Notified Status': 'delivered', 'Last Error': 'timeout' }),
            },
          ]),
        ),
      });
      render(<OrdersTable api={api} />);
      await screen.findByText('ORD-1');

      fireEvent.click(screen.getByRole('button', { name: /edit order ord-1/i }));
      const field = screen.getByLabelText('Edit Last Notified Status for order ORD-1');
      expect(field.value).toBe('delivered');
      expect(field).toBeDisabled();
    });

    it('an arbitrary column pre-fills and round-trips through edit', async () => {
      const headersWithNotes = [...HEADERS, 'Notes'];
      const api = makeApi({
        get: vi.fn().mockResolvedValue(
          ordersResponse(
            [
              {
                rowNumber: 2,
                orderId: 'ORD-1',
                values: { ...rowValues({ 'Order ID': 'ORD-1', Phone: '+2348012345678', Status: 'Processing' }), Notes: 'old note' },
              },
            ],
            { headers: headersWithNotes },
          ),
        ),
        patch: vi.fn().mockResolvedValue({}),
      });
      render(<OrdersTable api={api} />);
      await screen.findByText('ORD-1');

      fireEvent.click(screen.getByRole('button', { name: /edit order ord-1/i }));
      expect(screen.getByLabelText('Edit Notes for order ORD-1').value).toBe('old note');

      fireEvent.change(screen.getByLabelText('Edit Notes for order ORD-1'), { target: { value: 'new note' } });
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() =>
        expect(api.patch).toHaveBeenCalledWith(
          '/api/orders/2',
          expect.objectContaining({ values: expect.objectContaining({ Notes: 'new note' }) }),
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
