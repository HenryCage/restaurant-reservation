import { useState, useEffect, useCallback } from 'react';
import { ExclamationTriangleIcon, CheckCircleIcon, XCircleIcon, PencilIcon } from '@heroicons/react/24/outline';
import { COUNTRY_CODES } from '../countryCodes.js';

// A live Google Sheets API call per request (not local SQLite like contacts/
// campaigns) -- polled less often to avoid burning Sheets API quota per open
// dashboard tab (spec: 30-60s range).
const POLL_INTERVAL_MS = 45000;

const inputClass =
  'w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800 placeholder:text-slate-400 disabled:bg-slate-50 disabled:text-slate-400';
const selectClass =
  'border border-slate-200 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800';

/**
 * @param {{ api: ReturnType<typeof import('../api.js').createApiClient> }} props
 */
function OrdersTable({ api }) {
  const [orders, setOrders] = useState(null); // null = not loaded yet
  const [headers, setHeaders] = useState([]);
  const [roles, setRoles] = useState({});
  const [notifyStatuses, setNotifyStatuses] = useState([]);
  const [error, setError] = useState(null);
  const [formStatus, setFormStatus] = useState(null);

  const [creating, setCreating] = useState(false);
  const [createValues, setCreateValues] = useState({});
  const [createCountryCode, setCreateCountryCode] = useState('234');

  const [editingRowNumber, setEditingRowNumber] = useState(null);
  const [editOrderId, setEditOrderId] = useState('');
  const [editValues, setEditValues] = useState({});
  const [editCountryCode, setEditCountryCode] = useState('234');

  const fetchOrders = useCallback(async () => {
    try {
      const data = await api.get('/api/orders');
      // A stale backend (not yet restarted after a deploy) or a proxy/cache
      // hiccup could hand back an older response shape -- fail into the
      // existing error banner rather than crash the whole component.
      if (
        !data ||
        !Array.isArray(data.rows) ||
        !Array.isArray(data.headers) ||
        typeof data.roles !== 'object' ||
        data.rows.some((r) => !r || typeof r.values !== 'object')
      ) {
        throw new Error('Unexpected response from the server -- try refreshing the page.');
      }
      setOrders(data.rows);
      setHeaders(data.headers);
      setRoles(data.roles);
      setNotifyStatuses(data.notifyStatuses ?? []);
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

  const serviceHeaders = [roles.lastNotifiedStatus, roles.notifiedAt, roles.lastError];

  function startCreate() {
    setCreating(true);
    setCreateValues({});
    setCreateCountryCode('234');
    setFormStatus(null);
  }

  function cancelCreate() {
    setCreating(false);
  }

  async function handleCreateSubmit(e) {
    e.preventDefault();
    setFormStatus(null);
    try {
      await api.post('/api/orders', { values: createValues, countryCode: createCountryCode });
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
    // Every header's value pre-fills except Order ID/service columns, which
    // are rendered straight from the row itself (read-only, never submitted).
    const values = { ...order.values };
    delete values[roles.orderId];
    for (const h of serviceHeaders) delete values[h];
    setEditValues(values);
    setEditCountryCode('234');
    setFormStatus(null);
  }

  function cancelEdit() {
    setEditingRowNumber(null);
  }

  async function handleEditSubmit(e, rowNumber) {
    e.preventDefault();
    setFormStatus(null);
    try {
      await api.patch(`/api/orders/${rowNumber}`, {
        expectedOrderId: editOrderId,
        values: editValues,
        countryCode: editCountryCode,
      });
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

  /** One input per header, in sheet order -- shared shape for both the New Order form and an in-row edit form. */
  function renderField(header, { values, setValues, countryCode, setCountryCode, labelFor, countryLabel, disabledValue }) {
    if (disabledValue !== undefined) {
      return (
        <input
          key={header}
          type="text"
          aria-label={labelFor(header)}
          value={disabledValue}
          disabled
          className={`${inputClass} font-mono`}
        />
      );
    }
    if (header === roles.phone) {
      return (
        <div key={header} className="flex gap-2">
          <select
            aria-label={countryLabel}
            value={countryCode}
            onChange={(e) => setCountryCode(e.target.value)}
            className={selectClass}
          >
            {COUNTRY_CODES.map((c) => (
              <option key={c.code} value={c.code}>{c.label}</option>
            ))}
          </select>
          <input
            type="tel"
            aria-label={labelFor(header)}
            value={values[header] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [header]: e.target.value }))}
            required
            className={`${inputClass} flex-1 min-w-0 font-mono`}
          />
        </div>
      );
    }
    if (header === roles.status) {
      return (
        <input
          key={header}
          type="text"
          list="orderStatuses"
          placeholder={header}
          aria-label={labelFor(header)}
          value={values[header] ?? ''}
          onChange={(e) => setValues((v) => ({ ...v, [header]: e.target.value }))}
          required
          className={inputClass}
        />
      );
    }
    return (
      <input
        key={header}
        type="text"
        placeholder={header}
        aria-label={labelFor(header)}
        value={values[header] ?? ''}
        onChange={(e) => setValues((v) => ({ ...v, [header]: e.target.value }))}
        className={inputClass}
      />
    );
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
          {headers
            .filter((h) => h !== roles.orderId) // server-generated, omitted from create entirely
            .map((header) =>
              renderField(header, {
                values: createValues,
                setValues: setCreateValues,
                countryCode: createCountryCode,
                setCountryCode: setCreateCountryCode,
                labelFor: (h) => `New order ${h}`,
                countryLabel: 'New order country',
                disabledValue: serviceHeaders.includes(header) ? '' : undefined,
              }),
            )}
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
                {headers.map((header) => (
                  <th key={header} className="py-2.5 pr-4 whitespace-nowrap">{header}</th>
                ))}
                <th className="py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 font-medium text-slate-700">
              {orders.map((o) =>
                editingRowNumber === o.rowNumber ? (
                  <tr key={o.rowNumber} className="bg-slate-50/50">
                    <td colSpan={headers.length + 1} className="py-3">
                      <form
                        onSubmit={(e) => handleEditSubmit(e, o.rowNumber)}
                        className="flex flex-wrap items-center gap-2"
                      >
                        {headers.map((header) =>
                          renderField(header, {
                            values: editValues,
                            setValues: setEditValues,
                            countryCode: editCountryCode,
                            setCountryCode: setEditCountryCode,
                            labelFor: (h) => `Edit ${h} for order ${o.orderId}`,
                            countryLabel: `Edit country for order ${o.orderId}`,
                            disabledValue:
                              header === roles.orderId
                                ? editOrderId
                                : serviceHeaders.includes(header)
                                  ? o.values[header] ?? ''
                                  : undefined,
                          }),
                        )}
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
                    {headers.map((header) => (
                      <td key={header} className="py-3 pr-4 whitespace-nowrap">
                        {o.values[header] || (header === roles.lastNotifiedStatus || header === roles.lastError ? '—' : '')}
                      </td>
                    ))}
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
