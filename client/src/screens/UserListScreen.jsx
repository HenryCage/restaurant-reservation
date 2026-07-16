import { useState, useEffect, useCallback } from 'react';

const STATUS_STYLE = {
  active: 'bg-emerald-100 text-emerald-800',
  inactive: 'bg-slate-200 text-slate-600',
};

/** @param {{ type: 'tenant', tenantId: string } | { type: 'superadmin' }} scope */
function scopeQuery(scope) {
  return scope.type === 'superadmin' ? 'superadmins=true' : `tenantId=${encodeURIComponent(scope.tenantId)}`;
}

/**
 * Shared by the tenant-scoped user list and the superadmin roster -- same
 * columns and actions, only the query scope and create-payload shape differ.
 * @param {{
 *   api: ReturnType<typeof import('../api.js').createApiClient>,
 *   scope: { type: 'tenant', tenantId: string } | { type: 'superadmin' },
 *   refreshKey?: number,
 *   pendingReveal?: { email: string, temporaryPassword: string } | null,
 *   onDismissPendingReveal: () => void,
 *   onCreate: () => void,
 *   onBack: () => void,
 * }} props
 */
function UserListScreen({ api, scope, refreshKey, pendingReveal, onDismissPendingReveal, onCreate, onBack }) {
  const [users, setUsers] = useState(null); // null = not loaded yet
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  // A freshly generated temp password, from either a create (via
  // pendingReveal, threaded down from UserManagementScreen) or a
  // reset-password click (set directly below) -- shown once, then gone.
  const [reveal, setReveal] = useState(null);

  useEffect(() => {
    if (pendingReveal) setReveal(pendingReveal);
  }, [pendingReveal]);

  function dismissReveal() {
    setReveal(null);
    if (pendingReveal) onDismissPendingReveal();
  }

  const fetchUsers = useCallback(async () => {
    try {
      const list = await api.get(`/api/users?${scopeQuery(scope)}`);
      setUsers(list);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [api, scope]);

  // No polling here (matches TenantListScreen) -- an infrequently-changing
  // admin view; refreshKey lets the parent force a re-fetch after a create.
  useEffect(() => {
    fetchUsers();
  }, [fetchUsers, refreshKey]);

  async function handleToggleActive(user) {
    setActionError(null);
    try {
      await api.patch(`/api/users/${encodeURIComponent(user.id)}`, { active: !user.active });
      await fetchUsers();
    } catch (err) {
      setActionError(err.message);
    }
  }

  async function handleResetPassword(user) {
    setActionError(null);
    try {
      const { temporaryPassword } = await api.post(`/api/users/${encodeURIComponent(user.id)}/reset-password`, {});
      setReveal({ email: user.email, temporaryPassword });
      await fetchUsers();
    } catch (err) {
      setActionError(err.message);
    }
  }

  const isSuperadminScope = scope.type === 'superadmin';

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-6 md:p-12 font-sans">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-black text-slate-900 tracking-tight">
              {isSuperadminScope ? 'Superadmins' : 'Users'}
            </h1>
            <p className="text-sm text-slate-500 font-medium">
              {isSuperadminScope ? 'Manage superadmin accounts.' : `Manage users for "${scope.tenantId}".`}
            </p>
          </div>
          <button type="button" onClick={onBack} className="text-sm font-bold text-slate-500 hover:text-slate-900">
            ← Back
          </button>
        </div>

        {reveal && (
          <div className="p-4 rounded-xl border bg-emerald-50 border-emerald-200 text-emerald-900 text-sm font-medium flex items-start justify-between gap-4">
            <div>
              New password for <span className="font-mono">{reveal.email}</span>:{' '}
              <span className="font-mono font-bold">{reveal.temporaryPassword}</span>
              <div className="text-xs text-emerald-700 mt-1">Copy it now — it will not be shown again.</div>
            </div>
            <button
              type="button"
              onClick={dismissReveal}
              className="text-xs font-bold text-emerald-700 hover:text-emerald-900 whitespace-nowrap"
            >
              Dismiss
            </button>
          </div>
        )}

        {error && (
          <div className="p-4 rounded-xl border bg-rose-50 border-rose-200 text-rose-800 text-sm font-medium">
            {error}
          </div>
        )}
        {actionError && (
          <div className="p-4 rounded-xl border bg-rose-50 border-rose-200 text-rose-800 text-sm font-medium">
            {actionError}
          </div>
        )}

        <div className="bg-white border border-slate-200/80 rounded-3xl shadow-sm p-6 space-y-4">
          <button
            type="button"
            onClick={onCreate}
            className="py-3 px-5 bg-slate-900 text-white rounded-xl text-sm font-bold hover:bg-slate-800 transition-all active:scale-[0.99]"
          >
            {isSuperadminScope ? 'Create new superadmin' : 'Create new user'}
          </button>

          {users === null || users.length === 0 ? (
            <p className="text-sm text-slate-400">{users === null ? 'Loading…' : 'No users yet.'}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="border-b border-slate-100 text-slate-400 font-bold">
                    <th className="py-2.5">Email</th>
                    <th className="py-2.5">Status</th>
                    <th className="py-2.5">Must change password</th>
                    <th className="py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50 font-medium text-slate-700">
                  {users.map((u) => (
                    <tr key={u.id} className="hover:bg-slate-50/50">
                      <td className="py-3 font-mono text-xs">{u.email}</td>
                      <td className="py-3">
                        <span
                          className={`px-2.5 py-1 rounded-lg text-xs font-bold uppercase tracking-wide ${
                            u.active ? STATUS_STYLE.active : STATUS_STYLE.inactive
                          }`}
                        >
                          {u.active ? 'active' : 'inactive'}
                        </span>
                      </td>
                      <td className="py-3 text-slate-500">{u.mustChangePassword ? 'yes' : 'no'}</td>
                      <td className="py-3 text-right space-x-3">
                        <button
                          type="button"
                          onClick={() => handleResetPassword(u)}
                          className="text-sm font-bold text-slate-600 hover:text-slate-900"
                        >
                          Reset password
                        </button>
                        <button
                          type="button"
                          onClick={() => handleToggleActive(u)}
                          className="text-sm font-bold text-slate-600 hover:text-slate-900"
                        >
                          {u.active ? 'Deactivate' : 'Reactivate'}
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

export default UserListScreen;
