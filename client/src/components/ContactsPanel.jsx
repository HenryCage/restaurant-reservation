import { useState, useEffect, useCallback } from 'react';
import { CheckCircleIcon, XCircleIcon, PencilIcon, TrashIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { COUNTRY_CODES } from '../countryCodes.js';
import ConfirmDialog from './ConfirmDialog.jsx';

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
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editCountryCode, setEditCountryCode] = useState('234');
  const [editPhone, setEditPhone] = useState('');
  const [editTags, setEditTags] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(null);

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

  function startEdit(contact) {
    setEditingId(contact.id);
    setEditName(contact.name);
    setEditCountryCode('234');
    setEditPhone(contact.phone);
    setEditTags(contact.tags.join(', '));
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function handleEditSubmit(e, contactId) {
    e.preventDefault();
    setStatus(null);
    try {
      await api.patch(`/api/contacts/${contactId}`, {
        name: editName,
        phone: editPhone,
        countryCode: editCountryCode,
        tags: editTags
          ? editTags.split(',').map((t) => t.trim()).filter(Boolean)
          : [],
      });
      setEditingId(null);
      fetchContacts();
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    }
  }

  async function handleDeleteConfirmed() {
    const contact = confirmingDelete;
    setConfirmingDelete(null);
    setStatus(null);
    try {
      await api.delete(`/api/contacts/${contact.id}`);
      fetchContacts();
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    }
  }

  const query = search.trim().toLowerCase();
  const visibleContacts = query
    ? contacts.filter((c) => c.name.toLowerCase().includes(query) || c.phone.toLowerCase().includes(query))
    : contacts;

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

      <div className="pt-4 border-t border-slate-100 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Contacts List</h3>
          {contacts.length > 0 && (
            <div className="relative flex-shrink-0 w-36">
              <MagnifyingGlassIcon className="w-3.5 h-3.5 text-slate-300 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search"
                aria-label="Search contacts"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full border border-slate-200 rounded-lg pl-7 pr-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800 transition-all placeholder:text-slate-400"
              />
            </div>
          )}
        </div>
        {contacts.length === 0 ? (
          <p className="text-sm text-slate-400 italic">No contacts yet.</p>
        ) : visibleContacts.length === 0 ? (
          <p className="text-sm text-slate-400 italic">No contacts match "{search}".</p>
        ) : (
          <div className="max-h-[300px] overflow-y-auto space-y-3 pr-1">
            {visibleContacts.map((contact) =>
              editingId === contact.id ? (
                <form
                  key={contact.id}
                  onSubmit={(e) => handleEditSubmit(e, contact.id)}
                  className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2"
                >
                  <input
                    type="text"
                    aria-label={`Edit name for ${contact.name}`}
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    required
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800"
                  />
                  <div className="flex gap-2">
                    <select
                      aria-label={`Edit country for ${contact.name}`}
                      value={editCountryCode}
                      onChange={(e) => setEditCountryCode(e.target.value)}
                      className="border border-slate-200 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800"
                    >
                      {COUNTRY_CODES.map((c) => (
                        <option key={c.code} value={c.code}>{c.label}</option>
                      ))}
                    </select>
                    <input
                      type="tel"
                      aria-label={`Edit phone for ${contact.name}`}
                      value={editPhone}
                      onChange={(e) => setEditPhone(e.target.value)}
                      required
                      className="flex-1 min-w-0 border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800"
                    />
                  </div>
                  <input
                    type="text"
                    aria-label={`Edit tags for ${contact.name}`}
                    placeholder="tags, optional"
                    value={editTags}
                    onChange={(e) => setEditTags(e.target.value)}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800 placeholder:text-slate-400"
                  />
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      className="flex-1 py-2 bg-slate-900 text-white rounded-lg text-xs font-bold hover:bg-slate-800"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={cancelEdit}
                      className="flex-1 py-2 bg-white border border-slate-200 text-slate-600 rounded-lg text-xs font-bold hover:bg-slate-100"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <div
                  key={contact.id}
                  className="p-3 bg-slate-50 border border-slate-100 rounded-xl flex items-center justify-between gap-2"
                >
                  <div className="flex flex-col gap-1 min-w-0">
                    <span className="font-bold text-slate-900 text-sm truncate">{contact.name}</span>
                    <span className="text-xs text-slate-500 font-mono">{contact.phone}</span>
                    {contact.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-0.5">
                        {contact.tags.map((tag) => (
                          <span
                            key={tag}
                            className="px-1.5 py-0.5 rounded-md bg-slate-200 text-slate-600 text-[10px] font-bold uppercase tracking-wide"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      type="button"
                      aria-label={`Edit ${contact.name}`}
                      onClick={() => startEdit(contact)}
                      className="p-1.5 text-slate-400 hover:text-slate-900 rounded-lg hover:bg-slate-100"
                    >
                      <PencilIcon className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${contact.name}`}
                      onClick={() => setConfirmingDelete(contact)}
                      className="p-1.5 text-slate-400 hover:text-rose-600 rounded-lg hover:bg-rose-50"
                    >
                      <TrashIcon className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ),
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmingDelete !== null}
        title={`Delete ${confirmingDelete?.name}?`}
        message="This cannot be undone."
        confirmLabel="Delete"
        onConfirm={handleDeleteConfirmed}
        onCancel={() => setConfirmingDelete(null)}
      />
    </div>
  );
}

export default ContactsPanel;
