import { useState, useEffect, useCallback } from 'react';

const POLL_INTERVAL_MS = 5000;

const STATUS_STYLES = {
  sent: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-rose-100 text-rose-800',
  partial: 'bg-amber-100 text-amber-800',
};
const DEFAULT_STATUS_STYLE = 'bg-blue-100 text-blue-800'; // pending / processing

/**
 * @param {{ api: ReturnType<typeof import('../api.js').createApiClient> }} props
 */
function CampaignHistory({ api }) {
  const [campaigns, setCampaigns] = useState([]);

  const fetchCampaigns = useCallback(async () => {
    try {
      const list = await api.get('/api/campaigns');
      setCampaigns(list);
    } catch {
      // Polling failure is silent here -- the next tick retries. A session
      // expiry is already handled globally via api.js's onUnauthorized.
    }
  }, [api]);

  useEffect(() => {
    fetchCampaigns();
    const interval = setInterval(fetchCampaigns, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchCampaigns]);

  return (
    <div className="bg-white border border-slate-200/80 rounded-3xl shadow-sm p-6 md:p-8 space-y-4">
      <h3 className="text-lg font-extrabold text-slate-900">Campaign History</h3>
      {campaigns.length === 0 ? (
        <p className="text-sm text-slate-400">No campaigns yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse">
            <thead>
              <tr className="border-b border-slate-100 text-slate-400 font-bold">
                <th className="py-2.5">Name</th>
                <th className="py-2.5">Send To</th>
                <th className="py-2.5">Scheduled Time</th>
                <th className="py-2.5">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 font-medium text-slate-700">
              {/* already newest-first from GET /api/campaigns -- no client reorder */}
              {campaigns.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50/50">
                  <td className="py-3 font-semibold text-slate-900">{c.name}</td>
                  <td className="py-3 text-slate-500">{c.sendTo === 'all' ? 'All contacts' : c.sendTo}</td>
                  <td className="py-3 text-slate-500">{new Date(c.scheduledTime).toLocaleString()}</td>
                  <td className="py-3">
                    <span
                      className={`px-2.5 py-1 rounded-lg text-xs font-bold uppercase tracking-wide ${
                        STATUS_STYLES[c.status] ?? DEFAULT_STATUS_STYLE
                      }`}
                    >
                      {c.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default CampaignHistory;
