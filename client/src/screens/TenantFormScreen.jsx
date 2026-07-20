import { useState } from 'react';
import { COUNTRY_CODES } from '../countryCodes.js';

/** Builds the initial {status, template} rows from an existing tenant (edit mode). */
function initialRows(tenant) {
  const statuses = tenant?.notifyStatuses ?? [];
  if (statuses.length === 0) return [{ status: '', template: '' }];
  return statuses.map((status) => ({ status, template: tenant.templates?.[status] ?? '' }));
}

// Per-tenant SMS provider spec: only the fields relevant to whichever
// provider is selected are ever shown. `secret` fields (the one genuinely
// secret credential per provider) start blank in edit mode -- the real
// value never round-trips back from the API, only a masked form.
const PROVIDER_FIELDS = {
  termii: [
    { key: 'apiKey', label: 'API Key', secret: true },
    { key: 'baseUrl', label: 'Base URL', secret: false },
  ],
  africastalking: [
    { key: 'apiKey', label: 'API Key', secret: true },
    { key: 'username', label: 'Username', secret: false },
  ],
  twilio: [
    { key: 'accountSid', label: 'Account SID', secret: false },
    { key: 'authToken', label: 'Auth Token', secret: true },
    { key: 'fromNumber', label: 'From Number', secret: false },
  ],
};

/**
 * Secret fields always start blank; non-secret fields prefill from the
 * tenant's stored credentials only when `provider` matches what's already
 * stored (switching provider has nothing relevant to prefill from).
 */
function initialCredentials(provider, tenant) {
  const fields = PROVIDER_FIELDS[provider] ?? [];
  const sameProviderAsStored = tenant?.smsProvider === provider;
  const result = {};
  for (const f of fields) {
    result[f.key] = f.secret ? '' : sameProviderAsStored ? tenant?.smsCredentials?.[f.key] ?? '' : '';
  }
  return result;
}

/**
 * Shared by create and edit -- `mode` decides which.
 * @param {{
 *   api: ReturnType<typeof import('../api.js').createApiClient>,
 *   mode: 'create' | 'edit',
 *   tenant: object|null,
 *   onSaved: () => void,
 *   onCancel: () => void,
 * }} props
 */
