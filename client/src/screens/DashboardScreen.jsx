import { useState, useEffect, useCallback } from 'react';
import StatTiles from '../components/StatTiles.jsx';
import ContactsPanel from '../components/ContactsPanel.jsx';
import CampaignForm from '../components/CampaignForm.jsx';
import CampaignHistory from '../components/CampaignHistory.jsx';
import OrdersTable from '../components/OrdersTable.jsx';

const POLL_INTERVAL_MS = 5000;

/**
 * @param {{
 *   api: ReturnType<typeof import('../api.js').createApiClient>,
 *   onLogout: () => void,
 *   onBackToTenants?: () => void,
 * }} props
 */
function DashboardScreen({ api, onLogout, onBackToTenants }) {
  // Owns its own contacts/campaigns fetch purely to feed StatTiles (which has
  // no fetch of its own) and CampaignForm's sendTo dropdown -- ContactsPanel
  // and CampaignHistory still do their own independent polling for their own
  // lists, per the spec.
  const [contacts, setContacts] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [error, setError] = useState(null);

  const fetchStats = useCallback(async () => {
    try {
      const [contactsList, campaignsList] = await Promise.all([
        api.get('/api/contacts'),
        api.get('/api/campaigns'),
      ]);
      setContacts(contactsList);
      setCampaigns(campaignsList);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [api]);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchStats]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-6 md:p-12 font-sans">
      <div className="max-w-6xl mx-auto space-y-8">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-3xl font-black text-slate-900 tracking-tight">SMS Dispatch</h1>
            <p className="text-sm text-slate-500 font-medium">Automated notifications &amp; campaigns</p>
          </div>
          <div className="flex items-center gap-4">
            {onBackToTenants && (
              <button
                type="button"
                onClick={onBackToTenants}
                className="text-sm font-bold text-slate-500 hover:text-slate-900"
              >
                ← Tenants
              </button>
            )}
            <button type="button" onClick={onLogout} className="text-sm font-bold text-slate-500 hover:text-slate-900">
              Log out
            </button>
          </div>
        </div>

        {error ? (
          <div className="p-4 rounded-xl border bg-rose-50 border-rose-200 text-rose-800 text-sm font-medium">
            {error}
          </div>
        ) : (
          <>
            <StatTiles contacts={contacts} campaigns={campaigns} />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              <div className="lg:col-span-2 space-y-6">
                <CampaignForm api={api} contacts={contacts} onCreated={fetchStats} />
                <CampaignHistory api={api} contacts={contacts} />
              </div>
              <div className="space-y-6">
                <ContactsPanel api={api} />
              </div>
            </div>

            <OrdersTable api={api} />
          </>
        )}
      </div>
    </div>
  );
}

export default DashboardScreen;
