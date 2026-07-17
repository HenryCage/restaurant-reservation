import { Fragment, useState, useEffect, useCallback } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import ConfirmDialog from './ConfirmDialog.jsx';

const POLL_INTERVAL_MS = 5000;

const STATUS_STYLES = {
  sent: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-rose-100 text-rose-800',
  partial: 'bg-amber-100 text-amber-800',
  cancelled: 'bg-slate-200 text-slate-600',
};
const DEFAULT_STATUS_STYLE = 'bg-blue-100 text-blue-800'; // pending / processing

const RECIPIENT_STATUS_STYLES = {
  sent: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-rose-100 text-rose-800',
};
const DEFAULT_RECIPIENT_STATUS_STYLE = 'bg-blue-100 text-blue-800'; // pending

/**
 * @param {{
 *   api: ReturnType<typeof import('../api.js').createApiClient>,
 *   contacts?: { id: string, name: string }[],
 *   onEdit?: (campaign: object) => void,
 * }} props
 */
function CampaignHistory({ api, contacts = [], onEdit }) {
  const [campaigns, setCampaigns] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [recipientsByCampaign, setRecipientsByCampaign] = useState({});
  const [recipientsError, setRecipientsError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [confirmingCancel, setConfirmingCancel] = useState(null);

  /** sendTo is either "all" or a contact id -- resolve the id to a name for display. */
  function sendToLabel(sendTo) {
    if (sendTo === 'all') return 'All contacts';
    const contact = contacts.find((c) => c.id === sendTo);
    return contact ? contact.name : 'Unknown contact';
  }

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

  async function toggleExpand(campaignId) {
    if (expandedId === campaignId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(campaignId);
    setRecipientsError(null);
    if (!recipientsByCampaign[campaignId]) {
      try {
        const recipients = await api.get(`/api/campaigns/${campaignId}/recipients`);
        setRecipientsByCampaign((prev) => ({ ...prev, [campaignId]: recipients }));
      } catch (err) {
        setRecipientsError(err.message);
      }
    }
  }

  async function handleCancelConfirmed() {
    const campaign = confirmingCancel;
    setConfirmingCancel(null);
    setActionError(null);
    try {
      await api.post(`/api/campaigns/${campaign.id}/cancel`, {});
      fetchCampaigns();
    } catch (err) {
      setActionError(err.message);
    }
  }

  return (
    <div className="bg-white border border-slate-200/80 rounded-3xl shadow-sm p-6 md:p-8 space-y-4">
      <h3 className="text-lg font-extrabold text-slate-900">Campaign History</h3>

      {actionError && (
        <div className="p-3 rounded-xl border bg-rose-50 border-rose-200 text-rose-800 text-xs font-semibold">
          {actionError}
        </div>
      )}

      {campaigns.length === 0 ? (
        <p className="text-sm text-slate-400">No campaigns yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse">
            <thead>
              <tr className="border-b border-slate-100 text-slate-400 font-bold">
                <th className="py-2.5 w-8" aria-hidden="true"></th>
                <th className="py-2.5">Name</th>
                <th className="py-2.5">Send To</th>
                <th className="py-2.5">Scheduled Time</th>
                <th className="py-2.5">Status</th>
                <th className="py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 font-medium text-slate-700">
              {/* already newest-first from GET /api/campaigns -- no client reorder */}
              {campaigns.map((c) => (
                <Fragment key={c.id}>
                  <tr className="hover:bg-slate-50/50">
                    <td className="py-3">
                      <button
                        type="button"
                        aria-label={expandedId === c.id ? `Collapse ${c.name}` : `Expand ${c.name}`}
                        onClick={() => toggleExpand(c.id)}
                        className="text-slate-400 hover:text-slate-900"
                      >
                        {expandedId === c.id ? (
                          <ChevronDownIcon className="w-4 h-4" />
                        ) : (
                          <ChevronRightIcon className="w-4 h-4" />
                        )}
                      </button>
                    </td>
                    <td className="py-3 font-semibold text-slate-900">{c.name}</td>
                    <td className="py-3 text-slate-500">{sendToLabel(c.sendTo)}</td>
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
                    <td className="py-3">
                      {c.status === 'pending' && (
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() => onEdit?.(c)}
                            className="text-xs font-bold text-slate-500 hover:text-slate-900"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            aria-label={`Cancel ${c.name}`}
                            onClick={() => setConfirmingCancel(c)}
                            className="text-xs font-bold text-rose-500 hover:text-rose-700"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                  {expandedId === c.id && (
                    <tr>
                      <td colSpan={6} className="bg-slate-50/70 px-4 py-3">
                        {recipientsError ? (
                          <p className="text-xs text-rose-600 font-semibold">{recipientsError}</p>
                        ) : !recipientsByCampaign[c.id] ? (
                          <p className="text-xs text-slate-400">Loading recipients…</p>
                        ) : recipientsByCampaign[c.id].length === 0 ? (
                          <p className="text-xs text-slate-400">No recipients yet.</p>
                        ) : (
                          <table className="w-full text-left text-xs border-collapse">
                            <thead>
                              <tr className="text-slate-400 font-bold">
                                <th className="py-1.5 pr-4">Phone</th>
                                <th className="py-1.5 pr-4">Status</th>
                                <th className="py-1.5 pr-4">Error</th>
                                <th className="py-1.5">Sent At</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {recipientsByCampaign[c.id].map((r) => (
                                <tr key={r.id}>
                                  <td className="py-1.5 pr-4 font-mono text-slate-600">{r.phone}</td>
                                  <td className="py-1.5 pr-4">
                                    <span
                                      className={`px-2 py-0.5 rounded-md font-bold uppercase tracking-wide ${
                                        RECIPIENT_STATUS_STYLES[r.status] ?? DEFAULT_RECIPIENT_STATUS_STYLE
                                      }`}
                                    >
                                      {r.status}
                                    </span>
                                  </td>
                                  <td className="py-1.5 pr-4 text-rose-600">{r.error || '—'}</td>
                                  <td className="py-1.5 text-slate-500">
                                    {r.sentAt ? new Date(r.sentAt).toLocaleString() : '—'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={confirmingCancel !== null}
        title={`Cancel "${confirmingCancel?.name}"?`}
        message="This campaign will no longer be sent."
        confirmLabel="Cancel campaign"
        onConfirm={handleCancelConfirmed}
        onCancel={() => setConfirmingCancel(null)}
      />
    </div>
  );
}

export default CampaignHistory;