function TenantFormScreen({ api, mode, tenant, onSaved, onCancel }) {
  const isEdit = mode === 'edit';
  const [id, setId] = useState(tenant?.id ?? '');
  const [name, setName] = useState(tenant?.name ?? '');
  const [active, setActive] = useState(tenant?.active ?? true);
  const [sheetId, setSheetId] = useState(tenant?.sheetId ?? '');
  const [sheetName, setSheetName] = useState(tenant?.sheetName ?? 'Orders');
  const [senderId, setSenderId] = useState(tenant?.senderId ?? '');
  const [channel, setChannel] = useState(tenant?.channel ?? 'dnd');
  const [testNumber, setTestNumber] = useState(tenant?.testNumber ?? '');
  const [defaultCountryCode, setDefaultCountryCode] = useState(tenant?.defaultCountryCode ?? '');
  const [googleServiceAccountEmail, setGoogleServiceAccountEmail] = useState(tenant?.googleServiceAccountEmail ?? '');
  const [googlePrivateKey, setGooglePrivateKey] = useState('');
  const [rows, setRows] = useState(initialRows(tenant));
  const [smsProvider, setSmsProvider] = useState(tenant?.smsProvider ?? '');
  const [credentials, setCredentials] = useState(() => initialCredentials(tenant?.smsProvider ?? '', tenant));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  function handleProviderChange(next) {
    setSmsProvider(next);
    setCredentials(initialCredentials(next, tenant));
  }

  function updateCredential(key, value) {
    setCredentials((prev) => ({ ...prev, [key]: value }));
  }

  function updateRow(index, field, value) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  }

  function addRow() {
    setRows((prev) => [...prev, { status: '', template: '' }]);
  }

  function removeRow(index) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const notifyStatuses = rows.map((r) => r.status.trim()).filter(Boolean);
    const templates = Object.fromEntries(
      rows.filter((r) => r.status.trim() !== '').map((r) => [r.status.trim(), r.template]),
    );
    const payload = {
      name,
      active,
      sheetId,
      sheetName,
      senderId,
      channel,
      testNumber,
      notifyStatuses,
      templates,
      smsProvider,
      smsCredentials: smsProvider === '' ? {} : credentials,
      defaultCountryCode,
      googleServiceAccountEmail,
      googlePrivateKey,
    };

    try {
      if (isEdit) {
        await api.patch(`/api/tenants/${encodeURIComponent(tenant.id)}`, payload);
      } else {
        await api.post('/api/tenants', { id, ...payload });
      }
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const inputClass =
    'w-full border border-slate-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800 transition-all';
  const labelClass = 'text-xs font-bold text-slate-500 uppercase tracking-wider';

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-6 md:p-12 font-sans">
      <div className="max-w-2xl mx-auto space-y-6">
        <h1 className="text-3xl font-black text-slate-900 tracking-tight">
          {isEdit ? 'Edit tenant' : 'Create tenant'}
        </h1>

        {error && (
          <div className="p-4 rounded-xl border bg-rose-50 border-rose-200 text-rose-800 text-sm font-medium">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="bg-white border border-slate-200/80 rounded-3xl shadow-sm p-6 md:p-8 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label htmlFor="tenantId" className={labelClass}>Tenant ID</label>
              <input
                id="tenantId"
                type="text"
                value={id}
                onChange={(e) => setId(e.target.value)}
                disabled={isEdit}
                required
                className={`${inputClass} font-mono disabled:bg-slate-50 disabled:text-slate-400`}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="tenantName" className={labelClass}>Name</label>
              <input id="tenantName" type="text" value={name} onChange={(e) => setName(e.target.value)} required className={inputClass} />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label htmlFor="sheetId" className={labelClass}>Sheet ID</label>
              <input id="sheetId" type="text" value={sheetId} onChange={(e) => setSheetId(e.target.value)} required className={`${inputClass} font-mono`} />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="sheetName" className={labelClass}>Sheet Name</label>
              <input id="sheetName" type="text" value={sheetName} onChange={(e) => setSheetName(e.target.value)} className={inputClass} />
            </div>
          </div>

          <div className="space-y-3 pt-2 border-t border-slate-100">
            <span className={labelClass}>Google Service Account</span>
            <p className="text-xs text-slate-400">
              This tenant's own Google Cloud service account, shared on their Sheet with Editor access -- not the
              platform's. Leave both blank if this tenant has no Sheet configured yet.
            </p>
            <div className="space-y-1.5">
              <label htmlFor="googleServiceAccountEmail" className={labelClass}>Service Account Email</label>
              <input
                id="googleServiceAccountEmail"
                type="text"
                value={googleServiceAccountEmail}
                onChange={(e) => setGoogleServiceAccountEmail(e.target.value)}
                className={`${inputClass} font-mono`}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="googlePrivateKey" className={labelClass}>Private Key</label>
              <textarea
                id="googlePrivateKey"
                rows="3"
                value={googlePrivateKey}
                onChange={(e) => setGooglePrivateKey(e.target.value)}
                className={`${inputClass} font-mono resize-none`}
              />
              {isEdit && tenant?.googlePrivateKey && (
                <p className="text-xs text-slate-400">
                  Currently set: <span className="font-mono">{tenant.googlePrivateKey}</span> — leave blank to keep unchanged.
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label htmlFor="senderId" className={labelClass}>Sender ID</label>
              <input id="senderId" type="text" value={senderId} onChange={(e) => setSenderId(e.target.value)} required className={inputClass} />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="channel" className={labelClass}>Channel</label>
              <input id="channel" type="text" value={channel} onChange={(e) => setChannel(e.target.value)} className={inputClass} />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label htmlFor="testNumber" className={labelClass}>Test Number (optional)</label>
              <input id="testNumber" type="text" value={testNumber} onChange={(e) => setTestNumber(e.target.value)} className={`${inputClass} font-mono`} />
            </div>
            <div className="flex flex-col justify-end gap-2 pb-1">
              <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
                Active
              </label>
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="defaultCountryCode" className={labelClass}>Default Country Code</label>
            <select
              id="defaultCountryCode"
              value={defaultCountryCode}
              onChange={(e) => setDefaultCountryCode(e.target.value)}
              className={inputClass}
            >
              <option value="">(use global default)</option>
              {COUNTRY_CODES.map((c) => (
                <option key={c.code} value={c.code}>{c.label}</option>
              ))}
            </select>
            <p className="text-xs text-slate-400">
              Used only for a phone number written without a leading "+" (in this tenant's sheet, contacts, or
              campaigns) -- a number that already has "+" is always read from its own prefix, regardless of this
              setting.
            </p>
          </div>

          <div className="space-y-3 pt-2 border-t border-slate-100">
            <div className="space-y-1.5">
              <label htmlFor="smsProvider" className={labelClass}>SMS Provider</label>
              <select
                id="smsProvider"
                value={smsProvider}
                onChange={(e) => handleProviderChange(e.target.value)}
                className={inputClass}
              >
                <option value="">(none)</option>
                <option value="termii">Termii</option>
                <option value="africastalking">Africa's Talking</option>
                <option value="twilio">Twilio</option>
              </select>
            </div>

            {(PROVIDER_FIELDS[smsProvider] ?? []).map((f) => {
              const canStayBlank = f.secret && isEdit && tenant?.smsProvider === smsProvider;
              const existingMasked = canStayBlank ? tenant?.smsCredentials?.[f.key] : null;
              return (
                <div key={f.key} className="space-y-1.5">
                  <label htmlFor={`smsCred-${f.key}`} className={labelClass}>{f.label}</label>
                  <input
                    id={`smsCred-${f.key}`}
                    type={f.secret ? 'password' : 'text'}
                    value={credentials[f.key] ?? ''}
                    onChange={(e) => updateCredential(f.key, e.target.value)}
                    required={!canStayBlank}
                    className={inputClass}
                  />
                  {existingMasked && (
                    <p className="text-xs text-slate-400">
                      Currently set: <span className="font-mono">{existingMasked}</span> — leave blank to keep unchanged.
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          <div className="space-y-3 pt-2 border-t border-slate-100">
            <div className="flex items-center justify-between">
              <span className={labelClass}>Notify statuses &amp; templates</span>
              <button type="button" onClick={addRow} className="text-sm font-bold text-slate-600 hover:text-slate-900">
                + Add status
              </button>
            </div>

            {rows.map((row, index) => (
              <div key={index} className="grid grid-cols-1 md:grid-cols-[1fr_2fr_auto] gap-2 items-start">
                <input
                  type="text"
                  aria-label={`Status ${index + 1}`}
                  placeholder="Status (e.g. Out for delivery)"
                  value={row.status}
                  onChange={(e) => updateRow(index, 'status', e.target.value)}
                  className={inputClass}
                />
                <textarea
                  aria-label={`Template ${index + 1}`}
                  placeholder="Message template"
                  rows="2"
                  value={row.template}
                  onChange={(e) => updateRow(index, 'template', e.target.value)}
                  className={`${inputClass} resize-none`}
                />
                <button
                  type="button"
                  onClick={() => removeRow(index)}
                  className="py-3 px-3 text-sm font-bold text-rose-600 hover:text-rose-800"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>

          <div className="flex gap-3 pt-4">
            <button
              type="submit"
              disabled={loading}
              className="flex-1 py-3.5 bg-slate-900 text-white rounded-xl text-sm font-bold hover:bg-slate-800 transition-all active:scale-[0.99] disabled:opacity-50"
            >
              {loading ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="py-3.5 px-6 bg-slate-100 text-slate-700 rounded-xl text-sm font-bold hover:bg-slate-200 transition-all"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default TenantFormScreen;
