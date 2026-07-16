import { useState } from 'react';
import { ClockIcon } from '@heroicons/react/24/outline';

/**
 * @param {{
 *   api: ReturnType<typeof import('../api.js').createApiClient>,
 *   contacts: { id: string, name: string, phone: string }[],
 *   onCreated?: () => void,
 * }} props
 */
function CampaignForm({ api, contacts, onCreated }) {
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [sendTo, setSendTo] = useState('all');
  const [scheduledTime, setScheduledTime] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setStatus(null);
    try {
      // A blank schedule means "send now" -- campaigns.js always requires a
      // scheduledTime, so resolve the empty case client-side to the current
      // instant rather than leaving it optional server-side.
      const scheduledIso = scheduledTime ? new Date(scheduledTime).toISOString() : new Date().toISOString();
      await api.post('/api/campaigns', { name, message, sendTo, scheduledTime: scheduledIso });
      setStatus({ type: 'success', message: 'Campaign created.' });
      setName('');
      setMessage('');
      setSendTo('all');
      setScheduledTime('');
      onCreated?.();
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-white border border-slate-200/80 rounded-3xl shadow-sm overflow-hidden p-6 md:p-8 space-y-6">
      <h2 className="text-xl font-extrabold text-slate-900">New campaign</h2>

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
            <select
              id="sendTo"
              value={sendTo}
              onChange={(e) => setSendTo(e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800 transition-all bg-white text-slate-700"
            >
              <option value="all">All contacts</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.phone})
                </option>
              ))}
            </select>
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full flex items-center justify-center gap-2 mt-4 py-3.5 bg-slate-900 text-white rounded-xl text-sm font-bold hover:bg-slate-800 transition-all active:scale-[0.99] disabled:opacity-50"
        >
          {loading ? (
            <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          ) : (
            <>
              <ClockIcon className="w-4 h-4" />
              Create campaign
            </>
          )}
        </button>
      </form>
    </div>
  );
}

export default CampaignForm;
