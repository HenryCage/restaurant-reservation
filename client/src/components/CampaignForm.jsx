import { useState, useEffect } from 'react';
import { ClockIcon } from '@heroicons/react/24/outline';

/** datetime-local wants "YYYY-MM-DDTHH:mm" in the browser's local time, not an ISO/UTC string. */
function isoToDatetimeLocal(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * @param {{
 *   api: ReturnType<typeof import('../api.js').createApiClient>,
 *   contacts: { id: string, name: string, phone: string }[],
 *   onCreated?: () => void,
 *   editingCampaign?: { id: string, name: string, message: string, sendTo: string, scheduledTime: string } | null,
 *   onCancelEdit?: () => void,
 * }} props
 */
function CampaignForm({ api, contacts, onCreated, editingCampaign, onCancelEdit }) {
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [sendTo, setSendTo] = useState('all');
  const [scheduledTime, setScheduledTime] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(null);
  const [sendToSearch, setSendToSearch] = useState('');

  // Only a pending campaign can be edited (server-enforced too), so this
  // effect only ever needs to run when a *new* campaign is selected for edit.
  useEffect(() => {
    if (!editingCampaign) return;
    setName(editingCampaign.name);
    setMessage(editingCampaign.message);
    setSendTo(editingCampaign.sendTo);
    setScheduledTime(isoToDatetimeLocal(editingCampaign.scheduledTime));
    setStatus(null);
  }, [editingCampaign]);

  function resetForm() {
    setName('');
    setMessage('');
    setSendTo('all');
    setScheduledTime('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setStatus(null);
    try {
      // A blank schedule means "send now" -- campaigns.js always requires a
      // scheduledTime, so resolve the empty case client-side to the current
      // instant rather than leaving it optional server-side.
      const scheduledIso = scheduledTime ? new Date(scheduledTime).toISOString() : new Date().toISOString();
      if (editingCampaign) {
        await api.patch(`/api/campaigns/${editingCampaign.id}`, { name, message, sendTo, scheduledTime: scheduledIso });
        setStatus({ type: 'success', message: 'Campaign updated.' });
        resetForm();
        onCreated?.();
        onCancelEdit?.();
      } else {
        await api.post('/api/campaigns', { name, message, sendTo, scheduledTime: scheduledIso });
        setStatus({ type: 'success', message: 'Campaign created.' });
        resetForm();
        onCreated?.();
      }
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    } finally {
      setLoading(false);
    }
  }

  function handleCancelEdit() {
    resetForm();
    setStatus(null);
    onCancelEdit?.();
  }

  const sendToQuery = sendToSearch.trim().toLowerCase();
  // The current selection stays in the option list even while filtering, so
  // typing a search doesn't visually un-select whatever was already chosen.
  const visibleContacts = sendToQuery
    ? contacts.filter(
        (c) => c.id === sendTo || c.name.toLowerCase().includes(sendToQuery) || c.phone.toLowerCase().includes(sendToQuery),
      )
    : contacts;

  return (
    <div className="bg-white border border-slate-200/80 rounded-3xl shadow-sm overflow-hidden p-6 md:p-8 space-y-6">
      <h2 className="text-xl font-extrabold text-slate-900">{editingCampaign ? 'Edit campaign' : 'New campaign'}</h2>

      {status && (
        <div
          className={`p-4 rounded-xl border flex items-start gap-2.5 text-sm font-medium ${
            status.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-rose-50 border-rose-200 text-rose-800'
          }`}
        >
          <p>{status.message}</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="campaignName" className="text-xs font-bold text-slate-500 uppercase tracking-wider">
            Campaign Name
          </label>
          <input
            id="campaignName"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800 transition-all placeholder:text-slate-400"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="campaignMessage" className="text-xs font-bold text-slate-500 uppercase tracking-wider">
            Message
          </label>
          <textarea
            id="campaignMessage"
            rows="4"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            required
            className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800 transition-all resize-none placeholder:text-slate-400"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label htmlFor="scheduledTime" className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              Schedule (Optional)
            </label>
            <input
              id="scheduledTime"
              type="datetime-local"
              value={scheduledTime}
              onChange={(e) => setScheduledTime(e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800 transition-all text-slate-700"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="sendTo" className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              Send To
            </label>
            {contacts.length > 5 && (
              <input
                type="text"
                aria-label="Search recipients"
                placeholder="Search contacts…"
                value={sendToSearch}
                onChange={(e) => setSendToSearch(e.target.value)}
                className="w-full border border-slate-200 rounded-xl px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800 transition-all placeholder:text-slate-400"
              />
            )}
            <select
              id="sendTo"
              value={sendTo}
              onChange={(e) => setSendTo(e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800 transition-all bg-white text-slate-700"
            >
              <option value="all">All contacts</option>
              {visibleContacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.phone})
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex gap-3 mt-4">
          <button
            type="submit"
            disabled={loading}
            className="flex-1 flex items-center justify-center gap-2 py-3.5 bg-slate-900 text-white rounded-xl text-sm font-bold hover:bg-slate-800 transition-all active:scale-[0.99] disabled:opacity-50"
          >
            {loading ? (
              <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <>
                <ClockIcon className="w-4 h-4" />
                {editingCampaign ? 'Save changes' : 'Create campaign'}
              </>
            )}
          </button>
          {editingCampaign && (
            <button
              type="button"
              onClick={handleCancelEdit}
              className="py-3.5 px-6 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-bold hover:bg-slate-50 transition-all"
            >
              Cancel
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

export default CampaignForm;
