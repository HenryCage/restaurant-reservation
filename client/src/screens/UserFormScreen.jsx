import { useState } from 'react';

/**
 * Create-only -- unlike a tenant, a user has no editable fields once created
 * besides `active` and its password, both already handled inline on
 * UserListScreen's rows (Deactivate/Reactivate, Reset password), so there's
 * no shared create/edit form here the way TenantFormScreen has one.
 * @param {{
 *   api: ReturnType<typeof import('../api.js').createApiClient>,
 *   scope: { type: 'tenant', tenantId: string } | { type: 'superadmin' },
 *   onSaved: (result: { user: object, temporaryPassword: string }) => void,
 *   onCancel: () => void,
 * }} props
 */
function UserFormScreen({ api, scope, onSaved, onCancel }) {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const payload = scope.type === 'superadmin' ? { email, isSuperadmin: true } : { tenantId: scope.tenantId, email };

    try {
      const result = await api.post('/api/users', payload);
      onSaved(result);
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
      <div className="max-w-md mx-auto space-y-6">
        <h1 className="text-3xl font-black text-slate-900 tracking-tight">
          {scope.type === 'superadmin' ? 'Create superadmin' : 'Create user'}
        </h1>

        {error && (
          <div className="p-4 rounded-xl border bg-rose-50 border-rose-200 text-rose-800 text-sm font-medium">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="bg-white border border-slate-200/80 rounded-3xl shadow-sm p-6 md:p-8 space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="email" className={labelClass}>Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className={inputClass}
            />
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

export default UserFormScreen;
