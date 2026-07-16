import { useState, useEffect, useCallback } from 'react';
import { CheckCircleIcon, XCircleIcon } from '@heroicons/react/24/outline';
import { COUNTRY_CODES } from '../countryCodes.js';

const POLL_INTERVAL_MS = 5000;

/**
 * @param {{ api: ReturnType<typeof import('../api.js').createApiClient> }} props
 */
function ContactsPanel({ api }) {
  const [contacts, setContacts] = useState([]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [countryCode, setCountryCode] = useState('234');
  const [tags, setTags] = useState('');
  const [status, setStatus] = useState(null);

  const fetchContacts = useCallback(async () => {
    try {
      const list = await api.get('/api/contacts');
      setContacts(list);
    } catch {
      // Polling failure is silent here -- the next tick retries. A session
      // expiry is already handled globally via api.js's onUnauthorized.
    }
  }, [api]);

  useEffect(() => {
    fetchContacts();
    const interval = setInterval(fetchContacts, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchContacts]);

  async function handleSubmit(e) {
    e.preventDefault();
    setStatus(null);
    try {
      await api.post('/api/contacts', {
        name,
        phone,
        countryCode,
        tags: tags
          ? tags.split(',').map((t) => t.trim()).filter(Boolean)
          : [],
      });
      setStatus({ type: 'success', message: 'Contact added.' });
      setName('');
      setPhone('');
      setTags('');
      fetchContacts();
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    }
  }

  return (
    <div className="bg-white border border-slate-200/80 rounded-3xl shadow-sm p-6 space-y-4">
      <h2 className="text-xl font-extrabold text-slate-900">Contacts</h2>

      {status && (
        <div
          className={`p-3.5 rounded-xl border flex items-start gap-2 text-xs font-semibold ${
            status.type === 'success'
              ? 'bg-emerald-50 border-emerald-100 text-emerald-800'
              : 'bg-rose-50 border-rose-100 text-rose-800'
          }`}
        >
          {status.type === 'success' ? (
            <CheckCircleIcon className="w-4 h-4 flex-shrink-0" />
          ) : (
            <XCircleIcon className="w-4 h-4 flex-shrink-0" />
          )}
          <p>{status.message}</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-3.5">
        <input
          type="text"
          placeholder="Name"
          aria-label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800 transition-all placeholder:text-slate-400"
        />
        <div className="flex gap-2">
          <select
            aria-label="Country"
            value={countryCode}
            onChange={(e) => setCountryCode(e.target.value)}
            className="border border-slate-200 rounded-xl px-2 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800 transition-all"
          >
            {COUNTRY_CODES.map((c) => (
              <option key={c.code} value={c.code}>{c.label}</option>
            ))}
          </select>
          <input
            type="tel"
            placeholder="8012345678"
            aria-label="Phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
            className="flex-1 min-w-0 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800 transition-all placeholder:text-slate-400 font-mono"
          />
        </div>
        <input
          type="text"
          placeholder="tags, optional"
          aria-label="Tags"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800 transition-all placeholder:text-slate-400"
        />
        <button
          type="submit"
          className="w-full py-3 bg-teal-800 text-white rounded-xl text-sm font-bold hover:bg-teal-700 transition-all active:scale-[0.99]"
        >
          Add contact
        </button>
      </form>

      <div className="pt-4 border-t border-slate-100">
        <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Contacts List</h3>
        {contacts.length === 0 ? (
          <p className="text-sm text-slate-400 italic">No contacts yet.</p>
        ) : (
          <div className="max-h-[300px] overflow-y-auto space-y-3 pr-1">
            {contacts.map((contact) => (
              <div
                key={contact.id}
                className="p-3 bg-slate-50 border border-slate-100 rounded-xl flex flex-col gap-1"
              >
                <span className="font-bold text-slate-900 text-sm">{contact.name}</span>
                <span className="text-xs text-slate-500 font-mono">{contact.phone}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default ContactsPanel;
