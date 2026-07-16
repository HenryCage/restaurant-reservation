// StatTiles.jsx — pure presentational; counts are derived from props, no fetch of its own.

/**
 * @param {{ contacts: object[], campaigns: { status: string }[] }} props
 */
function StatTiles({ contacts, campaigns }) {
  const queued = campaigns.filter((c) => c.status === 'pending' || c.status === 'processing').length;
  const sent = campaigns.filter((c) => c.status === 'sent').length;
  const failed = campaigns.filter((c) => c.status === 'failed' || c.status === 'partial').length;

  const tiles = [
    { label: 'Contacts', value: contacts.length },
    { label: 'Queued', value: queued },
    { label: 'Sent', value: sent },
    { label: 'Failed', value: failed },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {tiles.map((t) => (
        <div key={t.label} className="bg-white border border-slate-200/80 p-5 rounded-2xl shadow-sm flex flex-col">
          <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">{t.label}</span>
          <span className="text-3xl font-black text-slate-900 mt-2">{t.value}</span>
        </div>
      ))}
    </div>
  );
}

export default StatTiles;
