import { useState, useEffect, useCallback } from 'react';
import { ExclamationTriangleIcon, CheckCircleIcon, XCircleIcon, PencilIcon } from '@heroicons/react/24/outline';
import { COUNTRY_CODES } from '../countryCodes.js';

// A live Google Sheets API call per request (not local SQLite like contacts/
// campaigns) -- polled less often to avoid burning Sheets API quota per open
// dashboard tab (spec: 30-60s range).
const POLL_INTERVAL_MS = 45000;

const EMPTY_FORM = { name: '', phone: '', countryCode: '234', amount: '', status: '' };

/**
 * @param {{ api: ReturnType<typeof import('../api.js').createApiClient> }} props
 */
function OrdersTable({ api }) {
  const [orders, setOrders] = useState(null); // null = not loaded yet
  const [columns, setColumns] = useState([]);
  const [notifyStatuses, setNotifyStatuses] = useState([]);
  const [error, setError] = useState(null);
  const [formStatus, setFormStatus] = useState(null);

  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState(EMPTY_FORM);

  const [editingRowNumber, setEditingRowNumber] = useState(null);
  const [editForm, setEditForm] = useState(EMPTY_FORM);
  const [editOrderId, setEditOrderId] = useState('');

  const fetchOrders = useCallback(async () => {
    try {
      const data = await api.get('/api/orders');
      setOrders(data.rows);
      setColumns(data.columns);
      setNotifyStatuses(data.notifyStatuses);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [api]);

  useEffect(() => {
    fetchOrders();
    const interval = setInterval(fetchOrders, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchOrders]);

  const showName = columns.includes('name');
  const showAmount = columns.includes('amount');

  function startCreate() {
    setCreating(true);
    setCreateForm(EMPTY_FORM);
    setFormStatus(null);
  }

  function cancelCreate() {
    setCreating(false);
  }

  async function handleCreateSubmit(e) {
    e.preventDefault();
    setFormStatus(null);
    try {
      await api.post('/api/orders', createForm);
      setCreating(false);
      setFormStatus({ type: 'success', message: 'Order created.' });
      fetchOrders();
    } catch (err) {
      setFormStatus({ type: 'error', message: err.message });
    }
  }

  function startEdit(order) {
    setEditingRowNumber(order.rowNumber);
    setEditOrderId(order.orderId);
    setEditForm({
      name: order.name ?? '',
      phone: order.phone ?? '',
      countryCode: '234',
      amount: order.amount ?? '',
      status: order.status ?? '',
    });
    setFormStatus(null);
  }

  function cancelEdit() {
    setEditingRowNumber(null);
  }

  async function handleEditSubmit(e, rowNumber) {
    e.preventDefault();
    setFormStatus(null);
    try {
      await api.patch(`/api/orders/${rowNumber}`, { expectedOrderId: editOrderId, ...editForm });
      setEditingRowNumber(null);
      fetchOrders();
    } catch (err) {
      if (err.message === 'this order changed, please refresh') {
        setFormStatus({ type: 'error', message: 'This order was changed elsewhere — refreshing…' });
        setEditingRowNumber(null);
        fetchOrders();
      } else {
        setFormStatus({ type: 'error', message: err.message });
      }
    }
  }

  return (
    <div className="bg-white border border-slate-200/80 rounded-3xl shadow-sm p-6 md:p-8 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-lg font-extrabold text-slate-900">Orders</h3>
        {!creating && (
          <button
            type="button"
            onClick={startCreate}
            className="text-sm font-bold text-slate-600 hover:text-slate-900"
          >
            + New order
          </button>
        )}
      </div>

      {formStatus && (
        <div
          className={`p-3.5 rounded-xl border flex items-start gap-2 text-xs font-semibold ${
            formStatus.type === 'success'
              ? 'bg-emerald-50 border-emerald-100 text-emerald-800'
              : 'bg-rose-50 border-rose-100 text-rose-800'
          }`}
        >
          {formStatus.type === 'success' ? (
            <CheckCircleIcon className="w-4 h-4 flex-shrink-0" />
          ) : (
            <XCircleIcon className="w-4 h-4 flex-shrink-0" />
          )}
          <p>{formStatus.message}</p>
        </div>
      )}

      <datalist id="orderStatuses">
        {notifyStatuses.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>

      {creating && (
        <form onSubmit={handleCreateSubmit} className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-2.5">
          {showName && (
            <input
              type="text"
              placeholder="Name"
              aria-label="New order name"
              value={createForm.name}
              onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800 placeholder:text-slate-400"
            />
          )}
          <div className="flex gap-2">
            <select
              aria-label="New order country"
              value={createForm.countryCode}
              onChange={(e) => setCreateForm((f) => ({ ...f, countryCode: e.target.value }))}
              className="border border-slate-200 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800"
            >
              {COUNTRY_CODES.map((c) => (
                <option key={c.code} value={c.code}>{c.label}</option>
              ))}
            </select>
            <input
              type="tel"
              placeholder="Phone"
              aria-label="New order phone"
              value={createForm.phone}
              onChange={(e) => setCreateForm((f) => ({ ...f, phone: e.target.value }))}
              required
              className="flex-1 min-w-0 border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800"
            />
          </div>
          {showAmount && (
            <input
              type="text"
              placeholder="Amount"
              aria-label="New order amount"
              value={createForm.amount}
              onChange={(e) => setCreateForm((f) => ({ ...f, amount: e.target.value }))}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800 placeholder:text-slate-400"
            />
          )}
          <input
            type="text"
            list="orderStatuses"
            placeholder="Status"
            aria-label="New order status"
            value={createForm.status}
            onChange={(e) => setCreateForm((f) => ({ ...f, status: e.target.value }))}
            required
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800 placeholder:text-slate-400"
          />
          <div className="flex gap-2">
            <button type="submit" className="flex-1 py-2 bg-slate-900 text-white rounded-lg text-xs font-bold hover:bg-slate-800">
              Create
            </button>
            <button
              type="button"
              onClick={cancelCreate}
              className="flex-1 py-2 bg-white border border-slate-200 text-slate-600 rounded-lg text-xs font-bold hover:bg-slate-100"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {error ? (
        <div className="p-4 rounded-xl border flex items-start gap-2.5 text-sm font-medium bg-rose-50 border-rose-200 text-rose-800">
          <ExclamationTriangleIcon className="w-5 h-5 flex-shrink-0" />
          <p>{error}</p>
        </div>
      ) : orders === null || orders.length === 0 ? (
        <p className="text-sm text-slate-400">{orders === null ? 'Loading…' : 'No orders yet.'}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse">
            <thead>
              <tr className="border-b border-slate-100 text-slate-400 font-bold">
                <th className="py-2.5">Order ID</th>
                <th className="py-2.5">Name</th>
                <th className="py-2.5">Phone</th>
                <th className="py-2.5">Status</th>
                <th className="py-2.5">Last Notified Status</th>
                <th className="py-2.5">Last Error</th>
                <th className="py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 font-medium text-slate-700">
              {orders.map((o) =>
                editingRowNumber === o.rowNumber ? (
                  <tr key={o.rowNumber} className="bg-slate-50/50">
                    <td colSpan={7} className="py-3">
                      <form
                        onSubmit={(e) => handleEditSubmit(e, o.rowNumber)}
                        className="flex flex-wrap items-center gap-2"
                      >
                        <span className="font-mono text-xs text-slate-400 px-2">{editOrderId}</span>
                        {showName && (
                          <input
                            type="text"
                            aria-label={`Edit name for order ${o.orderId}`}
                            value={editForm.name}
                            onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                            className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800"
                          />
                        )}
                        <select
                          aria-label={`Edit country for order ${o.orderId}`}
                          value={editForm.countryCode}
                          onChange={(e) => setEditForm((f) => ({ ...f, countryCode: e.target.value }))}
                          className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800"
                        >
                          {COUNTRY_CODES.map((c) => (
                            <option key={c.code} value={c.code}>{c.label}</option>
                          ))}
                        </select>
                        <input
                          type="tel"
                          aria-label={`Edit phone for order ${o.orderId}`}
                          value={editForm.phone}
                          onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))}
                          required
                          className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800"
                        />
                        {showAmount && (
                          <input
                            type="text"
                            aria-label={`Edit amount for order ${o.orderId}`}
                            value={editForm.amount}
                            onChange={(e) => setEditForm((f) => ({ ...f, amount: e.target.value }))}
                            className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-24 focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800"
                          />
                        )}
                        <input
                          type="text"
                          list="orderStatuses"
                          aria-label={`Edit status for order ${o.orderId}`}
                          value={editForm.status}
                          onChange={(e) => setEditForm((f) => ({ ...f, status: e.target.value }))}
                          required
                          className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800"
                        />
                        <button type="submit" className="py-1.5 px-3 bg-slate-900 text-white rounded-lg text-xs font-bold hover:bg-slate-800">
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          className="py-1.5 px-3 bg-white border border-slate-200 text-slate-600 rounded-lg text-xs font-bold hover:bg-slate-100"
                        >
                          Cancel
                        </button>
                      </form>
                    </td>
                  </tr>
                ) : (
                  <tr key={o.rowNumber} className="hover:bg-slate-50/50">
                    <td className="py-3 font-semibold text-slate-900">{o.orderId}</td>
                    <td className="py-3">{o.name}</td>
                    <td className="py-3 text-slate-500 font-mono">{o.phone}</td>
                    <td className="py-3">{o.status}</td>
                    <td className="py-3 text-slate-500">{o.lastNotifiedStatus || '—'}</td>
                    <td className="py-3 text-rose-600">{o.lastError || '—'}</td>
                    <td className="py-3">
                      <button
                        type="button"
                        aria-label={`Edit order ${o.orderId}`}
                        onClick={() => startEdit(o)}
                        className="p-1.5 text-slate-400 hover:text-slate-900 rounded-lg hover:bg-slate-100"
                      >
                        <PencilIcon className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default OrdersTable;
