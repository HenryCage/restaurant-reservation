import { useState } from 'react';
import TenantListScreen from './TenantListScreen.jsx';
import TenantFormScreen from './TenantFormScreen.jsx';

/**
 * Small local navigation wrapper for the tenant-management area (list <->
 * create/edit form) -- kept separate from App.jsx's top-level auth-state
 * machine so App.jsx doesn't need two more `screen` values for what's really
 * one cohesive area (mirrors how DashboardScreen composes its own children).
 * @param {{ api: ReturnType<typeof import('../api.js').createApiClient>, onBack: () => void }} props
 */
function TenantManagementScreen({ api, onBack }) {
  const [view, setView] = useState('list'); // 'list' | 'create' | 'edit'
  const [editingTenant, setEditingTenant] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  function handleEdit(tenant) {
    setEditingTenant(tenant);
    setView('edit');
  }

  function handleCreate() {
    setEditingTenant(null);
    setView('create');
  }

  function handleSaved() {
    setRefreshKey((k) => k + 1);
    setView('list');
  }

  function handleCancel() {
    setView('list');
  }

  if (view === 'list') {
    return <TenantListScreen api={api} refreshKey={refreshKey} onEdit={handleEdit} onCreate={handleCreate} onBack={onBack} />;
  }

  return (
    <TenantFormScreen api={api} mode={view} tenant={editingTenant} onSaved={handleSaved} onCancel={handleCancel} />
  );
}

export default TenantManagementScreen;
