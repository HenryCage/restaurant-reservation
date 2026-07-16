import { useState } from 'react';

/**
 * Superadmin-only: chooses which tenant's data to view. The chosen id is
 * held in App.jsx's React state, not the URL (no client-side router) --
 * validity is confirmed implicitly by the dashboard's first real fetch.
 * @param {{
 *   onPick: (tenantId: string) => void,
 *   onManageTenants: () => void,
 *   onManageUsers: (tenantId: string) => void,
 *   onManageSuperadmins: () => void,
 * }} props
 */
function TenantPickerScreen({ onPick, onManageTenants, onManageUsers, onManageSuperadmins }) {
  const [tenantId, setTenantId] = useState('');

  function handleSubmit(e) {
    e.preventDefault();
    const trimmed = tenantId.trim();
    if (trimmed === '') return;
    onPick(trimmed);
  }

  function handleManageUsers() {
    const trimmed = tenantId.trim();
    if (trimmed === '') return;
    onManageUsers(trimmed);
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex items-center justify-center p-6 font-sans">
      <div className="w-full max-w-sm bg-white border border-slate-200/80 rounded-3xl shadow-sm p-8 space-y-6">
        <div>
          <h1 className="text-2xl font-black text-slate-900 tracking-tight">Choose a tenant</h1>
          <p className="text-sm text-slate-500 font-medium">Superadmin: pick which tenant's data to view.</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="tenantId" className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              Tenant ID
            </label>
            <input
              id="tenantId"
              type="text"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              required
              className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-800 transition-all font-mono"
            />
          </div>

          <div className="flex gap-3 mt-4">
            <button
              type="submit"
              className="flex-1 flex items-center justify-center gap-2 py-3.5 bg-slate-900 text-white rounded-xl text-sm font-bold hover:bg-slate-800 transition-all active:scale-[0.99]"
            >
              Continue
            </button>
            <button
              type="button"
              onClick={handleManageUsers}
              className="flex-1 flex items-center justify-center gap-2 py-3.5 bg-slate-100 text-slate-700 rounded-xl text-sm font-bold hover:bg-slate-200 transition-all active:scale-[0.99]"
            >
              Manage users
            </button>
          </div>
        </form>

        <div className="space-y-2">
          <button
            type="button"
            onClick={onManageTenants}
            className="w-full text-center text-sm font-bold text-slate-500 hover:text-slate-900"
          >
            Manage tenants →
          </button>
          <button
            type="button"
            onClick={onManageSuperadmins}
            className="w-full text-center text-sm font-bold text-slate-500 hover:text-slate-900"
          >
            Manage superadmins →
          </button>
        </div>
      </div>
    </div>
  );
}

export default TenantPickerScreen;
