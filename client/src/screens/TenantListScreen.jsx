import { useState, useEffect, useCallback } from 'react';

const STATUS_STYLE = {
  active: 'bg-emerald-100 text-emerald-800',
  inactive: 'bg-slate-200 text-slate-600',
};

/**
 * @param {{
 *   api: ReturnType<typeof import('../api.js').createApiClient>,
 *   refreshKey?: number,
 *   onEdit: (tenant: object) => void,
 *   onCreate: () => void,
 *   onBack: () => void,
 * }} props
 */
function TenantListScreen({ api, refreshKey, onEdit, onCreate, onBack }) {
  const [tenants, setTenants] = useState(null); // null = not loaded yet
  const [error, setError] = useState(null);

  const fetchTenants = useCallback(async () => {
    try {
      const list = await api.get('/api/tenants');
      setTenants(list);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [api]);

  // No polling here (unlike contacts/campaigns) -- this is an infrequently-
  // changing admin view; refreshKey lets the parent force a re-fetch after a
  // create/edit instead.
  useEffect(() => {
    fetchTenants();
  }, [fetchTenants, refreshKey]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-6 md:p-12 font-sans">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-black text-slate-900 tracking-tight">Tenants</h1>
            <p className="text-sm text-slate-500 font-medium">Manage tenant configuration.</p>
          </div>
          <button type="button" onClick={onBack} className="text-sm font-bold text-slate-500 hover:text-slate-900">
            ← Back
          </button>
        </div>

        {error && (
          <div className="p-4 rounded-xl border bg-rose-50 border-rose-200 text-rose-800 text-sm font-medium">
            {error}
          </div>
        )}

        <div className="bg-white border border-slate-200/80 rounded-3xl shadow-sm p-6 space-y-4">
          <button
            type="button"
            onClick={onCreate}
            className="py-3 px-5 bg-slate-900 text-white rounded-xl text-sm font-bold hover:bg-slate-800 transition-all active:scale-[0.99]"
          >
            Create new tenant
          </button>

          {tenants === null || tenants.length === 0 ? (
            <p className="text-sm text-slate-400">{tenants === null ? 'Loading…' : 'No tenants yet.'}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="border-b border-slate-100 text-slate-400 font-bold">
                    <th className="py-2.5">ID</th>
                    <th className="py-2.5">Name</th>
                    <th className="py-2.5">Status</th>
                    <th className="py-2.5">Sheet ID</th>
                    <th className="py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50 font-medium text-slate-700">
                  {tenants.map((t) => (
                    <tr key={t.id} className="hover:bg-slate-50/50">
                      <td className="py-3 font-mono text-xs">{t.id}</td>
                      <td className="py-3 font-semibold text-slate-900">{t.name}</td>
                      <td className="py-3">
                        <span
                          className={`px-2.5 py-1 rounded-lg text-xs font-bold uppercase tracking-wide ${
                            t.active ? STATUS_STYLE.active : STATUS_STYLE.inactive
                          }`}
                        >
                          {t.active ? 'active' : 'inactive'}
                        </span>
                      </td>
                      <td className="py-3 text-slate-500 font-mono text-xs">{t.sheetId}</td>
                      <td className="py-3 text-right">
                        <button
                          type="button"
                          onClick={() => onEdit(t)}
                          className="text-sm font-bold text-slate-600 hover:text-slate-900"
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default TenantListScreen;
