import { useState } from 'react';

/**
 * Superadmin-only: chooses which tenant's data to view. The chosen id is
 * held in App.jsx's React state, not the URL (no client-side router) --
 * validity is confirmed implicitly by the dashboard's first real fetch.
 * @param {{ onPick: (tenantId: string) => void }} props
 */
function TenantPickerScreen({ onPick }) {
  const [tenantId, setTenantId] = useState('');

  function handleSubmit(e) {
    e.preventDefault();
    const trimmed = tenantId.trim();
    if (trimmed === '') return;
    onPick(trimmed);
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

          <button
            type="submit"
            className="w-full flex items-center justify-center gap-2 mt-4 py-3.5 bg-slate-900 text-white rounded-xl text-sm font-bold hover:bg-slate-800 transition-all active:scale-[0.99]"
          >
            Continue
          </button>
        </form>
      </div>
    </div>
  );
}

export default TenantPickerScreen;
