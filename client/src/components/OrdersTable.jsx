import { useState, useEffect, useCallback } from 'react';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';

// A live Google Sheets API call per request (not local SQLite like contacts/
// campaigns) -- polled less often to avoid burning Sheets API quota per open
// dashboard tab (spec: 30-60s range).
const POLL_INTERVAL_MS = 45000;

/**
 * @param {{ api: ReturnType<typeof import('../api.js').createApiClient> }} props
 */
function OrdersTable({ api }) {
  const [orders, setOrders] = useState(null); // null = not loaded yet
  const [error, setError] = useState(null);

  const fetchOrders = useCallback(async () => {
    try {
      const rows = await api.get('/api/orders');
      setOrders(rows);
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

  return (
    <div className="bg-white border border-slate-200/80 rounded-3xl shadow-sm p-6 md:p-8 space-y-4">
      <h3 className="text-lg font-extrabold text-slate-900">Orders</h3>

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
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 font-medium text-slate-700">
              {orders.map((o) => (
                <tr key={o.rowNumber} className="hover:bg-slate-50/50">
                  <td className="py-3 font-semibold text-slate-900">{o.orderId}</td>
                  <td className="py-3">{o.name}</td>
                  <td className="py-3 text-slate-500 font-mono">{o.phone}</td>
                  <td className="py-3">{o.status}</td>
                  <td className="py-3 text-slate-500">{o.lastNotifiedStatus || '—'}</td>
                  <td className="py-3 text-rose-600">{o.lastError || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default OrdersTable;
